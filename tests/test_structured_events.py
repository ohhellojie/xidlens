"""Synthetic, offline fixtures for release-specific structured formats."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import structured_events as se


def dcgm(statuses=('Pass', 'Fail', 'Warn', 'Skip', 'Not Run'), legacy=False):
    root_name = 'DCGM GPU Diagnostic' if legacy else 'DCGM Diagnostic'
    body = {'test_categories': [{'category': 'Hardware', 'tests': [{
        'name': 'memory', 'results': [
            {'gpu_id': i, 'status': status, 'warnings': [{'warning': 'synthetic detail',
              'error_id': 1, 'error_category': 2, 'error_severity': 3}], 'future_field': {'value': i}}
            for i, status in enumerate(statuses)]}]}]}
    if legacy:
        return {root_name: body, 'version': '3.3.9', 'Driver Version Detected': '550.0'}
    return {root_name: body, 'metadata': {'version': '4.6.0', 'Driver Version Detected': '620.0'},
            'entity_groups': [{'entity_group': 'GPU', 'entity_group_id': 1,
                               'entities': [{'entity_id': 0, 'serial_num': 'DEMO-GPU-001'}]}]}


def goe(**changes):
    event = {'moduleSignature': 'GPU-GSP', 'category': 1, 'moduleEventCode': 1,
             'severity': 30, 'scope': 1, 'logLevel': 50, 'originator': '1',
             'deviceUUID': 'GPU-DEMO-001', 'instanceId': '8',
             'timestamp': '1793318400123456', 'traceId': '9007199254740993',
             'groupCursor': '9007199254740994', 'groupPosition': 0, 'legacyXid': 119,
             'contexts': [{'type': 32769, 'message': 'synthetic timeout'}],
             'futureContext': {'unrecognized': True}}
    event.update(changes)
    return event


def goe_document(events=None):
    return {'format': 'xidlens-goe', 'formatVersion': 1, 'driverVersion': '620.0',
            'events': [goe()] if events is None else events}


def collect(text, **kwargs):
    collector = se.Collector('synthetic.log', **kwargs)
    for n, line in enumerate(text.splitlines(), 1):
        collector.consume(line, n)
    return collector.finish()


def report():
    return {'source': 'synthetic.log', 'complete': True, 'recognized': False,
            'warnings': ['未识别到支持的 GPU 日志结构或错误记录。'],
            'gpus': [{'id': 0, 'pci': '0000:41:00.0', 'uuid': 'GPU-DEMO-001', 'errors': 0}],
            'events': [], 'diagnostics': {'checks': []}}


class DcgmTests(unittest.TestCase):
    def test_current_and_legacy_statuses_remain_distinct(self):
        for legacy in (False, True):
            result = se.parse_dcgm_json(json.dumps(dcgm(legacy=legacy)), 'synthetic.json')
            self.assertEqual([r['status'] for r in result['dcgm']['results']],
                             ['pass', 'fail', 'warn', 'skip', 'not_run'])
            self.assertEqual(result['dcgm']['runs'][0]['version'], '3.3.9' if legacy else '4.6.0')
            self.assertTrue(result['complete'])
            self.assertEqual(result['warnings'], [], 'Valid versioned output has no generic read warning')

    def test_unknown_fields_and_error_metadata_are_preserved(self):
        original = dcgm()
        original['unknown-root'] = {'some': 'value'}
        result = se.parse_dcgm_json(json.dumps(original))
        self.assertEqual(result['rawDocument'], original)
        row = result['dcgm']['results'][0]
        self.assertEqual(row['raw']['future_field'], {'value': 0})
        self.assertEqual(row['warnings'][0]['error_severity'], 3)

    def test_missing_and_unknown_outcomes_are_not_pass(self):
        data = dcgm(('unexpected',))
        tests = data['DCGM Diagnostic']['test_categories'][0]['tests']
        tests.extend([{'name': 'pcie'}, {'name': 'diagnostic', 'results': [{'gpu_id': 1}]}])
        parsed = se.parse_dcgm_json(json.dumps(data))
        self.assertEqual([r['status'] for r in parsed['dcgm']['results']], ['unknown', 'not_recorded'])
        self.assertEqual(parsed['dcgm']['summaries'][0]['status'], 'not_recorded')

    def test_summary_does_not_double_count_entity_results(self):
        data = dcgm(('Fail',))
        data['DCGM Diagnostic']['test_categories'][0]['tests'][0]['test_summary'] = {'status': 'Fail'}
        parsed = se.parse_dcgm_json(json.dumps(data))
        merged = se.merge_into_report(report(), parsed)
        self.assertEqual(len(parsed['dcgm']['summaries']), 1)
        self.assertEqual(len(merged['diagnostics']['checks']), 1)

    def test_global_summary_with_no_entity_remains_visible(self):
        data = dcgm(())
        data['DCGM Diagnostic']['test_categories'][0]['tests'][0]['test_summary'] = {
            'status': 'Fail', 'warnings': [{'warning': 'could not start synthetic test'}]}
        parsed = se.parse_dcgm_json(json.dumps(data))
        merged = se.merge_into_report(report(), parsed)
        self.assertEqual(merged['diagnostics']['checks'][0]['status'], 'error')
        self.assertEqual(merged['diagnostics']['checks'][0]['address'], '')

    def test_new_entity_fields_remain_report_local(self):
        data = dcgm(())
        data['DCGM Diagnostic']['test_categories'][0]['tests'][0]['results'] = [
            {'entity_group': 'GPU', 'entity_group_id': 1, 'entity_id': 0, 'status': 'Pass'},
            {'entity_group': 'CPU', 'entity_group_id': 7, 'entity_id': 0, 'status': 'Skip'}]
        merged = se.merge_into_report(report(), se.parse_dcgm_json(json.dumps(data)))
        self.assertEqual(len(merged['gpus']), 1)
        self.assertTrue(all(c['address'] == '' for c in merged['diagnostics']['checks']))
        self.assertIn('CPU 0', merged['diagnostics']['checks'][1]['observation'])

    def test_iterations_are_not_collapsed(self):
        data = {'iterations': [dcgm(('Pass',)), dcgm(('Fail',))], 'Overall Result': 'Fail'}
        parsed = se.parse_dcgm_json(json.dumps(data))
        self.assertEqual([r['run'] for r in parsed['dcgm']['results']], [1, 2])
        self.assertEqual(parsed['dcgm']['overallResult'], 'Fail')

    def test_empty_and_runtime_error_output_are_recognized(self):
        data = {'DCGM Diagnostic': {'runtime_error': 'synthetic unavailable executable', 'error_code': -51}}
        parsed = se.parse_dcgm_json(json.dumps(data))
        self.assertTrue(parsed['recognized'])
        self.assertEqual(parsed['dcgm']['results'], [])
        self.assertTrue(parsed['dcgm']['runs'][0]['runtimeError'])
        merged = se.merge_into_report(report(), parsed)
        self.assertEqual(merged['diagnostics']['checks'][0]['status'], 'review')
        self.assertEqual(merged['diagnostics']['checks'][0]['title'], 'DCGM 运行未完成')

    def test_results_limit_marks_partial_and_retains_original(self):
        parsed = se.parse_dcgm_json(json.dumps(dcgm()), max_records=2)
        self.assertEqual(len(parsed['dcgm']['results']), 2)
        self.assertFalse(parsed['complete'])
        self.assertEqual(len(parsed['rawDocument']['DCGM Diagnostic']['test_categories'][0]['tests'][0]['results']), 5)

    def test_wrong_container_types_are_not_success(self):
        data = dcgm()
        data['DCGM Diagnostic']['test_categories'][0]['tests'][0]['results'] = {'status': 'Pass'}
        parsed = se.parse_dcgm_json(json.dumps(data))
        self.assertFalse(parsed['complete'])
        self.assertEqual(parsed['dcgm']['results'], [])


class InputBoundsTests(unittest.TestCase):
    def test_duplicate_keys_rejected(self):
        with self.assertRaisesRegex(se.StructuredInputError, '重复'):
            se.parse_dcgm_json('{"DCGM Diagnostic":{},"DCGM Diagnostic":{"version":"4"}}')

    def test_nonfinite_values_rejected(self):
        for value in ('NaN', 'Infinity', '-Infinity', '1e9999'):
            with self.subTest(value=value), self.assertRaises(se.StructuredInputError):
                se.parse_dcgm_json('{"a":' + value + '}')

    def test_truncated_json_and_wrong_scalar_do_not_crash_collector(self):
        result = collect('{"DCGM Diagnostic":')
        self.assertFalse(result['complete'])
        self.assertFalse(result['recognized'])
        self.assertIsNone(se.parse_dcgm_json('[]'))
        self.assertIsNone(se.parse_dcgm_json('null'))

    def test_bytes_and_depth_bounds(self):
        with self.assertRaises(se.StructuredInputError):
            se.parse_dcgm_json('{"a":"中文"}', max_bytes=8)
        with self.assertRaises(se.StructuredInputError):
            se.parse_dcgm_json('[' * 65 + '0' + ']' * 65)
        self.assertFalse(collect(json.dumps(dcgm()), max_json_bytes=32)['complete'])

    def test_pointer_offsets_distinguish_identical_values(self):
        text = json.dumps(dcgm(('Fail', 'Fail')), indent=2)
        parsed = se.parse_dcgm_json(text, 'synthetic.json')
        evidence = [r['evidence'] for r in parsed['dcgm']['results']]
        self.assertNotEqual(evidence[0]['line'], evidence[1]['line'])
        for e in evidence:
            self.assertTrue(text.splitlines()[e['line'] - 1].strip().startswith('{'))
            self.assertEqual(json.loads(e['text'])['status'], 'Fail')
            self.assertIn('/results/', e['jsonPointer'])

    def test_leading_blank_lines_preserved(self):
        text = '\n\n' + json.dumps(dcgm(('Pass',)), indent=2)
        result = collect(text)
        e = result['dcgm']['results'][0]['evidence']
        self.assertEqual(text.splitlines()[e['line'] - 1].strip(), '{')

    def test_strings_are_data_and_no_code_is_executed(self):
        data = dcgm(('<script>alert(1)</script>',))
        data['__proto__'] = {'polluted': True}
        result = se.parse_dcgm_json(json.dumps(data))
        self.assertEqual(result['dcgm']['results'][0]['status'], 'unknown')
        self.assertEqual(result['rawDocument']['__proto__'], {'polluted': True})

    def test_finished_collector_is_idempotent_and_not_reusable(self):
        collector = se.Collector('synthetic.log')
        collector.consume('some ordinary data', 1)
        first = collector.finish()
        self.assertIs(first, collector.finish())
        with self.assertRaises(ValueError):
            collector.consume('more', 2)


class SxidTests(unittest.TestCase):
    HEADER = '[ 10.500] nvidia-nvswitch3: SXid (PCI:0000:c1:00.0): 28006, Non-fatal, Link 46 synthetic issue'

    def test_switch_namespace_does_not_create_gpu(self):
        bundle = collect(self.HEADER)
        self.assertEqual(bundle['events'][0]['kind'], 'sxid')
        merged = se.merge_into_report(report(), bundle)
        row = merged['events'][0]
        self.assertIsNone(row['gpu'])
        self.assertEqual(row['address'], '0000:c1:00.0')
        self.assertEqual(row['structured']['link'], 46)
        self.assertEqual(row['structured']['severity'], 'non-fatal')

    def test_multiline_details_are_one_event_with_all_evidence(self):
        text = '\n'.join([self.HEADER,
            '[ 10.501] nvidia-nvswitch3: SXid (PCI:0000:c1:00.0): 28006, Severity 0 Engine instance 46',
            '[ 10.502] nvidia-nvswitch3: SXid (PCI:0000:c1:00.0): 28006, Data {0x0, 0x1}'])
        bundle = collect(text)
        self.assertEqual(len(bundle['events']), 1)
        self.assertEqual([e['line'] for e in bundle['events'][0]['representations']], [1, 2, 3])

    def test_same_code_repeated_header_is_a_new_occurrence(self):
        self.assertEqual(len(collect(self.HEADER + '\n' + self.HEADER)['events']), 2)

    def test_different_device_or_boot_does_not_merge(self):
        collector = se.Collector('synthetic.log')
        collector.consume(self.HEADER, 1, boot='A')
        collector.consume('[ 10.5] nvidia-nvswitch3: SXid (PCI:0000:c1:00.0): 28006, Data {0}', 2, boot='B')
        self.assertEqual(len(collector.finish()['events']), 2)

    def test_orphan_detail_unknown_and_integer_uptime_is_not_json(self):
        data = collect('[ 12] nvidia-nvswitch0: SXid (PCI:0000:42:00.0): 22003, Data {0}')
        self.assertEqual(data['events'][0]['severity'], 'unknown')
        self.assertTrue(data['events'][0]['continuation'])

    def test_gpu_xid_is_not_switch_xid(self):
        self.assertIsNone(se.parse_sxid_line('[ 1.0] NVRM: Xid (PCI:0000:41:00): 79, synthetic'))
        self.assertEqual(collect(self.HEADER.replace('Non-fatal', 'Fatal'))['events'][0]['severity'], 'fatal')

    def test_record_limit_marks_incomplete(self):
        data = collect('\n'.join([self.HEADER] * 3), max_records=2)
        self.assertEqual(len(data['events']), 2)
        self.assertFalse(data['complete'])


class GoeTests(unittest.TestCase):
    def test_explicit_interchange_version_and_full_identity(self):
        result = se.parse_goe_json(json.dumps(goe_document()), 'synthetic.json')
        event = result['events'][0]
        self.assertEqual(event['code'], 'GPU-GSP/0x0001/0x0001')
        self.assertEqual(event['traceId'], '9007199254740993')
        self.assertEqual(event['timestamp']['epochMicroseconds'], '1793318400123456')
        self.assertEqual(event['rawFields']['futureContext'], {'unrecognized': True})
        self.assertTrue(result['experimental'])
        data = goe_document()
        data['formatVersion'] = 2
        with self.assertRaises(se.StructuredInputError):
            se.parse_goe_json(json.dumps(data))

    def test_unmarked_nvidia_looking_json_is_not_guessed(self):
        self.assertIsNone(se.parse_goe_json(json.dumps({'events': [goe()]})))

    def test_same_occurrence_duplicate_representations_count_once(self):
        result = se.parse_goe_json(json.dumps(goe_document([goe(), goe()])))
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(len(result['events'][0]['representations']), 2)
        self.assertEqual(result['events'][0]['occurrences'], 1)

    def test_same_trace_and_code_different_instance_remain_distinct(self):
        result = se.parse_goe_json(json.dumps(goe_document([goe(), goe(instanceId='9')])))
        self.assertEqual(len(result['events']), 2)

    def test_missing_identity_and_conflicting_payloads_are_not_deduplicated(self):
        for a, b in ((goe(instanceId=''), goe(instanceId='')), (goe(), goe(severity=40))):
            result = se.parse_goe_json(json.dumps(goe_document([a, b])))
            self.assertEqual(len(result['events']), 2)
        self.assertTrue(result['events'][0]['identityConflict'])

    def test_invalid_event_keeps_original_and_marks_partial(self):
        data = goe_document([goe(category=65536), goe(moduleSignature='<script>')])
        result = se.parse_goe_json(json.dumps(data))
        self.assertEqual(result['events'], [])
        self.assertEqual(result['rawDocument'], data)
        self.assertFalse(result['complete'])

    def test_only_unique_uuid_matches_existing_gpu(self):
        bundle = se.parse_goe_json(json.dumps(goe_document()))
        unique = se.merge_into_report(report(), bundle)
        self.assertEqual(unique['events'][0]['gpu'], 0)
        conflicting = report()
        conflicting['gpus'].append({'id': 1, 'pci': '0000:81:00.0', 'uuid': 'GPU-DEMO-001'})
        se.merge_into_report(conflicting, bundle)
        self.assertIsNone(conflicting['events'][0]['gpu'])

    def test_legacy_xid_code_is_only_a_hint(self):
        base = report()
        base['events'] = [{'id': 'e0', 'kind': 'xid', 'code': '119', 'gpu': 0,
                           'line': 3, 'source': 'synthetic.log'}]
        merged = se.merge_into_report(base, se.parse_goe_json(json.dumps(goe_document()), 'synthetic.log'))
        self.assertEqual(merged['events'][1]['occurrenceCount'], 1)
        self.assertNotIn('relatedEventId', merged['events'][1])

    def test_unverified_legacy_reference_cannot_suppress_an_event(self):
        base = report()
        base['events'] = [{'id': 'e0', 'kind': 'xid', 'code': '119', 'gpu': 0,
                           'line': 3, 'source': 'synthetic.log'}]
        data = goe_document([goe(legacyReference={'source': 'synthetic.log', 'line': 3})])
        merged = se.merge_into_report(base, se.parse_goe_json(json.dumps(data), 'synthetic.log'))
        self.assertEqual(merged['events'][1]['occurrenceCount'], 1)
        self.assertNotIn('relatedEventId', merged['events'][1])
        self.assertEqual(merged['events'][1]['structured']['rawFields']['legacyReference'], data['events'][0]['legacyReference'])

    def test_field_based_text_requires_context_and_cper_scope_is_explicit(self):
        body = '''Device UUID : GPU-DEMO-001
Source Module : GPU-GSP
Category : Timeout (0x0001)
Module Event Code : Unknown (0x0001)
Severity : Recoverable
Scope : Device
Timestamp : 1793318400123456
Instance ID : 8
Originator : 1
Future Field : keep this
Legacy Xid : 119'''
        self.assertEqual(collect(body)['events'], [])
        result = collect('nvidia-smi event-log\n' + body)
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['events'][0]['severityDomain'], 'host-cper')
        self.assertEqual(result['events'][0]['rawFields']['Future Field'], 'keep this')
        self.assertEqual(result['events'][0]['evidence']['line'], 2)

    def test_device_field_after_identity_is_in_same_block(self):
        text = '''nvidia-smi event-log
Source Module : GPU-GSP
Category : 0x0001
Module Event Code : 0x0001
Device UUID : GPU-DEMO-001'''
        result = collect(text)
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['events'][0]['deviceUUID'], 'GPU-DEMO-001')

    def test_boundary_does_not_consume_later_smi_snapshot(self):
        text = '''nvidia-smi event-log
Source Module : GPU-GSP
Category : 0x0001
Module Event Code : 0x0001
nvidia-smi -q
GPU UUID : GPU-DEMO-OTHER
Product Name : synthetic'''
        result = collect(text)
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['events'][0]['deviceUUID'], '')


if __name__ == '__main__':
    unittest.main()
