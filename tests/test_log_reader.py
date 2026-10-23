import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from test_parser import parser, SAMPLE
from log_reader import LogStore, Outline


class LogReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.reports = {}
        self.store = LogStore(self.root/'cache', lambda key: self.reports[key], capacity=2)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def add(self, content=None, name='sample.log'):
        path = self.root/name
        path.write_bytes(content if content is not None else SAMPLE.encode())
        reports = parser.analyze(path)
        keys = []
        for report in reports:
            key = format(len(self.reports)+1,'032x')
            report['input'] = {'key':key,'name':name}
            self.reports[key] = (path,report,key)
            keys.append(key)
        return keys

    def ready(self, key):
        self.store.meta(key)
        self.store.jobs[key].future.result(timeout=10)
        meta = self.store.meta(key)
        self.assertEqual(meta['state'],'ready',meta)
        return meta

    def test_exact_lines_and_evidence_addresses(self):
        key = self.add()[0]
        meta = self.ready(key)
        expected = SAMPLE.splitlines()
        self.assertEqual(meta['lines'],len(expected))
        self.assertEqual(self.store.lines(key,key,1,256)['lines'],expected)
        for event in self.reports[key][1]['events']:
            self.assertEqual(self.store.lines(key,key,event['line'],1)['lines'],[event['raw']])

    def test_zip_members_with_same_name_and_nested_gzip(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf,'w') as z:
            z.writestr('same.log',SAMPLE)
            z.writestr('same.log',SAMPLE.replace('DEMO-GPU-001','SECOND'))
            z.writestr('../third.log.gz',gzip.compress(SAMPLE.replace('DEMO-GPU-001','THIRD').encode()))
        keys = self.add(buf.getvalue(),'archive!sample.zip')
        self.assertEqual(len(keys),3)
        for key, token in zip(keys,['DEMO-GPU-001','SECOND','THIRD']):
            self.ready(key)
            self.assertIn(token,'\n'.join(self.store.lines(key,key,1,256)['lines']))
        self.assertFalse((self.root.parent/'third.log').exists())

    def test_tar_and_gzip_keep_member_local_line_numbers(self):
        for kind in ('tar','tgz','gz'):
            with self.subTest(kind=kind):
                if kind=='gz': raw=gzip.compress(SAMPLE.encode())
                else:
                    buf=io.BytesIO()
                    with tarfile.open(fileobj=buf,mode='w:gz' if kind=='tgz' else 'w') as t:
                        for name,text in [('a.log',SAMPLE),('b.log.gz',gzip.compress(SAMPLE.encode()))]:
                            data=text.encode() if isinstance(text,str) else text
                            info=tarfile.TarInfo(name);info.size=len(data);t.addfile(info,io.BytesIO(data))
                    raw=buf.getvalue()
                keys=self.add(raw,'data.'+kind)
                for key in keys:
                    self.ready(key)
                    self.assertEqual(self.store.lines(key,key,1,256)['lines'],SAMPLE.splitlines())

    def test_decoding_bom_crlf_gb18030_blank_and_html(self):
        raw=b'\xef\xbb\xbf'+SAMPLE.encode()+b'\r\n\r\n'+('中文日志\r\n').encode('gb18030')+b'<img src=x onerror=alert(1)>\n'
        key=self.add(raw)[0];meta=self.ready(key)
        rows=self.store.lines(key,key,1,256)['lines']
        self.assertIn('中文日志',rows);self.assertIn('',rows)
        self.assertEqual(rows[-1],'<img src=x onerror=alert(1)>')
        self.assertTrue(any('GB18030' in w for w in meta['warnings']))

    def test_changed_copy_is_rejected(self):
        key=self.add()[0]
        self.reports[key][0].write_text(SAMPLE+'changed',encoding='utf-8')
        self.store.meta(key);self.store.jobs[key].future.result(timeout=10)
        self.assertEqual(self.store.meta(key)['state'],'error')
        self.assertIn('不一致',self.store.meta(key)['message'])

    def test_literal_search_navigation_and_no_matches(self):
        key=self.add((SAMPLE+'\nTest [a].*\nTEST [a].*\nlast\n').encode())[0];meta=self.ready(key)
        self.store.search(key,key,'[a].*');self.store.jobs[key].search['future'].result(timeout=10)
        result=self.store.search(key,key,'[a].*')
        self.assertEqual(result['count'],2)
        first=self.store.match(key,key,'[a].*',1,'next')
        second=self.store.match(key,key,'[a].*',first['line'],'next')
        self.assertEqual(second['line'],first['line']+1)
        self.assertEqual(self.store.match(key,key,'[a].*',second['line'],'next')['line'],first['line'])
        self.assertEqual(self.store.match(key,key,'[a].*',first['line'],'previous')['line'],second['line'])
        self.assertEqual(self.store.search(key,key,'[a].*',second['line'])['current'],2)
        self.store.search(key,key,'absent');self.store.jobs[key].search['future'].result(timeout=10)
        self.assertEqual(self.store.search(key,key,'absent')['count'],0)
        self.assertEqual(len(list((self.root/'cache').glob('*.matches'))),1)

    def test_large_log_uses_paged_lines_and_bounded_markers(self):
        text=SAMPLE+('kernel: heartbeat\n'*100000)
        key=self.add(text.encode())[0];meta=self.ready(key)
        self.assertGreater(meta['lines'],100000)
        self.assertLessEqual(len(self.store.lines(key,key,50000,256)['lines']),256)
        self.store.search(key,key,'heartbeat');self.store.jobs[key].search['future'].result(timeout=10)
        result=self.store.search(key,key,'heartbeat')
        self.assertEqual(result['count'],100000)
        self.assertLessEqual(len(result['markers']),1025)

    def test_limits_revision_and_cache_cleanup(self):
        key=self.add()[0];self.ready(key)
        for start,count in [(0,1),(1,257),(-1,1),(10**9,2)]:
            with self.assertRaises(ValueError):self.store.lines(key,key,start,count)
        with self.assertRaises(ValueError):self.store.lines(key,'stale',1,1)
        with self.assertRaises(ValueError):self.store.meta('../secret')
        with self.assertRaises(ValueError):self.store.search(key,key,'x'*513)
        self.store.drop(key)
        self.assertFalse(list((self.root/'cache').glob('*.text')))

    def test_oversized_line_reports_partial_read(self):
        # A partial legacy report has no complete-content checksum.
        key=self.add()[0];path,report,revision=self.reports[key]
        report['contentSha256']=None;path.write_bytes(SAMPLE.encode()+b'x'*300)
        with patch('log_reader.MAX_LINE',256):meta=self.ready(key)
        self.assertFalse(meta['complete']);self.assertTrue(meta['warnings'])

    def test_section_labels_ignore_separators_and_command_banners(self):
        outline=Outline()
        lines=['====','*** /sys/bus/pci/devices/0000:25:00.0/power/control','auto','*** /sys/bus/pci/devices/0000:25:00.0/power/runtime_status','active','/usr/bin/nvidia-smi --query','','==============NVSMI LOG==============','GPU 00000000:25:00.0','    Temperature','        GPU Current Temp : 40 C','/sbin/lspci -vv','25:00.0 3D controller: NVIDIA']
        for n,line in enumerate(lines,1):outline.consume(line,n)
        result=outline.finish(len(lines))
        self.assertEqual([n['title'] for n in result],['日志正文','PCIe 电源状态','nvidia-smi --query','lspci -vv'])
        self.assertTrue(all(1<=n['line']<=n['end']<=len(lines) for n in result))

    def test_position_survives_restart_and_same_content_reparse(self):
        key=self.add()[0];self.ready(key)
        view={'top':8,'selected':10,'offset':12.5,'left':80,'query':'GPU','wrap':True}
        self.store.save_position(key,key,view)
        self.store.close()
        self.store=LogStore(self.root/'cache',lambda k:self.reports[k])
        self.assertEqual(self.ready(key)['position'],view)
        path,report,_=self.reports[key];self.reports[key]=(path,report,'new-revision')
        self.assertEqual(self.ready(key)['position'],view)
        with self.assertRaises(ValueError):self.store.save_position(key,key,view)
        report['contentSha256']=None;report['source']='different'
        self.reports[key]=(path,report,'changed')
        self.assertEqual(self.ready(key)['position'],{})

    def test_position_rejects_invalid_payloads(self):
        key=self.add()[0];self.ready(key)
        for value in [[],{'top':True},{'top':0},{'selected':10**9},{'offset':float('nan')},{'offset':float('inf')},{'query':[]},{'query':'x'*513}]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):self.store.save_position(key,key,value)

    def test_cancel_and_evict_cleanup_only_cache(self):
        keys=[self.add(name=f'{n}.log')[0] for n in range(3)]
        for key in keys:self.ready(key)
        self.assertNotIn(keys[0],self.store.jobs)
        self.assertEqual(len(list((self.root/'cache').glob('*.text'))),2)
        self.store.close()
        self.assertFalse(list((self.root/'cache').iterdir()))
        self.assertTrue(all(self.reports[k][0].exists() for k in keys))


if __name__=='__main__':unittest.main()
