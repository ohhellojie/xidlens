"""仅监听本机的离线界面；不向外部服务发送日志。"""
from __future__ import annotations
import argparse, concurrent.futures, json, os, secrets, select, sys, threading, uuid
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

class ImportJob:
    def __init__(self):
        self.cancelled=threading.Event()
        self.result={'state':'ready','phase':'uploading','bytes':0,'lines':0,'totalBytes':None}
        self.future=None
        self.path=None

    def is_set(self):return self.cancelled.is_set() or STOP_EVENT.is_set()

    def progress(self, values):
        core.check_cancel(self)
        with LOCK:
            if self.result['state']!='cancelling':self.result.update(values)

    def cleanup(self):
        if self.path:
            self.path.unlink(missing_ok=True)
            try:self.path.parent.rmdir()
            except OSError:pass

    def cancel(self):
        with LOCK:
            if self.result['state'] in {'done','error','cancelled'}:return
            self.cancelled.set()
            previous=self.result['state']
            self.result['state']='cancelling'
            queued=self.future is not None and self.future.cancel()
        if previous=='ready' or queued:
            self.cleanup()
            with LOCK:self.result['state']='cancelled'


def save_cases(cases, job):
    # Prepare all reports before publishing any, so cancellation keeps prior results intact.
    identities={}
    for p in RESULTS.glob('*.json'):
        core.check_cancel(job)
        try:
            old=json.loads(p.read_text(encoding='utf-8'))
            if old.get('contentSha256'):identities[(old['contentSha256'],old['source'],json.dumps(old.get('catalog'),sort_keys=True))]=old['id']
        except (ValueError,KeyError):continue
    staged={};backups={};published=[];committed=False
    try:
        for case in cases:
            core.check_cancel(job)
            key=(case.get('contentSha256'),case['source'],json.dumps(case.get('catalog'),sort_keys=True))
            case_id=identities.get(key) if key[0] else None
            case_id=case_id or uuid.uuid4().hex
            if key[0]:identities[key]=case_id
            case['id']=case_id
            target=job.path.parent/(case_id+'.pending')
            staged[case_id]=target
            with target.open('w',encoding='utf-8') as f:
                parts=[];size=0
                for part in json.JSONEncoder(ensure_ascii=False).iterencode(case):
                    parts.append(part);size+=len(part)
                    if size>=65536:
                        core.check_cancel(job);f.write(''.join(parts));parts=[];size=0
                core.check_cancel(job);f.write(''.join(parts))
        with LOCK:
            core.check_cancel(job)
            try:
                for case_id,temporary in staged.items():
                    target=RESULTS/(case_id+'.json')
                    if target.exists():
                        backup=job.path.parent/(case_id+'.backup');target.replace(backup);backups[case_id]=backup
                    temporary.replace(target);published.append(case_id)
            except Exception:
                for case_id in published:(RESULTS/(case_id+'.json')).unlink(missing_ok=True)
                for case_id,backup in backups.items():backup.replace(RESULTS/(case_id+'.json'))
                raise
            job.result.update(state='done',phase='done',ids=list(staged))
            committed=True
        return list(staged)
    finally:
        for p in staged.values():p.unlink(missing_ok=True)
        if committed:
            for p in backups.values():p.unlink(missing_ok=True)


def case_list():
    cases=[]
    for p in sorted(RESULTS.glob('*.json'),key=lambda p:p.stat().st_mtime):
        try:
            d=json.loads(p.read_text(encoding='utf-8'));cases.append({'id':d['id'],'source':d['source'],'gpus':len(d['gpus']),'events':len(d['events']),'complete':d['complete'],'collected':d.get('server',{}).get('time','')})
        except (ValueError,KeyError):continue
    return cases

def run_job(job):
    try:
        job.progress({'state':'running','phase':'parsing','source':job.path.name,'bytes':0,'lines':0,'totalBytes':None})
        cases=analyze(job.path,cancel_event=job,progress=job.progress)
        if not cases:raise ValueError('没有可读取的报告')
        job.progress({'phase':'saving'})
        save_cases(cases,job)
    except core.AnalysisCancelled:
        with LOCK:job.result.update(state='cancelled')
    except Exception as exc:
        with LOCK:job.result.update(state='error',message=f'解析失败：{type(exc).__name__} · {exc}')
    finally:job.cleanup()


class Handler(BaseHTTPRequestHandler):
    rbufsize=0
    def log_message(self,*args):pass
    def allowed(self):return self.headers.get('Host')==f'127.0.0.1:{self.server.server_port}'
    def authenticated(self):return self.allowed() and secrets.compare_digest(self.headers.get('X-Local-Token',''),TOKEN)
    def respond(self,data,status=200,ctype='application/json; charset=utf-8'):
        body=json.dumps(data,ensure_ascii=False).encode('utf-8') if ctype.startswith('application/json') else data
        self.send_response(status);self.send_header('Content-Type',ctype);self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        try:self.end_headers();self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
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
            with LOCK:
                job=JOBS.get(url.path.rsplit('/',1)[-1]);d=dict(job.result) if job else {'state':'error','message':'任务不存在'}
            return self.respond(d)
        return self.respond({'error':'不存在的资源'},404)
    def do_POST(self):
        url=urlparse(self.path)
        if not self.authenticated():return self.respond({'error':'拒绝访问'},403)
        origin=self.headers.get('Origin')
        if origin and origin!=f'http://127.0.0.1:{self.server.server_port}':return self.respond({'error':'拒绝跨站请求'},403)
        if url.path=='/api/stop':
            self.respond({'ok':True});threading.Thread(target=self.server.request_stop,daemon=True).start();return
        if url.path=='/api/import/start':
            key=uuid.uuid4().hex
            with LOCK:JOBS[key]=ImportJob()
            return self.respond({'job':key},201)
        if url.path.startswith('/api/job/') and url.path.endswith('/cancel'):
            key=url.path.split('/')[-2]
            with LOCK:job=JOBS.get(key)
            if not job:return self.respond({'error':'任务不存在'},404)
            job.cancel()
            with LOCK:result=dict(job.result)
            return self.respond(result)
        if url.path!='/api/import':return self.respond({'error':'不存在的资源'},404)
        try:length=int(self.headers.get('Content-Length','0'))
        except ValueError:return self.respond({'error':'无效文件长度'},400)
        if not 0<length<=512*1024*1024:return self.respond({'error':'请选择 512 MB 以内的文件'},413)
        query=parse_qs(url.query)
        name=Path(query.get('name',['log.txt'])[0].replace('\\','/')).name
        if not name or name in ('.','..') or '\x00' in name:return self.respond({'error':'无效文件名'},400)
        key=query.get('job',[''])[0]
        with LOCK:
            if not key:key=uuid.uuid4().hex;JOBS[key]=ImportJob()
            job=JOBS.get(key)
            if job is None or job.result['state']!='ready':job=None
            else:job.result.update(state='uploading',totalBytes=length)
        if job is None:return self.respond({'error':'导入任务已结束'},409)
        folder=UPLOADS/key
        try:
            folder.mkdir();job.path=folder/name
            with job.path.open('wb') as f:
                left=length
                while left:
                    core.check_cancel(job)
                    if not select.select([self.connection],[],[],.2)[0]:continue
                    chunk=self.rfile.read(min(left,1024*1024))
                    core.check_cancel(job)
                    if not chunk:raise ValueError('文件传输中断')
                    f.write(chunk);left-=len(chunk)
                    job.progress({'bytes':length-left})
            with LOCK:
                core.check_cancel(job)
                job.result.update(state='queued',phase='queued')
                job.future=EXECUTOR.submit(run_job,job)
        except Exception as exc:
            job.cleanup()
            with LOCK:
                job.result.update(state='cancelled' if job.is_set() else 'error',message='文件读取失败')
            return self.respond({'error':'已取消' if job.is_set() else '文件读取失败'},409 if job.is_set() else 400)
        return self.respond({'job':key},202)


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
            with LOCK:jobs=list(JOBS.values())
            for job in jobs:job.cancel()
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
