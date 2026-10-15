"""仅监听本机的离线界面；不向外部服务发送日志。"""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, json, os, secrets, select, sys, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
sys.dont_write_bytecode=True
from parser import analyze, core, CATALOG, CATALOG_WARNING
from catalog import CatalogStore, MAX_UPLOAD
from online import OnlineUpdates
from knowledge import KnowledgeStore
from version import VERSION
import recovery

ROOT=Path(__file__).resolve().parent
APP_HOME=Path(sys.executable).resolve().parent if getattr(sys,'frozen',False) else ROOT
RUNTIME=Path(os.environ.get('GPU_LOG_DATA_DIR',str(APP_HOME/'runtime'))).resolve();RESULTS=RUNTIME/'results';UPLOADS=RUNTIME/'uploads'
SOURCES=RUNTIME/'sources'
for p in (RUNTIME,RESULTS,UPLOADS,SOURCES):p.mkdir(parents=True,exist_ok=True)
TOKEN=secrets.token_urlsafe(24);JOBS={};LOCK=threading.Lock()
EXECUTOR=concurrent.futures.ThreadPoolExecutor(max_workers=1)
STOP_EVENT=threading.Event()
RESULTS_LOCK=threading.RLock()
CASE_CACHE={}
RECOVERY={'recovered':0,'interrupted':0,'pending':0}
INVALID_REPORTS=[]
CATALOG_STORE=CatalogStore(RUNTIME,CATALOG,CATALOG_WARNING)
ONLINE=OnlineUpdates(RUNTIME,CATALOG_STORE)
KNOWLEDGE=KnowledgeStore(RUNTIME)

def cleanup_file(path):
    try:path.unlink(missing_ok=True)
    except OSError:pass

class ImportJob:
    def __init__(self):
        self.cancelled=threading.Event()
        self.result={'state':'ready','phase':'uploading','bytes':0,'lines':0,'totalBytes':None}
        self.future=None
        self.path=None
        self.catalog=CATALOG_STORE.snapshot()
        self.target=None
        self.input_ref=None
        self.new_source=None

    def is_set(self):return self.cancelled.is_set() or STOP_EVENT.is_set()

    def progress(self, values):
        core.check_cancel(self)
        with LOCK:
            if self.result['state']!='cancelling':self.result.update(values)

    def cleanup(self):
        if self.path and (self.path.parent/'transaction.json').exists():return
        if self.new_source and self.result['state']!='done':cleanup_file(self.new_source)
        if self.path:
            cleanup_file(self.path)
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
    with RESULTS_LOCK:
        return _save_cases(cases,job)

def _save_cases(cases, job):
    # Prepare all reports before publishing any, so cancellation keeps prior results intact.
    identities={};old_sources=[]
    if job.target:
        old,stamp=job.target
        path=RESULTS/(old['id']+'.json')
        if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=stamp:
            raise ValueError('报告已变更，请刷新后重试')
    for p in RESULTS.glob('*.json'):
        core.check_cancel(job)
        try:
            old=json.loads(p.read_text(encoding='utf-8'))
            if old.get('input'):old_sources.append(old['input'])
            if old.get('contentSha256'):identities[(old['contentSha256'],old['source'],json.dumps(old.get('catalog'),sort_keys=True))]=old['id']
        except (OSError,ValueError,KeyError,TypeError,AttributeError):continue
    staged={};committed=False
    try:
        for case in cases:
            core.check_cancel(job)
            key=(case.get('contentSha256'),case['source'],json.dumps(case.get('catalog'),sort_keys=True))
            case_id=job.target[0]['id'] if job.target else identities.get(key) if key[0] else None
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
                f.flush();os.fsync(f.fileno())
        with LOCK:
            core.check_cancel(job)
            recovery.prepare(job.path.parent,RESULTS,staged)
            try:
                for case_id,temporary in staged.items():
                    target=RESULTS/(case_id+'.json')
                    temporary.replace(target)
                    CASE_CACHE.pop(case_id,None)
                recovery.settle(job.path.parent,RESULTS,commit=True)
            except Exception:
                try:recovery.settle(job.path.parent,RESULTS)
                except Exception:
                    RECOVERY['pending']+=1
                    raise
                raise
            job.result.update(state='done',phase='done',ids=list(staged))
            committed=True
        return list(staged)
    finally:
        journal=job.path.parent/'transaction.json'
        if journal.exists():
            try:
                if json.loads(journal.read_text(encoding='utf-8'))['state'] in ('committed','rolledback'):
                    recovery.clean_folder(job.path.parent)
            except (OSError,ValueError,KeyError):pass
        else:
            for p in staged.values():cleanup_file(p)
            for p in job.path.parent.glob('*.backup'):cleanup_file(p)
        if committed:
            prune_sources(old_sources)


def read_case(key):
    if not isinstance(key,str) or not re_id(key):raise ValueError('报告不存在')
    path=RESULTS/(key+'.json')
    if path.is_symlink() or path.resolve().parent!=RESULTS:raise ValueError('报告不存在')
    raw=path.read_bytes();report=json.loads(raw);report['id']=key
    return report,hashlib.sha256(raw).hexdigest()


def source_path(ref):
    if not isinstance(ref,dict) or not isinstance(ref.get('key'),str) or not re_id(ref['key']):return None
    name=ref.get('name')
    if not isinstance(name,str) or not name or name in ('.','..') or any(c in name for c in '/\\\x00:'):return None
    path=SOURCES/ref['key']
    if path.is_symlink() or path.resolve().parent!=SOURCES or not path.is_file():return None
    return path


def prune_sources(refs):
    # Only remove known, unreferenced application copies, never original user files.
    used=set()
    try:
        for p in RESULTS.glob('*.json'):
            d=json.loads(p.read_text(encoding='utf-8'));ref=d.get('input') or {}
            if isinstance(ref,dict):used.add(ref.get('key'))
    except (OSError,ValueError,TypeError,AttributeError):return
    for ref in refs:
        path=source_path(ref)
        if path and ref['key'] not in used:
            try:path.unlink()
            except OSError:pass


def copy_input(source,target,job):
    total=source.stat().st_size;done=0
    with source.open('rb') as src,target.open('wb') as dst:
        while True:
            core.check_cancel(job)
            chunk=src.read(1024*1024)
            if not chunk:break
            dst.write(chunk);done+=len(chunk)
            job.progress({'phase':'copying','bytes':done,'totalBytes':total})


def reparse_job(key,use_file=False):
    with RESULTS_LOCK:target=read_case(key)
    if not target[0].get('contentSha256'):raise ValueError('报告缺少文件校验信息，请重新导入')
    job=ImportJob();job.target=target
    cached=None if use_file else source_path(target[0].get('input'))
    job_key=uuid.uuid4().hex
    with LOCK:
        JOBS[job_key]=job
        if cached:
            job.input_ref=target[0]['input']
            job.result.update(state='queued',phase='queued')
            job.future=EXECUTOR.submit(run_cached_job,job,cached)
    return {'job':job_key,'needsFile':cached is None}


def run_cached_job(job,cached):
    try:
        core.check_cancel(job)
        folder=UPLOADS/uuid.uuid4().hex;folder.mkdir();job.path=folder/job.input_ref['name']
        job.progress({'state':'running','phase':'copying'})
        copy_input(cached,job.path,job)
        run_job(job)
    except core.AnalysisCancelled:
        with LOCK:job.result.update(state='cancelled')
    except OSError:
        with LOCK:job.result.update(state='error',message='原日志无法读取，请重新选择文件')
    finally:job.cleanup()


def case_list():
    with RESULTS_LOCK:
        INVALID_REPORTS.clear()
        cases=[];seen=set()
        for p in RESULTS.glob('*.json'):
            if not re_id(p.stem) or p.is_symlink() or p.resolve().parent!=RESULTS:continue
            try:
                stat=p.stat();stamp=(stat.st_mtime_ns,stat.st_size);seen.add(p.stem)
                cached=CASE_CACHE.get(p.stem)
                if cached and cached[0]==stamp:summary=cached[1]
                else:
                    d=json.loads(p.read_text(encoding='utf-8'));server=d.get('server') or {}
                    summary={'id':p.stem,'source':d['source'],'gpus':len(d['gpus']),'events':len(d['events']),
                             'complete':d.get('complete',True),'collected':server.get('time',''),
                             'server':{k:(server.get(k) or '') for k in ('sn','model','time')},
                             'identities':[{k:(g.get(k) or '') for k in ('label','sn','uuid')} for g in d['gpus']],
                             'bytes':d.get('bytes'),'modified':stat.st_mtime}
                    CASE_CACHE[p.stem]=(stamp,summary)
                cases.append(summary)
            except (OSError,ValueError,KeyError,TypeError,AttributeError):INVALID_REPORTS.append(p.stem)
        for key in set(CASE_CACHE)-seen:CASE_CACHE.pop(key,None)
        return sorted(cases,key=lambda d:(d['modified'],d['id']))

def delete_cases(ids):
    if not isinstance(ids,list) or not 0<len(ids)<=1000 or any(not isinstance(key,str) or not re_id(key) for key in ids):
        raise ValueError('请选择有效报告（最多 1000 份）')
    deleted=[];failed=[];refs=[]
    with RESULTS_LOCK:
        for key in dict.fromkeys(ids):
            path=RESULTS/(key+'.json')
            try:
                if path.is_symlink() or path.resolve().parent!=RESULTS:raise OSError('Invalid report path')
                try:refs.append(json.loads(path.read_text(encoding='utf-8')).get('input'))
                except (OSError,ValueError,AttributeError):pass
                path.unlink(missing_ok=True)
                CASE_CACHE.pop(key,None);deleted.append(key)
            except OSError:failed.append(key)
        prune_sources(refs)
    return {'deleted':deleted,'failed':failed}

def run_job(job):
    try:
        if RECOVERY['pending']:raise ValueError('报告恢复未完成，请重启后重试')
        job.progress({'state':'running','phase':'parsing','source':job.path.name,'bytes':0,'lines':0,'totalBytes':None})
        cases=analyze(job.path,cancel_event=job,progress=job.progress,catalog=job.catalog)
        if not cases:raise ValueError('没有可读取的报告')
        if job.target:
            old=job.target[0]
            matches=[c for c in cases if c.get('contentSha256')==old['contentSha256']]
            if len(matches)>1:
                member=old['source'].partition('!')[2]
                matches=[c for c in matches if c['source'].partition('!')[2]==member]
            if len(matches)!=1:raise ValueError('文件内容与原报告不符，请重新选择')
            case=matches[0]
            if not case.get('complete',True):raise ValueError('日志读取不完整，已保留原报告')
            case['source']=old['source']
            for event in case['events']:event['source']=old['source']
            cases=[case]
        if not job.input_ref:
            source_key=uuid.uuid4().hex
            job.new_source=SOURCES/source_key
            copy_input(job.path,job.new_source,job)
            job.input_ref={'key':source_key,'name':job.path.name}
        for case in cases:case['input']=job.input_ref
        job.progress({'phase':'saving'})
        save_cases(cases,job)
    except core.AnalysisCancelled:
        with LOCK:job.result.update(state='cancelled')
    except Exception as exc:
        message=(str(exc) if isinstance(exc,ValueError) else '重新解析失败，请重试') if job.target else f'解析失败：{type(exc).__name__} · {exc}'
        with LOCK:job.result.update(state='error',message=message)
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
        if url.path=='/':return self.respond((ROOT/'index.html').read_text(encoding='utf-8').replace('__LOCAL_TOKEN__',TOKEN).replace('__APP_VERSION__',VERSION).encode(),ctype='text/html; charset=utf-8')
        if url.path=='/analysis.js':return self.respond((ROOT/'analysis.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path=='/knowledge.js':return self.respond((ROOT/'knowledge'/'knowledge.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path=='/app.js':return self.respond((ROOT/'app.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path=='/logo.png':return self.respond((ROOT/'logo.png').read_bytes(),ctype='image/png')
        if not self.authenticated():return self.respond({'error':'会话已失效，请重新打开程序'},403)
        if url.path=='/api/knowledge/content':return self.respond(KNOWLEDGE.content())
        if url.path=='/api/knowledge/status':return self.respond(KNOWLEDGE.status())
        if url.path=='/api/online':return self.respond(ONLINE.snapshot())
        if url.path=='/api/catalog':return self.respond(CATALOG_STORE.info())
        if url.path=='/api/catalog/rules':
            catalog=CATALOG_STORE.snapshot()
            return self.respond({'rules':[dict(code=key,**value) for key,value in sorted(catalog['codes'].items(),key=lambda item:int(item[0]))],'catalog':{k:v for k,v in catalog.items() if k!='codes'}})
        if url.path=='/api/cases':return self.respond({'cases':case_list(),'recovery':RECOVERY,'unreadable':len(INVALID_REPORTS)})
        if url.path=='/api/reparse/source':
            try:
                with RESULTS_LOCK:report,_=read_case(parse_qs(url.query).get('id',[''])[0])
                return self.respond({'available':source_path(report.get('input')) is not None})
            except (OSError,ValueError):return self.respond({'error':'报告不存在'},404)
        if url.path.startswith('/api/case/'):
            key=url.path.rsplit('/',1)[-1]
            if not re_id(key):return self.respond({'error':'不存在的记录'},404)
            path=RESULTS/(key+'.json')
            with RESULTS_LOCK:
                try:
                    if not path.is_symlink() and path.resolve().parent==RESULTS and path.is_file():
                        return self.respond(path.read_bytes(),ctype='application/octet-stream')
                except OSError:return self.respond({'error':'报告读取失败'},500)
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
        if url.path.startswith('/api/knowledge/'):
            parts=url.path.split('/')
            try:
                if len(parts)!=5:raise ValueError('无效资料操作')
                KNOWLEDGE.start(parts[3],parts[4]);return self.respond(KNOWLEDGE.status())
            except ValueError as exc:return self.respond({'error':str(exc)},400)
        if RECOVERY['pending'] and (url.path.startswith(('/api/import','/api/reparse')) or url.path=='/api/cases/delete'):
            return self.respond({'error':'报告恢复未完成，请检查目录权限后重启'},503)
        if url.path.startswith('/api/online/'):
            action=url.path.rsplit('/',1)[-1]
            try:
                if action=='enable':ONLINE.settings_save(True)
                elif action=='disable':ONLINE.settings_save(False)
                elif action=='cancel':ONLINE.cancel.set()
                else:ONLINE.start(action)
                return self.respond(ONLINE.snapshot())
            except ValueError as exc:return self.respond({'error':str(exc)},400)
            except OSError:return self.respond({'error':'设置保存失败'},500)
        if url.path in ('/api/catalog/reset','/api/catalog/import'):
            with ONLINE.lock:
                if 'rules' in ONLINE.active:return self.respond({'error':'请等待规则操作结束'},409)
        if url.path=='/api/catalog/reset':
            try:return self.respond(CATALOG_STORE.reset())
            except OSError:return self.respond({'error':'规则保存失败，请重试'},500)
        if url.path=='/api/catalog/import':
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=MAX_UPLOAD:return self.respond({'error':'请选择 10 MB 以内的规则文件'},413)
                self.connection.settimeout(20)
                chunks=[];left=length
                while left:
                    chunk=self.rfile.read(min(left,1024*1024))
                    if not chunk:raise ValueError('文件读取未完成')
                    chunks.append(chunk);left-=len(chunk)
                name=parse_qs(url.query).get('name',[''])[0]
                return self.respond(CATALOG_STORE.import_file(b''.join(chunks),name))
            except ValueError as exc:return self.respond({'error':str(exc)},400)
            except OSError:return self.respond({'error':'规则读取或保存失败，请重试'},500)
            finally:self.connection.settimeout(None)
        if url.path=='/api/cases/delete':
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=65536:raise ValueError('无效请求长度')
                self.connection.settimeout(5)
                chunks=[];remaining=length
                while remaining:
                    chunk=self.rfile.read(remaining)
                    if not chunk:raise ValueError('请求未完成')
                    chunks.append(chunk);remaining-=len(chunk)
                body=json.loads(b''.join(chunks))
                if not isinstance(body,dict):raise ValueError('无效请求')
                result=delete_cases(body.get('ids'))
            except (ValueError,UnicodeError):return self.respond({'error':'请选择有效报告（最多 1000 份）'},400)
            except OSError:return self.respond({'error':'删除请求未完成，请重试'},400)
            finally:self.connection.settimeout(None)
            return self.respond(result)
        if url.path=='/api/stop':
            self.respond({'ok':True});threading.Thread(target=self.server.request_stop,daemon=True).start();return
        if url.path=='/api/import/start':
            key=uuid.uuid4().hex
            with LOCK:JOBS[key]=ImportJob()
            return self.respond({'job':key},201)
        if url.path=='/api/reparse/start':
            query=parse_qs(url.query)
            try:return self.respond(reparse_job(query.get('id',[''])[0],query.get('file',['0'])[0]=='1'),201)
            except (OSError,ValueError) as exc:return self.respond({'error':str(exc)},400)
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
        RECOVERY.update(recovery.recover(RUNTIME))
        ONLINE.schedule()
        self.thread=threading.Thread(target=self.http.serve_forever,kwargs={'poll_interval':0.1},daemon=True)
        self.thread.start()
        (RUNTIME/'session.json').write_text(json.dumps({'url':self.url,'pid':os.getpid()}),encoding='utf-8')

    def mark_ready(self):
        import update_install
        update_install.mark_ready(APP_HOME)

    def request_stop(self):
        if self.on_stop:self.on_stop()
        else:self.close()

    def close(self):
        with self.close_lock:
            if self.closed.is_set():return
            self.closed.set()
            ONLINE.stop.set();ONLINE.cancel.set()
            KNOWLEDGE.close()
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
    service.mark_ready()
    if sys.stdout is not None:print(service.url,flush=True)
    try:service.closed.wait()
    finally:service.close()

if __name__=='__main__':main()
