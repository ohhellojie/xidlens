"""仅监听本机；模型辅助只发送用户明确确认的证据预览。"""
from __future__ import annotations
import argparse, concurrent.futures, errno, hashlib, json, os, secrets, select, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
sys.dont_write_bytecode=True
from parser import analyze, core, CATALOG, CATALOG_WARNING
from catalog import CatalogStore, MAX_UPLOAD
from online import OnlineUpdates
from knowledge import KnowledgeStore
from version import VERSION
from report_data import normalize_report
from log_reader import LogStore
from sessions import SessionStore
from evidence import EvidenceError, EvidenceStore
import assistant
import recovery

ROOT=Path(__file__).resolve().parent
APP_HOME=Path(sys.executable).resolve().parent if getattr(sys,'frozen',False) else ROOT
RUNTIME=Path(os.environ.get('GPU_LOG_DATA_DIR',str(APP_HOME/'runtime'))).resolve();RESULTS=RUNTIME/'results';UPLOADS=RUNTIME/'uploads'
SOURCES=RUNTIME/'sources'
for p in (RUNTIME,RESULTS,UPLOADS,SOURCES):p.mkdir(parents=True,exist_ok=True)
TOKEN=secrets.token_urlsafe(24);JOBS={};LOCK=threading.Lock()
MAX_JOBS=128
IMPORT_IDLE_TIMEOUT=30
JSON_BODY_TIMEOUT=5
EXECUTOR=concurrent.futures.ThreadPoolExecutor(max_workers=1)
STOP_EVENT=threading.Event()
RESULTS_LOCK=threading.RLock()
ASSISTANT_LOCK=threading.Lock()
CASE_CACHE={}
RECOVERY={'recovered':0,'interrupted':0,'pending':0}
INVALID_REPORTS=[]
CATALOG_STORE=CatalogStore(RUNTIME,CATALOG,CATALOG_WARNING)
ONLINE=OnlineUpdates(RUNTIME,CATALOG_STORE)
KNOWLEDGE=KnowledgeStore(RUNTIME)

def sidebar_pinned():
    try:return json.loads((RUNTIME/'ui-settings.json').read_text(encoding='utf-8')).get('sidebarPinned',True) is not False
    except (OSError,ValueError,AttributeError):return True

def cleanup_file(path):
    try:path.unlink(missing_ok=True)
    except OSError:pass

def import_error(exc):
    if isinstance(exc,TimeoutError):return '文件传输超时，请重试'
    if isinstance(exc,PermissionError):return '无法读写文件，请检查目录权限或文件占用'
    if isinstance(exc,OSError):
        if exc.errno==errno.ENOSPC or getattr(exc,'winerror',None)==112:return '磁盘空间不足，原有报告已保留'
        return '文件读取或保存失败，请检查磁盘和文件状态'
    return str(exc) if isinstance(exc,ValueError) else '日志处理失败，请重试或重新选择原始日志'

def register_job(job):
    # Caller holds LOCK. Keep active jobs and bound completed job history.
    for key,old in list(JOBS.items()):
        if old.result['state']=='ready' and time.monotonic()-old.created>300:
            JOBS.pop(key)
    for key,old in list(JOBS.items()):
        if len(JOBS)<MAX_JOBS:break
        if old.result['state'] in {'done','error','cancelled'}:JOBS.pop(key)
    if len(JOBS)>=MAX_JOBS:raise ValueError('待处理任务过多，请等待当前任务结束')
    key=uuid.uuid4().hex;JOBS[key]=job;return key

class ImportJob:
    def __init__(self):
        self.created=time.monotonic()
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
        if self.result['state'] in {'done','error','cancelled'}:
            self.catalog=None;self.target=None
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
            with LOCK:self.result['state']='cancelled'
            self.cleanup()


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
                    READER.drop(case_id)
                    READER_SOURCES.pop(case_id,None)
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
    raw=path.read_bytes()
    try:report=normalize_report(json.loads(raw))
    except (ValueError,RecursionError) as exc:raise ValueError('报告数据损坏，请重新导入原日志') from exc
    report['id']=key
    return report,hashlib.sha256(raw).hexdigest()


def session_report(key):
    # SessionStore holds its own lock before calling this reader. Never acquire
    # a session lock while holding RESULTS_LOCK elsewhere in the server.
    with RESULTS_LOCK:return read_case(key)


SESSIONS=SessionStore(RUNTIME/'sessions',session_report)


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
    with LOCK:
        job_key=register_job(job)
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
                    d=normalize_report(json.loads(p.read_text(encoding='utf-8')));server=d['server']
                    summary={'id':p.stem,'source':d['source'],'gpus':len(d['gpus']),'events':len(d['events']),
                             'complete':d.get('complete',True),'collected':server.get('time',''),
                             'server':{k:(server.get(k) or '') for k in ('sn','model','time')},
                             'identities':[{k:(g.get(k) or '') for k in ('label','sn','uuid')} for g in d['gpus']],
                             'bytes':d.get('bytes'),'modified':stat.st_mtime}
                    CASE_CACHE[p.stem]=(stamp,summary)
                cases.append(summary)
            except (OSError,ValueError,KeyError,TypeError,AttributeError,RecursionError):INVALID_REPORTS.append(p.stem)
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
                CASE_CACHE.pop(key,None);READER.drop(key);READER_SOURCES.pop(key,None);deleted.append(key)
            except OSError:failed.append(key)
        prune_sources(refs)
    # A save holding the evidence lock either fails its final report check or
    # finishes before this cleanup. Never acquire that lock under RESULTS_LOCK.
    cleanup_failed=[]
    for key in deleted:
        try:EVIDENCE.remove_report(key)
        except Exception:cleanup_failed.append(key)
    result={'deleted':deleted,'failed':failed}
    if cleanup_failed:result['evidenceCleanupFailed']=cleanup_failed
    return result

def run_job(job):
    try:
        if RECOVERY['pending']:raise ValueError('报告恢复未完成，请重启后重试')
        job.progress({'state':'running','phase':'parsing','source':job.path.name,'bytes':0,'lines':0,'totalBytes':None})
        cases=analyze(job.path,cancel_event=job,progress=job.progress,catalog=job.catalog)
        recognized=[case for case in cases if case.get('recognized')]
        if not recognized:raise ValueError('未识别到 GPU、PCIe 或系统日志内容，请选择原始日志或命令输出')
        skipped=len(cases)-len(recognized)
        cases=recognized
        if skipped:
            for case in cases:case['warnings'].append(f'压缩包中有 {skipped} 个文件未识别到日志内容，已跳过')
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
        message=import_error(exc)
        with LOCK:job.result.update(state='error',message=message)
    finally:job.cleanup()


READER_SOURCES={}
def reader_source(key):
    # Avoid reparsing a large JSON report for every small viewport request.
    with RESULTS_LOCK:
        report_path=RESULTS/(key+'.json')
        if report_path.is_symlink() or not report_path.is_file():raise ValueError('报告不存在')
        stat=report_path.stat();stamp=(stat.st_mtime_ns,stat.st_size)
        cached=READER_SOURCES.get(key)
        if not cached or cached[0]!=stamp:
            report,_=read_case(key)
            ref=report.get('input');path=source_path(ref)
            if path is None:raise ValueError('原日志副本不存在，请重新导入日志')
            report={k:report.get(k) for k in ('input','source','sourceMember','contentSha256','events','lines')}
            cached=(stamp,path,report)
            READER_SOURCES[key]=cached
            while len(READER_SOURCES)>4:READER_SOURCES.pop(next(iter(READER_SOURCES)))
        _,path,report=cached
        if source_path(report['input'])!=path:raise ValueError('原日志副本不存在，请重新导入日志')
        source_stat=path.stat()
        revision=hashlib.sha256(json.dumps([stamp,source_stat.st_mtime_ns,source_stat.st_size,report['input'],report['sourceMember']]).encode()).hexdigest()[:24]
        return path,report,revision

READER=LogStore(RUNTIME/'reader-cache',reader_source)

def evidence_source(key):
    # Keep identity fields for redaction and use the reader's revision for lines.
    # EvidenceStore acquires its own lock before resolving; never call it while
    # holding RESULTS_LOCK from another server path.
    with RESULTS_LOCK:
        report,_=read_case(key)
        path,_,revision=reader_source(key)
        return path,report,revision

EVIDENCE=EvidenceStore(RUNTIME/'evidence',evidence_source,READER.lines)

class Handler(BaseHTTPRequestHandler):
    rbufsize=0
    def log_message(self,*args):pass
    def allowed(self):return self.headers.get('Host')==f'127.0.0.1:{self.server.server_port}'
    def authenticated(self):return self.allowed() and secrets.compare_digest(self.headers.get('X-Local-Token',''),TOKEN)
    def assistant_authenticated(self):
        origins=self.headers.get_all('Origin',[])
        return (len(self.headers.get_all('Host',[]))==1 and len(self.headers.get_all('X-Local-Token',[]))==1
                and len(origins)<=1 and (not origins or origins[0]==f'http://127.0.0.1:{self.server.server_port}') and self.authenticated())
    def read_json_body(self,limit=8192):
        lengths=self.headers.get_all('Content-Length',[])
        if len(lengths)!=1 or not lengths[0].isascii() or not lengths[0].isdecimal() or self.headers.get('Transfer-Encoding'):
            raise ValueError('无效请求长度')
        length=int(lengths[0])
        if not 0<length<=limit:raise ValueError('无效请求长度')
        old_timeout=self.connection.gettimeout();deadline=time.monotonic()+JSON_BODY_TIMEOUT
        try:
            chunks=[];remaining=length
            while remaining:
                wait=deadline-time.monotonic()
                if wait<=0:raise TimeoutError('request timeout')
                self.connection.settimeout(wait)
                chunk=self.rfile.read(min(remaining,8192))
                if not chunk:raise ValueError('请求未完成')
                chunks.append(chunk);remaining-=len(chunk)
            def pairs(items):
                result={}
                for key,value in items:
                    if key in result:raise ValueError('重复字段')
                    result[key]=value
                return result
            def constant(value):raise ValueError('无效数字')
            body=json.loads(b''.join(chunks),object_pairs_hook=pairs,parse_constant=constant)
            if not isinstance(body,dict):raise ValueError('无效请求')
            return body
        finally:self.connection.settimeout(old_timeout)
    def respond(self,data,status=200,ctype='application/json; charset=utf-8'):
        body=json.dumps(data,ensure_ascii=False).encode('utf-8') if ctype.startswith('application/json') else data
        self.send_response(status);self.send_header('Content-Type',ctype);self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        try:self.end_headers();self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
    def do_GET(self):
        url=urlparse(self.path)
        if url.path.startswith('/api/assistant/') and not self.assistant_authenticated():return self.respond({'error':'拒绝访问','code':'forbidden'},403)
        if not self.allowed():return self.respond({'error':'拒绝访问'},403)
        if url.path=='/':return self.respond((ROOT/'index.html').read_text(encoding='utf-8').replace('__LOCAL_TOKEN__',TOKEN).replace('__APP_VERSION__',VERSION).replace('__SIDEBAR_PINNED__',str(sidebar_pinned()).lower()).encode(),ctype='text/html; charset=utf-8')
        if url.path=='/reader.js':return self.respond((ROOT/'reader'/'reader.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path in ('/overview.js','/overview.css','/sessions.js','/sessions.css','/timeline.js','/timeline.css','/comparison.js','/evidence.js','/evidence.css','/assistant.js','/assistant.css','/structured.js','/structured.css','/demo.txt'):
            kind='application/javascript' if url.path.endswith('.js') else 'text/css' if url.path.endswith('.css') else 'text/plain'
            return self.respond((ROOT/url.path[1:]).read_bytes(),ctype=kind+'; charset=utf-8')
        if url.path=='/diagnostics.js':return self.respond((ROOT/'diagnostics.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path=='/diagnostics.css':return self.respond((ROOT/'diagnostics.css').read_bytes(),ctype='text/css; charset=utf-8')
        if url.path=='/analysis.js':return self.respond((ROOT/'analysis.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path=='/knowledge.js':return self.respond((ROOT/'knowledge'/'knowledge.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path=='/app.js':return self.respond((ROOT/'app.js').read_bytes(),ctype='application/javascript; charset=utf-8')
        if url.path=='/logo.png':return self.respond((ROOT/'logo.png').read_bytes(),ctype='image/png')
        if not self.authenticated():return self.respond({'error':'会话已失效，请重新打开程序'},403)
        if url.path=='/api/assistant/protocol':
            origin=self.headers.get('Origin')
            if origin and origin!=f'http://127.0.0.1:{self.server.server_port}':return self.respond({'error':'拒绝跨站请求','code':'forbidden'},403)
            if url.query:return self.respond({'error':'整理规则请求无效','code':'invalid_input'},400)
            return self.respond(assistant.protocol())
        if url.path=='/api/evidence':
            origin=self.headers.get('Origin')
            if origin and origin!=f'http://127.0.0.1:{self.server.server_port}':return self.respond({'error':'拒绝跨站请求'},403)
            query=parse_qs(url.query,keep_blank_values=True)
            if set(query)!={'id'} or len(query['id'])!=1 or not re_id(query['id'][0]):return self.respond({'error':'报告编号无效'},400)
            try:return self.respond(EVIDENCE.list(query['id'][0]))
            except EvidenceError as exc:return self.respond({'error':str(exc)},exc.status)
            except FileNotFoundError:return self.respond({'error':'报告或原日志不存在'},404)
            except (ValueError,TypeError,KeyError,RecursionError):return self.respond({'error':'报告无法读取，请重新导入原日志'},422)
            except OSError:return self.respond({'error':'证据记录暂时无法读取，请重试'},503)
            except Exception:return self.respond({'error':'证据读取失败，请重试'},500)
        if url.path=='/api/sessions' or url.path.startswith('/api/session/'):
            origin=self.headers.get('Origin')
            if origin and origin!=f'http://127.0.0.1:{self.server.server_port}':return self.respond({'error':'拒绝跨站请求'},403)
            try:
                if url.path=='/api/sessions':return self.respond(SESSIONS.list())
                key=url.path.removeprefix('/api/session/')
                if not re_id(key):return self.respond({'error':'关联记录不存在'},404)
                return self.respond(SESSIONS.get(key))
            except FileNotFoundError:return self.respond({'error':'关联记录不存在'},404)
            except (ValueError,TypeError,KeyError,RecursionError):return self.respond({'error':'关联记录数据损坏，请重新建立关联'},422)
            except OSError:return self.respond({'error':'关联记录暂时无法读取，请重试'},503)
            except Exception:return self.respond({'error':'关联读取失败，请重试'},500)
        if url.path.startswith('/api/log/'):
            q=parse_qs(url.query);value=lambda name,default='':q.get(name,[default])[0]
            key=value('id');revision=value('revision')
            try:
                if url.path=='/api/log/meta':
                    if value('retry')=='1':READER.drop(key)
                    return self.respond(READER.meta(key))
                if url.path=='/api/log/lines':return self.respond(READER.lines(key,revision,int(value('start','1')),int(value('count','128'))))
                if url.path=='/api/log/search':return self.respond(READER.search(key,revision,value('q'),int(value('selected','1'))))
                if url.path=='/api/log/match':return self.respond(READER.match(key,revision,value('q'),int(value('selected','1')),value('direction','next')))
                return self.respond({'error':'不存在的接口'},404)
            except (ValueError,FileNotFoundError) as exc:return self.respond({'error':str(exc) if isinstance(exc,ValueError) else '原日志副本不存在，请重新导入日志'},400)
            except OSError:return self.respond({'error':'原日志暂时无法读取，请重试'},503)
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
            with RESULTS_LOCK:
                try:
                    report,_=read_case(key)
                    return self.respond(report)
                except FileNotFoundError:return self.respond({'error':'不存在的记录'},404)
                except ValueError as exc:return self.respond({'error':str(exc)},422)
                except OSError:return self.respond({'error':'报告读取失败'},500)
        if url.path.startswith('/api/job/'):
            with LOCK:
                job=JOBS.get(url.path.rsplit('/',1)[-1]);d=dict(job.result) if job else {'state':'error','message':'任务不存在'}
            return self.respond(d)
        return self.respond({'error':'不存在的资源'},404)
    def do_POST(self):
        url=urlparse(self.path)
        if url.path.startswith('/api/assistant/') and not self.assistant_authenticated():return self.respond({'error':'拒绝访问','code':'forbidden'},403)
        if not self.authenticated():return self.respond({'error':'拒绝访问'},403)
        origin=self.headers.get('Origin')
        if origin and origin!=f'http://127.0.0.1:{self.server.server_port}':return self.respond({'error':'拒绝跨站请求'},403)
        if url.path=='/api/assistant/run':
            body=None;acquired=False
            try:
                if url.query:raise ValueError('unexpected query')
                body=self.read_json_body(192*1024)
                mode=body.get('mode','offline')
                if mode=='offline':
                    if set(body)-{'mode','input'} or 'input' not in body:raise ValueError('invalid offline input')
                elif mode=='model':
                    if set(body)-{'mode','confirmed','endpoint','apiKey','preview'} or not {'confirmed','endpoint','preview'}<=set(body):raise ValueError('invalid model input')
                    acquired=ASSISTANT_LOCK.acquire(blocking=False)
                    if not acquired:return self.respond({'error':'已有模型请求正在处理，请稍后重试','code':'busy'},409)
                else:raise ValueError('invalid mode')
                result=assistant.request_assistance(body)
            except assistant.AssistanceError as exc:
                status=504 if exc.code=='timeout' else 502 if exc.code in {'connection_failed','service_error','invalid_response','unknown_reference','incomplete_response','redirect_blocked','response_limit'} else 400
                return self.respond({'error':str(exc),'code':exc.code},status)
            except TimeoutError:return self.respond({'error':'请求传输超时，请重试','code':'request_timeout'},408)
            except (ValueError,UnicodeError,TypeError,KeyError,RecursionError):return self.respond({'error':'证据辅助请求无效，请重新检查预览','code':'invalid_input'},400)
            except Exception:return self.respond({'error':'证据辅助未完成，请稍后重试','code':'connection_failed'},500)
            finally:
                if isinstance(body,dict):body.pop('apiKey',None)
                body=None
                # Client cancellation never releases a still-running model request.
                if acquired:ASSISTANT_LOCK.release()
            return self.respond(result)
        if url.path in ('/api/evidence/save','/api/evidence/delete','/api/evidence/preview'):
            action=url.path.rsplit('/',1)[-1]
            if RECOVERY['pending'] and action!='delete':return self.respond({'error':'报告恢复未完成，请检查目录权限后重启'},503)
            try:
                body=self.read_json_body(128*1024)
                required={'id','revision','identity'}|({'entry'} if action=='save' else {'bookmarkId'} if action=='delete' else {'ids'})
                optional={'options'} if action=='preview' else set()
                if set(body)-required-optional or required-set(body):raise ValueError('无效字段')
                if action=='save':result=EVIDENCE.save(body['id'],body['revision'],body['identity'],body['entry'])
                elif action=='delete':result=EVIDENCE.delete(body['id'],body['revision'],body['identity'],body['bookmarkId'])
                else:result=EVIDENCE.preview(body['id'],body['revision'],body['identity'],body['ids'],body.get('options'))
                return self.respond(result)
            except EvidenceError as exc:return self.respond({'error':str(exc)},exc.status)
            except FileNotFoundError:return self.respond({'error':'报告或原日志不存在'},404)
            except (ValueError,UnicodeError,TypeError,KeyError,RecursionError):return self.respond({'error':'证据请求无效，请核对报告与原文后重试'},400)
            except TimeoutError:return self.respond({'error':'证据请求传输超时，请重试'},408)
            except OSError:return self.respond({'error':'证据记录读取或保存失败，请重试'},503)
            except Exception:return self.respond({'error':'证据操作失败，请重试'},500)
        if url.path in ('/api/sessions/create','/api/sessions/refresh','/api/sessions/delete'):
            if RECOVERY['pending'] and url.path!='/api/sessions/delete':
                return self.respond({'error':'报告恢复未完成，请检查目录权限后重启'},503)
            try:
                body=self.read_json_body()
                if url.path.endswith('/create'):
                    if set(body)-{'ids','name'}:raise ValueError('无效字段')
                    return self.respond(SESSIONS.create(body.get('ids'),body.get('name','')),201)
                if set(body)!={'id'}:raise ValueError('无效字段')
                result=SESSIONS.refresh(body['id']) if url.path.endswith('/refresh') else SESSIONS.delete(body['id'])
                return self.respond(result)
            except FileNotFoundError:return self.respond({'error':'关联或成员报告不存在'},404)
            except (ValueError,UnicodeError,TypeError,KeyError,RecursionError):return self.respond({'error':'关联请求无效，请检查所选报告、名称与记录编号'},400)
            except TimeoutError:return self.respond({'error':'关联请求传输超时，请重试'},408)
            except OSError:return self.respond({'error':'关联记录读取或保存失败，请重试'},503)
            except Exception:return self.respond({'error':'关联操作失败，请重试'},500)
        if url.path in ('/api/sidebar/pin','/api/sidebar/unpin'):
            try:
                with LOCK:
                    pending=RUNTIME/'ui-settings.pending'
                    pending.write_text(json.dumps({'sidebarPinned':url.path.endswith('/pin')}),encoding='utf-8')
                    pending.replace(RUNTIME/'ui-settings.json')
                return self.respond({'ok':True})
            except OSError:return self.respond({'error':'菜单设置保存失败，请重试'},500)
        if url.path.startswith('/api/knowledge/'):
            parts=url.path.split('/')
            try:
                if len(parts)!=5:raise ValueError('无效资料操作')
                KNOWLEDGE.start(parts[3],parts[4]);return self.respond(KNOWLEDGE.status())
            except ValueError as exc:return self.respond({'error':str(exc)},400)
        if RECOVERY['pending'] and (url.path.startswith(('/api/import','/api/reparse')) or url.path=='/api/cases/delete'):
            return self.respond({'error':'报告恢复未完成，请检查目录权限后重启'},503)
        if url.path=='/api/log/position':
            q=parse_qs(url.query)
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=8192:raise ValueError('阅读位置数据无效')
                body=json.loads(self.rfile.read(length))
                return self.respond(READER.save_position(q.get('id',[''])[0],q.get('revision',[''])[0],body))
            except (ValueError,OSError) as exc:return self.respond({'error':str(exc) if isinstance(exc,ValueError) else '阅读位置保存失败'},400)
        if url.path.startswith('/api/online/'):
            action=url.path.rsplit('/',1)[-1]
            try:
                if action=='enable':ONLINE.settings_save(True)
                elif action=='disable':ONLINE.settings_save(False)
                elif action=='notify-enable':ONLINE.settings_save(notify=True)
                elif action=='notify-disable':ONLINE.settings_save(notify=False)
                elif action=='remind-later':ONLINE.settings_save(dismissal='later',expected_version=parse_qs(url.query).get('version',[''])[0])
                elif action=='ignore-version':ONLINE.settings_save(dismissal='ignore',expected_version=parse_qs(url.query).get('version',[''])[0])
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
            try:
                with LOCK:key=register_job(ImportJob())
            except ValueError as exc:return self.respond({'error':str(exc)},409)
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
        if not (core.log_member(name.lower()) or name.lower().endswith(('.zip','.tar','.tgz','.tar.gz'))):return self.respond({'error':'不支持此文件类型，请选择日志文本或 GZ、ZIP、TAR 压缩包'},415)
        key=query.get('job',[''])[0]
        with LOCK:
            if not key:
                try:key=register_job(ImportJob())
                except ValueError as exc:return self.respond({'error':str(exc)},409)
            job=JOBS.get(key)
            if job is None or job.result['state']!='ready':job=None
            else:job.result.update(state='uploading',totalBytes=length)
        if job is None:return self.respond({'error':'导入任务已结束'},409)
        folder=UPLOADS/key
        try:
            folder.mkdir();job.path=folder/name
            with job.path.open('wb') as f:
                left=length
                last_received=time.monotonic()
                while left:
                    core.check_cancel(job)
                    if time.monotonic()-last_received>IMPORT_IDLE_TIMEOUT:raise TimeoutError('upload timeout')
                    if not select.select([self.connection],[],[],.2)[0]:continue
                    chunk=self.rfile.read(min(left,1024*1024))
                    core.check_cancel(job)
                    if not chunk:raise ValueError('文件传输中断')
                    f.write(chunk);left-=len(chunk)
                    last_received=time.monotonic()
                    job.progress({'bytes':length-left})
            with LOCK:
                core.check_cancel(job)
                job.result.update(state='queued',phase='queued')
                job.future=EXECUTOR.submit(run_job,job)
        except Exception as exc:
            with LOCK:
                job.result.update(state='cancelled' if job.is_set() else 'error',message=import_error(exc))
            job.cleanup()
            return self.respond({'error':'已取消' if job.is_set() else job.result['message']},409 if job.is_set() else 400)
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
            READER.close()
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
