"""Source-aware session API using synthetic reports and a loopback server."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from test_sessions import report, A, B, C


class SessionApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        spec=importlib.util.spec_from_file_location('session_api_server',Path(__file__).resolve().parents[1]/'app/server.py')
        cls.s=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'GPU_LOG_DATA_DIR':cls.temp.name}):spec.loader.exec_module(cls.s)
        cls.service=cls.s.LocalService(0)
        with patch.object(cls.s.ONLINE,'schedule'):cls.service.start()

    @classmethod
    def tearDownClass(cls):
        cls.service.close();cls.temp.cleanup()

    def setUp(self):
        self.s.RECOVERY['pending']=0
        for folder in (self.s.RESULTS,self.s.SESSIONS.root):
            for path in folder.iterdir():path.unlink()
        self.s.CASE_CACHE.clear()
        self.save(A,'first.log');self.save(B,'second.log')

    def save(self,key,source,**changes):
        value=report(source)
        for field in ('snapshots','topology','matrices','cpuRows'):value['diagnostics'][field]=[]
        value['contentSha256']=key*2
        value.update(changes)
        self.write(key,value)
        return value

    def write(self,key,value):
        with self.s.RESULTS_LOCK:
            (self.s.RESULTS/(key+'.json')).write_text(json.dumps(value),encoding='utf-8')

    def read(self,key):
        return json.loads((self.s.RESULTS/(key+'.json')).read_text(encoding='utf-8'))

    def request(self,path,body=None,headers=None,raw=None,method=None):
        data=raw if raw is not None else json.dumps(body).encode() if body is not None else None
        request_headers={'X-Local-Token':self.s.TOKEN,'Content-Type':'application/json'}
        request_headers.update(headers or {})
        connection=http.client.HTTPConnection('127.0.0.1',self.service.http.server_port,timeout=3)
        try:
            connection.request(method or ('POST' if data is not None else 'GET'),path,body=data,headers=request_headers)
            response=connection.getresponse();content=response.read()
            return response.status,json.loads(content) if response.getheader('Content-Type','').startswith('application/json') else content
        finally:connection.close()

    def create(self,ids=None,**extra):
        status,value=self.request('/api/sessions/create',{'ids':ids or [A,B],'name':'Synthetic session',**extra})
        self.assertEqual(201,status,value)
        return value

    def test_create_list_get_delete_preserve_reports(self):
        originals={key:(self.s.RESULTS/(key+'.json')).read_bytes() for key in (A,B)}
        created=self.create();key=created['manifest']['id']
        self.assertEqual('user-selected',created['manifest']['method'])
        self.assertEqual([A,B],[row['reportId'] for row in created['manifest']['members']])
        self.assertEqual(2,created['view']['counts']['events'])
        status,listed=self.request('/api/sessions');self.assertEqual(200,status)
        self.assertEqual(key,listed['sessions'][0]['id'])
        status,loaded=self.request('/api/session/'+key);self.assertEqual(200,status);self.assertEqual(created,loaded)
        status,removed=self.request('/api/sessions/delete',{'id':key});self.assertEqual((200,{'deleted':key}),(status,removed))
        self.assertEqual(404,self.request('/api/session/'+key)[0])
        for report_id,raw in originals.items():self.assertEqual(raw,(self.s.RESULTS/(report_id+'.json')).read_bytes())

    def test_source_navigation_keeps_report_id_member_and_line(self):
        value=self.create()['view']
        events=value['events'];self.assertEqual([A,B],[row['reportId'] for row in events])
        self.assertEqual([12,12],[row['line'] for row in events]);self.assertNotEqual(events[0]['id'],events[1]['id'])
        self.assertEqual('logs/second.log',events[1]['sourceMember'])
        self.assertEqual(B+':0',events[1]['deviceKey'])
        ref=value['checks'][1]['evidence'][0]
        self.assertEqual((B,'second.log',15),(ref['reportId'],ref['source'],ref['line']))
        self.assertEqual('source',value['timeOrder'])

    def test_removed_member_stays_visible_and_can_refresh(self):
        created=self.create();key=created['manifest']['id']
        self.request('/api/cases/delete',{'ids':[B]})
        status,value=self.request('/api/session/'+key);self.assertEqual(200,status)
        self.assertEqual('missing',value['view']['members'][1]['state']);self.assertFalse(value['view']['complete'])
        self.assertEqual(1,value['view']['counts']['events'])
        status,value=self.request('/api/sessions/refresh',{'id':key});self.assertEqual(200,status)
        self.assertEqual(2,len(value['manifest']['members']));self.assertEqual('missing',value['view']['members'][1]['state'])

    def test_timeline_projection_survives_normalized_api_read(self):
        value=self.read(B)
        value['lifecycleEvents']=[{'id':'l0','kind':'driver_load','line':20,'raw':'[13.000] NVRM: loading NVIDIA UNIX Kernel Module',
                                  'timeInfo':{'kind':'uptime_seconds','raw':'13.000'}}]
        value['diagnostics']['snapshots']=[{'id':'s0','address':'0000:41:00.0','line':23,
            'evidence':{'line':23,'text':'GPU 0000:41:00.0','time':{'kind':'uptime_seconds','raw':'14.000'}},
            'fields':[{'path':'ECC Errors','value':'0','evidence':{'line':25,'text':'ECC Errors: 0'}}]}]
        self.write(B,value)
        original=(self.s.RESULTS/(B+'.json')).read_bytes()
        view=self.create()['view']
        self.assertEqual((2,1,1),(view['counts']['events'],view['counts']['lifecycleEvents'],view['counts']['snapshots']))
        action=view['lifecycleEvents'][0];snapshot=view['snapshots'][0]
        self.assertEqual((B,20,'uptime_seconds'),(action['reportId'],action['line'],action['timeInfo']['kind']))
        self.assertEqual((B,'second.log',23),(snapshot['reportId'],snapshot['source'],snapshot['evidence']['line']))
        self.assertEqual('logs/second.log',snapshot['sourceMember'])
        self.assertEqual((B,25),(snapshot['fields'][0]['evidence']['reportId'],snapshot['fields'][0]['evidence']['line']))
        self.assertEqual(original,(self.s.RESULTS/(B+'.json')).read_bytes())

    def test_reparsed_revision_requires_explicit_refresh(self):
        created=self.create();key=created['manifest']['id'];old=created['manifest']['members'][1]['revision']
        report_b=self.read(B);report_b['gpus'][0]['model']='Synthetic new parser value';self.write(B,report_b)
        status,value=self.request('/api/session/'+key);self.assertEqual(200,status)
        self.assertEqual('changed',value['view']['members'][1]['state']);self.assertEqual(1,value['view']['counts']['events'])
        self.assertEqual(old,value['manifest']['members'][1]['revision'])
        status,value=self.request('/api/sessions/refresh',{'id':key});self.assertEqual(200,status)
        self.assertEqual('ready',value['view']['members'][1]['state']);self.assertEqual(2,value['view']['counts']['events'])
        self.assertNotEqual(old,value['manifest']['members'][1]['revision'])

    def test_machine_conflict_does_not_link_same_gpu_identity(self):
        value=self.read(B);value['server']['sn']='OTHER-SYNTHETIC-SERVER';self.write(B,value)
        view=self.create()['view'];self.assertEqual([],view['links']);self.assertEqual(2,len(view['deviceGroups']))
        self.assertTrue(any(row['kind']=='machine-conflict' for row in view['warnings']))

    def test_device_identity_conflict_preserves_both_sources(self):
        value=self.read(B);value['gpus'][0]['fields']['serial'][0]['value']='OTHER-DEMO-SERIAL';value['gpus'][0]['sn']='OTHER-DEMO-SERIAL';self.write(B,value)
        view=self.create()['view'];self.assertEqual([],view['links']);self.assertEqual(2,len(view['events']))

    def test_duplicate_contents_count_once_but_keep_members(self):
        value=self.read(B);value['contentSha256']=A*2;self.write(B,value)
        view=self.create()['view'];self.assertEqual(2,len(view['members']));self.assertEqual('duplicate',view['members'][1]['state'])
        self.assertEqual(A,view['members'][1]['duplicateOf']);self.assertEqual(1,view['counts']['events'])

    def test_selected_ids_and_name_validation(self):
        invalid=[{}, {'ids':[]},{'ids':[A]},{'ids':[A,A]},{'ids':[A,'../secret']},{'ids':[A,True]},
                 {'ids':[A]*33},{'ids':[A,B],'name':None},{'ids':[A,B],'name':'x'*121},
                 {'ids':[A,B],'name':'bad\nname'},{'ids':[A,B],'file':'C:/PRIVATE'}]
        for body in invalid:
            with self.subTest(body=str(body)[:80]):
                status,value=self.request('/api/sessions/create',body);self.assertEqual(400,status,value)
                self.assertNotIn('PRIVATE',json.dumps(value))
        self.assertEqual(404,self.request('/api/sessions/create',{'ids':[A,C]})[0])
        self.assertEqual([],list(self.s.SESSIONS.root.iterdir()))

    def test_missing_or_invalid_session_ids(self):
        for path in ('/api/session/../secret','/api/session/'+C,'/api/session/'+A+'/extra'):
            self.assertEqual(404,self.request(path)[0])
        for action in ('refresh','delete'):
            for body in ({},{'id':'../secret'},{'id':3},{'id':A,'extra':True}):
                self.assertEqual(400,self.request('/api/sessions/'+action,body)[0])
        self.assertEqual(404,self.request('/api/sessions/refresh',{'id':C})[0])

    def test_json_length_encoding_depth_and_duplicate_keys(self):
        invalid=[b'',b'not json',b'[]',b'null',b'\xff',b'{'*2000+b'}'*2000,
                 b'{"ids":[],"ids":[]}',b'{"ids":NaN}',b' '*8193]
        for raw in invalid:
            with self.subTest(raw=raw[:20]):self.assertEqual(400,self.request('/api/sessions/create',raw=raw)[0])
        self.assertEqual([],list(self.s.SESSIONS.root.iterdir()))

    def test_body_timeout_and_length_header_are_bounded(self):
        connection=http.client.HTTPConnection('127.0.0.1',self.service.http.server_port,timeout=2)
        try:
            with patch.object(self.s,'JSON_BODY_TIMEOUT',.05):
                connection.request('POST','/api/sessions/create',body=b'{',headers={'X-Local-Token':self.s.TOKEN,'Content-Length':'50'})
                response=connection.getresponse();self.assertEqual(408,response.status);self.assertNotIn(b'PRIVATE',response.read())
        finally:connection.close()
        for length in ('-1','+20','not-a-number','9999999999999999999999999999999999'):
            self.assertEqual(400,self.request('/api/sessions/create',raw=b'{}',headers={'Content-Length':length})[0])

    def test_token_host_and_origin_rejected_before_read_or_write(self):
        for headers in ({'X-Local-Token':''},{'X-Local-Token':'invalid'},{'Host':'evil.invalid'},
                        {'Origin':'https://evil.invalid'},{'Origin':'null'}):
            self.assertEqual(403,self.request('/api/sessions',headers=headers)[0])
            self.assertEqual(403,self.request('/api/sessions/create',{'ids':[A,B]},headers=headers)[0])
        self.assertEqual([],list(self.s.SESSIONS.root.iterdir()))
        origin=f'http://127.0.0.1:{self.service.http.server_port}'
        self.assertEqual(201,self.request('/api/sessions/create',{'ids':[A,B]},headers={'Origin':origin})[0])

    def test_recovery_blocks_create_refresh_but_allows_get_delete(self):
        key=self.create()['manifest']['id'];self.s.RECOVERY['pending']=1
        self.assertEqual(503,self.request('/api/sessions/create',{'ids':[A,B]})[0])
        self.assertEqual(503,self.request('/api/sessions/refresh',{'id':key})[0])
        self.assertEqual(200,self.request('/api/session/'+key)[0]);self.assertEqual(200,self.request('/api/sessions')[0])
        self.assertEqual(200,self.request('/api/sessions/delete',{'id':key})[0])

    def test_storage_errors_are_fixed_messages_without_local_paths(self):
        private='C:/PRIVATE/secret-folder/report.json'
        with patch.object(self.s.SESSIONS,'create',side_effect=PermissionError(private)):
            status,value=self.request('/api/sessions/create',{'ids':[A,B]});self.assertEqual(503,status);self.assertNotIn('PRIVATE',json.dumps(value))
        with patch.object(self.s.SESSIONS,'get',side_effect=RuntimeError(private)):
            status,value=self.request('/api/session/'+A);self.assertEqual(500,status);self.assertNotIn('PRIVATE',json.dumps(value))
        with patch.object(self.s.SESSIONS,'list',side_effect=OSError(private)):
            status,value=self.request('/api/sessions');self.assertEqual(503,status);self.assertNotIn('PRIVATE',json.dumps(value))

    def test_corrupt_manifest_is_reported_not_executed(self):
        key=self.create()['manifest']['id'];path=self.s.SESSIONS.root/(key+'.json')
        path.write_text('{"version":1,"id":"bad"}',encoding='utf-8')
        self.assertEqual(422,self.request('/api/session/'+key)[0])
        status,value=self.request('/api/sessions');self.assertEqual(200,status);self.assertEqual(1,value['unreadable'])

    def test_report_loader_holds_results_lock(self):
        original=self.s.read_case;calls=[]
        def checked(key):
            self.assertTrue(self.s.RESULTS_LOCK._is_owned())
            calls.append(key);return original(key)
        with patch.object(self.s,'read_case',side_effect=checked):
            key=self.create()['manifest']['id']
            self.assertEqual(200,self.request('/api/session/'+key)[0])
        self.assertTrue(calls)

    def test_concurrent_get_and_report_read_complete_without_lock_inversion(self):
        key=self.create()['manifest']['id'];results=[]
        def read_session():results.append(self.request('/api/session/'+key)[0])
        with self.s.RESULTS_LOCK:
            worker=threading.Thread(target=read_session);worker.start()
            self.assertEqual(A,self.s.read_case(A)[0]['id'])
        worker.join(3);self.assertFalse(worker.is_alive());self.assertEqual([200],results)

    def test_static_assets_have_expected_types_and_remain_host_bound(self):
        for name in ('sessions.js','sessions.css','timeline.js','timeline.css'):
            status,content=self.request('/'+name,headers={'X-Local-Token':''})
            self.assertEqual(200,status);self.assertTrue(content)
            self.assertEqual(403,self.request('/'+name,headers={'Host':'evil.invalid'})[0])


if __name__=='__main__':unittest.main()
