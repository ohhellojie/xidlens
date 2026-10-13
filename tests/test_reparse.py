import importlib.util, io, json, os, tempfile, time, unittest, urllib.request, urllib.error, zipfile
from pathlib import Path
from unittest.mock import patch
from test_parser import parser, SAMPLE

class ReparseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        spec=importlib.util.spec_from_file_location('reparse_test_server',Path(__file__).resolve().parents[1]/'app/server.py')
        cls.s=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'GPU_LOG_DATA_DIR':cls.temp.name}):spec.loader.exec_module(cls.s)
        cls.service=cls.s.LocalService(0);cls.service.start()
        cls.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    @classmethod
    def tearDownClass(cls):cls.service.close();cls.temp.cleanup()
    def setUp(self):
        for folder in (self.s.RESULTS,self.s.SOURCES):
            for p in folder.glob('*'):p.unlink()
        self.s.CASE_CACHE.clear()
    def request(self,path,body=None):
        req=urllib.request.Request(self.service.url+path,data=body,headers={'X-Local-Token':self.s.TOKEN})
        with self.opener.open(req,timeout=5) as response:return json.load(response)
    def wait(self,key):
        for _ in range(500):
            result=self.request('api/job/'+key)
            if result['state'] in ('done','error','cancelled'):
                future=self.s.JOBS[key].future
                if future:future.result(timeout=5)
                return result
            time.sleep(.01)
        self.fail('job timed out')
    def imported(self,name='sample.log',content=None):
        key=self.request('api/import?name='+name,SAMPLE.encode() if content is None else content)['job']
        result=self.wait(key);self.assertEqual(result['state'],'done',result)
        return result['ids']
    def path(self,key):return self.s.RESULTS/(key+'.json')
    def report(self,key):return json.loads(self.path(key).read_text(encoding='utf-8'))
    def upload_reparse(self,key,text):
        job=self.request('api/reparse/start?id='+key+'&file=1',b'')['job']
        self.request('api/import?name=renamed.log&job='+job,text)
        return self.wait(job)
    def test_cached_reparse_keeps_id_and_restores_fields(self):
        key=self.imported()[0];d=self.report(key);ref=d['input'];d['gpus'][0]['sn']='OLD-PARSER';self.path(key).write_text(json.dumps(d),encoding='utf-8')
        result=self.request('api/reparse/start?id='+key,b'');self.assertFalse(result['needsFile'])
        self.assertEqual(self.wait(result['job'])['ids'],[key])
        self.assertEqual(self.report(key)['gpus'][0]['sn'],'DEMO-GPU-001')
        self.assertEqual(self.report(key)['input'],ref)
        self.assertEqual(len(list(self.s.RESULTS.glob('*.json'))),1)
    def test_missing_copy_reselect_and_retain_next_time(self):
        key=self.imported()[0];self.s.source_path(self.report(key)['input']).unlink()
        self.assertFalse(self.request('api/reparse/source?id='+key)['available'])
        self.assertEqual(self.upload_reparse(key,SAMPLE.encode())['ids'],[key])
        self.assertTrue(self.request('api/reparse/source?id='+key)['available'])
        self.assertEqual(self.report(key)['source'],'sample.log')
    def test_wrong_file_keeps_original_bytes_and_cache(self):
        key=self.imported()[0];old=self.path(key).read_bytes();sources=list(self.s.SOURCES.iterdir())
        result=self.upload_reparse(key,SAMPLE.replace('DEMO-GPU-001','WRONG-GPU').encode())
        self.assertEqual(result['state'],'error');self.assertIn('文件内容',result['message'])
        self.assertEqual(self.path(key).read_bytes(),old);self.assertEqual(list(self.s.SOURCES.iterdir()),sources)
    def test_legacy_report_without_input_can_reselect(self):
        key=self.imported()[0];d=self.report(key);d.pop('input');self.path(key).write_text(json.dumps(d),encoding='utf-8')
        self.assertEqual(self.upload_reparse(key,SAMPLE.encode())['ids'],[key])
    def test_archive_reparses_only_selected_member_and_preserves_shared_copy(self):
        buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w') as z:z.writestr('one.log',SAMPLE);z.writestr('two.log',SAMPLE)
        ids=self.imported('samples.zip',buf.getvalue());other=self.path(ids[1]).read_bytes();cached=self.s.source_path(self.report(ids[0])['input'])
        result=self.request('api/reparse/start?id='+ids[0],b'')
        self.assertEqual(self.wait(result['job'])['ids'],[ids[0]])
        self.assertEqual(self.path(ids[1]).read_bytes(),other)
        self.request('api/cases/delete',json.dumps({'ids':[ids[0]]}).encode());self.assertTrue(cached.exists())
        self.request('api/cases/delete',json.dumps({'ids':[ids[1]]}).encode());self.assertFalse(cached.exists())
    def prepared(self,key):
        job=self.s.ImportJob();job.target=self.s.read_case(key)
        folder=self.s.UPLOADS/('fixture-'+str(time.time_ns()));folder.mkdir();job.path=folder/'sample.log';job.path.write_bytes(SAMPLE.encode())
        return job
    def test_cancel_during_parse_copy_and_save_keeps_old_report(self):
        for phase in ('parsing','copying','saving'):
            with self.subTest(phase=phase):
                key=self.imported()[0];old=self.path(key).read_bytes();job=self.prepared(key);original=job.progress
                def progress(values):
                    if values.get('phase')==phase:job.cancelled.set()
                    original(values)
                job.progress=progress;self.s.run_job(job)
                self.assertEqual(job.result['state'],'cancelled');self.assertEqual(self.path(key).read_bytes(),old)
                self.assertFalse(job.path.parent.exists())
                self.assertEqual(len(list(self.s.SOURCES.iterdir())),1)
    def test_partial_analysis_does_not_replace_old_result(self):
        key=self.imported()[0];old=self.path(key).read_bytes();job=self.prepared(key)
        cases=parser.analyze(job.path);cases[0]['complete']=False
        with patch.object(self.s,'analyze',return_value=cases):self.s.run_job(job)
        self.assertEqual(job.result['state'],'error');self.assertEqual(self.path(key).read_bytes(),old)
    def test_publish_failure_rolls_back_report_and_source(self):
        key=self.imported()[0];old=self.path(key).read_bytes();job=self.prepared(key);replace=Path.replace
        def fail(path,target):
            if path.suffix=='.pending':raise OSError('simulated write failure')
            return replace(path,target)
        with patch.object(Path,'replace',fail):self.s.run_job(job)
        self.assertEqual(job.result['state'],'error');self.assertEqual(self.path(key).read_bytes(),old)
        self.assertEqual(len(list(self.s.SOURCES.iterdir())),1)
    def test_deleted_or_updated_report_is_not_overwritten(self):
        for action in ('delete','update'):
            key=self.imported()[0];job=self.prepared(key)
            if action=='delete':self.path(key).unlink();expected=None
            else:expected=self.path(key).read_bytes()+b' ';self.path(key).write_bytes(expected)
            self.s.run_job(job);self.assertEqual(job.result['state'],'error')
            self.assertEqual(self.path(key).read_bytes() if self.path(key).exists() else None,expected)
    def test_untrusted_source_path_is_never_opened(self):
        for ref in ({'key':'../secret','name':'file.log'},{'key':'a'*32,'name':'../file.log'},{'key':'a'*32,'name':'C:secret'}):
            self.assertIsNone(self.s.source_path(ref))
        with self.assertRaises(urllib.error.HTTPError):self.request('api/reparse/start?id=../secret',b'')

    def test_cleanup_failure_does_not_mark_committed_report_as_failed(self):
        key=self.imported()[0];job=self.prepared(key);unlink=Path.unlink
        def fail(path,*args,**kwargs):
            if path.suffix=='.backup':raise PermissionError('busy backup')
            return unlink(path,*args,**kwargs)
        with patch.object(Path,'unlink',fail):self.s.run_job(job)
        self.assertEqual(job.result['state'],'done')
        self.assertTrue(self.s.source_path(self.report(key)['input']).is_file())
        self.assertEqual(self.report(key)['gpus'][0]['sn'],'DEMO-GPU-001')
