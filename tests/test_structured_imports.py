"""Import and saved-report readback of synthetic, documented structured formats."""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import parser
import structured_events as se
from test_structured_events import dcgm, goe, goe_document

GPU='GPU-DEMO-001'
IDENTITY='*** /proc/driver/nvidia/gpus/0000:41:00.0/information\nGPU UUID: '+GPU+'\n'
XID='[12.000] NVRM: Xid (PCI:0000:41:00): 119, synthetic timeout'
SXID='[13.000] nvidia-nvswitch2: SXid (PCI:0000:c1:00.0): 119, Non-fatal, Link 3 synthetic issue'
GOE_BODY='''Device UUID : GPU-DEMO-001
Source Module : GPU-GSP
Category : Timeout (0x0001)
Module Event Code : Unknown (0x0001)
Severity : Recoverable
Scope : Device
Timestamp : 1793318400123456
Instance ID : 8
Originator : 1
Trace ID : 9007199254740993
Legacy Xid : 119
Future Field : synthetic extension'''


class StructuredImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        spec=importlib.util.spec_from_file_location('structured_import_test_server',Path(__file__).resolve().parents[1]/'app/server.py')
        cls.s=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'GPU_LOG_DATA_DIR':str(Path(cls.temp.name)/'runtime')}):spec.loader.exec_module(cls.s)

    @classmethod
    def tearDownClass(cls):
        cls.s.KNOWLEDGE.close();cls.s.READER.close();cls.s.EXECUTOR.shutdown(wait=True,cancel_futures=True)
        cls.temp.cleanup()

    def readback(self,report):
        key='a'*32
        raw=json.dumps(report,ensure_ascii=False).encode()
        with self.s.RESULTS_LOCK:
            (self.s.RESULTS/(key+'.json')).write_bytes(raw)
            loaded,revision=self.s.read_case(key)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),revision)
        self.assertEqual(key,loaded['id'])
        self.assertEqual(report['events'],loaded['events'])
        self.assertEqual(report['lifecycleEvents'],loaded['lifecycleEvents'])
        if 'structured' in report:self.assertEqual(report['structured'],loaded['structured'])
        if 'diagnostics' in report:
            self.assertIn('diagnostics',loaded,'normalize_report must not discard structured checks')
            self.assertEqual(report['diagnostics']['checks'],loaded['diagnostics']['checks'])
        return loaded

    def import_text(self,text,name='synthetic.log'):
        path=Path(self.temp.name)/name
        if name.endswith('.gz'):path.write_bytes(gzip.compress(text.encode()))
        else:path.write_bytes(text.encode())
        reports=parser.analyze(path)
        self.assertEqual(1,len(reports))
        return self.readback(reports[0])

    def test_current_and_legacy_dcgm_statuses_and_exact_json_lines(self):
        for legacy in (False,True):
            with self.subTest(legacy=legacy):
                raw=dcgm(legacy=legacy)
                text='\n \n'+json.dumps(raw,ensure_ascii=False,indent=2)
                loaded=self.import_text(text,'synthetic-dcgm.json')
                rows=loaded['structured']['dcgm']['results']
                self.assertTrue(loaded['recognized']);self.assertTrue(loaded['complete']);self.assertEqual([],loaded['gpus'])
                self.assertEqual(['pass','fail','warn','skip','not_run'],[row['status'] for row in rows])
                checks=[row for row in loaded['diagnostics']['checks'] if row.get('rule')=='dcgm']
                self.assertEqual(['ok','error','review','missing','missing'],[row['status'] for row in checks])
                self.assertEqual('3.3.9' if legacy else '4.6.0',loaded['structured']['dcgm']['runs'][0]['version'])
                for index,row in enumerate(rows):
                    evidence=row['evidence'];id_line=next(n for n,line in enumerate(text.splitlines(),1) if f'"gpu_id": {index},' in line)
                    self.assertEqual(id_line-1,evidence['line']);self.assertEqual('synthetic-dcgm.json',evidence['source'])
                    self.assertEqual(row['raw'],json.loads(evidence['text']))
                    self.assertEqual('}',text.splitlines()[evidence['endLine']-1].strip().rstrip(','))
                    self.assertTrue(evidence['jsonPointer'].endswith('/results/'+str(index)))
                    self.assertEqual({'value':index},row['raw']['future_field'])
                self.assertFalse(any('未识别到支持' in warning for warning in loaded['warnings']))

    def test_runtime_error_source_is_its_actual_json_value(self):
        for nested in (True, False):
            raw={'DCGM Diagnostic':{},'metadata':{'version':'4.6.0'}}
            target=raw['DCGM Diagnostic'] if nested else raw
            target['runtime_error']='Synthetic unavailable'
            target['future_error_code']=-51
            text=json.dumps(raw,indent=2)
            loaded=self.import_text(text,'synthetic-runtime.json')
            run=loaded['structured']['dcgm']['runs'][0]
            expected=next(n for n,line in enumerate(text.splitlines(),1) if '"runtime_error"' in line)
            self.assertEqual(expected,run['runtimeEvidence']['line'])
            self.assertEqual('/DCGM Diagnostic/runtime_error' if nested else '/runtime_error',run['runtimeEvidence']['jsonPointer'])
            self.assertEqual('',run['rawPointer'])
            check=next(row for row in loaded['diagnostics']['checks'] if row.get('rule')=='dcgm')
            self.assertEqual(expected,check['evidence'][0]['line'])
            self.assertEqual(raw,loaded['structured']['rawDocument'])

    def test_structured_clock_domains_survive_saved_report_read(self):
        loaded=self.import_text('[13] nvidia-nvswitch2: SXid (PCI:0000:c1:00.0): 119, Non-fatal, synthetic issue')
        self.assertEqual({'kind':'uptime_seconds','raw':'13'},loaded['events'][0]['timeInfo'])
        loaded=self.import_text(json.dumps(goe_document()),'synthetic-goe-clock.json')
        event=loaded['events'][0]
        self.assertEqual('calendar',event['timeInfo']['kind'])
        self.assertEqual('1793318400123456',event['timeInfo']['epochMicroseconds'])
        self.assertEqual(event['time'],event['timeInfo']['raw'])

    def test_missing_unknown_and_invalid_results_never_become_pass(self):
        raw=dcgm(('Unspecified','Pass'))
        tests=raw['DCGM Diagnostic']['test_categories'][0]['tests']
        tests[0]['results'][1].pop('status');tests.append({'name':'absent-results'})
        loaded=self.import_text(json.dumps(raw),'missing-dcgm.json')
        self.assertEqual(['unknown','not_recorded'],[row['status'] for row in loaded['structured']['dcgm']['results']])
        checks=[row for row in loaded['diagnostics']['checks'] if row.get('rule')=='dcgm']
        self.assertEqual(['missing']*3,[row['status'] for row in checks])
        malformed=self.import_text('{"DCGM Diagnostic": {"test_categories": "Pass"}}','invalid-dcgm.json')
        self.assertFalse(malformed['complete']);self.assertFalse(any(row.get('rule')=='dcgm' and row['status']=='ok' for row in malformed['diagnostics']['checks']))

    def test_runtime_error_remains_review_and_keeps_raw_document(self):
        raw={'DCGM Diagnostic':{'runtime_error':'synthetic interrupted run'},'metadata':{'version':'4.6.0'},'future':{'value':42}}
        loaded=self.import_text(json.dumps(raw),'runtime-dcgm.json')
        self.assertEqual(raw,loaded['structured']['rawDocument'])
        checks=[row for row in loaded['diagnostics']['checks'] if row.get('rule')=='dcgm']
        self.assertEqual(['review'],[row['status'] for row in checks])
        self.assertIn('运行未完成',checks[0]['title'])

    def test_generic_json_including_embedded_log_strings_is_not_diagnosed(self):
        for raw in ({'status':'Pass','message':XID,'action':'GPU reset executed: GPU-DEMO-001, success: true'},
                    [XID,{'status':'Pass'}],XID,{'events':[goe()]},{'DCGM Diagnostic':'Pass'}):
            with self.subTest(raw=str(raw)[:60]):
                loaded=self.import_text(json.dumps(raw),'unrelated.json')
                self.assertEqual([],loaded['events']);self.assertEqual([],loaded['gpus']);self.assertEqual([],loaded['lifecycleEvents'])
                self.assertFalse(any(row.get('rule')=='dcgm' and row['status']=='ok' for row in loaded['diagnostics']['checks']))
                if 'DCGM Diagnostic' not in raw:self.assertFalse(loaded['recognized'])

    def test_dcgm_warning_text_is_not_a_second_kernel_event(self):
        raw=dcgm(('Fail',));raw['DCGM Diagnostic']['test_categories'][0]['tests'][0]['results'][0]['warnings']=[{'warning':XID}]
        loaded=self.import_text(json.dumps(raw,indent=2),'warning-dcgm.json')
        self.assertEqual([],loaded['events']);self.assertEqual([],loaded['gpus'])
        self.assertEqual(XID,loaded['structured']['dcgm']['results'][0]['warnings'][0]['warning'])

    def test_malformed_duplicate_and_nonfinite_json_stay_incomplete(self):
        for text in ('{"DCGM Diagnostic":', '{"DCGM Diagnostic":{},"DCGM Diagnostic":{}}',
                     '{"DCGM Diagnostic":{},"number":NaN}', '{"DCGM Diagnostic":{},"number":1e9999}',
                     '{"nested":'+'['*65+'0'+']'*65+'}'):
            with self.subTest(text=text[:60]):
                loaded=self.import_text(text,'malformed.json');self.assertFalse(loaded['complete']);self.assertFalse(loaded['recognized'])
                self.assertTrue(loaded['structured']['warnings'])

    def test_sxid_is_separate_from_same_number_xid_and_continuations_keep_lines(self):
        text=IDENTITY+'-- Boot demo-a --\n'+XID+'\n'+SXID+'\n'+SXID.replace('Non-fatal, Link 3 synthetic issue','Severity 0 Engine instance 3')+'\n'+SXID.replace('Non-fatal, Link 3 synthetic issue','Data {0x0, 0x1}')+'\n'
        loaded=self.import_text(text)
        self.assertEqual(['xid','sxid'],[row['kind'] for row in loaded['events']]);self.assertEqual(1,len(loaded['gpus']))
        xid,sxid=loaded['events'];self.assertEqual('119',xid['code']);self.assertEqual('119',sxid['code'])
        self.assertEqual(0,xid['gpu']);self.assertIsNone(sxid['gpu']);self.assertIsNone(sxid['manual'])
        self.assertEqual('0000:c1:00.0',sxid['address']);self.assertEqual('non-fatal',sxid['structured']['severity'])
        self.assertEqual(5,sxid['line']);self.assertEqual([5,6,7],[row['line'] for row in sxid['structured']['representations']])
        self.assertEqual('-- Boot demo-a --',sxid['boot']);self.assertEqual(1,sxid['occurrenceCount'])

    def test_sxid_boot_boundary_and_repeated_headers_do_not_deduplicate(self):
        text=SXID+'\n'+SXID+'\n-- Boot demo-next --\n'+SXID.replace('Non-fatal, Link 3 synthetic issue','Data {0x1}')
        loaded=self.import_text(text,'switch.log')
        self.assertEqual([],loaded['gpus']);self.assertEqual([1,2,4],[row['line'] for row in loaded['events']])
        self.assertEqual('unknown',loaded['events'][-1]['structured']['severity'])

    def test_goe_text_legacy_code_is_a_hint_and_does_not_merge_xid(self):
        text=IDENTITY+XID+'\n*** nvidia-smi event-log\n'+GOE_BODY+'\n'
        loaded=self.import_text(text)
        self.assertEqual(['xid','goe'],[row['kind'] for row in loaded['events']])
        goe_row=loaded['events'][1];self.assertEqual(5,goe_row['line']);self.assertEqual(0,goe_row['gpu'])
        self.assertEqual('host-cper',goe_row['structured']['severityDomain']);self.assertEqual(119,goe_row['structured']['legacyXid'])
        self.assertEqual(1,goe_row['occurrenceCount']);self.assertNotIn('relatedEventId',goe_row)
        self.assertEqual([{'kind':'legacy-xid-hint','code':'119','merged':False,'reason':'no-verified-same-source-reference'}],goe_row['relations'])
        self.assertEqual('9007199254740993',goe_row['structured']['traceId'])
        self.assertEqual('synthetic extension',goe_row['structured']['rawFields']['Future Field'])
        self.assertTrue(loaded['structured']['experimental'])

    def test_goe_json_full_identity_deduplicates_representations_with_exact_lines(self):
        # This is the explicit XidLens interchange schema, not NVIDIA JSON.
        text=json.dumps(goe_document([goe(),goe()]),indent=2)
        loaded=self.import_text(text,'goe-exchange.json')
        self.assertEqual(1,len(loaded['events']));row=loaded['events'][0]
        self.assertEqual(1,row['occurrenceCount']);self.assertEqual(2,row['representationCount']);self.assertIsNone(row['gpu'])
        lines=[n-1 for n,line in enumerate(text.splitlines(),1) if '"moduleSignature"' in line]
        self.assertEqual(lines,[ref['line'] for ref in row['structured']['representations']])
        self.assertEqual('within-source-complete-goe-identity',loaded['structured']['deduplicationScope'])
        self.assertEqual('1793318400123456',row['structured']['timestamp']['epochMicroseconds'])

    def test_goe_text_full_identity_deduplicates_only_identical_payloads(self):
        for second,expected in ((GOE_BODY,1),(GOE_BODY.replace('Instance ID : 8','Instance ID : 9'),2),
                                (GOE_BODY.replace('Severity : Recoverable','Severity : Fatal'),2)):
            loaded=self.import_text('nvidia-smi event-log\nEvent 1\n'+GOE_BODY+'\nEvent 2\n'+second)
            self.assertEqual(expected,len(loaded['events']))
            if expected==1:self.assertEqual(2,loaded['events'][0]['representationCount'])
            if 'Severity : Fatal' in second:self.assertTrue(loaded['events'][0]['structured']['identityConflict'])
        incomplete=GOE_BODY.replace('Instance ID : 8\n','')
        loaded=self.import_text('nvidia-smi event-log\nEvent 1\n'+incomplete+'\nEvent 2\n'+incomplete)
        self.assertEqual(2,len(loaded['events']))

    def test_goe_blocks_do_not_contaminate_device_inventory_or_parse_opaque_payload(self):
        text=IDENTITY+'nvidia-smi event-log\n'+GOE_BODY.replace(GPU,'GPU-DEMO-OTHER')+'\nPayload : '+XID+'\n*** /proc/driver/nvidia/gpus/0000:41:00.0/information\nModel: Demo GPU\n'
        loaded=self.import_text(text)
        self.assertEqual(GPU,loaded['gpus'][0]['uuid']);self.assertEqual('Demo GPU',loaded['gpus'][0]['model'])
        self.assertEqual(['goe'],[row['kind'] for row in loaded['events']]);self.assertIsNone(loaded['events'][0]['gpu'])
        self.assertIn(XID,loaded['events'][0]['structured']['rawFields']['Payload'])

    def test_lifecycle_events_survive_mixed_structured_input(self):
        canonical='GPU-11111111-2222-3333-4444-555555555555'
        reset='[14.000] GPU reset executed: '+canonical+', success: true'
        driver='[15.000] NVRM: loading NVIDIA UNIX x86_64 Kernel Module  580.65.06  synthetic date'
        loaded=self.import_text(IDENTITY.replace(GPU,canonical)+XID+'\n'+SXID+'\n'+reset+'\n'+driver+'\n')
        self.assertEqual(['reset','driver_load'],[row['kind'] for row in loaded['lifecycleEvents']])
        self.assertEqual([5,6],[row['line'] for row in loaded['lifecycleEvents']]);self.assertEqual('completed',loaded['lifecycleEvents'][0]['outcome'])

    def test_plain_log_never_builds_json_document_or_buffers_body(self):
        text='\n'*10000+'ordinary synthetic text\n'*10000+XID+'\n'
        instance=parser.Parser('ordinary.log')
        with patch.object(se,'JsonDocument',side_effect=AssertionError('ordinary text entered JSON decoder')):
            with patch.object(instance.structured,'consume',wraps=instance.structured.consume) as consume:
                result=parser.convert(instance.parse(io.BytesIO(text.encode())))
                self.assertEqual(1,consume.call_count,'Only the first nonblank plain-text line probes JSON mode')
        self.assertEqual([],instance.structured.json_lines);self.assertEqual(0,instance.structured.json_bytes)
        self.assertEqual(20001,result['events'][0]['line']);self.assertNotIn('structured',result)

    def test_leading_blank_json_prefix_offsets_and_bounds(self):
        text='\n'*250+json.dumps(dcgm(('Pass',)),indent=2)
        loaded=self.import_text(text,'leading.json')
        expected=next(n for n,line in enumerate(text.splitlines(),1) if '"gpu_id"' in line)-1
        self.assertEqual(expected,loaded['structured']['dcgm']['results'][0]['evidence']['line'])
        instance=parser.Parser('limited.json');instance.structured.max_json_bytes=32
        result=parser.convert(instance.parse(io.BytesIO((' '*40+'\n{}').encode())))
        self.assertFalse(result['complete']);self.assertFalse(result['recognized']);self.assertEqual([],instance.structured.json_lines)

    def test_archive_members_remain_independent_and_gzip_is_supported(self):
        path=Path(self.temp.name)/'synthetic-bundle.zip';dcgm_text=json.dumps(dcgm(('Pass',)),indent=2)
        with zipfile.ZipFile(path,'w') as archive:
            archive.writestr('results/dcgm.json',dcgm_text);archive.writestr('events/switch.log',SXID)
            archive.writestr('events/goe.json',json.dumps(goe_document()))
        reports=[self.readback(row) for row in parser.analyze(path)]
        self.assertEqual(['results/dcgm.json','events/switch.log','events/goe.json'],[row['sourceMember']['name'] for row in reports])
        self.assertEqual('synthetic-bundle.zip!events/switch.log',reports[1]['events'][0]['source'])
        self.assertEqual(1,reports[1]['events'][0]['line']);self.assertEqual([],reports[2]['gpus'])
        zipped=self.import_text(dcgm_text,'synthetic-dcgm.json.gz');self.assertTrue(zipped['recognized']);self.assertEqual('pass',zipped['structured']['dcgm']['results'][0]['status'])


if __name__=='__main__':unittest.main()
