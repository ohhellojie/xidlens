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

    def test_unsupported_file_extension_is_rejected_before_upload(self):
        before=set(self.s.UPLOADS.iterdir())
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('api/import?name=photo.png', SAMPLE.encode())
        self.assertEqual(caught.exception.code,415)
        self.assertEqual(set(self.s.UPLOADS.iterdir()),before)

    def test_unrecognized_content_does_not_create_report_or_source(self):
        before=set(self.s.RESULTS.iterdir());sources=set(self.s.SOURCES.iterdir())
        for content in (b'ordinary notes, no diagnostic content', b'\x89PNG\x00\x01\x02\x03'):
            job=self.job_file();job.path.write_bytes(content);self.s.run_job(job)
            self.assertEqual(job.result['state'],'error')
            self.assertIn('未识别到',job.result['message'])
        self.assertEqual(set(self.s.RESULTS.iterdir()),before)
        self.assertEqual(set(self.s.SOURCES.iterdir()),sources)

    def test_archive_skips_unrecognized_text_and_keeps_real_log(self):
        job=self.job_file('mixed.zip')
        with zipfile.ZipFile(job.path,'w') as archive:
            archive.writestr('notes.txt','just some notes')
            archive.writestr('gpu.log',SAMPLE)
        self.s.run_job(job)
        self.assertEqual(job.result['state'],'done')
        self.assertEqual(len(job.result['ids']),1)
        result=json.loads((self.s.RESULTS/(job.result['ids'][0]+'.json')).read_text(encoding='utf-8'))
        self.assertTrue(any('1 个文件' in w for w in result['warnings']))

    def test_extensionless_system_log_and_uppercase_log_are_accepted(self):
        for name in ('dmesg','syslog','messages','GPU.LOG'):
            key=self.request('api/import?name='+name,SAMPLE.encode())['job']
            self.assertEqual(self.wait(key)['state'],'done')

    def test_sidebar_mode_is_saved_and_restored_in_page(self):
        for mode,pinned in [('unpin',False),('pin',True)]:
            self.request('api/sidebar/'+mode,b'')
            self.assertEqual(self.s.sidebar_pinned(),pinned)
            page=self.opener.open(self.service.url).read().decode()
            self.assertIn('data-sidebar-pinned="'+str(pinned).lower()+'"',page)

    def test_stalled_upload_times_out_and_cleans_partial_copy(self):
        import http.client
        key=self.request('api/import/start',b'')['job']
        connection=http.client.HTTPConnection('127.0.0.1',self.service.http.server_port,timeout=3)
        try:
            with patch.object(self.s,'IMPORT_IDLE_TIMEOUT',.05):
                connection.putrequest('POST','/api/import?name=stall.log&job='+key)
                connection.putheader('X-Local-Token',self.s.TOKEN)
                connection.putheader('Content-Length','100');connection.endheaders();connection.send(b'N')
                response=connection.getresponse();message=json.load(response)
                self.assertEqual(response.status,400);self.assertIn('超时',message['error'])
            self.assertEqual(self.wait(key)['state'],'error')
            self.assertFalse((self.s.UPLOADS/key).exists())
        finally:connection.close()

    def test_full_log_http_archive_members_positions_and_auth(self):
        payload=io.BytesIO()
        with zipfile.ZipFile(payload,'w') as z:
            z.writestr('first.log',SAMPLE)
            z.writestr('second.log',SAMPLE.replace('DEMO-GPU-001','SECOND-GPU'))
        job=self.request('api/import?name=reader-test.zip',payload.getvalue())
        result=self.wait(job['job']);self.assertEqual(result['state'],'done',result)
        for key,token in zip(result['ids'],['DEMO-GPU-001','SECOND-GPU']):
            meta=self.request('api/log/meta?id='+key)
            self.s.READER.jobs[key].future.result(timeout=10)
            meta=self.request('api/log/meta?id='+key);self.assertEqual(meta['state'],'ready',meta)
            suffix='?id='+key+'&revision='+meta['revision']
            rows=self.request('api/log/lines'+suffix+'&start=1&count=128')['lines']
            self.assertIn(token,'\n'.join(rows))
            report=self.request('api/case/'+key)
            for event in report['events']:self.assertEqual(rows[event['line']-1],event['raw'])
            view={'top':4,'selected':8,'offset':3,'left':24,'wrap':True,'query':'GPU'}
            self.request('api/log/position'+suffix,json.dumps(view).encode())
            self.assertEqual(self.request('api/log/meta?id='+key)['position'],view)
            with self.assertRaises(urllib.error.HTTPError) as caught:self.request('api/log/lines?id='+key+'&revision=stale')
            self.assertEqual(caught.exception.code,400)
            with self.assertRaises(urllib.error.HTTPError) as caught:self.opener.open(self.service.url+'api/log/lines'+suffix)
            self.assertEqual(caught.exception.code,403)
        self.s.delete_cases(result['ids'])
        self.assertTrue(all(key not in self.s.READER.jobs for key in result['ids']))
        with self.assertRaises(urllib.error.HTTPError):self.request('api/log/meta?id='+result['ids'][0])

    def test_storage_failure_is_distinguished_and_releases_job_data(self):
        import errno
        job=self.job_file();before=set(self.s.RESULTS.iterdir())
        with patch.object(self.s,'copy_input',side_effect=OSError(errno.ENOSPC,'full')):self.s.run_job(job)
        self.assertEqual(job.result['state'],'error');self.assertIn('空间不足',job.result['message'])
        self.assertEqual(set(self.s.RESULTS.iterdir()),before);self.assertIsNone(job.catalog)

    def test_completed_job_history_is_bounded_without_dropping_active_jobs(self):
        with patch.object(self.s,'JOBS',{}),patch.object(self.s,'MAX_JOBS',3):
            with self.s.LOCK:
                active=self.s.register_job(self.s.ImportJob())
                for _ in range(10):
                    job=self.s.ImportJob();job.result['state']='done';self.s.register_job(job)
            self.assertEqual(len(self.s.JOBS),3);self.assertIn(active,self.s.JOBS)

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
        self.assertIsNone(self.s.JOBS[key].catalog)

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
