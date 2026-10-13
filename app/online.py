"""Opt-in update checks. Only fixed public endpoints receive requests."""
import copy
import hashlib
import json
import re
import threading
import time
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from pathlib import Path
from catalog import MAX_UPLOAD, parse_upload
from version import VERSION

RELEASES = 'https://api.github.com/repos/ohhellojie/xidlens/releases?per_page=100'
CATALOG_PAGE = 'https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html'
HOSTS = {'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'docs.nvidia.com'}


def safe_url(url):
    p = urlparse(url)
    if p.scheme != 'https' or p.hostname not in HOSTS or p.username or p.password or p.port not in (None, 443):
        raise ValueError('更新地址不受支持')
    return url


class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, safe_url(newurl))


def download(url, limit, progress=None, cancelled=None):
    req = urllib.request.Request(safe_url(url), headers={'User-Agent': 'XidLens/'+VERSION})
    start = time.monotonic()
    with urllib.request.build_opener(Redirects()).open(req, timeout=15) as response:
        safe_url(response.url)
        total = int(response.headers.get('Content-Length', 0))
        if total > limit: raise ValueError('下载文件过大')
        chunks = []; size = 0
        while True:
            if cancelled and cancelled.is_set(): raise ValueError('已取消下载')
            if time.monotonic()-start > 180: raise ValueError('下载超时，请重试')
            chunk = response.read(65536)
            if not chunk: break
            size += len(chunk)
            if size > limit: raise ValueError('下载文件过大')
            chunks.append(chunk)
            if progress: progress(size, total)
        if total and size != total: raise ValueError('下载不完整，请重试')
        return b''.join(chunks)


def version_key(value):
    m = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)(?:-(?:preview|rc)\.(\d+))?', value)
    if not m: raise ValueError('版本格式不受支持')
    return (*map(int, m.groups()[:3]), 1 if m[4] is None else 0, int(m[4] or 0))


def select_release(rows, current=VERSION):
    candidates = []
    for row in rows:
        if row.get('draft'): continue
        try: key = version_key(row['tag_name'])
        except (KeyError, TypeError, ValueError): continue
        assets = row.get('assets', [])
        exe = next((a for a in assets if a.get('name') == 'XidLens.exe'), None)
        if not exe or not re.fullmatch(r'sha256:[0-9a-f]{64}', exe.get('digest') or ''): continue
        tag = row['tag_name']
        expected = f'https://github.com/ohhellojie/xidlens/releases/download/{tag}/XidLens.exe'
        if exe.get('browser_download_url') != expected: continue
        if key > version_key(current):
            candidates.append((key, {'version':tag, 'url':f'https://github.com/ohhellojie/xidlens/releases/tag/{tag}',
                                    'asset':expected, 'sha256':exe['digest'][7:], 'size':exe['size'],
                                    'notes':str(row.get('body') or '')[:12000], 'prerelease':bool(row.get('prerelease'))}))
    return max(candidates, key=lambda r:r[0])[1] if candidates else None


class Links(HTMLParser):
    def __init__(self): super().__init__(); self.links=[]
    def handle_starttag(self, tag, attrs):
        if tag == 'a': self.links.extend(v for k,v in attrs if k == 'href' and v)


def official_catalog():
    page = download(CATALOG_PAGE, 4*1024*1024).decode('utf-8')
    links = Links(); links.feed(page)
    urls = [urljoin(CATALOG_PAGE, v) for v in links.links if v.split('?')[0].endswith('/Xid-Catalog.xlsx')]
    urls = [u for u in urls if u.startswith('https://docs.nvidia.com/deploy/xid-errors/_downloads/')]
    if not urls: raise ValueError('官方规则下载地址已变化，请查看原文')
    raw = download(urls[0], MAX_UPLOAD)
    data = parse_upload(raw, 'NVIDIA-Xid-Catalog.xlsx')
    data.update(sourceUrl=CATALOG_PAGE, language='en', provider='NVIDIA')
    return data


class OnlineUpdates:
    def __init__(self, runtime, catalog):
        self.root=Path(runtime)/'updates'; self.catalog=catalog
        self.lock=threading.RLock(); self.stop=threading.Event(); self.cancel=threading.Event()
        self.candidate=None; self.release=None; self.ready=None; self.active=set()
        self.settings={'automatic':False, 'lastCheck':0}
        try:
            saved=json.loads((self.root/'settings.json').read_text(encoding='utf-8'))
            if type(saved.get('automatic')) is bool:self.settings['automatic']=saved['automatic']
            if type(saved.get('lastCheck')) in (float,int):self.settings['lastCheck']=saved['lastCheck']
        except (OSError,ValueError,AttributeError):pass
        self.state={'app':{'state':'idle'},'rules':{'state':'idle'}}

    def snapshot(self):
        with self.lock:
            result=copy.deepcopy(self.state)
            if self.candidate and result['rules']['state'] in ('current','available'):
                same=self.candidate['sha256']==self.catalog.info()['sha256']
                result['rules'].update(state='current' if same else 'available',message='官方规则已是最新' if same else '可获取官方规则')
            return result|{'settings':dict(self.settings),'current':VERSION}

    def settings_save(self, automatic=None):
        with self.lock:
            proposed=dict(self.settings)
            if automatic is not None:
                if type(automatic) is not bool:raise ValueError('无效设置')
                proposed['automatic']=automatic
            self.root.mkdir(parents=True,exist_ok=True)
            tmp=self.root/'settings.pending';tmp.write_text(json.dumps(proposed),encoding='utf-8');tmp.replace(self.root/'settings.json')
            self.settings=proposed

    def change(self, kind, **values):
        with self.lock:self.state[kind].update(values)

    def start(self, action):
        kind='rules' if action in ('check-rules','apply-rules') else 'app'
        with self.lock:
            if kind in self.active:raise ValueError('正在处理，请稍候')
            if action=='download-app' and not self.release:raise ValueError('请先检查更新')
            if action=='apply-rules' and not self.candidate:raise ValueError('请先检查规则')
            if action not in ('check-app','check-rules','download-app','apply-rules'):raise ValueError('无效操作')
            self.active.add(kind)
            if action=='download-app':self.cancel.clear()
            self.state[kind]={'state':'working','action':action,'message':{'check-app':'正在检查…','check-rules':'正在检查…','download-app':'正在下载…','apply-rules':'正在应用…'}[action]}
        threading.Thread(target=self.run,args=(action,kind),daemon=True).start()

    def run(self, action, kind):
        try:
            if action=='check-app':
                release=select_release(json.loads(download(RELEASES,4*1024*1024)))
                with self.lock:self.release=release;self.ready=None
                self.change(kind,state='available' if release else 'current',message='发现新版本' if release else '暂无更新',release=release)
            elif action=='check-rules':
                candidate=official_catalog()
                with self.lock:self.candidate=candidate
                same=candidate['sha256']==self.catalog.info()['sha256']
                self.change(kind,state='current' if same else 'available',message='官方规则已是最新' if same else '可获取官方规则',count=len(candidate['codes']),sha256=candidate['sha256'])
            elif action=='apply-rules':
                self.catalog.apply(copy.deepcopy(self.candidate))
                self.change(kind,state='current',message='已应用官方规则',count=len(self.candidate['codes']))
            else:
                release=dict(self.release)
                raw=download(release['asset'],128*1024*1024,lambda n,t:self.change(kind,bytes=n,total=t),self.cancel)
                if self.cancel.is_set():raise ValueError('已取消下载')
                if len(raw)!=release['size'] or hashlib.sha256(raw).hexdigest()!=release['sha256'] or not raw.startswith(b'MZ'):
                    raise ValueError('更新文件校验失败，请重试')
                self.root.mkdir(parents=True,exist_ok=True)
                path=self.root/'XidLens.download.exe';tmp=path.with_suffix('.pending')
                try:tmp.write_bytes(raw);tmp.replace(path)
                finally:tmp.unlink(missing_ok=True)
                with self.lock:self.ready={'path':str(path),**release}
                self.change(kind,state='ready',message='下载完成',release=release)
        except Exception as exc:
            message=str(exc) if isinstance(exc,ValueError) else ('保存失败，请检查目录权限和可用空间' if isinstance(exc,PermissionError) else '连接失败，请稍后重试')
            self.change(kind,state='error',message=message)
        finally:
            with self.lock:self.active.discard(kind)

    def check_due(self):
        with self.lock:
            due=self.settings['automatic'] and time.time()-self.settings['lastCheck']>=86400 and not self.active
            if not due:return
            self.settings['lastCheck']=time.time()
            self.settings_save()
            self.start('check-app');self.start('check-rules')

    def schedule(self):
        def loop():
            while not self.stop.wait(30):
                try:self.check_due()
                except (OSError,ValueError):pass
        threading.Thread(target=loop,daemon=True).start()
