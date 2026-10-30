/* Diagnostic views consume only parsed report data; log text is always escaped. */
((root)=>{'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={error:'发现错误',review:'待核实',ok:'未见异常',missing:'数据缺失'};
const groups=['概览','显存与 ECC','温度与功耗','时钟与性能','PCIe 链路','配置与模式'];
const meaning={X:'设备自身',SYS:'经过 PCIe 及 NUMA 节点间互联',NODE:'经过同一 NUMA 节点内的 PCIe 主桥互联',PHB:'经过 PCIe 主桥',PXB:'经过多个 PCIe 桥，未经过主桥',PIX:'经过至多一个 PCIe 桥'};
const state={snapshot:'',group:'概览',field:'',query:'',check:'',filter:'all',view:'tree',matrix:'',matrixScope:'gpu',matrixFocus:'',matrixRowPage:0,matrixColPage:0,node:'',only:false,cell:'',treeQuery:'',kind:'all',pathOnly:false,detailHidden:false,unlinkedOpen:false,collapsed:new Set(),initialized:false,reveal:false};
let context=null,report=null,lastPage='';
const detailVisibility=new Map();
Object.assign(state,{gpuPicker:false,gpuQuery:'',statusGpu:null,viewInitialized:false});
const PAGE_SIZE=100;
let indexedChecks=null,indexedCount=-1,checksByAddress=new Map(),checksByField=new Map();
function indexChecks(){
 const list=report.diagnostics.checks;if(indexedChecks===list&&indexedCount===list.length)return;
 indexedChecks=list;indexedCount=list.length;checksByAddress=new Map();checksByField=new Map();
 for(const c of list){if(['error','review','missing'].includes(c.status)){if(!checksByAddress.has(c.address))checksByAddress.set(c.address,[]);checksByAddress.get(c.address).push(c);}if(c.snapshot&&c.path){const key=c.snapshot+'\0'+c.path;if(!checksByField.has(key))checksByField.set(key,[]);checksByField.get(key).push(c);}}
}
function pageRows(rows,key){state[key]=Math.max(0,Math.min(Number(state[key])||0,Math.max(0,Math.ceil(rows.length/PAGE_SIZE)-1)));return rows.slice(state[key]*PAGE_SIZE,(state[key]+1)*PAGE_SIZE);}
function pager(rows,key){if(rows.length<=PAGE_SIZE)return '';const p=state[key];return `<nav class="diag-pagination" aria-label="列表分页"><span>${p*PAGE_SIZE+1}–${Math.min(rows.length,(p+1)*PAGE_SIZE)} / ${rows.length}</span><div><button class="btn" data-diag="${key}" data-value="${p-1}" ${p===0?'disabled':''}>上一页</button><button class="btn" data-diag="${key}" data-value="${p+1}" ${(p+1)*PAGE_SIZE>=rows.length?'disabled':''}>下一页</button></div></nav>`;}
const button=(key,value,text,selected=null)=>`<button class="btn ${selected?'diag-active':''}" data-diag="${key}" data-value="${esc(value)}" ${selected===null?'':`aria-pressed="${selected}"`}>${esc(text)}</button>`;
const badge=s=>`<span class="badge diag-${esc(s)}">${esc(labels[s]||s)}</span>`;
const evidence=items=>{
 const rows=[...new Map((items||[]).filter(Boolean).map(e=>[e.line+'|'+e.text,e])).values()].sort((a,b)=>(Number(a.line)||Infinity)-(Number(b.line)||Infinity));
 if(!rows.length)return '';
 const links=[...new Map(rows.filter(e=>Number.isInteger(e.line)&&e.line>0).map(e=>[e.line,e])).values()];
 const link=(e,label='')=>`<button class="source-location" data-source-line="${e.line}" title="${esc((e.text||'').trim().slice(0,180))}" aria-label="查看第 ${e.line} 行原文">${label}<span>第 ${e.line.toLocaleString()} 行</span>${!label?`<span class="source-preview">${esc((e.text||'').trim().slice(0,180))}</span>`:''}${context.icon?.('external','small-icon')||'↗'}</button>`;
 if(links.length===1&&rows.every(e=>e.line===links[0].line))return `<div class="source-reference">${link(links[0],'<span>原文</span>')}</div>`;
 return `<details class="source-references" ${state.evidencePage>0?'open':''}><summary>原文<span>${rows.length} 处</span></summary><div class="source-reference-list">${pageRows(rows,'evidencePage').map(e=>Number.isInteger(e.line)&&e.line>0?link(e):`<pre>${esc(e.text)}</pre>`).join('')}${pager(rows,'evidencePage')}</div></details>`;
};
const detailToggle=()=>`<button class="btn quiet icon-btn detail-toggle" data-diag="detail" aria-label="${state.detailHidden?'显示详情':'收起详情'}" title="${state.detailHidden?'显示详情':'收起详情'}" aria-expanded="${!state.detailHidden}">${context.icon?.('panel','small-icon')||'◧'}</button>`;
const parameterInfo=f=>{const text=f.description&&!f.description.startsWith('设备在该字段路径下')?`<p>${esc(f.description)}</p>`:'';const path=f.path!==f.name?`<p class="source-meta mono">${esc(f.path)}</p>`:'';return text||path?`<div class="detail-section parameter-info">${text}${path}</div>`:'';};

const split=(body,detail)=>`<div class="workspace-split diag-split ${state.detailHidden?'diag-wide':''}"><section class="workspace-main diag-main">${body}</section><aside class="inspector diag-detail" data-scroll-key="${context.state.page}-detail" ${state.detailHidden?'hidden':''}>${detail}</aside></div>`;
const section=(title,body)=>`<div class="detail-section"><h3>${esc(title)}</h3>${body}</div>`;
const checkList=address=>checksByAddress.get(address)||[];
const checkTitle=c=>c.title+(/\/Volatile\//.test(c.path||'')?'（易失性）':/\/Aggregate\//.test(c.path||'')?'（累计）':'');
function checkDetail(c){return c?`<div class="inspector-title">${badge(c.status)}<h2>${esc(c.title)}</h2><p class="mono">${esc(c.address||'报告')}</p></div>${section('观察结果',`<p>${esc(c.observation)}</p>`)}${section('说明',`<p>${esc(c.basis)}</p>`)}${evidence(c.evidence)}<div class="detail-actions">${c.address?button('locate',c.address,'定位到拓扑'):''}${c.snapshot?button('snapshot',c.snapshot,'查看状态字段'):''}</div>`:'<div class="live-empty">没有匹配的检查项</div>';}
function gpuPicker(g){
 if(!g)return '';
 const all=report.gpus,index=all.indexOf(g),q=state.gpuQuery.trim().toLowerCase();
 const matches=all.filter(x=>!q||[x.label,x.pci,x.model,x.sn,x.uuid].some(v=>String(v||'').toLowerCase().includes(q)));
 const tabStop=matches.find(x=>x.id===g.id)||matches[0];
 const alertFor=x=>['error','review','missing'].find(s=>checkList(x.pci).some(c=>c.status===s));
 return `<div class="gpu-selector"><div class="gpu-selector-bar"><button id="gpu-picker-toggle" class="gpu-current" data-diag="gpuPicker" aria-expanded="${state.gpuPicker}" aria-controls="gpu-picker-panel" aria-label="选择 GPU，当前 ${esc(g.label)}"><span class="gpu-current-label">${esc(g.label)}</span><span class="mono">${esc(g.pci)}</span>${context.icon?.('chevron','small-icon')||''}</button><span class="gpu-current-model" title="${esc(g.model)}">${esc(g.model||'')}</span><div class="gpu-stepper"><span>${index+1} / ${all.length}</span><button class="btn quiet icon-btn gpu-previous" data-diag="gpu" data-value="${all[index-1]?.id??''}" aria-label="上一块 GPU" ${index===0?'disabled':''}>${context.icon?.('chevron','small-icon')||'‹'}</button><button class="btn quiet icon-btn" data-diag="gpu" data-value="${all[index+1]?.id??''}" aria-label="下一块 GPU" ${index===all.length-1?'disabled':''}>${context.icon?.('chevron','small-icon')||'›'}</button></div>${detailToggle()}</div>${state.gpuPicker?`<section id="gpu-picker-panel" class="gpu-picker-panel" role="dialog" aria-label="选择 GPU"><div class="gpu-picker-head"><input id="gpu-picker-search" type="search" class="select" placeholder="编号、PCI、SN 或 UUID" aria-label="搜索 GPU" value="${esc(state.gpuQuery)}"><span>${matches.length} / ${all.length}</span></div><div class="gpu-picker-grid" data-scroll-key="gpu-picker">${matches.map(x=>{const alert=alertFor(x);return `<button class="gpu-option" tabindex="${x===tabStop?0:-1}" data-diag="gpu" data-value="${x.id}" aria-pressed="${x.id===g.id}" aria-label="${esc(x.label)}，${esc(x.pci)}${alert?'，'+labels[alert]:''}"><span><strong>${esc(x.label)}</strong>${alert?`<i class="gpu-alert gpu-alert-${alert}" title="${labels[alert]}"></i>`:''}</span><span class="mono">${esc(x.pci)}</span></button>`;}).join('')||'<p class="gpu-picker-empty">没有匹配的 GPU</p>'}</div></section>`:''}</div>`;
}
function statusView(){
 const d=report.diagnostics, g=report.gpus.find(x=>x.id===(state.statusGpu??context.state.gpu))||report.gpus[0];
 state.statusGpu=g?.id??null;
 const snapshots=d.snapshots.filter(s=>s.address===g?.pci);
 let snapshot=snapshots.find(s=>s.id===state.snapshot)||snapshots.reduce((best,s)=>!best||s.fields.length>=best.fields.length?s:best,null);state.snapshot=snapshot?.id||'';
 const cards=gpuPicker(g);
 if(!snapshot)return cards+`<div class="live-empty"><h2>缺少 nvidia-smi -q 数据</h2></div>`;
 const q=state.query.trim().toLowerCase();
 const fields=snapshot.fields.filter(f=>q?(f.path+' '+f.value).toLowerCase().includes(q):f.group===state.group);
 const visible=pageRows(fields,'fieldPage');
 let f=visible.find(f=>f.path===state.field)||visible[0];state.field=f?.path||'';
 const related=f?checksByField.get(snapshot.id+'\0'+f.path)||[]:[];
 const fieldState=f=>{const statuses=(checksByField.get(snapshot.id+'\0'+f.path)||[]).map(c=>c.status);if(f.availability==='error')statuses.push('error');if(f.availability==='unavailable')statuses.push('missing');return ['error','review','missing'].find(s=>statuses.includes(s))||'';};
 const hasNotices=fields.some(f=>fieldState(f));
 const body=`<div class="diag-toolbar"><label>采集记录 <select class="select" data-diag-change="snapshot">${snapshots.map(s=>`<option value="${esc(s.id)}" ${s===snapshot?'selected':''}>第 ${s.line} 行 · ${s.fields.length} 个字段</option>`).join('')}</select></label>${!snapshots.at(-1).fields.length&&snapshot!==snapshots.at(-1)?`<span class="muted small">${snapshots.filter(s=>!s.fields.length).length} 条采集记录无字段</span>`:''}<input id="diagnostic-search" class="select" type="search" placeholder="搜索参数、路径或值" aria-label="搜索状态参数" value="${esc(state.query)}"></div><div class="diag-tabs">${groups.map(x=>button('group',x,x,!q&&state.group===x)).join('')}</div><div class="table-scroll" data-scroll-key="status-fields" tabindex="0" aria-label="状态参数列表"><table aria-label="状态参数"><thead><tr><th>参数</th><th>采集值</th>${hasNotices?'<th>提示</th>':''}</tr></thead><tbody>${visible.map(f=>`<tr data-diag="field" data-value="${esc(f.path)}" aria-selected="${state.field===f.path}" class="${state.field===f.path?'is-selected':''}"><td><button class="cell-btn" data-diag="field" data-value="${esc(f.path)}">${esc(f.name)}${f.path!==f.name?`<span class="cell-secondary">${esc(f.path)}</span>`:''}</button></td><td class="mono">${esc(f.value)}</td>${hasNotices?`<td>${fieldState(f)?badge(fieldState(f)):''}</td>`:''}</tr>`).join('')||`<tr><td colspan="${hasNotices?3:2}">${q?'没有匹配的参数':snapshot.fields.length?'该分组无数据':'该采集记录无状态字段'}</td></tr>`}</tbody></table></div>`;
 const detail=f?`<div class="inspector-title"><h2>${esc(f.name)}</h2><p class="diag-value">${esc(f.value)}</p></div>${parameterInfo(f)}${related.length?section('检查结果',related.map(c=>`<p>${badge(c.status)} ${esc(c.title)}</p>${button('check',c.id,'查看检查')}`).join('')):''}<div class="field-references">${evidence([f.evidence])}<a href="https://docs.nvidia.com/deploy/nvidia-smi/index.html" target="_blank" rel="noopener noreferrer">参数文档 ↗</a></div>`:'<div class="live-empty">没有可显示的参数</div>';
 return cards+split(body+pager(fields,'fieldPage'),detail);
}
const checkColumns={health:'状态参数',read:'字段读取',link:'PCIe 链路',CESta:'CESta',UESta:'UESta',DevSta:'DevSta',driver:'驱动绑定',aer:'AER',report:'报告检查',other:'其他检查'};
const checkKinds={gpu:'GPU',nic:'NIC',other:'其他 PCIe 设备',report:'报告'};
const priority={error:0,review:1,missing:2,ok:3};
const checkIcon=name=>context.icon?context.icon(name,'small-icon'):'';
function checkColumn(c){
 if(c.rule==='smi-read')return 'read';
 if(['pcie-link','smi-link'].includes(c.rule))return 'link';
 if(c.rule==='driver')return 'driver';
 if(c.rule==='pcie-status')return /CESta|UESta|DevSta/.exec(c.title)?.[0]||'other';
 if(c.rule==='aer')return 'aer';
 if(!c.address)return 'report';
 if(c.snapshot&&c.rule!=='smi-read')return 'health';
 return 'other';
}
function checksModel(data){
 const byAddress=new Map(),gpus=new Map(data.gpus.map(g=>[g.pci,g]));
 const ensure=address=>{if(!byAddress.has(address)){const g=gpus.get(address),n=data.nodes[address];byAddress.set(address,{address,kind:!address?'report':g||n?.kind==='gpu'?'gpu':n?.kind==='nic'?'nic':'other',name:g?.model||g?.label||({nic:'NIC',bridge:'PCIe 桥',vf:'SR-IOV VF',nvme:'NVMe'}[n?.kind])||(address?'PCIe 设备':'报告'),description:n?.description||'',checks:[],cells:new Map()});}return byAddress.get(address);};
 for(const address of new Set([...gpus.keys(),...Object.entries(data.nodes).filter(([,n])=>n.kind==='nic').map(([a])=>a)]))ensure(address);
 for(const c of data.diagnostics.checks){const row=ensure(c.address||''),col=checkColumn(c);row.checks.push(c);if(!row.cells.has(col))row.cells.set(col,[]);row.cells.get(col).push(c);}
 for(const row of byAddress.values()){row.checks.sort((a,b)=>(priority[a.status]??4)-(priority[b.status]??4));for(const cs of row.cells.values())cs.sort((a,b)=>(priority[a.status]??4)-(priority[b.status]??4));}
 const extra=new Set(data.diagnostics.checks.map(checkColumn));
 const columns=Object.keys(checkColumns).filter(k=>['read','link','CESta','UESta','DevSta','driver'].includes(k)||extra.has(k));
 const order=Object.keys(checkKinds);return {rows:[...byAddress.values()].sort((a,b)=>order.indexOf(a.kind)-order.indexOf(b.kind)||a.address.localeCompare(b.address)),columns};
}
let checksCache=null,checksSource=null,checksSize='',visibleCheckRows=[],activeCheckRow=null,activeCheckItems=[];
function checkCell(row,col){
 const items=(row.cells.get(col)||[]).filter(c=>state.filter==='all'||c.status===state.filter);
 if(items.length){const status=items[0].status;return {items,status,text:col==='driver'&&items.length===1&&status==='ok'?items[0].observation:col==='link'&&status==='review'?'存在差异':items.length>1?`${items.length} 项`:status==='error'?'1':labels[status]||status};}
 if(row.cells.has(col))return {items,status:'filtered',text:'已筛除'};
 const n=report.nodes[row.address],snap=report.diagnostics.snapshots.some(s=>s.address===row.address&&s.fields?.length);
 if(['aer','other'].includes(col))return {items,status:'none',text:'无记录'};
 if(row.kind==='report'||(['read','driver','health'].includes(col)&&row.kind!=='gpu')||(col==='link'&&n?.physicalFunction)||col==='report')return {items,status:'na',text:'不适用'};
 if((['read','health'].includes(col)&&snap)||n?.fields?.[col]?.length)return {items,status:'collected',text:'查看采集值'};
 return {items,status:'missing',text:'未采集'};
}
function checkStatus(status,text){return `<span class="check-state check-state-${esc(status)}">${checkIcon(status==='error'?'errors':status==='review'?'info':status==='ok'?'check':status==='missing'?'info':'rows')}<span>${esc(text)}</span></span>`;}
function checkCellContent(cell,col){
 if(['collected','na','filtered','none'].includes(cell.status))return `<span class="check-neutral-state">${esc(cell.text)}</span>`;
 if(cell.status==='ok')return col==='driver'?`<span class="check-plain-value">${esc(cell.items.map(c=>c.observation).filter(Boolean).join(' / '))}</span>`:checkStatus('ok','未见异常');
 return checkStatus(cell.status,cell.text);
}
function checkCollectedDetail(row,col){
 const fields=report.nodes[row.address]?.fields?.[col]||[],snapshot=report.diagnostics.snapshots.find(s=>s.address===row.address&&s.fields?.length);
 if(['read','health'].includes(col)&&snapshot)return `<div class="check-detail-actions">${button('snapshot',snapshot.id,'查看状态参数')}</div>`;
 return `<div class="check-raw-values mono">${[...new Set(fields.map(f=>f.value))].map(v=>`<p>${esc(v)}</p>`).join('')}</div>${evidence(fields.map(f=>f.evidence))}`;
}
function checkLinkComparison(c){
 const m=String(c.observation||'').match(/^(\d+(?:\.\d+)?) GT\/s ×(\d+)；最大 (\d+(?:\.\d+)?) GT\/s ×(\d+)$/);
 if(!m)return checkStatus(c.status,c.observation||c.title);
 const width=Number(m[1])===Number(m[3])&&m[2]!==m[4],current=Number(m[width?2:1]),maximum=Number(m[width?4:3]);
 return `<span class="check-link-comparison"><span class="check-link-values"><span><small>当前</small><strong>${esc(m[1])} GT/s ×${esc(m[2])}</strong></span><span><small>最大</small><strong>${esc(m[3])} GT/s ×${esc(m[4])}</strong></span></span>${maximum>0&&current<=maximum?`<meter min="0" max="${maximum}" value="${current}" aria-label="${width?'链路宽度':'链路速率'}：当前 ${current}，最大 ${maximum}"></meter>`:''}</span>`;
}
function checksDetail(row,col){
 if(!row)return '<div class="live-empty">没有匹配的检查项</div>';
 const cell=checkCell(row,col),items=cell.items;
 activeCheckItems=items;
 const selected=items.find(c=>c.id===state.check)||items[0];state.check=selected?.id||'';
 const visible=pageRows(items,'checkItemPage');
 const detail=items.length?`<div class="check-observations">${visible.map(c=>`<button class="check-observation ${c===selected?'is-current':''}" data-diag="checkItem" data-value="${esc(c.id)}" aria-pressed="${c===selected}">${col==='read'?`<span class="check-read-result">${checkStatus(c.status,'')}<span>${esc(c.observation||c.title)}</span></span>`:`<span>${checkStatus(c.status,c.title)}</span><span class="check-observation-value">${esc(c.observation||'日志未提供')}</span>`}</button>`).join('')}</div>${pager(items,'checkItemPage')}${selected?.basis?section('说明',`<p>${esc(selected.basis)}</p>`):''}<div class="check-detail-actions">${selected?.snapshot?button('snapshot',selected.snapshot,'状态参数'):''}${row.address?button('locate',row.address,'定位到拓扑'):''}</div>${evidence(selected?.evidence)}`:cell.status==='collected'?checkCollectedDetail(row,col):`<p class="check-empty-cell">${esc(cell.status==='na'?'该设备不适用此检查。':cell.status==='filtered'?'此项被当前状态筛选隐藏。':'日志未提供此项的检查结果。')}</p>`;
 let related='';
 if(col!=='link'){
  const links=row.cells.get('link')||[];
  if(links.length)related=`<div class="check-related"><h3>PCIe 链路</h3>${links.slice(0,3).map(c=>`<button data-diag="check" data-value="${esc(c.id)}">${checkLinkComparison(c)}${checkIcon('chevron')}</button>`).join('')}</div>`;
 }
 return `<div class="check-device-title"><h2>${esc(row.name)}</h2>${row.address?`<p class="mono">${esc(row.address)}</p>`:''}</div><div class="check-detail-heading"><h3>${esc(checkColumns[col])}</h3>${items.length>1?`<span class="muted">${items.length} 项</span>`:''}</div>${detail}${related}`;
}
function checksView(){
 const size=report.diagnostics.checks.length+'|'+Object.keys(report.nodes).length+'|'+report.gpus.length;
 if(checksSource!==report||checksSize!==size){checksSource=report;checksSize=size;checksCache=checksModel(report);}const {rows}=checksCache;
 const query=(state.checkQuery||'').trim().toLowerCase(),kind=state.checkKind||'all';
 const filtered=rows.filter(r=>(kind==='all'||r.kind===kind)&&(!query||[r.address,r.name,r.description,...r.checks.map(c=>c.title+' '+c.observation)].join(' ').toLowerCase().includes(query))&&(!state.checkOnly||r.checks.some(c=>['error','review','missing'].includes(c.status)))&&(state.filter==='all'||r.checks.some(c=>c.status===state.filter)));
 const counts=Object.fromEntries(Object.keys(labels).map(k=>[k,report.diagnostics.checks.filter(c=>c.status===k).length]));
 const controls=`<div class="checks-overview"><p>${[`${report.diagnostics.checks.length} 项检查`,counts.error?`${counts.error} 错误`:'',counts.review?`${counts.review} 待核实`:'',counts.missing?`${counts.missing} 数据缺失`:''].filter(Boolean).join(' · ')}</p><div class="checks-tools"><input class="select" id="checks-search" type="search" aria-label="搜索检查设备" placeholder="搜索设备或 PCI 地址" value="${esc(state.checkQuery||'')}"><label class="check-attention"><input type="checkbox" data-diag-change="checkOnly" ${state.checkOnly?'checked':''}>仅需关注</label><select class="select" data-diag-change="filter" aria-label="筛选检查状态"><option value="all">全部状态</option>${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${state.filter===k?'selected':''}>${v}</option>`).join('')}</select>${detailToggle()}</div></div>`;
 const tabs=`<div class="check-scopes" aria-label="检查设备类型">${button('checkKind','all','全部设备',kind==='all')}${Object.entries(checkKinds).filter(([k])=>rows.some(r=>r.kind===k)).map(([k,v])=>button('checkKind',k,`${v} ${rows.filter(r=>r.kind===k).length}`,kind===k)).join('')}</div>`;
 const forced=Boolean(query||state.checkOnly||state.filter!=='all'||kind!=='all'||!rows.some(r=>r.kind==='gpu'||r.kind==='nic'));
 const expanded=k=>forced||!(state.checkCollapsed||new Set(['other','report'])).has(k);
 const expandedRows=filtered.filter(r=>expanded(r.kind)),total=filtered.length,visible=pageRows(expandedRows,'checkPage');
 visibleCheckRows=visible;
 const extra=new Set(expandedRows.flatMap(r=>[...r.cells.keys()]));
 const columns=checksCache.columns.filter(k=>(expandedRows.some(r=>r.kind!=='report')&&['read','link','CESta','UESta','DevSta','driver'].includes(k))||extra.has(k));
 if(!columns.length)columns.push('read','link','CESta','UESta','DevSta','driver');
 let [address,col]=(state.checkCell||'').split('|');
 const requested=report.diagnostics.checks.find(c=>c.id===state.check);
 if(!state.checkCell&&requested){address=requested.address||'';col=checkColumn(requested);}
 let row=visibleCheckRows.find(r=>r.address===address)||visibleCheckRows.find(r=>r.checks.some(c=>c.status==='error'))||visibleCheckRows[0];
 if(row){if(!columns.includes(col)||row.address!==address)col=checkColumn(row.checks.find(c=>state.filter==='all'||c.status===state.filter)||{address:row.address,rule:row.kind==='gpu'?'smi-read':'pcie-link'});state.checkCell=row.address+'|'+col;}else state.checkCell='';
 activeCheckRow=row;activeCheckItems=[];
 let ri=0;
 const body=Object.entries(checkKinds).map(([k,label])=>{const part=visible.filter(r=>r.kind===k),all=filtered.filter(r=>r.kind===k),expanded=forced||!(state.checkCollapsed||new Set(['other','report'])).has(k);if(!all.length||(expanded&&!part.length))return '';return `<tbody class="check-device-group"><tr><th colspan="${columns.length+1}" class="check-group"><button data-diag="checkCollapse" data-value="${k}" aria-expanded="${expanded}" ${forced?'disabled':''}>${checkIcon('chevron')}<strong>${label}</strong><span>${filtered.filter(r=>r.kind===k).length}</span></button></th></tr>${expanded?part.map(r=>{const rowIndex=ri++;return `<tr class="check-device-row ${row===r?'check-row-selected':''}"><th scope="row"><button class="check-device" data-diag="checkDevice" data-value="${esc(r.address)}" title="${esc(r.description||r.name)}"><strong>${esc(r.name)}</strong>${r.address?`<span class="mono">${esc(r.address)}</span>`:''}</button></th>${columns.map((column,ci)=>{const cell=checkCell(r,column),selected=state.checkCell===r.address+'|'+column;return `<td><button class="check-cell" data-diag="checkCell" data-value="${esc(r.address+'|'+column)}" data-check-row="${rowIndex}" data-check-col="${ci}" tabindex="${selected?'0':'-1'}" aria-pressed="${selected}" aria-label="${esc(r.name+' '+(r.address||'')+' · '+checkColumns[column]+'：'+(labels[cell.status]||cell.text)+(cell.items.length?' · '+cell.items.length+' 项':''))}" title="${esc(cell.items.slice(0,3).map(c=>(c.title+'：'+(c.observation||'')).slice(0,500)).join('\n')||cell.text)}">${checkCellContent(cell,column)}</button></td>`;}).join('')}</tr>`;}).join(''):''}</tbody>`;}).join('');
 const table=`<div class="table-scroll checks-scroll" data-scroll-key="checks-list" tabindex="0" aria-label="设备检查矩阵"><table class="checks-matrix" style="--check-column-count:${columns.length}" aria-label="设备检查矩阵"><thead><tr><th scope="col">设备</th>${columns.map(k=>`<th scope="col">${esc(checkColumns[k])}</th>`).join('')}</tr></thead>${body}</table>${!total?`<div class="live-empty">${rows.length?'没有匹配的设备':'日志没有可显示的检查数据'}${rows.length?button('checkClear','','清除筛选'):''}</div>`:''}</div>${pager(expandedRows,'checkPage')}`;
 return controls+`<div class="checks-layout ${state.detailHidden?'checks-detail-hidden':''}"><section class="checks-main">${tabs}${table}</section><aside class="inspector check-inspector" data-scroll-key="checks-detail" ${state.detailHidden?'hidden':''}>${checksDetail(row,col)}</aside></div>`;
}
function fieldValue(n,key){return [...new Set((n?.fields?.[key]||[]).map(x=>x.value))].join(' / ');}
function nodeDetail(address){
 const n=report.nodes[address],g=report.gpus.find(g=>g.pci===address),edge=report.diagnostics.topology.find(x=>x.address===address);
 if(!n&&!g)return '<div class="live-empty">未选择设备</div>';
 const refs=[...(n?.evidence?[n.evidence]:[]),...Object.values(n?.fields||{}).flat().map(v=>v.evidence),...(edge?.evidence||[])];
 return `<div class="inspector-title"><h2>${esc(g?.label||(n?.kind==='vf'?'SR-IOV 虚拟功能':n?.kind)||'PCIe 设备')}</h2><p>${esc(n?.description||g?.model)}</p><p class="mono">${esc(address)}</p></div>${section('连接参数',`${n?.physicalFunction?`<p>由物理功能提供的 SR-IOV 虚拟功能（VF）。</p>`:''}<p>${n?.physicalFunction?'所属 PF':'上游'}：${esc(edge?.ambiguous?'关联有歧义':edge?.parent||'未提供')}</p><p>NUMA：${esc(fieldValue(n,'numa')||'未提供')}</p><p>当前链路：${esc(fieldValue(n,'link')||'未提供')}</p><p>最大能力：${esc(fieldValue(n,'link_max')||'未提供')}</p><p>驱动：${esc(fieldValue(n,'driver')||'未提供')}</p>`)}${checkList(address).length?section('相关检查',checkList(address).map(c=>button('check',c.id,checkTitle(c))).join('')):''}${g?`<div class="detail-actions">${button('status',g.id,'查看 GPU 状态')}</div>`:''}${evidence(refs)}`;
}
function treeView(){
 const d=report.diagnostics,parents=new Map(d.topology.map(n=>[n.address,n.parent]));
 const addresses=[...new Set([...d.topology.map(n=>n.address),...Object.keys(report.nodes),...report.gpus.map(g=>g.pci)])].filter(Boolean).sort();
 const all=new Set(addresses),children=new Map(),gpuMap=new Map(report.gpus.map(g=>[g.pci,g]));
 for(const a of addresses){const p=parents.get(a);if(all.has(p)&&p!==a){if(!children.has(p))children.set(p,[]);children.get(p).push(a);}}
 const path=a=>{const result=[],seen=new Set();while(a&&all.has(a)&&!seen.has(a)){result.unshift(a);seen.add(a);a=parents.get(a);}return result;};
 const roots=addresses.filter(a=>!all.has(parents.get(a))||parents.get(a)===a);
 const reachable=new Set();function visit(a){if(reachable.has(a))return;reachable.add(a);for(const c of children.get(a)||[])visit(c);}
 roots.forEach(visit);for(const a of addresses)if(!reachable.has(a)){roots.push(a);visit(a);}
 if(!state.node||!all.has(state.node))state.node=report.gpus.find(g=>g.id===context.state.gpu)?.pci||roots[0]||'';
 const selectedPath=path(state.node),pathSet=new Set(selectedPath);
 if(!state.initialized){for(const a of addresses)if(children.has(a)&&((children.get(a)||[]).some(c=>report.nodes[c]?.physicalFunction===a)||(path(a).length>1&&!pathSet.has(a))))state.collapsed.add(a);state.initialized=true;}
 if(state.reveal)for(const a of selectedPath)state.collapsed.delete(a);
 const q=state.treeQuery.trim().toLowerCase(),filtered=Boolean(q||state.kind!=='all'||state.only||state.pathOnly),allowed=new Set();
 let matches=0;const matched=[];
 for(const a of addresses){const n=report.nodes[a],g=gpuMap.get(a),kind=g?'gpu':n?.kind||'device';
  if((!q||(a+' '+(n?.description||'')+' '+(g?.label||'')+' '+(g?.model||'')).toLowerCase().includes(q))&&(state.kind==='all'||state.kind===kind)&&(!state.only||checkList(a).length)&&(!state.pathOnly||a===state.node)){matches++;matched.push(a);for(const p of path(a))allowed.add(p);}
 }
 if(matched.length&&!allowed.has(state.node)){state.node=matched[0];selectedPath.splice(0,selectedPath.length,...path(state.node));pathSet.clear();for(const a of selectedPath)pathSet.add(a);}
 const kindLabel=n=>({bridge:'PCIe 桥',gpu:'GPU',nic:'NIC',nvme:'NVMe',vf:'SR-IOV VF',device:'PCIe 设备'}[n?.kind]||'PCIe 设备');
 let visible=0;const rendered=new Set();
 function branch(a,depth){
  if(!allowed.has(a)||rendered.has(a))return '';rendered.add(a);visible++;
  const n=report.nodes[a],g=gpuMap.get(a),kids=(children.get(a)||[]).filter(c=>allowed.has(c)&&!rendered.has(c));
  const expanded=filtered||!state.collapsed.has(a),checks=checkList(a),link=fieldValue(n,'link');
  return `<li><div class="diag-tree-row ${pathSet.has(a)?'diag-on-path':''} ${state.node===a?'is-selected':''}" style="--depth:${depth}">
   ${kids.length?`<button class="diag-expander" data-diag="branch" data-value="${esc(a)}" aria-expanded="${expanded}" aria-label="${expanded?'折叠':'展开'} ${esc(a)}" ${filtered?'disabled':''}>${expanded?'▾':'▸'}</button>`:'<span class="diag-leaf" aria-hidden="true">└</span>'}
   <button class="diag-node" data-diag="node" data-value="${esc(a)}" aria-pressed="${state.node===a}" title="${esc(n?.description||g?.model||a)}">
    <span class="diag-node-kind">${esc(g?.label||kindLabel(n))}</span><strong class="mono">${esc(a)}</strong>
    <span class="diag-node-description">${esc(n?.description||g?.model||'设备信息未提供')}</span>
    ${checks.length?badge(checks.some(c=>c.status==='error')?'error':checks.some(c=>c.status==='review')?'review':'missing'):`<span class="diag-link">${esc(link)}</span>`}
   </button></div>${kids.length&&expanded?`<ul>${kids.map(c=>branch(c,depth+1)).join('')}</ul>`:''}</li>`;
 }
 const numa=a=>{const own=fieldValue(report.nodes[a],'numa');if(own)return own;const found=new Set(),pending=[a],seen=new Set();while(pending.length){const p=pending.pop();if(seen.has(p))continue;seen.add(p);const v=fieldValue(report.nodes[p],'numa');if(v)found.add(v);pending.push(...(children.get(p)||[]));}return found.size===1?[...found][0]:'未提供';};
 const edges=new Map(d.topology.map(e=>[e.address,e]));
 const unlinked=roots.filter(a=>!children.has(a)&&!edges.get(a)?.rootConfirmed),unlinkedSet=new Set(unlinked);
 const byNuma=new Map();for(const a of roots){if(unlinkedSet.has(a))continue;const k=numa(a);if(!byNuma.has(k))byNuma.set(k,[]);byNuma.get(k).push(a);}
 let tree=[...byNuma].map(([numa,items])=>{const rows=items.map(a=>branch(a,0)).join('');if(!rows)return '';const sockets=[...new Set((d.cpuRows||[]).filter(r=>r.NODE===numa).map(r=>r.SOCKET))];return `<section class="diag-numa"><h3>NUMA ${esc(numa)}${sockets.length?` · CPU Socket ${esc(sockets.join(', '))}`:''}</h3><ul>${rows}</ul></section>`;}).join('');
 if(state.reveal&&unlinkedSet.has(state.node))state.unlinkedOpen=true;
 const unknown=unlinked.filter(a=>allowed.has(a)),open=filtered||state.unlinkedOpen;
 if(unknown.length)tree+=`<section class="diag-numa diag-unlinked"><h3><button class="cell-btn" data-diag="unlinked" aria-expanded="${open}" ${filtered?'disabled':''}>${open?'▾':'▸'} 上游未确认 <span class="muted">${unknown.length} 个设备</span></button></h3>${open?`<ul>${unknown.map(a=>branch(a,0)).join('')}</ul>`:''}</section>`;
 const graph=`<div class="diag-toolbar"><input id="topology-search" class="select" type="search" placeholder="搜索 PCI 地址或设备" aria-label="搜索拓扑设备" value="${esc(state.treeQuery)}"><select class="select" data-diag-change="kind" aria-label="筛选设备类型">${Object.entries({all:'全部设备',gpu:'GPU',nic:'NIC',nvme:'NVMe',bridge:'PCIe 桥',vf:'SR-IOV VF'}).map(([k,v])=>`<option value="${k}" ${state.kind===k?'selected':''}>${v}</option>`).join('')}</select><label><input type="checkbox" data-diag-change="only" ${state.only?'checked':''}> 需关注路径</label></div>
  <div class="diag-tree-tools"><span class="muted small">${visible} / ${addresses.length} 个节点${filtered?` · ${matches} 个匹配`:''}</span><div>${filtered?'<span class="muted small">筛选时显示完整路径</span>':button('expand','','全部展开')+button('collapse','','收起分支')}${button('reveal','','定位所选')}</div></div>
  <nav class="diag-breadcrumb" aria-label="选中设备路径">${selectedPath.map(a=>button('node',a,a,a===state.node)).join('<span aria-hidden="true">›</span>')}</nav>
  <div class="diag-tree" data-scroll-key="pci-tree" tabindex="0" aria-label="PCIe 设备层级">${tree||`<div class="live-empty">${addresses.length?'没有匹配的设备':'缺少 PCI 设备数据（lspci -Dnnvv）'}</div>`}</div>
  <div class="diag-tree-foot"><label><input type="checkbox" data-diag-change="pathOnly" ${state.pathOnly?'checked':''}> 仅看所选设备路径</label><span class="muted small">连接来自 PCI 总线或 sysfs 路径</span></div>`;
 return split(graph,nodeDetail(state.node));
}
function matrixView(){
 const matrices=report.diagnostics.matrices;
 const m=matrices.find(x=>x.id===state.matrix)||matrices[0];state.matrix=m?.id||'';
 if(!m)return '<div class="live-empty"><h2>缺少 GPU 互联矩阵</h2><p>导入 nvidia-smi topo -m 或 topo -mp 的完整输出。</p></div>';
 const gpus=m.labels.filter(l=>l.startsWith('GPU')),nics=m.labels.filter(l=>l.startsWith('NIC'));
 if(state.matrixScope==='nic'&&!nics.length)state.matrixScope='gpu';
 const rowLabels=state.matrixScope==='all'?m.labels:gpus,cols=state.matrixScope==='gpu'?gpus:state.matrixScope==='nic'?nics:m.labels;
 if(!rowLabels.includes(state.matrixFocus))state.matrixFocus='';
 const focusRows=state.matrixFocus?[state.matrixFocus]:rowLabels,rowMap=new Map(m.rows.map(r=>[r.label,r]));
 const pageSize=16;
 state.matrixRowPage=Math.min(state.matrixRowPage||0,Math.max(0,Math.ceil(focusRows.length/pageSize)-1));
 state.matrixColPage=Math.min(state.matrixColPage||0,Math.max(0,Math.ceil(cols.length/pageSize)-1));
 const rows=focusRows.slice(state.matrixRowPage*pageSize,(state.matrixRowPage+1)*pageSize),visibleCols=cols.slice(state.matrixColPage*pageSize,(state.matrixColPage+1)*pageSize);
 const valueAt=(a,b)=>rowMap.get(a)?.cells[m.labels.indexOf(b)];
 const description=v=>meaning[v]||(/^NV\d+$/.test(v)?`${v.slice(2)} 条聚合 NVLink`:v?'未识别的关系码，保留日志原值。':'该位置未采集到有效关系');
 const nicName=l=>[...new Set((m.nicNames?.[l]||[]).map(v=>v.name))].join(' / ');
 const affinity=l=>{const r=rowMap.get(l);if(r?.affinityValues)return r.affinityValues;const keys=m.affinityColumns||m.evidence.text?.match(/CPU Affinity|NUMA Affinity|GPU NUMA ID/g)||[];return r?.affinity?.length===keys.length?Object.fromEntries(keys.map((k,i)=>[k,r.affinity[i]])):{};};
 let [a,b]=state.cell.split('|');
 if(!rows.includes(a)||!visibleCols.includes(b)){a=rows[0];b=visibleCols.find(l=>l!==a)||visibleCols[0];state.cell=a&&b?`${a}|${b}`:'';}
 const row=rowMap.get(a),value=valueAt(a,b);
 const selector=`<div class="diag-toolbar"><label>采集记录 <select class="select" data-diag-change="matrix">${matrices.map(x=>`<option value="${esc(x.id)}" ${x===m?'selected':''}>${x.mode==='unknown'?'命令未记录':'topo -'+x.mode} · 第 ${x.evidence.line} 行</option>`).join('')}</select></label><span class="muted small">${gpus.length} GPU · ${nics.length} NIC</span></div>`;
 const scopes=`<div class="diag-matrix-controls"><div class="diag-segment" aria-label="矩阵范围">${button('matrixScope','gpu','GPU ↔ GPU',state.matrixScope==='gpu')}${nics.length?button('matrixScope','nic','GPU ↔ NIC',state.matrixScope==='nic'):''}${button('matrixScope','all','全部设备',state.matrixScope==='all')}</div><label class="small">聚焦 <select class="select" data-diag-change="matrixFocus" aria-label="聚焦矩阵设备"><option value="">全部行</option>${rowLabels.map(l=>`<option ${l===state.matrixFocus?'selected':''}>${esc(l)}</option>`).join('')}</select></label></div>`;
 const pager=(key,items,page,title)=>items.length>pageSize?`<div class="diag-matrix-pager"><span>${title} ${page*pageSize+1}–${Math.min((page+1)*pageSize,items.length)} / ${items.length}</span><button class="btn" data-diag="${key}" data-value="${page-1}" aria-label="上一组${title}" ${page===0?'disabled':''}>‹</button><button class="btn" data-diag="${key}" data-value="${page+1}" aria-label="下一组${title}" ${(page+1)*pageSize>=items.length?'disabled':''}>›</button></div>`:'';
 const pages=`<div class="diag-matrix-pages">${pager('matrixRowPage',focusRows,state.matrixRowPage,'行')}${pager('matrixColPage',cols,state.matrixColPage,'列')}</div>`;
 const warn=m.complete?'':`<p class="diag-matrix-warning">${m.rows.length<m.labels.length?`缺少 ${m.labels.length-m.rows.length} 行数据。`:m.warnings?.length?'':'矩阵数据不完整。'}${m.warnings?.length?`<span>${m.warnings.length} 项格式提示</span>`:''}</p>`;
 const body=selector+scopes+pages+warn+`<div class="table-scroll diag-matrix-scroll" data-scroll-key="matrix-${state.matrixScope}" tabindex="0" aria-label="互联矩阵区域"><table class="diag-matrix" style="--matrix-width:${84+visibleCols.length*62}px" aria-label="GPU 互联矩阵"><colgroup><col style="width:84px">${visibleCols.map(()=>'<col style="width:62px">').join('')}</colgroup><thead><tr><th scope="col"><span class="muted small">设备</span></th>${visibleCols.map(l=>`<th scope="col" class="${l===b?'diag-axis-selected':''}" title="${esc(nicName(l)||m.mapping[l]||l)}">${esc(l)}${nicName(l)?`<small>${esc(nicName(l))}</small>`:''}</th>`).join('')}</tr></thead><tbody>${rows.map((l,ri)=>`<tr><th scope="row" class="${l===a?'diag-axis-selected':''}">${esc(l)}${affinity(l)['NUMA Affinity']?`<small>NUMA ${esc(affinity(l)['NUMA Affinity'])}</small>`:''}</th>${visibleCols.map((c,ci)=>{const v=valueAt(l,c),selected=l===a&&c===b;return `<td class="${l===a||c===b?'diag-axis ':''}${selected?'is-selected':''}"><button class="diag-relation ${v==='X'?'diag-self':/^NV\d+$/.test(v)?'diag-nv':''}" data-diag="cell" data-value="${esc(l+'|'+c)}" data-matrix-row="${ri}" data-matrix-col="${ci}" aria-pressed="${selected}" aria-label="${esc(l+' 到 '+c+'：'+(v||'未采集'))}" title="${esc(description(v))}">${esc(v||'—')}</button></td>`;}).join('')}</tr>`).join('')}</tbody></table></div><div class="diag-matrix-legend">${[...new Set(rows.flatMap(l=>visibleCols.map(c=>valueAt(l,c))).filter(Boolean))].map(v=>`<span title="${esc(description(v))}"><b>${esc(v)}</b> ${esc(v==='X'?'自身':v==='SYS'?'跨 NUMA':v==='NODE'?'同 NUMA 主桥':v==='PHB'?'PCIe 主桥':v==='PXB'?'多级 PCIe 桥':v==='PIX'?'至多一级桥':/^NV\d+$/.test(v)?'NVLink':'未识别')}</span>`).join('')}</div>${m.mode==='mp'?'<p class="source-meta diag-matrix-note">topo -mp 仅显示 PCIe 路径。</p>':''}`;
 const device=l=>{const address=m.mapping[l],name=nicName(l),f=affinity(l);return section(l,`${name?`<p class="mono">${esc(name)}</p>`:''}<dl class="diag-device-facts"><dt>PCI 地址</dt><dd class="mono">${esc(address||'未关联')}</dd>${Object.entries(f).map(([k,v])=>`<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join('')}</dl>${address?button('locate',address,'在连接树中定位'):''}`);};
 return split(body,`<div class="inspector-title"><h2>${esc(a||'—')} <span class="muted">→</span> ${esc(b||'—')}</h2><p class="diag-value">${esc(value||'未采集')}</p><p>${esc(description(value))}</p></div>${a?device(a):''}${b&&a!==b?device(b):''}${(m.warnings||[]).map(w=>`<p class="diag-warning">${esc(w)}</p>`).join('')}${evidence([m.evidence,...(row?[row.evidence]:[]),...(m.mappingEvidence?.[a]||[]),...(m.mappingEvidence?.[b]||[])])}`);
}
function render(data,ctx){
 if(lastPage&&lastPage!==ctx.state.page){detailVisibility.set(lastPage,state.detailHidden);state.detailHidden=detailVisibility.get(ctx.state.page)||false;state.gpuPicker=false;}lastPage=ctx.state.page;context=ctx;report=data;
 if(!data.source)return ctx.heading()+'<div class="live-empty">导入日志后查看解析结果</div>';
 if(!data.diagnostics)return ctx.heading()+'<div class="live-empty"><h2>此报告需要重新解析</h2><p>重新解析原日志以查看诊断结果。</p><button class="btn" data-page="reports">报告管理</button></div>';
 indexChecks();
 if(ctx.state.page==='topology'&&!state.viewInitialized){state.view=(!data.diagnostics.topology.length&&data.diagnostics.matrices.length)?'matrix':'tree';state.viewInitialized=true;}
 return ctx.heading()+`<div class="diag-workspace">${ctx.state.page==='status'?statusView():ctx.state.page==='checks'?checksView():`<div class="diag-tabs">${button('view','tree','PCIe 连接树',state.view==='tree')}${button('view','matrix','GPU 互联矩阵',state.view==='matrix')}${detailToggle()}</div>${state.view==='matrix'?matrixView():treeView()}`}</div>`;
}
function click(b){
 const key=b.dataset.diag;if(!key||!context)return false;const value=b.dataset.value;
 if(key==='checkCell'||key==='checkDevice'){
  const row=checksCache?.rows.find(r=>r.address===(key==='checkCell'?value.split('|')[0]:value));
  const col=key==='checkCell'?value.split('|')[1]:checkColumn(row?.checks.find(c=>state.filter==='all'||c.status===state.filter)||{address:row?.address,rule:'pcie-link'});
  state.checkCell=(row?.address||'')+'|'+col;state.check='';state.checkItemPage=0;state.detailHidden=false;
 }else if(key==='checkKind'){state.checkKind=value;state.checkPage=0;state.checkItemPage=0;state.listReveal=true;}
 else if(key==='checkClear'){Object.assign(state,{checkQuery:'',checkOnly:false,filter:'all',checkKind:'all',checkPage:0});}
 else if(key==='checkCollapse'){state.checkCollapsed??=new Set(['other','report']);state.checkCollapsed.has(value)?state.checkCollapsed.delete(value):state.checkCollapsed.add(value);}
 else if(key==='checkItem'){state.check=value;}
 else if(key==='checkItemPage'){state.checkItemPage=Math.max(0,Number(value)||0);state.check=activeCheckItems[state.checkItemPage*PAGE_SIZE]?.id||'';}
 if(key!=='evidencePage')state.evidencePage=0;if(['fieldPage','checkPage'].includes(key))state.listReveal=true;
 if(key==='gpuPicker'){state.gpuPicker=!state.gpuPicker;state.gpuQuery='';}
 else if(key==='gpu'){if(!report.gpus.some(g=>g.id===Number(value))||value==='')return true;context.state.gpu=Number(value);state.statusGpu=Number(value);state.snapshot='';state.field='';state.fieldPage=0;state.listReveal=true;state.gpuPicker=false;}
 else if(key==='status'){showDetail('status');context.state.gpu=Number(value);context.state.page='status';Object.assign(state,{statusGpu:Number(value),snapshot:'',field:'',query:'',group:'概览',fieldPage:0,listReveal:true});}
 else if(key==='locate'){context.state.page='topology';locate(value);}
 else if(key==='check'){
  const c=report.diagnostics.checks.find(c=>c.id===value);
  if(c){showDetail('checks');const keepFilter=context.state.page==='checks'&&(state.filter==='all'||state.filter===c.status);context.state.page='checks';Object.assign(state,{filter:keepFilter?state.filter:'all',checkKind:'all',checkQuery:'',checkOnly:false,check:value,checkCell:(c.address||'')+'|'+checkColumn(c),detailHidden:false});
   state.checkCollapsed??=new Set(['other','report']);const model=checksModel(report),row=model.rows.find(r=>r.address===(c.address||''));state.checkCollapsed.delete(row.kind);
   const expandedRows=model.rows.filter(r=>!state.checkCollapsed.has(r.kind));state.checkPage=Math.floor(Math.max(0,expandedRows.indexOf(row))/PAGE_SIZE);state.checkItemPage=Math.floor(row.cells.get(checkColumn(c)).findIndex(x=>x.id===value)/PAGE_SIZE);state.checkReveal=true;
  }
 }
 else if(key==='snapshot'){showDetail('status');const s=report.diagnostics.snapshots.find(s=>s.id===value);context.state.page='status';context.state.gpu=report.gpus.find(g=>g.pci===s?.address)?.id;state.statusGpu=context.state.gpu;state.snapshot=value;state.field='';state.query='';state.group='概览';state.fieldPage=0;state.listReveal=true;const c=report.diagnostics.checks.find(c=>c.id===state.check&&c.snapshot===value);if(c?.path&&s){state.field=c.path;state.group=s.fields.find(f=>f.path===c.path)?.group||'概览';state.query='';state.fieldPage=Math.floor(Math.max(0,s.fields.filter(f=>f.group===state.group).findIndex(f=>f.path===c.path))/PAGE_SIZE);}}
 else if(key==='detail')state.detailHidden=!state.detailHidden;
 else if(key==='matrixScope'){state.matrixScope=value;state.matrixRowPage=0;state.matrixColPage=0;state.matrixReveal=true;}
 else if(['matrixRowPage','matrixColPage'].includes(key)){state[key]=Math.max(0,Number(value)||0);state.matrixReveal=true;}
 else if(key==='unlinked')state.unlinkedOpen=!state.unlinkedOpen;
 else if(key==='branch'){if(state.collapsed.has(value))state.collapsed.delete(value);else state.collapsed.add(value);}
 else if(key==='expand')state.collapsed.clear();
 else if(key==='collapse'){state.collapsed=new Set(report.diagnostics.topology.map(n=>n.parent).filter(Boolean));}
 else if(key==='reveal'){state.reveal=true;state.treeQuery='';state.kind='all';state.only=false;}
 else if(!['checkCell','checkDevice','checkKind','checkClear','checkCollapse','checkItem','checkItemPage'].includes(key)){state[key]=value;if(key==='group'){state.query='';state.field='';state.fieldPage=0;state.listReveal=true;}if(key==='filter'){state.checkPage=0;state.checkCell='';state.check='';}}
 context.render();afterRender();if(typeof document!=='undefined'){if(key==='gpuPicker'&&state.gpuPicker)document.getElementById('gpu-picker-search')?.focus({preventScroll:true});if(key==='gpu')document.getElementById('gpu-picker-toggle')?.focus({preventScroll:true});}return true;
}
function change(el){const key=el.dataset.diagChange;if(!key||!context)return false;state[key]=el.type==='checkbox'?el.checked:el.value;if(key==='filter'){state.checkCell='';state.check='';}if(['filter','checkOnly'].includes(key)){state.checkPage=0;state.checkItemPage=0;}if(key==='snapshot'){state.fieldPage=0;state.field='';state.listReveal=true;}if(['matrix','matrixFocus'].includes(key)){state.matrixRowPage=0;state.matrixColPage=0;state.matrixReveal=true;}context.render();return true;}
function input(el){const key={'gpu-picker-search':'gpuQuery','diagnostic-search':'query','topology-search':'treeQuery','checks-search':'checkQuery'}[el.id];if(!key||!context)return false;const pos=el.selectionStart;if(key==='treeQuery'&&state.treeQuery&&!el.value)state.reveal=true;state[key]=el.value;if(key==='query'){state.fieldPage=0;state.listReveal=true;}if(key==='checkQuery'){state.checkPage=0;state.checkItemPage=0;}context.render();const next=document.getElementById(el.id);next.focus({preventScroll:true});if(pos!==null)try{next.setSelectionRange(pos,pos);}catch{}return true;}
function afterRender(){if(typeof document==='undefined')return;if(state.checkReveal){state.checkReveal=false;document.querySelector('.check-cell[aria-pressed="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});}if(state.listReveal){state.listReveal=false;const el=document.querySelector('[data-scroll-key="'+(context.state.page==='status'?'status-fields':'checks-list')+'"]');if(el)el.scrollTop=0;}if(state.matrixReveal){state.matrixReveal=false;document.querySelector('.diag-relation[aria-pressed="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});}if(!state.reveal)return;state.reveal=false;const el=Array.from(document.querySelectorAll('.diag-node')).find(b=>b.dataset.value===state.node);el?.scrollIntoView({block:'nearest',inline:'nearest'});}
function leave(){state.gpuPicker=false;}
function showDetail(page){detailVisibility.set(page,false);if(page===lastPage)state.detailHidden=false;}
function dismissPicker(target){if(state.gpuPicker&&!target.closest('.gpu-selector')){state.gpuPicker=false;document.getElementById('gpu-picker-panel')?.remove();document.getElementById('gpu-picker-toggle')?.setAttribute('aria-expanded','false');}}
function keydown(event){
 if(state.gpuPicker&&event.target.closest('.gpu-selector')){
  if(event.key==='Escape'){event.preventDefault();state.gpuPicker=false;context.render();document.getElementById('gpu-picker-toggle')?.focus({preventScroll:true});return true;}
  const options=Array.from(document.querySelectorAll('.gpu-option'));
  if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)&&!(event.target.id==='gpu-picker-search'&&event.key!=='ArrowDown')){
   event.preventDefault();const i=options.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,i+(['ArrowUp','ArrowLeft'].includes(event.key)?-1:1)));options[next]?.focus();return true;
  }
 }

 const check=event.target.closest('button[data-check-row]');
 if(check&&['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
  const items=Array.from(document.querySelectorAll('button[data-check-row]')),row=Number(check.dataset.checkRow),col=Number(check.dataset.checkCol);
  const nr=event.ctrlKey&&event.key==='Home'?0:event.ctrlKey&&event.key==='End'?Math.max(...items.map(b=>Number(b.dataset.checkRow))):row+(event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0);
  const nc=event.key==='Home'?0:event.key==='End'?Math.max(...items.map(b=>Number(b.dataset.checkCol))):col+(event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0);
  const next=items.find(b=>Number(b.dataset.checkRow)===nr&&Number(b.dataset.checkCol)===nc);event.preventDefault();
  if(next){const value=next.dataset.value;click(next);const target=Array.from(document.querySelectorAll('button[data-check-row]')).find(b=>b.dataset.value===value);target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',inline:'nearest'});}return true;
 }
 const cell=event.target.closest('button[data-matrix-row]');
 if(cell&&['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
  const row=Number(cell.dataset.matrixRow),col=Number(cell.dataset.matrixCol),items=Array.from(document.querySelectorAll('button[data-matrix-row]'));
  let nextRow=row+(event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0),nextCol=col+(event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0);
  if(event.key==='Home')nextCol=0;
  if(event.key==='End')nextCol=Math.max(...items.filter(b=>Number(b.dataset.matrixRow)===row).map(b=>Number(b.dataset.matrixCol)));
  const next=items.find(b=>Number(b.dataset.matrixRow)===nextRow&&Number(b.dataset.matrixCol)===nextCol);
  event.preventDefault();if(next){const value=next.dataset.value;click(next);const target=Array.from(document.querySelectorAll('button[data-matrix-row]')).find(b=>b.dataset.value===value);target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',inline:'nearest'});}return true;
 }
 const b=event.target.closest('button[data-diag]');if(!b||!['field','check','node'].includes(b.dataset.diag)||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return false;
 const selector=b.dataset.diag==='node'?'.diag-node':`tbody button[data-diag="${b.dataset.diag}"]`,items=Array.from(document.querySelectorAll(selector)),i=items.indexOf(b);if(i<0)return false;
 event.preventDefault();const next=items[event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,i+(event.key==='ArrowDown'?1:-1)))],value=next.dataset.value;click(next);
 const target=Array.from(document.querySelectorAll(selector)).find(b=>b.dataset.value===value);target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',inline:'nearest'});return true;
}
function locate(address){showDetail('topology');Object.assign(state,{node:address,view:'tree',viewInitialized:true,only:false,pathOnly:false,kind:'all',treeQuery:'',reveal:true});}
function reset(){indexedChecks=null;checksSource=null;lastPage='';detailVisibility.clear();Object.assign(state,{view:'tree',detailHidden:false,gpuPicker:false,gpuQuery:'',statusGpu:null,viewInitialized:false,matrixReveal:false,checkCell:'',checkQuery:'',checkKind:'all',checkOnly:false,checkCollapsed:new Set(['other','report']),checkItemPage:0,checkReveal:false,evidencePage:0,listReveal:false,fieldPage:0,checkPage:0,filter:'all',snapshot:'',group:'概览',field:'',query:'',check:'',node:'',matrix:'',matrixScope:'gpu',matrixFocus:'',matrixRowPage:0,matrixColPage:0,cell:'',only:false,treeQuery:'',kind:'all',pathOnly:false,unlinkedOpen:false,collapsed:new Set(),initialized:false,reveal:false});}
function openMatrix(){state.view='matrix';state.viewInitialized=true;}
function capture(){return {state:structuredClone({...state,gpuPicker:false,gpuQuery:''}),details:[...detailVisibility],lastPage};}
function restore(saved){reset();if(!saved)return;Object.assign(state,structuredClone(saved.state));for(const [page,hidden] of saved.details||[])detailVisibility.set(page,hidden);lastPage=saved.lastPage||'';}
const api={render,click,change,input,locate,reset,keydown,afterRender,openMatrix,dismissPicker,leave,capture,restore};
if(typeof module!=='undefined'&&module.exports)module.exports={...api,esc,meaning,checksModel,checkColumn};else root.XidDiagnostics=api;
})(globalThis);
