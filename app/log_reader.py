"""Bounded, on-demand access to retained log sources. No archive extraction."""
from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager, ExitStack
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import gzip
import hashlib
import json
import re
import struct
import tarfile
import threading
import uuid
import zipfile

import gpu_summary_core as core

MAX_BYTES = 512 * 1024 * 1024
MAX_LINE = 1024 * 1024
MAX_CONTAINER = 2 * 1024 * 1024 * 1024
MAX_OUTLINE = 5000
U64 = struct.Struct('<Q')
COMMAND = re.compile(r'^(?:(?:\$\s*|[^\s]+[#$]\s+))?(?:sudo\s+)?(?:/(?:usr/)?s?bin/)?((?:nvidia-smi|lspci|lscpu|dmidecode|dmesg|journalctl|uname|hostnamectl)(?:\s+[^\r\n]*)?)$')


@contextmanager
def open_source(path, report, cancel):
    """Choose exactly the report's archive member, never a user-supplied path."""
    name = report['input']['name']
    lower = name.lower()
    member = report.get('sourceMember')
    member_name = member.get('name') if isinstance(member, dict) else None
    member_index = member.get('index') if isinstance(member, dict) else None
    if member_name is None:
        prefix = name + '!'
        member_name = report['source'][len(prefix):] if report['source'].startswith(prefix) else report['source'].partition('!')[2]

    def choose(entries, tar=False):
        matches = []
        for index, item in enumerate(entries):
            core.check_cancel(cancel)
            item_name = item.name if tar else item.filename
            if item_name == member_name and (member_index is None or index == member_index):
                if (tar and not item.isfile()) or (not tar and item.is_dir()):
                    continue
                matches.append(item)
                if tar:
                    return item
        if len(matches) != 1:
            raise ValueError('压缩包成员无法唯一定位，请重新导入日志')
        return matches[0]

    with ExitStack() as stack:
        stream = stack.enter_context(path.open('rb'))
        if lower.endswith('.zip'):
            archive = stack.enter_context(zipfile.ZipFile(stream))
            item = choose(archive.infolist())
            stream = stack.enter_context(archive.open(item))
            if item.filename.lower().endswith('.gz'):
                stream = stack.enter_context(gzip.GzipFile(fileobj=stream))
        elif lower.endswith(('.tar.gz', '.tgz', '.tar')):
            if lower.endswith(('.tar.gz', '.tgz')):
                stream = stack.enter_context(gzip.GzipFile(fileobj=stream))
            archive = stack.enter_context(tarfile.open(fileobj=core.ReadBudget(stream, MAX_CONTAINER, cancel), mode='r|'))
            # Streaming tar cannot seek backwards. Duplicates in legacy reports are
            # still protected by the content checksum checked after indexing.
            item = choose(archive, tar=True)
            if item is None:
                raise ValueError('压缩包中找不到原日志，请重新导入')
            stream = stack.enter_context(archive.extractfile(item))
            if item.name.lower().endswith('.gz'):
                stream = stack.enter_context(gzip.GzipFile(fileobj=stream))
        elif lower.endswith('.gz'):
            stream = stack.enter_context(gzip.GzipFile(fileobj=stream))
        yield stream


class Outline:
    """Small section index for the current-block label."""
    def __init__(self):
        self.items = []

    def consume(self, text, line):
        s = text.strip()
        command = COMMAND.fullmatch(s)
        header = re.fullmatch(r'[=]{3,}\s*([^=\s].*?[^=\s]|[^=\s])\s*[=]{3,}', s)
        previous = self.items[-1] if self.items else None
        if s == '==============NVSMI LOG==============' and previous and previous['title'].startswith('nvidia-smi') and line-previous['line']<6:
            return
        title = 'nvidia-smi -q' if s == '==============NVSMI LOG==============' else command[1] if command else header[1] if header else s[4:].strip() if s.startswith('*** ') and not s.startswith('*** ls:') else ''
        if title.startswith('/sys/bus/pci/devices/') and '/power/' in title:
            title = 'PCIe 电源状态'
            if previous and previous['title']==title:return
        if title and len(title)<512 and len(self.items)<MAX_OUTLINE:
            self.items.append({'line':line,'title':title[:160]})
        elif not self.items:
            self.items.append({'line':1,'title':'日志正文'})

    def finish(self, lines):
        for i,node in enumerate(self.items):
            node['end'] = self.items[i+1]['line']-1 if i+1<len(self.items) else lines
        return self.items


class Job:
    def __init__(self, key, revision, path, report, root):
        self.key, self.revision, self.path, self.report = key, revision, path, report
        self.cancel = threading.Event()
        self.state = {'state': 'indexing', 'lines': 0}
        self.base = root / (key + '-' + uuid.uuid4().hex)
        self.text = self.base.with_suffix('.text')
        self.index = self.base.with_suffix('.index')
        self.search = None
        self.future = None

    def is_set(self):
        return self.cancel.is_set()


class LogStore:
    def __init__(self, root, resolve, capacity=3):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.resolve = resolve
        self.capacity = capacity
        self.jobs = OrderedDict()
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='log-reader')
        self.closed = False
        self.position_file = self.root.parent/'reader-positions.json'
        try:
            self.positions = json.loads(self.position_file.read_text(encoding='utf-8')) if self.position_file.stat().st_size <= 2*1024*1024 else {}
            if not isinstance(self.positions,dict): self.positions = {}
        except (OSError,ValueError): self.positions = {}
        # Disposable caches from a previous process, never original sources.
        for path in self.root.iterdir():
            if re.fullmatch(r'[a-f0-9]{32}-[a-f0-9]{32}\.(text|index|matches)', path.name):
                try: path.unlink()
                except OSError: pass

    def _get(self, key):
        if not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{32}', key):
            raise ValueError('报告不存在')
        path, report, revision = self.resolve(key)
        with self.lock:
            if self.closed:
                raise ValueError('日志服务已关闭')
            old = self.jobs.get(key)
            if old and old.revision == revision:
                self.jobs.move_to_end(key)
                return old
            if old: self.drop(key)
            job = Job(key, revision, path, report, self.root)
            self.jobs[key] = job
            while len(self.jobs) > self.capacity:
                self.drop(next(iter(self.jobs)))
            job.future = self.executor.submit(self._build, job)
            return job

    def _cancel_search(self, search):
        search['cancel'].set()
        def clean(_):
            try: search['path'].unlink(missing_ok=True)
            except OSError: pass
        if search.get('future'): search['future'].add_done_callback(clean)

    def _clean(self, job):
        for path in self.root.glob(job.base.name + '.*'):
            try: path.unlink()
            except OSError: pass

    def drop(self, key):
        with self.lock:
            job = self.jobs.pop(key, None)
            if job:
                job.cancel.set()
                if job.search: self._cancel_search(job.search)
                if job.future: job.future.add_done_callback(lambda _: self._clean(job))
                if job.search and job.search.get('future'): job.search['future'].add_done_callback(lambda _: self._clean(job))

    def close(self):
        with self.lock:
            self.closed = True
            for key in list(self.jobs): self.drop(key)
        self.executor.shutdown(wait=True, cancel_futures=True)

    def meta(self, key):
        job = self._get(key)
        return dict(job.state, revision=job.revision, identity=self._identity(job), position=self.position(key))

    @staticmethod
    def _identity(job):
        return job.report.get('contentSha256') or hashlib.sha256(json.dumps([job.report['input'],job.report.get('sourceMember'),job.report['source']]).encode()).hexdigest()

    def position(self, key):
        with self.lock:
            job=self.jobs.get(key);saved=self.positions.get(key,{})
            return saved.get('view',{}) if isinstance(saved,dict) and job and saved.get('identity')==self._identity(job) else {}

    def save_position(self, key, revision, view):
        job=self._ready(key,revision)
        if not isinstance(view,dict):raise ValueError('阅读位置无效')
        clean={}
        for field in ('top','selected'):
            value=view.get(field,1)
            if type(value) is not int or not 1<=value<=max(1,job.state['lines']):raise ValueError('阅读行号无效')
            clean[field]=value
        offset=view.get('offset',0)
        if type(offset) not in (int,float) or not 0<=offset<=10000000:raise ValueError('阅读位置无效')
        clean['offset']=offset
        left=view.get('left',0)
        if type(left) not in (int,float) or not 0<=left<=10000000:raise ValueError('阅读位置无效')
        clean['left']=left
        clean['wrap']=view.get('wrap',False) is True
        query=view.get('query','')
        if not isinstance(query,str) or len(query)>512:raise ValueError('搜索词过长')
        clean['query']=query
        with self.lock:
            self.positions.pop(key,None)
            self.positions[key]={'identity':self._identity(job),'view':clean}
            while len(self.positions)>500:self.positions.pop(next(iter(self.positions)))
            temporary=self.position_file.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.positions,ensure_ascii=False),encoding='utf-8')
            temporary.replace(self.position_file)
        return {'saved':True}

    def _build(self, job):
        outline = Outline()
        digest = hashlib.sha256()
        count = used = output = fallback = nul = 0
        warnings = []
        try:
            with open_source(job.path, job.report, job) as source, job.text.open('xb') as text, job.index.open('xb') as index:
                while True:
                    core.check_cancel(job)
                    raw = source.readline(min(MAX_LINE, MAX_BYTES - used + 1))
                    if not raw: break
                    used += len(raw)
                    if used > MAX_BYTES:
                        warnings.append('日志超过 512 MB，当前显示已读取部分')
                        break
                    if len(raw) >= MAX_LINE and not raw.endswith(b'\n'):
                        warnings.append('遇到超过 1 MB 的单行，当前显示此前内容')
                        break
                    digest.update(raw)
                    count += 1
                    if b'\0' in raw:
                        nul += 1
                        raw = raw.replace(b'\0', b'\\0')
                    try: line = raw.decode('utf-8-sig' if count == 1 else 'utf-8').rstrip('\r\n')
                    except UnicodeDecodeError:
                        line = raw.decode('gb18030', errors='replace').rstrip('\r\n')
                        fallback += 1
                    encoded = (line + '\n').encode('utf-8')
                    index.write(U64.pack(output))
                    text.write(encoded)
                    output += len(encoded)
                    outline.consume(line, count)
                    if count % 2048 == 0: job.state = {'state':'indexing', 'lines':count}
                index.write(U64.pack(output))
            core.check_cancel(job)
            expected = job.report.get('contentSha256')
            if expected and digest.hexdigest() != expected:
                raise ValueError('原日志副本与报告不一致，请重新导入日志')
            if fallback: warnings.append(f'{fallback} 行使用 GB18030 解码，请核对非 ASCII 内容')
            if nul: warnings.append(f'{nul} 行包含 NUL，原文显示为 \\0')
            all_errors = [{'line':e['line'], 'title':('Xid '+e['code']) if e['kind']=='xid' else core.LABELS.get(e['kind'],e['title'])} for e in job.report.get('events',[]) if 0 < e['line'] <= count]
            errors = sorted(all_errors, key=lambda e:e['line'])[:2000]
            tree = outline.finish(count)
            if len(all_errors) > len(errors): warnings.append('位置标记显示前 2000 条异常，全部记录可在错误记录页查看')
            job.state = {'state':'ready','lines':count,'bytes':used,'outline':tree,'errors':errors,'errorCount':len(all_errors),'warnings':warnings,'complete':not any('当前显示' in w for w in warnings),'encoding':'UTF-8 / GB18030' if fallback else 'UTF-8'}
        except core.AnalysisCancelled:
            self._clean(job)
        except Exception as exc:
            self._clean(job)
            job.state = {'state':'error','message':str(exc) if isinstance(exc,ValueError) else '原日志读取失败，请检查文件或重新导入'}

    def _ready(self, key, revision):
        job = self._get(key)
        if revision != job.revision: raise ValueError('日志已变更，请重新打开')
        if job.state['state'] != 'ready': raise ValueError(job.state.get('message','原文索引尚未完成'))
        return job

    def lines(self, key, revision, start, count):
        job = self._ready(key, revision)
        if not 1 <= start <= max(1,job.state['lines']) or not 1 <= count <= 256:
            raise ValueError('行号范围无效')
        count = min(count, job.state['lines'] - start + 1)
        with job.index.open('rb') as index, job.text.open('rb') as text:
            index.seek((start - 1) * 8)
            offsets = [U64.unpack(index.read(8))[0] for _ in range(count + 1)]
            take = 0
            for i in range(count):
                if i and offsets[i + 1] - offsets[0] > 4 * 1024 * 1024: break
                take = i + 1
            text.seek(offsets[0])
            raw = text.read(offsets[take] - offsets[0])
            rows = [raw[offsets[i]-offsets[0]:offsets[i+1]-offsets[0]-1].decode('utf-8') for i in range(take)]
        return {'start':start,'lines':rows,'revision':revision}

    def search(self, key, revision, query, selected=1):
        job = self._ready(key, revision)
        if not isinstance(query,str) or not 0 < len(query) <= 512: raise ValueError('搜索词需为 1–512 个字符')
        query = query.lower()
        with self.lock:
            search = job.search
            if not search or search['query'] != query or search['state'] == 'error':
                if search: self._cancel_search(search)
                search = {'query':query,'cancel':threading.Event(),'state':'searching','count':0,'path':self.root/(job.key+'-'+uuid.uuid4().hex+'.matches')}
                job.search = search
                search['future'] = self.executor.submit(self._search, job, search)
        result = {k:search[k] for k in ('state','count')}
        if search['state'] == 'ready':
            result.update(markers=search['markers'])
            with search['path'].open('rb') as f:
                at = self._bisect(f, search['count'], selected)
                result['current'] = at+1 if at < search['count'] and self._hit(f,at)==selected else 0
        return result

    @staticmethod
    def _hit(stream, index):
        stream.seek(index * 8)
        return U64.unpack(stream.read(8))[0]

    def _bisect(self, stream, count, line):
        low, high = 0, count
        while low < high:
            mid = (low + high) // 2
            if self._hit(stream,mid) < line: low = mid + 1
            else: high = mid
        return low

    def match(self, key, revision, query, selected, direction):
        job = self._ready(key,revision)
        search = job.search
        if not search or search['query'] != query.lower() or search['state'] != 'ready': raise ValueError('搜索尚未完成')
        count = search['count']
        if not count: return {'line':None,'index':0}
        with search['path'].open('rb') as f:
            at = self._bisect(f,count,selected)
            if direction == 'next':
                if at < count and self._hit(f,at)==selected: at += 1
            elif direction == 'previous': at -= 1
            else: raise ValueError('搜索方向无效')
            at %= count
            return {'line':self._hit(f,at),'index':at+1}

    def _search(self, job, search):
        count = 0
        buckets = {}
        try:
            with job.text.open('rb') as source, search['path'].open('xb') as hits:
                for line, raw in enumerate(source,1):
                    if job.is_set() or search['cancel'].is_set(): raise core.AnalysisCancelled()
                    if search['query'] in raw[:-1].decode('utf-8').lower():
                        hits.write(U64.pack(line));count += 1
                        buckets.setdefault(int(line/max(1,job.state['lines'])*1024),line)
                    if line % 8192 == 0: search['count'] = count
            search.update(state='ready',count=count,markers=list(buckets.values()))
        except Exception:
            search.update(state='error',count=0)
        finally:
            if job.is_set() or search['cancel'].is_set() or search['state']=='error':
                try: search['path'].unlink(missing_ok=True)
                except OSError: pass
