"""仅监听本机的离线界面；不向外部服务发送日志。"""
from __future__ import annotations
import argparse, concurrent.futures, json, os, secrets, sys, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
sys.dont_write_bytecode=True
from parser import analyze, core

ROOT=Path(__file__).resolve().parent
APP_HOME=Path(sys.executable).resolve().parent if getattr(sys,'frozen',False) else ROOT
RUNTIME=Path(os.environ.get('GPU_LOG_DATA_DIR',str(APP_HOME/'runtime'))).resolve();RESULTS=RUNTIME/'results';UPLOADS=RUNTIME/'uploads'
for p in (RUNTIME,RESULTS,UPLOADS):p.mkdir(parents=True,exist_ok=True)
TOKEN=secrets.token_urlsafe(24);JOBS={};LOCK=threading.Lock()
EXECUTOR=concurrent.futures.ThreadPoolExecutor(max_workers=1)
STOP_EVENT=threading.Event()

def save_case(case):
    case_id=uuid.uuid4().hex
    if case.get('contentSha256'):
        for p in RESULTS.glob('*.json'):
            old=json.loads(p.read_text(encoding='utf-8'))
            if old.get('contentSha256')==case['contentSha256'] and old.get('source')==case['source'] and old.get('catalog')==case.get('catalog'):
                case_id=old['id'];break
    case['id']=case_id
    temporary=RESULTS/(case_id+'.tmp')
    temporary.write_text(json.dumps(case,ensure_ascii=False),encoding='utf-8')
    temporary.replace(RESULTS/(case_id+'.json'))
    return case_id

def case_list():
    cases=[]
    for p in sorted(RESULTS.glob('*.json'),key=lambda p:p.stat().st_mtime):
        try:
            d=json.loads(p.read_text(encoding='utf-8'));cases.append({'id':d['id'],'source':d['source'],'gpus':len(d['gpus']),'events':len(d['events']),'complete':d['complete'],'collected':d.get('server',{}).get('time','')})
        except (ValueError,KeyError):continue
    return cases

def run_job(job,path):
    try:
        cases=analyze(path,cancel_event=STOP_EVENT)
        if not cases:raise ValueError('没有可读取的报告')
        ids=[]
        for case in cases:
            core.check_cancel(STOP_EVENT)
            ids.append(save_case(case))
        with LOCK:JOBS[job]={'state':'done','ids':ids}
    except core.AnalysisCancelled:
        with LOCK:JOBS[job]={'state':'error','message':'已停止读取'}
    except Exception as exc:
        with LOCK:JOBS[job]={'state':'error','message':f'解析失败：{type(exc).__name__} · {exc}'}
    finally:
        path.unlink(missing_ok=True)
        try:path.parent.rmdir()
        except OSError:pass

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def allowed(self):return self.headers.get('Host')==f'127.0.0.1:{self.server.server_port}'
    def authenticated(self):return self.allowed() and secrets.compare_digest(self.headers.get('X-Local-Token',''),TOKEN)
    def respond(self,data,status=200,ctype='application/json; charset=utf-8'):
        body=json.dumps(data,ensure_ascii=False).encode('utf-8') if ctype.startswith('application/json') else data
        self.send_response(status);self.send_header('Content-Type',ctype);self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers();self.wfile.write(body)
    def do_GET(self):
        url=urlparse(self.path)
        if not self.allowed():return self.respond({'error':'拒绝访问'},403)
        if url.path=='/':return self.respond((ROOT/'index.html').read_text(encoding='utf-8').replace('__LOCAL_TOKEN__',TOKEN).encode(),ctype='text/html; charset=utf-8')
        if url.path=='/analysis.js':return self.respond((ROOT/'analysis.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path=='/app.js':return self.respond((ROOT/'app.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path=='/logo.png':return self.respond((ROOT/'logo.png').read_bytes(),ctype='image/png')
        if not self.authenticated():return self.respond({'error':'会话已失效，请重新打开程序'},403)
        if url.path=='/api/cases':return self.respond({'cases':case_list()})
        if url.path.startswith('/api/case/'):
            key=url.path.rsplit('/',1)[-1]
            if not re_id(key):return self.respond({'error':'不存在的记录'},404)
            path=RESULTS/(key+'.json')
            if path.is_file():return self.respond(path.read_bytes(),ctype='application/octet-stream')
        if url.path.startswith('/api/job/'):
            with LOCK:d=JOBS.get(url.path.rsplit('/',1)[-1],{'state':'error','message':'任务不存在'})
            return self.respond(d)
        return self.respond({'error':'不存在的资源'},404)
    def do_POST(self):
        url=urlparse(self.path)
        if not self.authenticated():return self.respond({'error':'拒绝访问'},403)
        origin=self.headers.get('Origin')
        if origin and origin!=f'http://127.0.0.1:{self.server.server_port}':return self.respond({'error':'拒绝跨站请求'},403)
        if url.path=='/api/stop':
            self.respond({'ok':True});threading.Thread(target=self.server.request_stop,daemon=True).start();return
        if url.path!='/api/import':return self.respond({'error':'不存在的资源'},404)
        try:length=int(self.headers.get('Content-Length','0'))
        except ValueError:return self.respond({'error':'无效文件长度'},400)
        if not 0<length<=512*1024*1024:return self.respond({'error':'请选择 512 MB 以内的文件'},413)
        name=Path(parse_qs(url.query).get('name',['log.txt'])[0].replace('\\','/')).name
        if not name or name in ('.','..') or '\x00' in name:return self.respond({'error':'无效文件名'},400)
        job=uuid.uuid4().hex;folder=UPLOADS/job;folder.mkdir();path=folder/name
        try:
            with path.open('wb') as f:
                left=length
                while left:
                    chunk=self.rfile.read(min(left,1024*1024))
                    if not chunk:raise ValueError('文件传输中断')
                    f.write(chunk);left-=len(chunk)
        except Exception:
            path.unlink(missing_ok=True);return self.respond({'error':'文件读取失败'},400)
        with LOCK:JOBS[job]={'state':'running'}
        EXECUTOR.submit(run_job,job,path);return self.respond({'job':job},202)

def re_id(s):return len(s)==32 and all(c in '0123456789abcdef' for c in s)

class LocalService:
    def __init__(self,port=0):
        self.http=ThreadingHTTPServer(('127.0.0.1',port),Handler)
        self.http.daemon_threads=True
        self.http.request_stop=self.request_stop
        self.url=f'http://127.0.0.1:{self.http.server_port}/'
        self.on_stop=None
        self.closed=threading.Event()
        self.thread=None
        self.close_lock=threading.Lock()

    def start(self):
        self.thread=threading.Thread(target=self.http.serve_forever,kwargs={'poll_interval':0.1},daemon=True)
        self.thread.start()
        (RUNTIME/'session.json').write_text(json.dumps({'url':self.url,'pid':os.getpid()}),encoding='utf-8')

    def request_stop(self):
        if self.on_stop:self.on_stop()
        else:self.close()

    def close(self):
        with self.close_lock:
            if self.closed.is_set():return
            self.closed.set()
            STOP_EVENT.set()
            if self.thread and self.thread.is_alive():
                self.http.shutdown()
                self.thread.join(timeout=5)
            self.http.server_close()
            EXECUTOR.shutdown(wait=True,cancel_futures=True)
            session=RUNTIME/'session.json'
            try:
                if json.loads(session.read_text(encoding='utf-8')).get('url')==self.url:session.unlink()
            except (OSError,ValueError):pass


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--no-browser',action='store_true');ap.add_argument('--port',type=int,default=0);args=ap.parse_args()
    service=LocalService(args.port)
    service.start()
    if sys.stdout is not None:print(service.url,flush=True)
    try:service.closed.wait()
    finally:service.close()

if __name__=='__main__':main()
