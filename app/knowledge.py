"""Versioned reference packages, independent of parser rules and application updates."""
import copy
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import threading
from urllib.parse import urlparse
from catalog import read_json, validate as validate_catalog, text
from online import download, RELEASES, version_key
from recovery import write_json

KINDS=('xid','manual')
MAX_PACKAGE=10*1024*1024
REPOSITORY='https://github.com/ohhellojie/xidlens'


def source_url(value):
    text(value,'来源链接',2048)
    url=urlparse(value)
    if url.scheme!='https' or url.username or url.password or url.port not in (None,443):raise ValueError('来源链接无效')
    if url.hostname!='docs.nvidia.com' and not (url.hostname=='github.com' and url.path.startswith('/NVIDIA/')):
        raise ValueError('来源链接无效')
    return value


def strings(value,maximum=128):
    if not isinstance(value,list) or len(value)>maximum:raise ValueError('资料列表无效')
    return [text(v,'资料文本') for v in value]


def validate(raw,kind):
    if kind not in KINDS or len(raw)>MAX_PACKAGE:raise ValueError('资料包无效')
    data=read_json(raw)
    if not isinstance(data,dict) or type(data.get('schema')) is not int or data['schema']!=1 or data.get('kind')!=kind:raise ValueError('资料包格式不兼容')
    version=data.get('version','')
    if not isinstance(version,str) or not re.fullmatch(r'\d{1,4}\.\d{1,4}\.\d{1,4}',version):raise ValueError('资料版本无效')
    stamp=data.get('updatedAt','')
    if not isinstance(stamp,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',stamp):raise ValueError('资料日期无效')
    date.fromisoformat(stamp)
    refs=data.get('sources')
    if not isinstance(refs,list) or not 1<=len(refs)<=32:raise ValueError('资料来源缺失')
    sources=[{'title':text(r['title'],'来源名称',256),'url':source_url(r['url'])} for r in refs]
    content=data.get('content')
    if not isinstance(content,dict):raise ValueError('资料内容无效')
    if kind=='xid':
        cn,en=validate_catalog(content['cn']),validate_catalog(content['en'])
        if set(cn['codes'])!=set(en['codes']):raise ValueError('中英文条目不一致')
        unused=strings(content['unused'],4096)
        if not set(unused)<=set(cn['codes']):raise ValueError('未使用条目无效')
        tables={}
        for name in ('Xid 144-150 Decode','Customer User Guide'):
            rows=content['extra'][name]
            if not isinstance(rows,list) or not 1<=len(rows)<=4096:raise ValueError('解码表无效')
            tables[name]=[strings(row,32) for row in rows]
        content={'cn':cn,'en':en,'unused':unused,'extra':tables}
    else:
        refs=content['sources'];topics=content['topics']
        if not isinstance(refs,dict) or not 1<=len(refs)<=64:raise ValueError('手册来源无效')
        refs={text(k,'来源编号',64):[text(v[0],'来源名称',256),source_url(v[1])] for k,v in refs.items() if isinstance(v,list) and len(v)==2}
        if not refs or not isinstance(topics,list) or not 1<=len(topics)<=128:raise ValueError('手册目录无效')
        ids=set();parsed=[]
        for t in topics:
            key=text(t['id'],'主题编号',64)
            if not re.fullmatch(r'[a-zA-Z0-9_-]+',key) or key in ids:raise ValueError('主题编号无效')
            ids.add(key)
            item={k:text(t[k],k,50000) for k in ('id','group','title','sub','scope')}
            for k in ('refs','related','next'):item[k]=strings(t[k])
            if not set(item['refs'])<=set(refs):raise ValueError('主题来源缺失')
            if any(not re.fullmatch(r'\d{1,5}',c) for c in item['related']):raise ValueError('关联 Xid 无效')
            steps=t['steps']
            if not isinstance(steps,list) or not 1<=len(steps)<=64:raise ValueError('排查步骤缺失')
            item['steps']=[strings(s,2) for s in steps]
            if any(len(s)!=2 for s in item['steps']):raise ValueError('排查步骤无效')
            if 'note' in t:item['note']=text(t['note'],'补充说明')
            if 'extracts' in t:
                item['extracts']=strings(t['extracts'])
                if any(not re.fullmatch(r'\d{1,5}',c) for c in item['extracts']):raise ValueError('详细说明编号无效')
            if 'branches' in t:
                if not isinstance(t['branches'],list) or not 1<=len(t['branches'])<=32:raise ValueError('分支无效')
                item['branches']=[{k:text(b.get(k,''),k) for k in ('label','title','text','code','extra')} for b in t['branches']]
                if any(not re.fullmatch(r'\d{1,5}',b['code']) for b in item['branches']):raise ValueError('分支编号无效')
            if 'table' in t:
                table=t['table'];rows=table['rows']
                if not isinstance(rows,list) or len(rows)>256:raise ValueError('手册表格无效')
                item['table']={'title':text(table['title'],'表格标题'),'head':strings(table['head'],2),'rows':[strings(r,2) for r in rows]}
                if len(item['table']['head'])!=2 or any(len(r)!=2 for r in item['table']['rows']):raise ValueError('手册表格无效')
            if 'commands' in t:
                if not isinstance(t['commands'],list) or len(t['commands'])>32:raise ValueError('命令示例无效')
                item['commands']=[{k:text(c[k],k) for k in ('title','code','note')} for c in t['commands']]
            parsed.append(item)
        if any(not set(t['next'])<=ids for t in parsed):raise ValueError('后续主题缺失')
        content={'topics':parsed,'sources':refs}
    result={'schema':1,'kind':kind,'version':version,'updatedAt':stamp,'publisher':'XidLens','sources':sources,'content':content}
    if 'scope' in data:result['scope']=text(data['scope'],'适用范围',256)
    return result


def checked(raw,kind):
    try:return validate(raw,kind)
    except (ValueError,KeyError,TypeError,IndexError,AttributeError,OverflowError,RecursionError) as exc:
        raise ValueError('资料包格式无效或不兼容') from exc


def candidate(rows,kind,current):
    if not isinstance(rows,list):raise ValueError('更新信息无效')
    found=[]
    for row in rows:
        if not isinstance(row,dict) or row.get('draft') or row.get('prerelease'):continue
        tag=row.get('tag_name','');match=re.fullmatch(r'knowledge-'+kind+r'-v(\d{1,4}\.\d{1,4}\.\d{1,4})',tag) if isinstance(tag,str) else None
        if not match or version_key(match[1])<=version_key(current):continue
        name=f'XidLens-{kind}.json';url=f'{REPOSITORY}/releases/download/{tag}/{name}'
        for asset in row.get('assets') or []:
            if not isinstance(asset,dict):continue
            digest=asset.get('digest') or '';size=asset.get('size')
            if asset.get('name')!=name or asset.get('browser_download_url')!=url:continue
            if not isinstance(digest,str) or not re.fullmatch(r'sha256:[0-9a-f]{64}',digest):continue
            if type(size) is not int or not 0<size<=MAX_PACKAGE:continue
            found.append({'version':match[1],'url':url,'sha256':digest[7:],'size':size})
    return max(found,key=lambda c:version_key(c['version'])) if found else None


class KnowledgeStore:
    def __init__(self,runtime,bundled=None):
        self.root=Path(runtime)/'knowledge';self.bundled=Path(bundled or Path(__file__).parent/'knowledge')
        self.lock=threading.RLock();self.data={};self.origin={};self.warning={};self.state={};self.candidates={}
        self.cancel={k:threading.Event() for k in KINDS};self.threads={}
        for kind in KINDS:
            data=checked((self.bundled/(kind+'.json')).read_bytes(),kind)
            self.origin[kind]='内置';self.warning[kind]=''
            for filename in ('active.json','previous.json'):
                path=self.root/kind/filename
                if not path.exists():continue
                try:
                    raw=path.read_bytes()
                    saved=read_json(raw)
                    serialized=json.dumps(saved['package'],ensure_ascii=False,sort_keys=True).encode('utf-8')
                    if hashlib.sha256(serialized).hexdigest()!=saved['sha256']:raise ValueError('资料校验失败')
                    pack=checked(serialized,kind)
                    if version_key(pack['version'])>=version_key(data['version']):data=pack;self.origin[kind]='已更新' if filename=='active.json' else '已恢复'
                    break
                except (OSError,ValueError,KeyError,TypeError):self.warning[kind]='保存的资料无法读取，已使用可用版本'
            self.data[kind]=data;self.state[kind]={'state':'idle'}

    def status(self):
        with self.lock:
            return copy.deepcopy({k:{'version':v['version'],'updatedAt':v['updatedAt'],'sources':v['sources'],'origin':self.origin[k],
                       'warning':self.warning[k],'state':self.state[k],
                       'candidate':self.candidates.get(k),'updateSource':REPOSITORY+'/releases'} for k,v in self.data.items()})

    def content(self):
        with self.lock:return {'packages':copy.deepcopy(self.data),'status':copy.deepcopy(self.status())}

    def save(self,kind,pack):
        with self.lock:
            if self.cancel[kind].is_set():raise ValueError('已取消更新')
            if version_key(pack['version'])<=version_key(self.data[kind]['version']):raise ValueError('资料版本没有更新')
            folder=self.root/kind;folder.mkdir(parents=True,exist_ok=True)
            def wrapped(value):
                raw=json.dumps(value,ensure_ascii=False,sort_keys=True).encode('utf-8')
                return {'sha256':hashlib.sha256(raw).hexdigest(),'package':value}
            write_json(folder/'previous.json',wrapped(self.data[kind]))
            if self.cancel[kind].is_set():raise ValueError('已取消更新')
            write_json(folder/'active.json',wrapped(pack))
            self.data[kind]=copy.deepcopy(pack);self.origin[kind]='已更新';self.warning[kind]=''

    def start(self,kind,action):
        if kind not in KINDS or action not in ('check','apply','cancel'):raise ValueError('无效资料操作')
        with self.lock:
            if action=='cancel':self.cancel[kind].set();return
            if self.state[kind]['state']=='working':raise ValueError('正在处理，请稍候')
            if action=='apply' and kind not in self.candidates:raise ValueError('请先检查更新')
            self.cancel[kind].clear();self.state[kind]={'state':'working','action':action,'message':'正在检查…' if action=='check' else '正在更新…'}
            thread=threading.Thread(target=self.run,args=(kind,action),daemon=True);self.threads[kind]=thread;thread.start()

    def run(self,kind,action):
        try:
            if action=='check':
                rows=read_json(download(RELEASES,4*1024*1024,cancelled=self.cancel[kind]))
                with self.lock:
                    next_version=candidate(rows,kind,self.data[kind]['version'])
                    if self.cancel[kind].is_set():raise ValueError('已取消检查')
                    if next_version:self.candidates[kind]=next_version
                    else:self.candidates.pop(kind,None)
                    self.state[kind]={'state':'available' if next_version else 'current','message':'发现新版本' if next_version else '暂无资料更新'}
            else:
                with self.lock:entry=dict(self.candidates[kind])
                raw=download(entry['url'],MAX_PACKAGE,cancelled=self.cancel[kind])
                if len(raw)!=entry['size'] or hashlib.sha256(raw).hexdigest()!=entry['sha256']:raise ValueError('资料校验失败')
                pack=checked(raw,kind)
                if pack['version']!=entry['version']:raise ValueError('资料版本不一致')
                self.save(kind,pack)
                with self.lock:
                    self.candidates.pop(kind,None);self.state[kind]={'state':'current','message':'资料已更新'}
        except Exception as exc:
            message=str(exc) if isinstance(exc,ValueError) else ('保存失败' if isinstance(exc,PermissionError) else '更新失败')
            with self.lock:self.state[kind]={'state':'error','message':message+('，已保留原资料' if action=='apply' else '，请重试')}

    def close(self):
        for event in self.cancel.values():event.set()
