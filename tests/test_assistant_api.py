"""Assistant HTTP boundaries; synthetic evidence and loopback/mock transport only."""
import contextlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

REPO=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(REPO/'app'))
import assistant


def selected():
    return {'text':'Synthetic selected note','evidence':[{'id':'e1','text':'Synthetic Xid 79','source':'报告 1','line':12}]}


def payload():
    return {'mode':'model','confirmed':True,'endpoint':'http://localhost:9876/v1','apiKey':'SYNTHETIC-KEY-ONLY','preview':assistant.preview_request(selected(),'synthetic-model')}


def response(ref='e1'):
    value={'observations':[],'uncertainties':[],'summary':[{'text':'Synthetic observation','refs':[ref]}]}
    return json.dumps({'choices':[{'finish_reason':'stop','message':{'content':json.dumps(value)}}]}).encode()


class AssistantApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        spec=importlib.util.spec_from_file_location('assistant_api_server',REPO/'app/server.py')
        cls.s=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'GPU_LOG_DATA_DIR':cls.temp.name}):spec.loader.exec_module(cls.s)
        cls.service=cls.s.LocalService(0)
        with patch.object(cls.s.ONLINE,'schedule'):cls.service.start()

    @classmethod
    def tearDownClass(cls):
        cls.service.close();cls.temp.cleanup()

    def request(self,path='/api/assistant/run',body=None,*,raw=None,headers=None,method=None):
        data=raw if raw is not None else json.dumps(body,ensure_ascii=False).encode() if body is not None else None
        outgoing={'X-Local-Token':self.s.TOKEN,'Content-Type':'application/json'};outgoing.update(headers or {})
        connection=http.client.HTTPConnection('127.0.0.1',self.service.http.server_port,timeout=4)
        try:
            connection.request(method or ('POST' if data is not None else 'GET'),path,data,outgoing)
            result=connection.getresponse();return result.status,json.loads(result.read())
        finally:connection.close()

    def test_protocol_is_readonly_and_exact(self):
        with patch.object(self.s.EVIDENCE,'list') as bookmarks,patch.object(assistant,'_http_transport') as transport:
            status,value=self.request('/api/assistant/protocol')
        self.assertEqual((200,assistant.protocol()),(status,value));bookmarks.assert_not_called();transport.assert_not_called()
        self.assertNotIn('apiKey',json.dumps(value));self.assertEqual(400,self.request('/api/assistant/protocol?input=synthetic')[0])

    def test_token_host_origin_checked_before_any_work(self):
        data=payload()
        with patch.object(assistant,'request_assistance') as run,patch.object(assistant,'protocol') as protocol:
            for headers in ({'X-Local-Token':''},{'X-Local-Token':'invalid'},{'Host':'other.invalid'},{'Origin':'https://other.invalid'},{'Origin':'null'},{'Origin':''}):
                for path,body in (('/api/assistant/protocol',None),('/api/assistant/run',data)):
                    status,value=self.request(path,body,headers=headers);self.assertEqual(403,status);self.assertEqual('forbidden',value['code'])
            run.assert_not_called();protocol.assert_not_called()
        origin=f'http://127.0.0.1:{self.service.http.server_port}'
        self.assertEqual(200,self.request('/api/assistant/protocol',headers={'Origin':origin})[0])

    def test_duplicate_security_headers_rejected(self):
        for name,value in (('Host',f'127.0.0.1:{self.service.http.server_port}'),('X-Local-Token',self.s.TOKEN),('Origin',f'http://127.0.0.1:{self.service.http.server_port}')):
            connection=http.client.HTTPConnection('127.0.0.1',self.service.http.server_port,timeout=3)
            try:
                connection.putrequest('GET','/api/assistant/protocol')
                connection.putheader('X-Local-Token',self.s.TOKEN)
                if name=='Origin':connection.putheader('Origin',value)
                connection.putheader(name,value);connection.endheaders()
                result=connection.getresponse();self.assertEqual(403,result.status);result.read()
            finally:connection.close()

    def test_default_offline_does_not_lock_or_call_transport(self):
        with patch.object(assistant,'_http_transport') as transport:
            self.s.ASSISTANT_LOCK.acquire()
            try:status,value=self.request(body={'input':selected()})
            finally:self.s.ASSISTANT_LOCK.release()
        self.assertEqual(200,status);self.assertEqual('offline',value['mode']);transport.assert_not_called()
        self.assertEqual(400,self.request(body={'input':selected(),'apiKey':'SYNTHETIC-KEY-ONLY'})[0])

    def test_actual_model_body_is_complete_preview_and_key_only_in_header(self):
        captured={};data=payload();before={path.relative_to(self.s.RUNTIME).as_posix():path.read_bytes() for path in self.s.RUNTIME.rglob('*') if path.is_file()}
        def transport(url,body,headers,**options):
            captured.update(url=url,body=body,headers=dict(headers));return 200,response()
        with patch.object(assistant,'_http_transport',side_effect=transport):status,value=self.request(body=data)
        self.assertEqual(200,status,value);self.assertEqual(data['preview'],json.loads(captured['body']))
        self.assertEqual(json.dumps(data['preview'],ensure_ascii=False,separators=(',',':')).encode(),captured['body'])
        self.assertEqual(selected(),json.loads(json.loads(captured['body'])['messages'][1]['content']))
        self.assertEqual('Bearer SYNTHETIC-KEY-ONLY',captured['headers']['Authorization'])
        self.assertNotIn(b'SYNTHETIC-KEY-ONLY',captured['body']);self.assertNotIn('SYNTHETIC-KEY-ONLY',json.dumps(value))
        after={path.relative_to(self.s.RUNTIME).as_posix():path.read_bytes() for path in self.s.RUNTIME.rglob('*') if path.is_file()}
        self.assertEqual(before,after,'Assistant requests do not persist evidence, results or credentials')

    def test_backend_request_key_is_erased_after_completion(self):
        captured=[]
        def run(body):captured.append(body);return {'mode':'offline','summaryText':'synthetic'}
        with patch.object(assistant,'request_assistance',side_effect=run):self.assertEqual(200,self.request(body=payload())[0])
        self.assertNotIn('apiKey',captured[0]);self.assertFalse(self.s.ASSISTANT_LOCK.locked())

    def test_bad_preview_confirmation_and_unknown_reference(self):
        with patch.object(assistant,'_http_transport') as transport:
            for data in (payload()|{'confirmed':False},payload()|{'preview':{}},payload()|{'report':{'raw':'UNSELECTED'}}):
                self.assertEqual(400,self.request(body=data)[0])
            transport.assert_not_called()
        with patch.object(assistant,'_http_transport',return_value=(200,response('unselected'))):
            status,value=self.request(body=payload());self.assertEqual(502,status);self.assertEqual('unknown_reference',value['code'])

    def test_private_errors_and_key_echo_never_reflected(self):
        private='SYNTHETIC-KEY-ONLY PRIVATE BODY'
        errors=io.StringIO()
        for transport in (lambda *a,**k:(_ for _ in ()).throw(RuntimeError(private)),lambda *a,**k:(401,private.encode()),lambda *a,**k:(200,private.encode())):
            with contextlib.redirect_stderr(errors),patch.object(assistant,'_http_transport',side_effect=transport):
                status,value=self.request(body=payload());self.assertGreaterEqual(status,400)
                self.assertNotIn(private,json.dumps(value));self.assertNotIn('SYNTHETIC-KEY-ONLY',json.dumps(value))
        with contextlib.redirect_stderr(errors),patch.object(assistant,'request_assistance',side_effect=RuntimeError(private)):
            status,value=self.request(body=payload());self.assertEqual((500,'connection_failed'),(status,value['code']))
        self.assertNotIn(private,errors.getvalue());self.assertFalse(self.s.ASSISTANT_LOCK.locked())

    def test_strict_json_and_envelope_size(self):
        with patch.object(assistant,'request_assistance') as run:
            for raw in (b'{"mode":"offline","mode":"model"}',b'{"input":NaN}',b'[]',b'null',b'\xff',b'{'):
                status,value=self.request(raw=raw);self.assertEqual((400,'invalid_input'),(status,value['code']))
            # Oversized requests are rejected from headers before reading a body.
            status,value=self.request(method='POST',headers={'Content-Length':str(192*1024+1)})
            self.assertEqual((400,'invalid_input'),(status,value['code']))
            for length in ('-1','+20','invalid','99999999999999999999'):
                self.assertEqual(400,self.request(raw=b'{}',headers={'Content-Length':length})[0])
            self.assertEqual(400,self.request(raw=b'{}',headers={'Transfer-Encoding':'chunked'})[0])
            run.assert_not_called()
        raw=json.dumps({'mode':'offline','input':selected()}).encode();padded=raw+b' '*(192*1024-len(raw))
        self.assertEqual(200,self.request(raw=padded)[0],'Exactly 192 KiB is accepted before input validation')
        self.assertEqual(400,self.request('/api/assistant/run?apiKey=synthetic',body=payload())[0])

    def test_short_and_slow_body_never_reach_assistant(self):
        with patch.object(self.s,'JSON_BODY_TIMEOUT',.05),patch.object(assistant,'request_assistance') as run:
            self.assertEqual(408,self.request(raw=b'{',headers={'Content-Length':'50'})[0]);run.assert_not_called()
        with socket.create_connection(('127.0.0.1',self.service.http.server_port),timeout=2) as client:
            request=(f'POST /api/assistant/run HTTP/1.0\r\nHost: 127.0.0.1:{self.service.http.server_port}\r\nX-Local-Token: {self.s.TOKEN}\r\nContent-Length: 50\r\n\r\n{{').encode()
            client.sendall(request);client.shutdown(socket.SHUT_WR);self.assertIn(b'400',client.recv(4096).split(b'\r\n')[0])

    def test_duplicate_content_length_rejected(self):
        connection=http.client.HTTPConnection('127.0.0.1',self.service.http.server_port,timeout=2)
        try:
            connection.putrequest('POST','/api/assistant/run');connection.putheader('X-Local-Token',self.s.TOKEN)
            connection.putheader('Content-Length','2');connection.putheader('Content-Length','2');connection.endheaders(b'{}')
            result=connection.getresponse();self.assertEqual(400,result.status);result.read()
        finally:connection.close()

    def test_disconnected_client_keeps_model_slot_until_transport_finishes(self):
        entered,finish=threading.Event(),threading.Event()
        def transport(*args,**kwargs):entered.set();finish.wait(3);return 200,response()
        data=json.dumps(payload()).encode();client=socket.create_connection(('127.0.0.1',self.service.http.server_port),timeout=2)
        with patch.object(assistant,'_http_transport',side_effect=transport) as mock:
            try:
                headers=(f'POST /api/assistant/run HTTP/1.0\r\nHost: 127.0.0.1:{self.service.http.server_port}\r\nX-Local-Token: {self.s.TOKEN}\r\nContent-Length: {len(data)}\r\n\r\n').encode()
                client.sendall(headers+data);self.assertTrue(entered.wait(2));client.close()
                status,value=self.request(body=payload());self.assertEqual((409,'busy'),(status,value['code']));self.assertEqual(1,mock.call_count)
                self.assertEqual(200,self.request('/api/assistant/protocol')[0]);self.assertEqual(200,self.request(body={'input':selected()})[0])
            finally:finish.set();client.close()
            self.assertTrue(self.s.ASSISTANT_LOCK.acquire(timeout=3));self.s.ASSISTANT_LOCK.release()
            self.assertEqual(200,self.request(body=payload())[0]);self.assertEqual(2,mock.call_count)


if __name__=='__main__':unittest.main()
