/* Offline findings with explicit evidence and coverage. No hardware operations. */
((root)=>{'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const analysis=root.XidAnalysis||(typeof require==='function'?require('./analysis.js'):null);
const labels={error:'发现错误',conflict:'字段冲突',review:'待核实',missing:'数据缺失',ok:'未见异常'};
const order={error:0,conflict:1,review:2,missing:3,ok:4};
const names={model:'产品名称',serial:'GPU SN',uuid:'GPU UUID',slot:'物理槽位',slotDesignation:'槽位名称',numa:'NUMA 节点',host:'主机名',sn:'服务器 SN',manufacturer:'厂商'};
const pathNames={'ECC Errors':'ECC','Volatile':'易失性','Aggregate':'累计','DRAM':'DRAM','SRAM':'SRAM','Uncorrectable':'不可纠正','Correctable':'可纠正','DRAM Uncorrectable':'DRAM 不可纠正','DRAM Correctable':'DRAM 可纠正','Double Bit':'双比特','Single Bit':'单比特','Device Memory':'显存','Remapped Rows':'行重映射','Pending':'待处理','Remapping Failure Occurred':'重映射失败','Retired Pages':'退役页'};
const PAGE_SIZE=50;
let report=null,context=null,model=null,cache=null;
const state={selected:'',filter:'all',query:'',page:0,collect:false,evidenceLimit:20};
const usable=v=>v!==null&&v!==undefined&&!['','n/a','unknown','not available','not supported','冲突','—'].includes(String(v).trim().toLowerCase());
const pathLabel=p=>String(p||'').split('/').map(x=>pathNames[x]||x).join(' · ');
const originLabel=v=>({'nvidia_smi_snapshot':'nvidia-smi -q','proc_information':'/proc/driver/nvidia 信息','lspci':'lspci','nvidia_smi_query':'nvidia-smi 查询'}[v]||v);
const timeLabel=e=>{const time=e?.time;return (typeof time==='object'?time?.raw:time)||'时间未记录';};
const lineKey=e=>JSON.stringify([e?.caseId||e?.reportId||'',e?.source||'',e?.line,e?.endLine,e?.jsonPointer,e?.text]);
const references=items=>[...new Map((items||[]).filter(Boolean).map(e=>[lineKey(e),e])).values()];
const refOf=v=>({...v.evidence,origin:v.origin||v.evidence?.origin||'',value:v.value});
function guideFor(rule){
 if(/smi|ecc|remap|health/.test(rule))return 'smi';
 if(/topology/.test(rule))return 'topology';
 if(/pcie|driver/.test(rule))return 'pci';
 if(/incomplete/.test(rule))return 'complete';
 return 'kernel';
}
function nextStep(check){
 const rule=check.rule||'';
 if(rule==='pcie-link'||rule==='smi-link')return '核对采集时负载、链路对端、插槽布线和 BIOS 配置，再比较相同时点的链路值。';
 if(rule==='pcie-status'||rule==='aer')return '结合内核 AER 严重级别、发生时间和上下游端口核对。';
 if(rule==='driver')return '核对设备用于主机计算还是虚拟机直通，再检查对应驱动。';
 if(rule==='smi-read')return '保留读取错误，核对驱动、权限和同期内核日志。';
 if(rule==='smi-health')return /ECC|Replay/.test(check.path||'')?'按同一设备和统计周期比较多次采集，核对期间是否有驱动重载或计数重置。':'结合该设备的 nvidia-smi 状态和同期内核记录核对。';
 return '查看对应原文及上下文，核对采集范围和时间。';
}
function buildModel(data){
 const gpus=data.gpus||[],checks=data.diagnostics?.checks||[],snapshots=data.diagnostics?.snapshots||[];
 const gpuByAddress=new Map(gpus.map(g=>[g.pci,g])),byAddress=new Map(),snapByAddress=new Map(),findings=[],gaps=new Set();
 const add=item=>findings.push({evidence:[],scope:[],gaps:[],actions:[],...item});
 for(const c of checks){if(!byAddress.has(c.address||''))byAddress.set(c.address||'',[]);byAddress.get(c.address||'').push(c);}
 for(const s of snapshots){if(!snapByAddress.has(s.address))snapByAddress.set(s.address,[]);snapByAddress.get(s.address).push(s);}
 const device=address=>gpuByAddress.get(address)?.label||data.nodes?.[address]?.kind|| (address?'PCIe 设备':'报告');
 const uniqueChecks=new Map();
 for(const c of checks){
  if(c.status==='ok')continue;
  // Replace the global missing snapshot notice with one scoped item per GPU.
  if(c.rule==='smi-data'&&gpus.length)continue;
  const key=JSON.stringify([c.address,c.rule,c.path,c.status,c.title,c.observation]);
  if(uniqueChecks.has(key)){uniqueChecks.get(key).evidence.push(...c.evidence||[]);continue;}
  const status=Object.hasOwn(labels,c.status)?c.status:'review';
  const title=/^ECC Errors\//.test(c.path||'')?pathLabel(c.path):c.title||'检查结果';
  const observation=c.path&&c.observation?.startsWith(c.path+': ')?c.observation.slice(c.path.length+2):c.observation||'日志未提供观察值。';
  const item={id:'check:'+String(c.id??uniqueChecks.size),address:c.address||'',device:device(c.address),status,title,observation,basis:c.basis||'',next:nextStep(c),evidence:[...c.evidence||[]],gaps:status==='missing'?[guideFor(c.rule||'')]:[],checkId:c.id,snapshot:c.snapshot||'',path:c.path||''};
  uniqueChecks.set(key,item);add(item);for(const gap of item.gaps)gaps.add(gap);
 }
 const conflict=(fields,address,prefix)=>{
  for(const [field,records] of Object.entries(fields||{})){
   const valid=records.filter(v=>usable(v.value)),values=[...new Set(valid.map(v=>String(v.value).trim()))];
   if(values.length<2)continue;
   add({id:'conflict:'+prefix+':'+address+':'+field,address,device:device(address),status:'conflict',title:(names[field]||field)+'存在不同值',observation:values.join(' / '),basis:'同一设备标识下的来源提供了不同值；保留各处原始记录。',next:'核对采集时间、启动会话与来源，确认是否属于同一设备。',evidence:references(valid.map(refOf)),values:valid.map(v=>({value:String(v.value),origin:v.origin||'来源未记录',evidence:v.evidence||{}}))});
  }
 };
 for(const g of gpus){
  // Stable identity fields can conflict; changing measurements are not identity conflicts.
  conflict(Object.fromEntries(['model','serial','uuid'].filter(k=>g.fields?.[k]).map(k=>[k,g.fields[k]])),g.pci,'gpu');
  conflict(Object.fromEntries(['slot','slotDesignation','numa'].filter(k=>g.pciFields?.[k]).map(k=>[k,g.pciFields[k]])),g.pci,'pci');
  const snaps=snapByAddress.get(g.pci)||[],scope=[],ownChecks=byAddress.get(g.pci)||[];
  const relevant=new Map();
  for(const c of ownChecks){const key=(c.rule||'')+'|'+(c.path||c.title||'');if(!relevant.has(key))relevant.set(key,[]);relevant.get(key).push(c);}
  for(const records of relevant.values())if(records.every(c=>c.status==='ok')){
   const values=[...new Set(records.map(c=>c.observation||''))];
   if(values.length===1)scope.push({name:records[0].title,value:values[0],evidence:references(records.flatMap(c=>c.evidence||[]))});
  }
  const paths=new Map();
  for(const s of snaps)for(const f of s.fields||[]){if(!paths.has(f.path))paths.set(f.path,[]);paths.get(f.path).push(f);}
  const unavailable=[];
  for(const [path,fields] of paths){
   const relevant=/^ECC Errors\//.test(path)||/^Remapped Rows\/.+(?:Pending|Failure)/.test(path)||/^Remapped Rows\/(?:Pending|Remapping Failure Occurred)$/.test(path);
   if(!relevant)continue;
   const values=[...new Set(fields.map(f=>String(f.value).trim()))];
   if(values.every(v=>v.toLowerCase()==='not supported'))continue;
   if(fields.some(f=>f.availability==='unavailable'||!usable(f.value))){unavailable.push(pathLabel(path));continue;}
   const checked=ownChecks.some(c=>c.path===path&&c.status!=='ok');
   const zero=/^ECC Errors\//.test(path)&&values.every(v=>/^0+$/.test(v));
   const no=/^Remapped Rows\//.test(path)&&/(?:Pending|Failure)/.test(path)&&values.every(v=>v.toLowerCase()==='no');
   if(values.length===1&&!checked&&(zero||no))scope.push({name:pathLabel(path),value:values[0],evidence:references(fields.map(f=>f.evidence))});
  }
  if(!snaps.length||snaps.every(s=>!s.fields?.length)){
   gaps.add('smi');add({id:'missing:smi:'+g.pci,address:g.pci,device:g.label,status:'missing',title:'缺少 GPU 详细状态',observation:'未读取到该设备的 nvidia-smi -q 状态块。',basis:'ECC、行重映射等状态无法判断。',next:'补充同一次采集的 nvidia-smi -q 输出。',gaps:['smi'],evidence:references([g.pciEvidence,...Object.values(g.fields||{}).flatMap(v=>v.map(x=>x.evidence))])});
  }else if(unavailable.length){
   gaps.add('smi');add({id:'missing:fields:'+g.pci,address:g.pci,device:g.label,status:'missing',title:'部分 GPU 状态无法读取',observation:unavailable.join('；'),basis:'N/A、Unknown 或不可用字段不能按 0 处理；需核对设备支持范围和读取条件。',next:'核对字段支持范围、驱动和读取条件后补充采集。',gaps:['smi'],evidence:references([...paths.values()].flat().filter(f=>f.availability==='unavailable'||!usable(f.value)).map(f=>f.evidence))});
  }
  if(scope.length)add({id:'ok:'+g.pci,address:g.pci,device:g.label,status:'ok',title:'已检查项目',observation:scope.length+' 项已检查',basis:'结论仅覆盖下列项目及其采集时点。',next:'需要核验时查看对应原文。',scope,evidence:references(scope.flatMap(x=>x.evidence))});
 }
 conflict(Object.fromEntries(['model','sn','uuid','host','manufacturer'].filter(k=>data.server?.fields?.[k]).map(k=>[k,data.server.fields[k]])),'','server');
 const eventGroups=new Map();
 const checkedLines=new Set(checks.filter(c=>c.status==='error'||c.status==='review').flatMap(c=>(c.evidence||[]).map(e=>JSON.stringify([c.address,e.line]))));
 for(const e of data.events||[]){
  if(!['sxid','goe'].includes(e.kind)&&checkedLines.has(JSON.stringify([e.address,e.line])))continue;
  const key=analysis.eventKey(e);
  if(!eventGroups.has(key))eventGroups.set(key,[]);eventGroups.get(key).push(e);
 }
 for(const [key,events] of eventGroups){
  const e=events[0],structured=['sxid','goe'].includes(e.kind),count=analysis.countEvents(events),metadata=structured?analysis.eventMetadata(e):[];
  const evidence=events.flatMap(x=>{const refs=analysis.sourceEvidence(x),fallback={line:x.line,text:x.raw,time:x.time,section:x.section,boot_marker:x.boot,source:x.source,caseId:x.caseId||x.reportId};return refs.length?refs.map(ref=>({...fallback,...ref,text:ref.text||x.raw,caseId:x.caseId||x.reportId})): [fallback];});
  const origins=references(evidence),name=structured?analysis.eventTitle(e):e.kind==='xid'?'Xid '+e.code+' · '+(e.title||'错误记录'):e.title||(e.kind==='init'?'初始化失败':'错误记录');
  const label=analysis.eventNamespace(e)==='nvswitch'?'NVSwitch'+(e.structured?.switch!=null?' '+e.structured.switch:''):e.kind==='goe'?(gpus.find(g=>g.id===e.gpu)?.label||e.targetUUID||e.structured?.deviceUUID||'未关联设备'):device(e.address);
  add({id:'event:'+key,address:e.address||'',device:label,status:e.kind==='goe'?'review':'error',title:name,observation:count+' 次事件'+(origins.length!==count?' · '+origins.length+' 处来源':''),basis:[e.description||'日志记录了此事件。需结合设备状态和上下文核对。',...metadata.map(([label,value])=>label+'：'+value)].join(' '),next:'核对原文、影响范围和同期设备状态。',actions:e.actions||[],event:e,evidence:origins,count});
 }
 if(data.complete===false&&!checks.some(c=>c.rule==='incomplete')){gaps.add('complete');add({id:'missing:complete',device:'报告',address:'',status:'missing',title:'日志读取不完整',observation:'结果仅覆盖已读取内容。',basis:'未读取内容无法判断。',next:'查看读取提示，保留完整日志后重新导入。',gaps:['complete']});}
 if(!data.diagnostics&&data.source){gaps.add('reparse');add({id:'missing:legacy',device:'报告',address:'',status:'missing',title:'此报告需要重新解析',observation:'旧报告未包含结构化检查结果。',basis:'重新解析后可显示状态检查和采集缺口。',next:'在报告管理中选择此报告并重新解析。',gaps:['reparse']});}
 for(const f of findings)f.evidence=references(f.evidence);
 findings.sort((a,b)=>order[a.status]-order[b.status]||(a.address||'').localeCompare(b.address||''));
 return {findings,gaps:[...gaps],counts:Object.fromEntries(Object.keys(labels).map(k=>[k,findings.filter(f=>f.status===k).length])),gpuCount:gpus.length,source:data.source||'',complete:data.complete!==false};
}
const guides={smi:{title:'GPU 详细状态',command:'nvidia-smi -q',detail:'保留完整输出、采集时间和设备标识，用于核对 ECC、行重映射及字段读取状态。'},pci:{title:'PCIe 设备与驱动',command:'lspci -Dnnvv',detail:'保留 GPU 和上下游端口的 LnkCap、LnkSta、AER 及驱动字段；部分字段需要相应读取权限。'},topology:{title:'GPU 互联关系',command:'nvidia-smi topo -m',detail:'保留表头和所有设备行；需要仅查看 PCIe 关系时另采集 nvidia-smi topo -mp。'},kernel:{title:'本次启动内核日志',command:'journalctl -k -b --no-pager',detail:'保留事件前后文及启动会话。无 journalctl 时可保留 dmesg 输出及其时间类型。'},complete:{title:'完整原始日志',command:'',detail:'查看读取提示，保留未截断的原始文件后重新导入。'},reparse:{title:'重新解析报告',command:'',detail:'打开报告管理，选中此报告并重新解析。'}};
function collectionHtml(keys){
 const selected=[...new Set(keys?.length?keys:['smi','pci','kernel','topology'])].filter(k=>guides[k]);
 const commands=selected.map(k=>guides[k].command).filter(Boolean);
 return `<section class="overview-collection" aria-label="采集清单"><div class="overview-section-heading"><h3>采集清单</h3><button class="link-btn" data-overview="close-collect">收起</button></div><p class="overview-note">在目标机器上读取并保存输出；本工具不会执行这些命令。保留采集时间和来源文件。</p>${selected.map(k=>{const g=guides[k];return `<div class="overview-guide"><strong>${esc(g.title)}</strong>${g.command?`<code>${esc(g.command)}</code>`:''}<p>${esc(g.detail)}</p></div>`;}).join('')}${commands.length?`<button class="btn" data-copy="${esc(commands.join('\n'))}">复制命令</button>`:''}</section>`;
}
const ico=name=>context?.icon?.(name,'small-icon')||'';
const badge=status=>`<span class="overview-state overview-${esc(status)}">${ico(status==='ok'?'check':status==='error'?'errors':'info')}<span>${esc(labels[status])}</span></span>`;
function sourceLink(e,label='查看原文'){
 if(!Number.isInteger(e?.line)||e.line<=0)return '';
 return `<button class="link-btn overview-source" data-source-line="${e.line}"${e.caseId||e.reportId?` data-source-case="${esc(e.caseId||e.reportId)}"`:''} aria-label="${esc(label)}，第 ${e.line} 行">${esc(label)} · 第 ${e.line.toLocaleString()} 行${ico('external')}</button>`;
}
function evidenceHtml(items){
 if(!items.length)return '<p class="overview-note">没有可定位的原文；需补充来源。</p>';
 const visible=items.slice(0,state.evidenceLimit);
 return `<div class="overview-evidence">${visible.map(e=>`<div class="overview-evidence-item"><div class="overview-evidence-meta"><span>${esc(e.origin||e.section||e.source||'原始日志')}</span>${sourceLink(e,'原文')}</div><pre>${esc(e.text||e.value||'原文未保存')}</pre>${e.jsonPointer?`<p class="overview-note mono">${esc(e.jsonPointer)}</p>`:''}${e.time||e.boot_marker?`<p class="overview-note">${esc(timeLabel(e))}${e.boot_marker?' · '+esc(e.boot_marker):''}</p>`:''}</div>`).join('')}${items.length>visible.length?`<button class="btn" data-overview="more-evidence">显示更多来源（${visible.length} / ${items.length}）</button>`:''}</div>`;
}
function detail(f){
 if(!f)return '<div class="overview-detail-empty"><h2>没有匹配的发现</h2><p>调整筛选或查看完整日志。</p></div>';
 let body='';
 if(f.status==='conflict')body=`<p class="overview-detail-summary">${esc(f.next)}</p><div class="overview-conflicts">${f.values.slice(0,state.evidenceLimit).map(v=>`<section class="overview-conflict"><h3>${esc(originLabel(v.origin))}</h3><strong>${esc(v.value)}</strong><p>${esc(timeLabel(v.evidence))}</p>${sourceLink(v.evidence)}<pre>${esc(v.evidence.text||v.value)}</pre></section>`).join('')}</div>${f.values.length>state.evidenceLimit?'<button class="btn" data-overview="more-evidence">显示更多来源</button>':''}`;
 else if(f.status==='ok')body=`<p class="overview-detail-summary">${esc(f.basis)}</p><div class="overview-scope"><table aria-label="已检查项目"><thead><tr><th>检查项</th><th>观察值</th><th>来源</th></tr></thead><tbody>${f.scope.slice(0,state.evidenceLimit).map(s=>`<tr><th scope="row">${esc(s.name)}</th><td>${esc(s.value)}</td><td>${sourceLink(s.evidence[0],'原文')||'来源未记录'}</td></tr>`).join('')}</tbody></table></div>${f.scope.length>state.evidenceLimit?'<button class="btn" data-overview="more-evidence">显示更多检查项</button>':''}<p class="overview-note overview-limit">未采集的项目不计为正常。</p>`;
 else body=`<section class="overview-detail-section"><h3>${f.status==='missing'?'缺少什么':'观察结果'}</h3><p>${esc(f.observation)}</p></section><section class="overview-detail-section"><h3>${f.status==='missing'?'影响范围':'判断依据'}</h3><p>${esc(f.basis||'查看原文及上下文。')}</p>${f.path&&f.title!==pathLabel(f.path)?`<p class="overview-path">${esc(pathLabel(f.path))}</p>`:''}</section>${f.status!=='missing'?`<section class="overview-detail-section"><h3>下一步</h3><p>${esc(f.next)}</p>${f.actions.length?`<ul>${f.actions.map(a=>`<li>${esc(typeof a==='string'?a:a.text||a.label||a.key||'')}</li>`).join('')}</ul>`:''}</section>`:''}<section class="overview-detail-section"><h3>${f.status==='missing'?'已有证据':'证据'}</h3>${evidenceHtml(f.evidence)}</section>`;
 const primary=f.status==='missing'?'<button class="btn primary" data-overview="collect">查看补采清单</button>':f.status==='conflict'?'<button class="btn" data-page="reader">查看完整日志</button>':Number.isInteger(f.evidence[0]?.line)&&f.evidence[0].line>0?`<button class="btn primary" data-source-line="${f.evidence[0].line}"${f.evidence[0].caseId||f.evidence[0].reportId?` data-source-case="${esc(f.evidence[0].caseId||f.evidence[0].reportId)}"`:''}>查看对应原文</button>`:'<button class="btn" data-page="reader">查看完整日志</button>';
 return `<div class="overview-detail-head"><p>${esc(f.device)}${f.address?` · <span class="mono">${esc(f.address)}</span>`:''}</p><h2>${esc(f.title)}</h2>${badge(f.status)}</div><div class="overview-detail-body" data-scroll-key="overview-detail-body">${body}${state.collect?collectionHtml(f.gaps.length?f.gaps:model.gaps):''}</div><div class="overview-detail-actions">${primary}${f.status==='missing'&&f.evidence.length?sourceLink(f.evidence[0],'查看已有原文'):''}</div>`;
}
function row(f){return `<button class="overview-row ${state.selected===f.id?'is-selected':''}" data-overview="select" data-value="${esc(f.id)}" aria-pressed="${state.selected===f.id}" aria-controls="overview-detail"><span class="overview-device"><strong>${esc(f.device)}</strong><span class="mono">${esc(f.address||'采集范围')}</span></span><span class="overview-observation"><strong>${esc(f.title)}</strong><span>${esc(f.observation)}</span></span>${badge(f.status)}${ico('chevron')}</button>`;}
function render(data,ctx){
 report=data;context=ctx;
 if(cache?.data!==data){cache={data,model:buildModel(data)};}model=cache.model;
 const title='<div class="overview-heading"><h1 tabindex="-1">诊断概览</h1>';
 if(!data.source)return `<div class="overview-workspace">${title}</div><div class="overview-start"><h2>导入日志开始分析</h2><p>读取设备信息、重点发现和对应原文。日志在本机处理。</p><div class="actions"><button class="btn primary" data-action="import">导入日志</button><button class="btn" data-action="load-demo">查看示例</button><button class="btn" data-overview="collect">采集说明</button></div>${state.collect?collectionHtml():''}</div></div>`;
 const q=state.query.trim().toLowerCase(),filtered=model.findings.filter(f=>(state.filter==='all'||f.status===state.filter)&&(!q||[f.device,f.address,f.title,f.observation].join(' ').toLowerCase().includes(q)));
 state.page=Math.min(Math.max(0,state.page),Math.max(0,Math.ceil(filtered.length/PAGE_SIZE)-1));
 const visible=filtered.slice(state.page*PAGE_SIZE,(state.page+1)*PAGE_SIZE),current=visible.find(f=>f.id===state.selected)||visible[0];state.selected=current?.id||'';
 const attention=visible.filter(f=>f.status!=='ok'),normal=visible.filter(f=>f.status==='ok');
 const isDcgm=data.structured?.format==='dcgm-json';
 const summary=[isDcgm?'DCGM 诊断':model.gpuCount+' 块 GPU',...Object.entries(labels).filter(([k])=>k!=='ok'&&model.counts[k]).map(([k,v])=>model.counts[k]+' 项'+v)].join(' · ');
 const list=(name,items)=>items.length?`<section class="overview-group"><h2>${name}<span>${items.length}</span></h2>${items.map(row).join('')}</section>`:'';
 const pagination=filtered.length>PAGE_SIZE?`<nav class="overview-pagination" aria-label="发现分页"><span>${state.page*PAGE_SIZE+1}–${Math.min((state.page+1)*PAGE_SIZE,filtered.length)} / ${filtered.length}</span><div><button class="btn" data-overview="page" data-value="${state.page-1}" ${state.page===0?'disabled':''}>上一页</button><button class="btn" data-overview="page" data-value="${state.page+1}" ${(state.page+1)*PAGE_SIZE>=filtered.length?'disabled':''}>下一页</button></div></nav>`:'';
 return `<div class="overview-workspace">${title}<p>${esc(summary)}</p><p class="overview-time">采集时间：${esc(data.server?.time||'未记录')}</p>${isDcgm&&model.findings.length?'<button class="btn" data-page="structured">查看 DCGM 结果</button>':''}</div><div class="overview-layout"><section class="overview-findings" aria-label="诊断发现"><div class="overview-toolbar"><input id="overview-search" class="select" type="search" aria-label="搜索诊断发现" placeholder="设备、发现或 PCI 地址" value="${esc(state.query)}"><select class="select" data-overview-change="filter" aria-label="筛选诊断状态"><option value="all">全部状态</option>${Object.entries(labels).map(([key,value])=>`<option value="${key}" ${key===state.filter?'selected':''}>${value}</option>`).join('')}</select></div><div class="overview-list" data-scroll-key="overview-list">${list('需要关注',attention)}${list('已检查项',normal)}${!filtered.length?`<div class="overview-empty"><h2>${model.findings.length?'没有匹配的发现':isDcgm?'DCGM 测试结果':'没有可判断的检查项'}</h2><p>${model.findings.length?'调整筛选查看其他结果。':isDcgm?'测试结论按结果中的项目与实体展示。':'日志未提供检查所需的数据，不能据此判断设备正常。'}</p><button class="btn" ${isDcgm&&!model.findings.length?'data-page="structured"':`data-overview="${model.findings.length?'clear':'collect'}"`}>${model.findings.length?'清除筛选':isDcgm?'查看结果':'查看采集说明'}</button>${state.collect?collectionHtml(model.gaps):''}</div>`:''}</div>${pagination}</section><aside id="overview-detail" class="overview-detail" data-scroll-key="overview-detail" aria-label="重点发现详情">${current?detail(current):'<div class="overview-detail-empty">选择发现查看详情</div>'}</aside></div></div>`;
}
function reset(){Object.assign(state,{selected:'',filter:'all',query:'',page:0,collect:false,evidenceLimit:20});cache=null;}
function click(el){
 const action=el?.dataset?.overview;if(!action||!context)return false;
 if(action==='select'){state.selected=el.dataset.value;state.collect=false;state.evidenceLimit=20;}
 else if(action==='page'){state.page=Number(el.dataset.value)||0;state.selected='';state.collect=false;}
 else if(action==='clear'){state.filter='all';state.query='';state.page=0;}
 else if(action==='collect'){const f=model?.findings.find(f=>f.id===state.selected);if(context.openCollection){context.openCollection(f?.gaps.length?f.gaps:model?.gaps||[]);return true;}state.collect=true;}
 else if(action==='close-collect')state.collect=false;
 else if(action==='more-evidence')state.evidenceLimit+=20;
 else if(action==='verify'){state.evidenceLimit=Math.max(state.evidenceLimit,2);}
 else return false;
 context.render();
 if(action==='collect'&&typeof document!=='undefined')document.querySelector('.overview-collection')?.scrollIntoView({block:'nearest'});
 if(action==='verify'&&typeof document!=='undefined')document.querySelector('.overview-conflicts .overview-source')?.focus({preventScroll:false});
 return true;
}
function change(el){if(el?.dataset?.overviewChange!=='filter')return false;state.filter=el.value;state.page=0;state.selected='';state.collect=false;context?.render();return true;}
function input(el){if(el?.id!=='overview-search')return false;state.query=el.value;state.page=0;state.selected='';context?.render();if(typeof document!=='undefined')document.getElementById('overview-search')?.focus({preventScroll:true});return true;}
function keydown(event){
 const row=event.target?.closest?.('.overview-row');if(!row||!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||typeof document==='undefined')return false;
 const rows=[...document.querySelectorAll('.overview-row')],i=rows.indexOf(row),next=rows[event.key==='Home'?0:event.key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,i+(event.key==='ArrowDown'?1:-1)))];
 event.preventDefault();if(next){const id=next.dataset.value;click(next);[...document.querySelectorAll('.overview-row')].find(el=>el.dataset.value===id)?.focus({preventScroll:false});}return true;
}
const collectionPlan=keys=>[...new Set(keys?.length?keys:['smi','pci','kernel','topology'])].filter(k=>guides[k]).map(k=>({key:k,...guides[k]}));
const api={render,click,change,input,keydown,reset,buildModel,collectionPlan,capture:()=>({...state}),restore:saved=>{reset();if(saved)Object.assign(state,saved);},afterRender:()=>{}};
if(typeof module!=='undefined'&&module.exports)module.exports={...api,collectionHtml,pathLabel};else root.XidOverview=api;
})(globalThis);
