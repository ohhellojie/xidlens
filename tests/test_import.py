import gzip
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request
import zipfile
from test_parser import parser, SAMPLE


class ProgressTests(unittest.TestCase):
    def test_text_and_gzip_progress_have_truthful_totals(self):
        with tempfile.TemporaryDirectory() as folder:
            for suffix,content in [('.log',SAMPLE.encode()),('.gz',gzip.compress(SAMPLE.encode()))]:
                p=Path(folder)/('report'+suffix);p.write_bytes(content);updates=[]
                reports=parser.analyze(p,progress=updates.append)
                parsed=[v for v in updates if v['phase']=='parsing']
                self.assertEqual(parsed[-1]['bytes'],len(SAMPLE.encode()))
                self.assertEqual(parsed[-1]['lines'],reports[0]['lines'])
                self.assertEqual(parsed[-1]['totalBytes'],len(content) if suffix=='.log' else None)
                self.assertEqual(updates[-1]['phase'],'organizing')
                self.assertEqual(len(reports[0]['events']),2)

    def test_cancel_between_archive_members_discards_analysis(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'reports.zip'
            with zipfile.ZipFile(p,'w') as z:
                z.writestr('first.log',SAMPLE);z.writestr('second.log',SAMPLE)
            cancelled=threading.Event();seen=[]
            def progress(value):
                seen.append(value)
                if value.get('source','').endswith('second.log'):cancelled.set()
            with self.assertRaises(parser.core.AnalysisCancelled):parser.analyze(p,cancel_event=cancelled,progress=progress)
            self.assertTrue(any(v.get('source','').endswith('first.log') and v.get('bytes',0)>0 for v in seen))


class ImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        spec=importlib.util.spec_from_file_location('import_test_server',Path(__file__).resolve().parents[1]/'app/server.py')
        cls.s=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'GPU_LOG_DATA_DIR':cls.temp.name}):spec.loader.exec_module(cls.s)
        cls.service=cls.s.LocalService(0);cls.service.start()
        cls.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.service.close();cls.temp.cleanup()

    def request(self,path,body=None):
        req=urllib.request.Request(self.service.url+path,data=body,headers={'X-Local-Token':self.s.TOKEN})
        return json.loads(self.opener.open(req,timeout=5).read())

    def wait(self,key,states=('done','error','cancelled')):
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            result=self.request('api/job/'+key)
            if result['state'] in states:return result
            time.sleep(.01)
        self.fail('Import timed out')

    def job_file(self,name='sample.log'):
        job=self.s.ImportJob();folder=self.s.UPLOADS/('test-'+str(time.monotonic_ns()));folder.mkdir()
        job.path=folder/name;job.path.write_text(SAMPLE,encoding='utf-8');return job

    def test_cancel_during_parsing_leaves_no_report_then_retry_succeeds(self):
        job=self.job_file();before=set(self.s.RESULTS.glob('*.json'))
        def progress(v):
            if v.get('lines',0)>0:job.cancelled.set()
        job.progress=progress
        self.s.run_job(job)
        self.assertEqual(job.result['state'],'cancelled')
        self.assertEqual(set(self.s.RESULTS.glob('*.json')),before)
        self.assertFalse(job.path.parent.exists())
        next_job=self.job_file();self.s.run_job(next_job)
        self.assertEqual(next_job.result['state'],'done')
        self.assertFalse(next_job.path.parent.exists())

    def test_starting_parse_clears_upload_percentage(self):
        job=self.job_file();job.result.update(bytes=500,totalBytes=500)
        original=job.progress;updates=[]
        def progress(values):
            updates.append(values.copy());original(values)
        job.progress=progress;self.s.run_job(job)
        self.assertEqual(updates[0]['bytes'],0)
        self.assertIsNone(updates[0]['totalBytes'])
        self.assertEqual(job.result['state'],'done')

    def test_cancel_during_staging_preserves_existing_report(self):
        first=self.job_file();self.s.run_job(first)
        report=self.s.RESULTS/(first.result['ids'][0]+'.json');original=report.read_bytes()
        job=self.job_file();cases=parser.analyze(job.path);cases[0]['extra']='A'*150000
        cancelled_during_write=[]
        original_check=self.s.core.check_cancel
        def check(event):
            if event is job and any(p.stat().st_size>0 for p in job.path.parent.glob('*.pending')):
                cancelled_during_write.append(True);job.cancelled.set()
            original_check(event)
        with patch.object(self.s.core,'check_cancel',side_effect=check):
            with self.assertRaises(self.s.core.AnalysisCancelled):self.s.save_cases(cases,job)
        self.assertEqual(report.read_bytes(),original)
        self.assertTrue(cancelled_during_write)
        self.assertFalse(list(job.path.parent.glob('*.pending')))
        job.cleanup()

    def test_zip_publishes_members_and_cleans_staging_files(self):
        job=self.job_file('reports.zip')
        with zipfile.ZipFile(job.path,'w') as z:
            z.writestr('first.log',SAMPLE)
            z.writestr('second.log',SAMPLE.replace('DEMO-SERVER-001','DEMO-SERVER-SECOND'))
        self.s.run_job(job)
        self.assertEqual(job.result['state'],'done')
        reports=[json.loads((self.s.RESULTS/(key+'.json')).read_text(encoding='utf-8')) for key in job.result['ids']]
        self.assertEqual({r['server']['sn'] for r in reports},{'DEMO-SERVER-001','DEMO-SERVER-SECOND'})
        self.assertTrue(all(len(r['events'])==2 for r in reports))
        self.assertFalse(job.path.parent.exists())

    def test_ready_cancel_is_idempotent(self):
        key=self.request('api/import/start',b'')['job']
        for _ in range(2):self.assertEqual(self.request('api/job/'+key+'/cancel',b'')['state'],'cancelled')

    def test_upload_cancel_unblocks_read_and_cleans_temp(self):
        key=self.request('api/import/start',b'')['job']
        conn=http.client.HTTPConnection('127.0.0.1',self.service.http.server_port,timeout=5)
        conn.putrequest('POST','/api/import?name=partial.log&job='+key)
        conn.putheader('X-Local-Token',self.s.TOKEN);conn.putheader('Content-Length',10*1024*1024);conn.endheaders();conn.send(b'A'*65536)
        try:
            self.wait(key,('uploading',));self.request('api/job/'+key+'/cancel',b'')
            self.assertEqual(self.wait(key)['state'],'cancelled')
        finally:conn.close()
        self.assertFalse((self.s.UPLOADS/key).exists())
        next_key=self.request('api/import?name=retry.log',SAMPLE.encode())['job']
        self.assertEqual(self.wait(next_key)['state'],'done')
        self.assertEqual(self.request('api/job/'+next_key+'/cancel',b'')['state'],'done')

    def test_queued_cancel_does_not_wait_for_previous_job(self):
        gate=threading.Event();started=threading.Event()
        def hold():started.set();gate.wait(5)
        future=self.s.EXECUTOR.submit(hold);started.wait(2)
        try:
            key=self.request('api/import?name=queued.log',SAMPLE.encode())['job']
            self.assertEqual(self.request('api/job/'+key)['state'],'queued')
            self.assertEqual(self.request('api/job/'+key+'/cancel',b'')['state'],'cancelled')
            self.assertFalse((self.s.UPLOADS/key).exists())
        finally:gate.set();future.result(timeout=5)

    def test_cancel_cannot_target_an_unknown_job(self):
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('api/job/'+'f'*32+'/cancel',b'')
        self.assertEqual(error.exception.code,404)
