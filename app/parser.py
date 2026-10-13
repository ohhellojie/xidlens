"""本地日志解析适配层。设备与事件适配层；字段保留原文证据。"""
from __future__ import annotations
import csv, hashlib, json, os, re, sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
import gpu_summary_core as core
BaseParser = core.Parser
APP_HOME = Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else ROOT
LOCAL_CATALOG = APP_HOME/'xid_catalog.local.json'
CATALOG_PATH = Path(os.environ.get('XIDLENS_CATALOG', str(LOCAL_CATALOG if LOCAL_CATALOG.is_file() else ROOT/'xid_catalog.json')))
CATALOG = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
PCI_HEADER = re.compile(r'^((?:[\da-fA-F]{4,8}:)?[\da-fA-F]{2}:[\da-fA-F]{2}\.[0-7])\s+(.+)')
UNAVAILABLE = {'', '—', 'n/a', 'na', 'none', 'unknown', 'not specified', 'not available', 'not supported', 'to be filled by o.e.m.', 'default string', '0'}

def digest(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def valid(value):
    marker = str(value).strip().lower()
    if marker.startswith('[') and marker.endswith(']'):marker = marker[1:-1].strip()
    return marker not in UNAVAILABLE

class Parser(BaseParser):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.r.update(server_fields={}, pci_nodes={}, metrics={}, gpu_indices={}, event_records=[])
        self.dmi_type=None;self.pci_node=None;self.os_block=False;self.smi_scope='';self.in_sysfs=None;self.dmi_slot={}
        self.r['dmi_slots']=[]
        self.csv_columns=None
        self.smi_path=[]
        self.r['scoped_metrics']={}

    def field(self,address,key,value,n,line,origin):
        if not valid(value):return
        super().field(address,key,str(value).strip(),n,line,origin)

    def evidence(self,n,line):
        ev=super().evidence(n,line);ev['text']=line;ev['truncated']=False
        return ev

    def flush_slot(self):
        if self.dmi_slot.get('address') and self.dmi_slot.get('designation'):
            self.r['dmi_slots'].append(self.dmi_slot)
        self.dmi_slot={}

    def put(self,fields,key,value,n,line,origin):
        value=str(value).strip()
        if not valid(value) and not (value=='0' and (key in {'numa','index','memory_used','memory_total'} or key.startswith('ecc') or key.endswith(('Instance ID','/Index')))):return
        values=fields.setdefault(key,[])
        if not any(x['value']==value for x in values):values.append({'value':value,'origin':origin,'evidence':self.evidence(n,line)})

    def event(self,kind,address,code,n,line):
        if kind in {'mods','thermal'}:return
        super().event(kind,address,code,n,line)
        if len(self.r['event_records'])<200000:
            self.r['event_records'].append({'kind':kind,'address':address,'code':str(code),'evidence':self.evidence(n,line)})
        else:
            self.r['complete']=False;self.warn('错误记录达到 200000 条，后续记录未保存。')

    def consume(self,line,n):
        s=line.strip()
        boundary=line.startswith('*** ') or (s.startswith('__________') and set(s)=={'_'})
        if boundary:
            self.flush_slot()
            self.dmi_type=None;self.pci_node=None;self.os_block=False;self.smi_scope='';self.in_sysfs=None
            self.csv_columns=None
        if boundary or core.SMI_GPU_RE.match(line) or re.match(r'Attached GPUs\s*:',s):self.smi_path=[]
        health_start=len(self.r['health_counters'])
        super().consume(line,n)
        # The adapter retains the full hierarchy, including MIG instance scope.
        if self.current_gpu and self.smi is not None and s and not core.SMI_GPU_RE.match(line):
            indent=len(line)-len(line.lstrip())
            while self.smi_path and self.smi_path[-1][0]>=indent:self.smi_path.pop()
            if ':' not in s:self.smi_path.append((indent,s))
            m=re.match(r'Index\s*:\s*(\d+)$',s)
            if m and self.smi_path and self.smi_path[-1][1]=='MIG Device':
                self.smi_path[-1]=(self.smi_path[-1][0],'MIG Device '+m[1])
            path=[name for _,name in self.smi_path]
            for counter in self.r['health_counters'][health_start:]:
                counter['path']='/'.join(path+[s.split(':',1)[0].strip()])
        if 'NVRM:' in line or line.startswith('['):return
        # Explicit nvidia-smi CSV headers establish the BDF/identity mapping.
        if ',' in s:
            values=next(csv.reader([s]))
            labels=[re.sub(r'\s*\[.*?\]\s*','',v).strip().lower() for v in values]
            aliases={'pci.bus_id':'pci','pci bus id':'pci','bus id':'pci','uuid':'uuid','gpu uuid':'uuid','serial':'serial','serial number':'serial','name':'model','gpu name':'model','index':'index'}
            columns={aliases[label]:i for i,label in enumerate(labels) if label in aliases}
            if 'pci' in columns and any(k in columns for k in ('uuid','serial','model')):
                self.csv_columns=columns
                return
            if self.csv_columns and len(values)>max(self.csv_columns.values()):
                address=values[self.csv_columns['pci']].strip()
                if re.fullmatch(core.BDF,address):
                    address=core.bdf(address)
                    for key,i in self.csv_columns.items():
                        value=values[i].strip()
                        if key=='index' and re.fullmatch(r'\d+',value):self.put(self.r['gpu_indices'].setdefault(address,{}),'index',value,n,line,'nvidia-smi CSV')
                        elif key in ('uuid','serial','model'):self.field(address,key,value,n,line,'nvidia-smi CSV')
                    self.r['recognized']=True
                    return
        elif s:
            self.csv_columns=None
        if n<=150:
            m=re.match(r'^uname:\s+Linux\s+(\S+)',line)
            if m:self.put(self.r['server_fields'],'host',m[1],n,line,'report uname')
            m=re.search(r'\|\s*Hostname\s*:\s*(\S+)',line)
            if m:self.put(self.r['server_fields'],'host',m[1],n,line,'report OS Details')
            m=re.search(r'(?:OS Details\s*)?\|\s*Distribution\s*:\s*(.+)',line)
            if m:self.put(self.r['server_fields'],'os_header',m[1],n,line,'report OS Details')
        if line.startswith('*** '):
            self.os_block='os-release' in line
            m=re.search(r'/sys/bus/pci/devices/('+core.BDF+r')/(numa_node|local_cpulist)',line)
            if m:self.in_sysfs=(core.bdf(m[1]),m[2])
        m=re.search(r'^Handle .+ DMI type (\d+),',s)
        if m:self.flush_slot();self.dmi_type=int(m[1])
        if s=='System Information' and ('dmidecode' in self.section.lower() or self.dmi_type==1):self.dmi_type=1
        if s=='System Slot Information':self.dmi_type=9
        if self.dmi_type==1:
            m=re.match(r'(Manufacturer|Product Name|Serial Number|UUID):\s*(.*)',s)
            if m:self.put(self.r['server_fields'],{'Manufacturer':'manufacturer','Product Name':'model','Serial Number':'sn','UUID':'uuid'}[m[1]],m[2],n,line,'dmidecode Type 1')
        if self.dmi_type==9:
            m=re.match(r'Designation:\s*(.+)',s)
            if m and valid(m[1]) and m[1]!='NotAvailable':self.dmi_slot.update(designation=m[1],evidence=self.evidence(n,line))
            m=re.match(r'Bus Address:\s*('+core.BDF+r')\s*$',s)
            if m:self.dmi_slot.update(address=core.bdf(m[1]),bus_evidence=self.evidence(n,line))
        # 主板、机箱和 Type 9 记录不冒充服务器 SN；未知总线关联不生成槽位。
        m=PCI_HEADER.match(line)
        if m:
            address=core.bdf(m[1]);self.pci_node=address
            node=self.r['pci_nodes'].setdefault(address,{'address':address,'fields':{},'bridge':'PCI bridge' in m[2],'gpu':bool(core.LSPCI_RE.match(line))})
            if node['gpu']:self.put(node['fields'],'pci_model',m[2],n,line,'lspci')
            node['evidence']=self.evidence(n,line)
        if self.pci_node:
            fields=self.r['pci_nodes'][self.pci_node]['fields']
            m=re.match(r'Physical Slot:\s*(.+)',s)
            if m:self.put(fields,'slot',m[1],n,line,'lspci Physical Slot')
            m=re.match(r'Bus:\s*primary=([\da-f]+),\s*secondary=([\da-f]+),\s*subordinate=([\da-f]+)',s,re.I)
            if m:self.put(fields,'secondary',m[2].lower(),n,line,'lspci Bus secondary')
            m=re.match(r'NUMA node:\s*(-?\d+)',s)
            if m and int(m[1])>=0:self.put(fields,'numa',m[1],n,line,'lspci NUMA node')
            m=re.match(r'(LnkCap|LnkSta):.*?Speed\s+([\d.]+GT/s).*?Width\s+(x\d+)',s)
            if m:self.put(fields,'link_max' if m[1]=='LnkCap' else 'link',f'{m[2]} · {m[3]}',n,line,'lspci '+m[1])
        if self.in_sysfs and re.match(r'^-?\d+(?:[-,]\d+)*$',s):
            address,key=self.in_sysfs;node=self.r['pci_nodes'].setdefault(address,{'address':address,'fields':{},'bridge':False,'gpu':False})
            if s!='-1':self.put(node['fields'],'numa' if key=='numa_node' else 'cpu_affinity',s,n,line,'sysfs '+key)
            self.in_sysfs=None
        if self.os_block and s.startswith('PRETTY_NAME='):self.put(self.r['server_fields'],'os',s.split('=',1)[1].strip('"'),n,line,'os-release')
        if (('hostname' in self.section.lower() and not 'hostnamectl' in self.section.lower()) and re.match(r'^[\w.-]+$',s) and not s.startswith(('_','-'))):
            self.put(self.r['server_fields'],'host',s,n,line,'hostname')
        # NVIDIA-SMI 表格中的 GPU 索引和 BDF 在同一行时才关联。
        m=re.search(r'^\|\s*(\d+)\s+[^|]+\|\s*('+core.BDF+r')\s+',line)
        if m:self.put(self.r['gpu_indices'].setdefault(core.bdf(m[2]),{}),'index',m[1],n,line,'nvidia-smi table')
        if self.current_gpu and self.smi is not None:
            scopes=[name for _,name in self.smi_path]
            self.smi_scope=scopes[-1] if scopes else ''
            is_mig=any(name.startswith('MIG Device') for name in scopes)
            if is_mig:
                m=re.match(r'(Index|GPU Instance ID|Compute Instance ID)\s*:\s*(\d+)',s)
                if m:self.put(self.r['scoped_metrics'].setdefault(self.current_gpu,{}),'/'.join(scopes+[m[1]]),m[2],n,line,'nvidia-smi snapshot')
            m=re.match(r'(GPU Current Temp|GPU Power Draw|Power Draw|Instantaneous Power Draw|Average Power Draw|DRAM Uncorrectable|Used|Total|Volatile Uncorr\. ECC)\s*:\s*(.*)',s)
            if m:
                key={'GPU Current Temp':'temp','Volatile Uncorr. ECC':'ecc'}.get(m[1])
                if m[1] in {'GPU Power Draw','Power Draw'} and (not scopes or self.smi_scope in {'GPU Power Readings','Power Readings'}):key='power'
                if m[1] in {'Instantaneous Power Draw','Average Power Draw'} and self.smi_scope in {'GPU Power Readings','Power Readings'}:key='power' if m[1]=='Instantaneous Power Draw' else 'power_average'
                if m[1]=='DRAM Uncorrectable' and scopes[-2:]==['ECC Errors','Volatile']:key='ecc_dram_volatile'
                if m[1] in {'Used','Total'} and self.smi_scope=='FB Memory Usage':key='memory_'+m[1].lower()
                if key:
                    target=self.r['scoped_metrics'] if is_mig else self.r['metrics']
                    self.put(target.setdefault(self.current_gpu,{}),'/'.join(scopes+[key]) if is_mig else key,m[2],n,line,'nvidia-smi snapshot')
            if scopes[-3:]==['ECC Errors','Volatile','Double Bit']:
                m=re.match(r'Device Memory\s*:\s*(.*)',s)
                if m and not is_mig:self.put(self.r['metrics'].setdefault(self.current_gpu,{}),'ecc_dram_volatile',m[1],n,line,'nvidia-smi snapshot')

    def parse(self,stream):
        result=super().parse(stream);self.flush_slot();return result

core.Parser=Parser

def one(fields,key):
    values=fields.get(key,[])
    return values[0]['value'] if len(values)==1 else ('冲突' if len(values)>1 else '')

def refs(fields,key):return fields.get(key,[])

def sampled(fields,key):
    value=one(fields,key)
    return '多个采集值' if value=='冲突' else value

def convert(r,container_warnings=(),cancel_event=None):
    inventory=r['gpu_inventory'];nodes=r['pci_nodes']
    addresses=sorted(set(inventory)|set(r['pci_gpu_addresses'])|{e['address'] for e in r['event_records'] if e['address'] and e['kind'] in {'xid','init','fallen','channel','ecc','smi_error'}})
    gpus=[]
    for i,address in enumerate(addresses):
        core.check_cancel(cancel_event)
        fields=inventory.get(address,{}).get('fields',{});nf=nodes.get(address,{}).get('fields',{});mf=r['metrics'].get(address,{})
        for ds in r['dmi_slots']:
            if ds['address']==address:
                values=nf.setdefault('slotDesignation',[])
                if not any(x['value']==ds['designation'] for x in values):values.append({'value':ds['designation'],'origin':'dmidecode Type 9 · Bus Address exact match','evidence':ds['evidence'],'bus_evidence':ds['bus_evidence']})
        index=one(r['gpu_indices'].get(address,{}),'index')
        sn=one(fields,'serial');physical=one(nf,'slot');designation=one(nf,'slotDesignation')
        slot=' / '.join(filter(None,[physical,designation]))
        if '冲突' in (physical,designation):slot='冲突'
        slot_refs=refs(nf,'slot')+refs(nf,'slotDesignation')
        parents=[p for p,v in nodes.items() if v.get('bridge') and p.split(':')[0]==address.split(':')[0] and one(v['fields'],'secondary')==address.split(':')[1]]
        parent=parents[0] if len(parents)==1 else ''
        gpus.append({'id':i,'index':index,'label':f'GPU {index}' if index not in ('','冲突') else f'GPU · {address[5:]}','pci':address,'model':one(fields,'model') or one(nf,'pci_model'),'sn':sn,'uuid':one(fields,'uuid'),'slot':slot,'slotSource':'; '.join(x['origin'] for x in slot_refs),'slotRaw':'\n\n'.join(f"{r['source']} · 第 {v['evidence']['line']} 行\n{v['evidence']['text']}" for v in slot_refs),'status':'有冲突' if '冲突' in [sn,slot,one(fields,'uuid')] else ('已读取' if inventory.get(address) else '仅 PCI / 错误记录'),'temp':sampled(mf,'temp'),'power':sampled(mf,'power') or (sampled(mf,'power_average')+'（平均）' if sampled(mf,'power_average') else ''),'memory':' / '.join(filter(None,[sampled(mf,'memory_used'),sampled(mf,'memory_total')])),'ecc':sampled(mf,'ecc_dram_volatile'),'numa':one(nf,'numa'),'cpuAffinity':one(nf,'cpu_affinity'),'parent':parent,'link':one(nf,'link'),'linkMax':one(nf,'link_max'),'fields':fields,'pciFields':nf,'metrics':mf,'scopedMetrics':r['scoped_metrics'].get(address,{}),'healthCounters':[c for c in r['health_counters'] if c['address']==address],'errors':0})
    ids={g['pci']:g['id'] for g in gpus};events=[]
    for i,e in enumerate(r['event_records']):
        core.check_cancel(cancel_event)
        ev=e['evidence'];item=CATALOG['codes'].get(e['code']) if e['kind']=='xid' else None
        title=item['title'] if item else (f"未收录 Xid {e['code']}" if e['kind']=='xid' else core.LABELS.get(e['kind'],e['kind']))
        row={'id':f'e{i}','gpu':ids.get(e['address']),'address':e['address'] or '', 'kind':e['kind'],'code':e['code'],'time':ev['time']['raw'] or '—','title':title,'description':item['description'] if item else '', 'actions':item['actions'] if item else [],'line':ev['line'],'raw':ev['text'],'truncated':ev.get('truncated',False),'section':ev['section'],'boot':ev['boot_marker'],'manual':item,'source':r['source']}
        events.append(row)
        if row['gpu'] is not None:gpus[row['gpu']]['errors']+=1
    sf=r['server_fields'];server={k:one(sf,k) for k in ('model','sn','host','os','manufacturer','uuid')}
    if not server['os']:server['os']=one(sf,'os_header')
    server.update(driver=' / '.join(r['driver_versions']),time=' / '.join(x['raw'] for x in r['collection_time']),fields=sf)
    raw='\n\n'.join(f"{p}\n"+'\n'.join(f"{k}: {v['value']} [第 {v['evidence']['line']} 行]" for k,vs in node['fields'].items() for v in vs) for p,node in nodes.items() if node.get('bridge') or p in ids)
    warnings=list(dict.fromkeys(list(container_warnings)+r['warnings']))
    if any(g['status']=='有冲突' for g in gpus):warnings.append('设备字段存在冲突，可在来源中核对。')
    return {'source':r['source'],'server':server,'gpus':gpus,'events':events,'nodes':nodes,'topologyRaw':raw,'warnings':warnings,'complete':r['complete'],'recognized':r['recognized'],'lines':r['lines_read'],'bytes':r['bytes_read'],'smiCounts':[s['attached'] for s in r['smi_snapshots']],'catalog':{'file':CATALOG['file'],'sha256':CATALOG['sha256']},'contentSha256':r['sha256_content']}

def analyze(path,cancel_event=None):
    result=core.analyze_path(path,cancel_event=cancel_event)
    cases=[convert(r,result['warnings'],cancel_event) for r in result['reports']]
    for case in cases:
        case['complete']=case['complete'] and result['complete']
    return cases
