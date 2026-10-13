import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from test_parser import parser, SAMPLE
import io


class ReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        spec=importlib.util.spec_from_file_location('report_test_server',Path(__file__).resolve().parents[1]/'app/server.py')
        cls.s=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'GPU_LOG_DATA_DIR':cls.temp.name}):spec.loader.exec_module(cls.s)
        cls.service=cls.s.LocalService(0);cls.service.start()
        cls.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.service.close();cls.temp.cleanup()

    def setUp(self):
        for p in self.s.RESULTS.glob('*.json'):p.unlink()
        self.s.CASE_CACHE.clear()

    def report(self,key='a'*32):
        d=parser.convert(parser.Parser('sample.log').parse(io.BytesIO(SAMPLE.encode())))
        d['id']=key;d['server']['time']='2026-10-13 10:00:00'
        path=self.s.RESULTS/(key+'.json');path.write_text(json.dumps(d),encoding='utf-8')
        return path,d

    def request(self,path,body=None,headers=None):
        req=urllib.request.Request(self.service.url+path,data=json.dumps(body).encode() if body is not None else None,
                                   headers=headers if headers is not None else {'X-Local-Token':self.s.TOKEN})
        with self.opener.open(req,timeout=5) as response:return json.load(response)

    def test_summary_matches_report_without_transferring_events(self):
        path,d=self.report();row=self.request('api/cases')['cases'][0]
        self.assertEqual(row['server']['sn'],d['server']['sn'])
        self.assertEqual(row['identities'][0]['sn'],d['gpus'][0]['sn'])
        self.assertEqual(row['identities'][0]['uuid'],d['gpus'][0]['uuid'])
        self.assertEqual((row['gpus'],row['events'],row['bytes']),(len(d['gpus']),len(d['events']),d['bytes']))
        self.assertNotIn('raw',json.dumps(row))
        with patch.object(Path,'read_text',side_effect=AssertionError('cache should avoid rereading')):
            self.assertEqual(self.s.case_list()[0],row)
        d['server']['sn']='CHANGED-SERVER';path.write_text(json.dumps(d),encoding='utf-8')
        self.assertEqual(self.s.case_list()[0]['server']['sn'],'CHANGED-SERVER')

    def test_delete_selected_keeps_source_and_unselected_report(self):
        first,_=self.report();second,_=self.report('b'*32)
        source=Path(self.temp.name)/'source.log';source.write_text(SAMPLE,encoding='utf-8')
        result=self.request('api/cases/delete',{'ids':['a'*32,'a'*32]})
        self.assertEqual(result,{'deleted':['a'*32],'failed':[]})
        self.assertFalse(first.exists());self.assertTrue(second.exists());self.assertEqual(source.read_text(encoding='utf-8'),SAMPLE)
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('api/case/'+'a'*32)
        self.assertEqual(error.exception.code,404)
        self.assertEqual([r['id'] for r in self.request('api/cases')['cases']],['b'*32])
        self.assertEqual(self.request('api/cases/delete',{'ids':['a'*32]})['failed'],[])

    def test_invalid_batch_does_not_delete_valid_ids(self):
        path,_=self.report()
        for ids in (['a'*32,'../source'],['a'*32,4],[],['a'*32]*1001,None):
            with self.assertRaises(urllib.error.HTTPError) as error:self.request('api/cases/delete',{'ids':ids})
            self.assertEqual(error.exception.code,400);self.assertTrue(path.exists())

    def test_delete_requires_token_and_same_origin(self):
        path,_=self.report()
        for headers in ({},{'X-Local-Token':self.s.TOKEN,'Origin':'https://example.com'}):
            with self.assertRaises(urllib.error.HTTPError) as error:self.request('api/cases/delete',{'ids':['a'*32]},headers)
            self.assertEqual(error.exception.code,403);self.assertTrue(path.exists())

    def test_partial_failure_is_explicit_and_remains_listed(self):
        first,_=self.report();second,_=self.report('b'*32);unlink=Path.unlink
        def guarded(p,*args,**kwargs):
            if p==second:raise PermissionError('busy')
            return unlink(p,*args,**kwargs)
        with patch.object(Path,'unlink',guarded):result=self.request('api/cases/delete',{'ids':['a'*32,'b'*32]})
        self.assertEqual(result,{'deleted':['a'*32],'failed':['b'*32]})
        self.assertFalse(first.exists());self.assertTrue(second.exists())
        self.assertEqual([r['id'] for r in self.request('api/cases')['cases']],['b'*32])

    def test_legacy_missing_metadata_and_corrupt_report(self):
        path,d=self.report();d.pop('bytes');d.pop('server');d['gpus'][0].pop('sn');path.write_text(json.dumps(d),encoding='utf-8')
        (self.s.RESULTS/('b'*32+'.json')).write_text('{broken',encoding='utf-8')
        rows=self.request('api/cases')['cases'];self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['server']['sn'],'');self.assertEqual(rows[0]['identities'][0]['sn'],'');self.assertIsNone(rows[0]['bytes'])

    def test_cache_cleared_after_delete_and_reimport(self):
        self.report();self.s.case_list();self.request('api/cases/delete',{'ids':['a'*32]})
        self.assertNotIn('a'*32,self.s.CASE_CACHE)
        path,d=self.report();d['server']['sn']='REIMPORTED';path.write_text(json.dumps(d),encoding='utf-8')
        self.assertEqual(self.request('api/cases')['cases'][0]['server']['sn'],'REIMPORTED')
