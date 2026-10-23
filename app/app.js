(()=>{'use strict';
const paths={
 x:'M6 4l12 16M18 4L6 20',
 server:'M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M15 6.5h2M15 17.5h2',
 errors:'M7 3h10l4 4v10l-4 4H7l-4-4V7zM12 7v6M12 17h.01',
 refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 7M4 12l2 7a7 7 0 0 0 12-2',
 compare:'M4 7h15M15 3l4 4-4 4M20 17H5M9 13l-4 4 4 4',
 topology:'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4',
 file:'M14 2H5v20h14V7zM14 2v6h5M8 12h8M8 16h6',
 import:'M12 3v12M8 7l4-4 4 4M4 15v6h16v-6',
 export:'M12 3v12M8 11l4 4 4-4M4 16v5h16v-5',
 copy:'M9 9h11v12H9zM15 9V3H3v12h6',
 search:'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM16 16l5 5',
 close:'M6 6l12 12M18 6L6 18',
 chevron:'M9 5l7 7-7 7',
 book:'M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1zM12 5v15',
 external:'M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7',
 moon:'M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14z',
 sun:'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
 gpu:'M4 5h16v13H4zM7 18v3M11 18v3M15 18v3M19 18v3M8 9h8v5H8zM1 8h3M1 12h3M1 16h3',
 check:'M5 12l4 4L19 6',
 info:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7h.01',
 rows:'M4 5h16M4 12h16M4 19h16',
 arrow:'M4 12h16M15 7l5 5-5 5'
};
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=(name,extra='')=>`<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.file}"></path></svg>`;
const val=v=>v===0?'0':v||'—',reliable=v=>v!==''&&v!==null&&v!==undefined&&v!=='冲突';
const token=document.querySelector('meta[name="local-token"]').content;
const blank=()=>({source:'',server:{},gpus:[],events:[],nodes:{},warnings:[],topologyRaw:''});
let data=blank(),cases=[],busy=false,toastTimer,priorFocus=null,drawerFocus=null,loadRequest=0,loadedCase='',loading=false;
const state={page:'devices',gpu:0,query:'',filter:'all',code:'all',event:'',errorPage:0,errorView:'groups',group:'',groupFilter:'',compareBase:'',compareRow:0,compareChanged:false,topology:'graph',onlyErrors:false,node:'',drawer:false};
const titles={resources:'解析规则',xid:'Xid 查询',manual:'排查手册',updates:'软件更新',reports:'报告管理',devices:'设备信息',errors:'错误记录',topology:'机器拓扑',status:'状态解析',checks:'异常检查',compare:'日志对比'};
const visibleGpus=()=>{const q=state.query.trim().toLowerCase();return data.gpus.filter(g=>!q||[g.sn,g.uuid,g.pci].some(v=>String(v||'').toLowerCase().includes(q)));};
const filteredEvents=()=>data.events.filter(e=>(!state.groupFilter||XidAnalysis.eventKey(e)===state.groupFilter)&&(state.filter==='all'||(state.filter.startsWith('pci:')?e.address===state.filter.slice(4):e.gpu===Number(state.filter)))&&(state.code==='all'||(state.code.startsWith('kind:')?e.kind===state.code.slice(5):e.kind==='xid'&&e.code===state.code)));
const currentGpu=()=>data.gpus.find(g=>g.id===state.gpu);
const codeLabel=e=>e.kind==='xid'?`Xid ${e.code}`:({init:'初始化',aer:'PCIe/AER',lockup:'soft lockup',channel:'通道超时',fallen:'GPU 不可访问',smi_error:'nvidia-smi',ecc:'ECC'}[e.kind]||e.kind);
function status(text){$('status').textContent=text;}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,2200);}
async function api(path,options={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
 try{const response=await fetch(path,{...options,signal:controller.signal,headers:{'X-Local-Token':token,...options.headers}});let d;try{d=await response.json();}catch(e){if(controller.signal.aborted)throw e;throw Error('服务返回的数据不完整，请重试');}if(!response.ok)throw Error(d?.error||'请求失败');return d;}
 catch(e){if(controller.signal.aborted)throw Error('请求超时，请确认程序仍在运行后重试');if(e instanceof TypeError)throw Error('无法连接本地服务，请确认程序仍在运行');throw e;}finally{clearTimeout(timer);}
}
const sidebar=document.querySelector('.sidebar'),sidebarPin=$('sidebar-pin'),sidebarToggle=$('sidebar-toggle');
let sidebarKeyboard=false;
const isSidebarPinned=()=>$('app').dataset.sidebarPinned==='true';
function sidebarOpen(open){sidebar.classList.toggle('is-open',!isSidebarPinned()&&open);sidebarToggle.setAttribute('aria-expanded',String(isSidebarPinned()||open));}
function syncSidebar(){const pinned=isSidebarPinned();sidebarPin.setAttribute('aria-pressed',String(pinned));sidebarPin.setAttribute('aria-label',pinned?'取消固定菜单':'固定菜单');sidebarPin.title=pinned?'取消固定菜单，移入时浮动展开':'固定菜单';sidebarPin.querySelector('span').textContent=pinned?'取消固定':'固定菜单';sidebarToggle.setAttribute('aria-label',pinned?'菜单已固定':'展开或收起菜单');sidebarOpen(false);}
sidebarPin.addEventListener('click',async()=>{const pinned=!isSidebarPinned();sidebarPin.disabled=true;try{await api('/api/sidebar/'+(pinned?'pin':'unpin'),{method:'POST'});$('app').dataset.sidebarPinned=String(pinned);syncSidebar();if(!pinned)sidebarOpen(true);}catch(e){toast(e.message);}finally{sidebarPin.disabled=false;}});
sidebarToggle.addEventListener('click',()=>{if(!isSidebarPinned())sidebarOpen(!sidebar.classList.contains('is-open'));});
sidebar.addEventListener('pointerenter',()=>sidebarOpen(true));
sidebar.addEventListener('pointerleave',()=>{if(!sidebarKeyboard||!sidebar.contains(document.activeElement))sidebarOpen(false);});
sidebar.addEventListener('focusin',()=>{if(sidebarKeyboard)sidebarOpen(true);});
sidebar.addEventListener('focusout',e=>{if(!sidebar.contains(e.relatedTarget))sidebarOpen(false);});
document.addEventListener('pointerdown',e=>{sidebarKeyboard=false;if(!sidebar.contains(e.target))sidebarOpen(false);});
document.addEventListener('keydown',e=>{if(e.key==='Tab')sidebarKeyboard=true;if(e.key==='Escape'&&!isSidebarPinned()&&sidebar.classList.contains('is-open')){sidebarKeyboard=false;sidebarOpen(false);sidebarToggle.focus({preventScroll:true});}});
syncSidebar();
let dialogRevision=0;
function openDialog(title,html,footer='',kind=''){dialogRevision++;if(!$('dialog').open)priorFocus=document.activeElement;$('dialog').dataset.kind=kind;$('dialog-title').textContent=title;$('dialog-body').innerHTML=html;$('dialog-foot').innerHTML=footer;$('dialog-foot').hidden=!footer;if(!$('dialog').open)$('dialog').showModal();(Array.from($('dialog-body').querySelectorAll('input,textarea,button')).find(el=>!el.disabled&&el.getClientRects().length)||$('dialog-close')).focus();}
function closeDialog(){if(deletingReports||catalogBusy)return;if($('dialog').dataset.kind==='update-notice'){dismissUpdateNotice(false,true);return;}if(busy){cancelImport();return;}$('dialog').close();priorFocus?.isConnected&&priorFocus.focus();}
function copyPreview(title,text){openDialog(title,`<textarea id="copy-text" aria-label="复制内容" spellcheck="false">${esc(text)}</textarea><p class="import-feedback" id="copy-feedback" role="status"></p>`,`<button class="btn primary" data-action="copy-content">复制</button>`);}
async function copy(text){if(!reliable(text))return;try{await navigator.clipboard.writeText(String(text));toast('已复制');}catch{copyPreview('复制内容',String(text));$('copy-text').select();$('copy-feedback').textContent='请按 Ctrl+C 复制';}}
async function download(name,text,type){if(window.pywebview?.api?.save_text){if(await window.pywebview.api.save_text(name,text))toast('已导出');return;}const url=URL.createObjectURL(new Blob(['\ufeff',text],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);toast('已导出');}
const safeCell=v=>{const s=String(v??'').replace(/[\t\r\n]/g,' ');return /^[=+\-@]/.test(s)?"'"+s:s;};
function tsv(list){return [['服务器型号','服务器 SN','GPU 编号','型号','PCI 地址','GPU SN','GPU UUID','槽位参考','槽位来源','读取状态','错误记录'],...list.map(g=>[data.server.model,data.server.sn,g.index,g.model,g.pci,g.sn,g.uuid,g.slot,g.slotSource,g.status,g.errors])].map(r=>r.map(safeCell).join('\t')).join('\r\n');}
function gpuText(g){if(!g)return '';return [['GPU',g.label],['型号',g.model],['PCI 地址',g.pci],['GPU SN',g.sn],['GPU UUID',g.uuid],['槽位参考',g.slot]].filter(([,v])=>v).map(([k,v])=>`${k}：${v}`).join('\n');}
function summary(){const groups=new Map(),list=state.page==='errors'?filteredEvents():data.events;for(const e of list){const key=[e.address,e.kind,e.code].join('|');if(!groups.has(key))groups.set(key,{e,count:0});groups.get(key).count++;}const ids=[...new Set(list.map(e=>e.gpu).filter(x=>x!==null))];return [data.source&&`日志：${data.source}`,data.complete===false?'读取不完整':'',data.server.model&&`服务器：${data.server.model}`,data.server.sn&&`服务器 SN：${data.server.sn}`,...ids.map(id=>gpuText(data.gpus.find(g=>g.id===id))).filter(Boolean),...[...groups.values()].map(({e,count})=>`${e.address||'系统'} · ${codeLabel(e)} · ${e.title}：${count} 行`),...(state.page==='errors'?[]:(data.diagnostics?.checks||[]).filter(c=>['error','review'].includes(c.status)).map(c=>`${c.label} · ${c.address||'报告'} · ${c.title}：${c.observation}`))].filter(Boolean).join('\n');}
function keyline(label,value,copyable=false){return `<div class="key-line"><span>${esc(label)}</span><span class="copy-value"><span class="${copyable?'mono':''}">${esc(val(value))}</span>${copyable&&reliable(value)?`<button class="inline-copy" data-copy="${esc(value)}" aria-label="复制${esc(label)}" title="复制${esc(label)}">${icon('copy','small-icon')}</button>`:''}</span></div>`;}
function field(label,value,options={}){return `<div><div class="field-label">${esc(label)}</div><div class="field-value ${options.mono?'mono':''} ${options.strong?'strong':''}"><span class="field-value-text" title="${esc(val(value))}">${esc(val(value))}</span>${options.copy&&reliable(value)?` <button class="inline-copy" data-copy="${esc(value)}" aria-label="复制${esc(label)}">${icon('copy','small-icon')}</button>`:''}</div></div>`;}
function uuidField(g){return `<div class="uuid-field"><div class="uuid-field-head"><span>GPU UUID</span>${reliable(g.uuid)?`<button class="inline-copy" data-copy="${esc(g.uuid)}" aria-label="复制 GPU UUID" title="复制完整 UUID">${icon('copy','small-icon')}</button>`:''}</div><div class="mono uuid-full">${esc(val(g.uuid))}</div></div>`;}
const shortUuid=v=>String(v).length>24?v.slice(0,12)+'…'+v.slice(-6):v;
function heading(extra=''){return `<div class="page-heading"><h1 tabindex="-1">${titles[state.page]}</h1>${extra}</div>`;}
function empty(text='导入日志后查看设备'){return `<div class="live-empty">${icon('file')}<h2>${esc(text)}</h2></div>`;}
function renderNav(){$('navigation').innerHTML=[['devices','server'],['status','file'],['checks','errors'],['topology','topology'],['errors','errors'],['compare','compare'],['xid','search'],['manual','book']].map(([page,mark])=>`<button class="nav-item" data-page="${page}" aria-label="${titles[page]}" title="${titles[page]}" ${state.page===page?'aria-current="page"':''}>${icon(mark)}<span class="nav-text">${titles[page]}</span>${page==='errors'&&data.events.length?`<span class="nav-count" title="${data.events.length} 条错误记录">${data.events.length}</span>`:''}</button>`).join('');}
function gpuRows(){const list=visibleGpus();return list.length?list.map(g=>`<tr data-gpu="${g.id}" aria-selected="${g.id===state.gpu}" class="${g.id===state.gpu?'is-selected':''}"><td><button class="cell-btn" data-open-gpu="${g.id}" aria-label="查看 ${esc(g.label)}">${esc(g.label)}<span class="cell-secondary">${esc(val(g.model))}</span></button></td><td class="mono">${esc(g.pci)}</td><td class="gpu-identifiers"><div class="identity-sn"><span class="identity-label">SN</span><span class="mono ${g.sn?'':'muted'}">${esc(val(g.sn))}</span></div><div class="identity-uuid"><span class="identity-label">UUID</span>${reliable(g.uuid)?`<button class="uuid-copy mono" data-copy="${esc(g.uuid)}" aria-label="复制 ${esc(g.label)} 完整 UUID" title="${esc(g.uuid)} · 点击复制">${esc(shortUuid(g.uuid))}${icon('copy','small-icon')}</button>`:`<span class="muted">${esc(val(g.uuid))}</span>`}</div></td><td>${esc(val(g.slot))}</td><td>${g.errors?`<button class="record-btn" data-gpu-errors="${g.id}" aria-label="查看 ${esc(g.label)} 的 ${g.errors} 条错误">${g.errors}</button>`:'<span class="muted">0</span>'}</td></tr>`).join(''):`<tr><td colspan="5"><div class="empty"><strong>没有匹配的 GPU</strong><button class="btn" data-action="clear-search">清除搜索</button></div></td></tr>`;}
function healthSection(g){const counters=g.healthCounters||[],scoped=g.scopedMetrics||{};if(!counters.length&&!Object.keys(scoped).length)return '';const groups=new Map();for(const c of counters){if(!groups.has(c.path))groups.set(c.path,new Set());groups.get(c.path).add(c.value);}return `<div class="detail-section"><h3>${counters.length?'非零健康计数':'MIG'}</h3><div class="health-values">${[...groups].map(([path,values])=>`<div class="health-value"><span>${esc(path.replaceAll('/',' / '))}</span><strong>${esc([...values].join(' / '))}</strong></div>`).join('')}</div><div class="detail-actions">${counters.length?'<button class="btn quiet" data-action="health-source">计数来源</button>':''}${Object.keys(scoped).length?'<button class="btn quiet" data-action="scoped-source">MIG 采集值</button>':''}</div></div>`;}
function deviceInspector(){const g=currentGpu();if(!g)return empty('没有匹配的 GPU');return `<div class="inspector-title"><div><h2>${esc(g.label)}</h2><p>${esc(val(g.model))}</p></div></div><div class="detail-section"><div class="detail-list">${keyline('GPU SN',g.sn,true)}${uuidField(g)}${keyline('PCI 地址',g.pci,true)}${keyline('槽位参考',g.slot)}${keyline('NUMA 节点',g.numa)}${g.status==='已读取'?'':keyline('读取状态',g.status)}</div></div><div class="detail-section"><h3>采集值</h3><div class="detail-list">${[['温度',g.temp],['功耗',g.power],['显存使用',g.memory],['当前链路',g.link],['最大能力',g.linkMax],['不可纠正 ECC',g.ecc]].filter(([,v])=>v!==''&&v!=null).map(([k,v])=>keyline(k,v)).join('')||'<p class="muted small">日志未提供采集值</p>'}</div></div>${healthSection(g)}<div class="detail-actions"><button class="btn" data-gpu-errors="${g.id}">${icon('errors','small-icon')}错误记录${g.errors?` · ${g.errors}`:''}</button><button class="btn" data-gpu-topology="${g.id}">${icon('topology','small-icon')}拓扑定位</button><button class="btn quiet" data-action="gpu-source">${icon('file','small-icon')}查看来源</button></div>`;}
function renderDevices(){if(!data.source)return heading()+empty();if(!data.gpus.length)return heading(Object.values(data.server).some(v=>typeof v==='string'&&v)?'<button class="btn" data-action="server-source">服务器信息</button>':'')+`<div class="live-empty"><h2>日志未提供 GPU 设备信息</h2>${data.diagnostics?.matrices?.length?'<button class="btn" data-page="topology">查看互联矩阵</button>':''}</div>`;const list=visibleGpus();if(list.length&&!list.some(g=>g.id===state.gpu))state.gpu=list[0].id;const s=data.server;return heading()+`<section class="server-strip" aria-label="服务器信息"><div class="server-fields">${field('服务器 SN',s.sn,{mono:true,strong:true,copy:true})}${field('型号',s.model)}${field('驱动',s.driver,{mono:true})}${field('采集时间',s.time,{mono:true})}</div><button class="btn quiet icon-btn" data-action="server-source" aria-label="查看服务器信息" title="查看服务器信息">${icon('info')}</button></section><div class="workspace-split"><section class="workspace-main" aria-label="GPU 列表"><div class="table-toolbar"><div class="table-title"><h2>GPU 列表</h2><span class="count" id="gpu-count">${list.length} / ${data.gpus.length}</span></div><div class="actions"><div class="search">${icon('search')}<input id="gpu-search" type="search" placeholder="搜索 SN / UUID / PCI 地址" aria-label="搜索 SN、UUID 或 PCI 地址" value="${esc(state.query)}" autocomplete="off"><button class="btn quiet icon-btn clear-search" data-action="clear-search" aria-label="清除搜索" ${state.query?'':'hidden'}>${icon('close','small-icon')}</button></div><button class="btn" data-action="copy-excel" id="copy-excel" ${list.length?'':'disabled'}>${icon('copy','small-icon')}复制到 Excel</button></div></div><div class="table-frame"><div class="table-scroll"><table class="device-table" aria-label="GPU 列表"><thead><tr><th>GPU / 型号</th><th>PCI 地址</th><th>SN / UUID</th><th>槽位参考</th><th>错误记录</th></tr></thead><tbody id="gpu-rows">${gpuRows()}</tbody></table></div></div><div class="table-foot"><span id="gpu-foot">${list.length} 块 GPU</span><button class="link-btn" data-action="copy-server">复制服务器信息</button></div></section><aside class="inspector" id="device-inspector" aria-label="GPU 详情">${list.length?deviceInspector():empty('没有匹配的 GPU')}</aside></div><div class="workspace-note">${icon('info')}槽位仅供参考，以设备标识核对。</div>`;}
function gpuOptions(){const bridgeOptions=Object.values(data.nodes).filter(n=>n.bridge&&data.events.some(e=>e.address===n.address)).map(n=>`<option value="pci:${esc(n.address)}" ${state.filter==='pci:'+n.address?'selected':''}>PCIe 桥 · ${esc(n.address)}</option>`).join('');return '<option value="all" '+(state.filter==='all'?'selected':'')+'>全部设备</option>'+bridgeOptions+data.gpus.map(g=>`<option value="${g.id}" ${state.filter===String(g.id)?'selected':''}>${esc(g.index!==''&&g.index!==undefined?'GPU '+g.index+' · '+g.pci:g.pci)}</option>`).join('');}
function codeOptions(){const codes=[...new Set(data.events.filter(e=>e.kind==='xid').map(e=>e.code))].sort((a,b)=>Number(a)-Number(b));const kinds=[...new Set(data.events.filter(e=>e.kind!=='xid').map(e=>e.kind))];return '<option value="all">全部类型</option>'+codes.map(c=>`<option value="${esc(c)}" ${state.code===c?'selected':''}>Xid ${esc(c)}</option>`).join('')+kinds.map(k=>`<option value="kind:${esc(k)}" ${state.code==='kind:'+k?'selected':''}>${esc(codeLabel({kind:k}))}</option>`).join('');}
function eventTime(text){const t=String(text??'—'),m=t.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);return m?`<span class="event-date">${esc(m[1])}</span><span class="event-clock" title="${esc(t)}">${esc(m[2])}</span>`:esc(t);}
function errorDetail(){const e=data.events.find(e=>e.id===state.event);if(!e)return empty('没有匹配的记录');const g=data.gpus.find(g=>g.id===e.gpu);return `<div class="inspector-title error-title"><div class="error-code">${icon('errors')}${esc(codeLabel(e))}</div>${e.title!==codeLabel(e)?`<h2 class="${e.title.length>36?'long-title':''}">${esc(e.title)}</h2>`:''}<div class="device-context">${g?`<button class="link-btn" data-open-gpu="${g.id}">${esc(g.label)}</button>`:''}<span class="mono">${esc(e.address||'系统')}</span></div></div>${e.kind==='xid'?`<div class="catalog-actions"><button class="link-btn" data-guide-code="${esc(e.code)}">排查参考 ${icon('chevron','small-icon')}</button></div>`:''}${errorOrigin(e)}${e.manual?`<div class="detail-section"><h3>错误说明</h3><p class="detail-copy">${esc(e.description.split('\n\n')[0])}</p></div>${e.actions.length?`<div class="detail-section"><h3>手册参考</h3><ul>${[...new Set(e.actions.map(a=>a.text||a.label||a.key))].map(text=>`<li>${esc(text)}</li>`).join('')}</ul></div>`:''}`:''}${e.manual&&data.catalog?.origin!=='builtin'&&data.catalog?.origin!=='official'?`<div class="detail-section"><h3>规则来源</h3><p class="source-meta">${esc(data.catalog?.file||'—')}${e.manual.sheet?' · '+esc(e.manual.sheet):''}${e.manual.row?' · 第 '+esc(e.manual.row)+' 行':''}</p></div>`:''}<div class="detail-actions">${e.kind==='xid'?`<a class="btn" href="https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html" target="_blank" rel="noopener noreferrer">${icon('book','small-icon')}官方说明${icon('external','small-icon')}</a>`:''}${g?`<button class="btn" data-gpu-topology="${g.id}">${icon('topology','small-icon')}拓扑定位</button>`:''}</div>`;}
function errorOrigin(e){return `<div class="error-origin"><div class="event-location">${esc(e.time)}</div><details class="raw-log" open><summary>${icon('chevron')}原始日志<span>第 ${e.line} 行</span></summary><pre>${esc(e.raw)}</pre>${e.truncated?'<p class="source-meta">此记录原文已截断，请重新导入日志。</p>':''}<p class="source-meta">${esc(e.source)}${e.boot?' · '+esc(e.boot):''}</p><button class="link-btn" data-copy="${esc(e.raw)}">复制原文</button></details></div>`;}
function selectEvent(id){state.event=id;document.querySelectorAll('[data-event]').forEach(row=>{row.classList.toggle('is-selected',row.dataset.event===id);row.setAttribute('aria-selected',String(row.dataset.event===id));});updateInspector('error-detail',errorDetail());}
function renderErrors(){if(!data.source)return heading()+empty('导入日志后查看错误记录');if(!data.events.length)return heading()+empty('日志中未找到错误记录');if(state.errorView==='groups')return renderGroupedErrors();const list=filteredEvents(),pages=Math.max(1,Math.ceil(list.length/100));state.errorPage=Math.max(0,Math.min(state.errorPage,pages-1));const rows=list.slice(state.errorPage*100,(state.errorPage+1)*100);if(!rows.some(e=>e.id===state.event))state.event=rows[0]?.id||'';return errorHeading()+`<div class="workspace-split"><section class="workspace-main" aria-label="错误列表"><div class="table-toolbar"><div class="table-title"><h2>${state.groupFilter?'组内原始记录':'日志记录'}</h2><span class="count">${list.length}</span></div><div class="actions"><label class="filter-label">设备<select class="select" id="error-filter">${gpuOptions()}</select></label><label class="filter-label">类型<select class="select" id="code-filter">${codeOptions()}</select></label><button class="btn quiet icon-btn" data-action="reset-errors" aria-label="重置筛选">${icon('close','small-icon')}</button></div></div><div class="table-frame error-table"><div class="table-scroll"><table aria-label="错误记录"><thead><tr><th>时间</th><th>设备</th><th>类型</th><th>说明</th></tr></thead><tbody>${rows.length?rows.map(e=>`<tr data-event="${e.id}" aria-selected="${state.event===e.id}" class="${state.event===e.id?'is-selected':''}"><td class="mono" title="${esc(e.time)}">${eventTime(e.time)}</td><td>${esc(data.gpus.find(g=>g.id===e.gpu)?(reliable(data.gpus.find(g=>g.id===e.gpu).index)?'GPU '+data.gpus.find(g=>g.id===e.gpu).index:'GPU'):'系统')}<span class="mono error-address">${esc(e.address)}</span></td><td><button class="cell-btn" data-select-event="${e.id}" aria-label="查看 ${esc(e.time)} 的 ${esc(codeLabel(e))}"><span class="badge amber">${esc(codeLabel(e))}</span></button></td><td><span class="event-title" title="${esc(e.title)}">${esc(e.title)}</span></td></tr>`).join(''):'<tr><td colspan="4"><div class="empty"><strong>没有匹配的错误记录</strong></div></td></tr>'}</tbody></table></div></div><div class="table-foot"><span title="记录条数不等于故障次数">${list.length?state.errorPage*100+1:0}–${Math.min((state.errorPage+1)*100,list.length)} / ${list.length} 条</span>${pages>1?`<div class="pager"><button class="btn" data-action="prev-errors" ${state.errorPage===0?'disabled':''}>上一页</button><span>${state.errorPage+1} / ${pages}</span><button class="btn" data-action="next-errors" ${state.errorPage===pages-1?'disabled':''}>下一页</button></div>`:''}</div></section><aside class="inspector" id="error-detail" aria-label="错误详情">${errorDetail()}</aside></div>`;}
let groupCache=null,comparisonData=null,comparisonLoading=false,comparisonError='',comparisonRequest=0;
function errorHeading(){return heading(`<div class="actions"><div class="segments" aria-label="错误视图"><button data-error-view="groups" aria-pressed="${state.errorView==='groups'}">聚合</button><button data-error-view="records" aria-pressed="${state.errorView==='records'}">原始记录</button></div><button class="btn" data-action="copy-summary">${icon('copy','small-icon')}复制摘要</button></div>`);}
function eventGroups(){
  const cacheKey=JSON.stringify([state.filter,state.code]);
  if(!groupCache||groupCache.events!==data.events||groupCache.key!==cacheKey)groupCache={events:data.events,key:cacheKey,groups:XidAnalysis.groupEvents(filteredEvents())};
  return groupCache.groups;
}
function groupDetail(){
  const group=eventGroups().find(g=>g.key===state.group);if(!group)return empty('没有匹配的记录');
  state.event=group.first.id;
  return `<div class="group-overview"><strong>${group.count.toLocaleString()} 条记录</strong><button class="btn" data-drill-group="${esc(group.key)}">查看原始记录</button><div class="group-times"><span>首条</span><span class="mono">${esc(group.first.time)}</span><span>末条</span><span class="mono">${esc(group.last.time)}</span></div><p class="muted small">${group.clock?'按日志时间排列':'按日志顺序排列'} · 条数不代表故障次数</p></div>`+errorDetail();
}
function selectGroup(key){
  state.group=key;
  document.querySelectorAll('[data-group]').forEach(row=>{const selected=row.dataset.group===key;row.classList.toggle('is-selected',selected);row.setAttribute('aria-selected',String(selected));});
  updateInspector('error-detail',groupDetail());
}
function renderGroupedErrors(){
  const groups=eventGroups(),pages=Math.max(1,Math.ceil(groups.length/100));
  state.errorPage=Math.min(state.errorPage,pages-1);
  const rows=groups.slice(state.errorPage*100,(state.errorPage+1)*100);
  if(!rows.some(g=>g.key===state.group))state.group=rows[0]?.key||'';
  return errorHeading()+`<div class="workspace-split"><section class="workspace-main" aria-label="错误聚合"><div class="table-toolbar"><div class="table-title"><h2>按设备和类型聚合</h2><span class="count">${groups.length} 组</span></div><div class="actions"><label class="filter-label">设备<select class="select" id="error-filter">${gpuOptions()}</select></label><label class="filter-label">类型<select class="select" id="code-filter">${codeOptions()}</select></label><button class="btn quiet icon-btn" data-action="reset-errors" aria-label="重置筛选">${icon('close','small-icon')}</button></div></div><div class="table-frame"><div class="table-scroll"><table class="group-table" aria-label="错误聚合"><thead><tr><th>设备</th><th>类型 / 说明</th><th>记录条数</th><th>首条 / 末条</th></tr></thead><tbody>${rows.map(group=>{
    const e=group.first,g=data.gpus.find(g=>g.id===e.gpu);
    return `<tr data-group="${esc(group.key)}" aria-selected="${group.key===state.group}" class="${group.key===state.group?'is-selected':''}"><td>${esc(g?.label||e.address||'系统')}</td><td><button class="cell-btn" data-select-group="${esc(group.key)}">${esc(codeLabel(e))}</button>${e.title!==codeLabel(e)?`<span class="cell-secondary event-title" title="${esc(e.title)}">${esc(e.title)}</span>`:''}</td><td class="mono">${group.count.toLocaleString()}</td><td class="group-range"><span class="mono" title="${esc(group.first.time)}">${esc(group.first.time)}</span><span class="mono muted" title="${esc(group.last.time)}">${esc(group.last.time)}</span></td></tr>`;
  }).join('')||'<tr><td colspan="4"><div class="empty">没有匹配的错误记录</div></td></tr>'}</tbody></table></div></div><div class="table-foot"><span>${groups.length} 组 · ${filteredEvents().length.toLocaleString()} 条记录</span>${pages>1?`<div class="pager"><button class="btn" data-action="prev-errors" ${!state.errorPage?'disabled':''}>上一页</button><span>${state.errorPage+1} / ${pages}</span><button class="btn" data-action="next-errors" ${state.errorPage===pages-1?'disabled':''}>下一页</button></div>`:''}</div></section><aside class="inspector" id="error-detail" aria-label="聚合详情">${groupDetail()}</aside></div>`;
}
const reportOption=c=>reportName(c.source)+(c.collected?' · '+c.collected:' · '+c.id.slice(0,6));
const reportName=source=>String(source||'').split(/[\\/]/).at(-1);
function comparisonRows(){return comparisonData?XidAnalysis.compareReports(comparisonData,data):null;}
function comparisonStatus(row){if(!row.matched)return row.before?'仅基准记录':'仅当前记录';const count=row.details.filter(f=>f.state==='changed').length,missing=row.details.filter(f=>f.state==='missing').length,multi=row.details.filter(f=>f.state==='ambiguous').length;return [count?`${count} 项字段变化`:'',row.changes.includes('错误记录')?'错误记录':'',!row.changes.length?'未见变化':'',missing?`${missing} 项缺失`:'',multi?`${multi} 项多值`:''].filter(Boolean).join(' · ');}
function comparisonField(f,index){const show=s=>s.ambiguous?'多个值':s.provided?s.value:'未提供';return `<div class="compare-field ${f.state==='changed'?'field-changed':''}"><button class="compare-field-link" data-compare-field="${index}" title="查看两份日志原文">${esc(f.label)}${icon('file','small-icon')}</button><span class="${!f.before.provided?'muted':''}">${esc(show(f.before))}</span><span class="${!f.after.provided?'muted':''}">${esc(show(f.after))}</span></div>`;}
function comparisonInspector(result){
  if(state.compareRow===result.rows.length&&result.system.errors.length)return `<div class="inspector-title"><h2>系统记录</h2><p>未关联 GPU 的错误记录</p></div><div class="compare-field compare-field-head"><span>类型</span><span>基准</span><span>当前</span></div>${result.system.errors.map(e=>`<div class="compare-field system-error-field ${e.before!==e.after?'field-changed':''}"><span>${esc(codeLabel(e))}${e.address?`<span class="cell-secondary mono">${esc(e.address)}</span>`:''}</span><span>${e.before.toLocaleString()}</span><span>${e.after.toLocaleString()}</span></div>`).join('')}<p class="compare-note">按各报告统计，时间范围可能不同。</p>`;
  const row=result.rows[state.compareRow];if(!row)return empty('没有可显示的设备');
 const changed=row.details.map((f,i)=>({f,i})).filter(({f})=>f.state==='changed'),rest=row.details.map((f,i)=>({f,i})).filter(({f})=>f.state!=='changed');
 const head='<div class="compare-field compare-field-head"><span>字段</span><span>基准</span><span>当前</span></div>';
 return `<div class="inspector-title"><h2>${row.matched?'设备对比':'未匹配设备'}</h2><p>${esc(row.basis?'匹配依据：'+row.basis:row.reason)}</p></div>${changed.length?`<div class="detail-section"><h3>变化字段 · ${changed.length}</h3>${head}${changed.map(({f,i})=>comparisonField(f,i)).join('')}</div>`:''}<details class="comparison-rest" ${!changed.length?'open':''}><summary>${changed.length?'其余字段':'设备字段'} · ${rest.length}</summary>${head}${rest.map(({f,i})=>comparisonField(f,i)).join('')}<p class="compare-note">缺失或多个采集值不计为变化。</p></details>${row.errors.length?`<div class="detail-section"><h3>错误记录条数</h3><div class="compare-field compare-field-head"><span>类型</span><span>基准</span><span>当前</span></div>${row.errors.map(e=>`<div class="compare-field ${e.before!==e.after?'field-changed':''}"><span>${esc(codeLabel(e))}</span><span>${row.before?e.before:'—'}</span><span>${row.after?e.after:'—'}</span></div>`).join('')}<p class="compare-note">按各报告统计，时间范围可能不同。</p></div>`:''}`;
}
function compareFieldSource(index){
 const row=comparisonRows()?.rows[state.compareRow],f=row?.details[Number(index)];if(!f)return;
 const panel=(side,report,gpu,label)=>`<section class="comparison-source"><h3>${label}</h3><p class="comparison-source-name">${esc(report.source)}</p><p class="source-meta">${esc(gpu?.label||'—')} · ${esc(gpu?.pci||'—')}</p>${!side.provided?'<p class="comparison-source-empty">未提供</p>':side.refs.some(r=>r.evidence?.text)?side.refs.filter(r=>r.evidence?.text).map(r=>`<div class="comparison-evidence"><p class="source-meta">${esc(r.origin||r.evidence.section||'')} · 第 ${esc(r.evidence.line)} 行</p><pre>${esc(r.evidence.text)}</pre>${r.bus_evidence?`<p class="source-meta">第 ${esc(r.bus_evidence.line)} 行</p><pre>${esc(r.bus_evidence.text)}</pre>`:''}</div>`).join(''):'<p class="comparison-source-empty">原文未保存在报告中</p>'}</section>`;
 openDialog(f.key.startsWith('health:')?f.key.slice(7).replaceAll('/',' / '):f.label,`<div class="comparison-sources">${panel(f.before,comparisonData,row.before,'基准')}${panel(f.after,data,row.after,'当前')}</div>`,'','compare-source');
}

function renderComparison(){
  if(!data.source||cases.length<2)return heading()+empty('导入两份日志后进行对比');
  const choices=cases.filter(c=>c.id!==loadedCase),result=comparisonRows();
  const controls=`<div class="compare-controls"><label><span class="field-label">基准报告</span><select id="compare-base" class="select"><option value="">选择日志</option>${choices.map(c=>`<option value="${esc(c.id)}" ${c.id===state.compareBase?'selected':''}>${esc(reportOption(c))}</option>`).join('')}</select>${comparisonData?`<div class="report-meta">${esc(val(comparisonData.server.sn))} · ${esc(val(comparisonData.server.time))}</div>`:''}</label><div><span class="field-label">当前报告</span><div class="current-report" title="${esc(data.source)}">${esc(reportName(data.source))}</div><div class="report-meta">${esc(val(data.server.sn))} · ${esc(val(data.server.time))}</div></div></div>`;
  if(!result)return heading()+controls+`<div class="live-empty" role="status">${comparisonLoading?'正在读取基准报告…':comparisonError?`<p>${esc(comparisonError)}</p><button class="btn" data-action="retry-comparison">重新读取</button>`:'选择基准报告'}</div>`;
  const rows=result.rows.map((row,index)=>({...row,index})).filter(row=>!state.compareChanged||!row.matched||row.changes.length);
  if(result.system.errors.length&&(!state.compareChanged||result.system.changed))rows.push({index:result.rows.length,system:true});
  if(!rows.some(r=>r.index===state.compareRow))state.compareRow=rows[0]?.index??-1;
  return heading()+controls+`<div class="compare-summary"><span>GPU ${comparisonData.gpus.length} → ${data.gpus.length}</span><span>匹配 ${result.matched}</span><span>GPU 差异 ${result.changed}</span><span>未匹配 ${result.beforeOnly+result.afterOnly}</span><label class="check-label"><input type="checkbox" id="compare-changed" ${state.compareChanged?'checked':''}>只看差异</label></div>${result.serverMismatch||result.incomplete?`<p class="compare-warning">${[result.serverMismatch?'服务器 SN 不同':'',result.incomplete?'存在未完整读取的报告':''].filter(Boolean).join(' · ')}</p>`:''}<div class="workspace-split compare-split"><section class="workspace-main"><div class="table-frame"><div class="table-scroll"><table class="compare-table" aria-label="设备对比"><thead><tr><th>对象 / 匹配依据</th><th>基准</th><th>当前</th><th>差异</th></tr></thead><tbody>${rows.map(row=>row.system?`<tr data-compare-row="${row.index}" aria-selected="${row.index===state.compareRow}" class="${row.index===state.compareRow?'is-selected':''}"><td><button class="cell-btn" data-select-comparison="${row.index}">系统记录</button></td><td>${result.system.before.toLocaleString()} 条记录</td><td>${result.system.after.toLocaleString()} 条记录</td><td>${result.system.changed?'有差异':'未见差异'}<span class="cell-secondary">未关联 GPU</span></td></tr>`:`<tr data-compare-row="${row.index}" aria-selected="${row.index===state.compareRow}" class="${row.index===state.compareRow?'is-selected':''}"><td><button class="cell-btn" data-select-comparison="${row.index}">${esc(row.basis||'未匹配')}</button></td><td>${esc(val(row.before?.label))}<span class="cell-secondary">${esc(row.before?.model||'')}</span></td><td>${esc(val(row.after?.label))}<span class="cell-secondary">${esc(row.after?.model||'')}</span></td><td>${esc(comparisonStatus(row))}${!row.matched?`<span class="cell-secondary">${esc(row.reason)}</span>`:''}</td></tr>`).join('')||`<tr><td colspan="4"><div class="empty">${state.compareChanged?'没有符合条件的差异':'没有可对比的 GPU 记录'}</div></td></tr>`}</tbody></table></div></div><div class="workspace-note">仅按唯一 SN / UUID 匹配；PCI 地址和槽位仅供对照。</div></section><aside class="inspector" id="compare-detail" aria-label="设备对比详情">${comparisonInspector(result)}</aside></div>`;
}
function selectComparison(index){
  state.compareRow=Number(index);
  document.querySelectorAll('[data-compare-row]').forEach(row=>{const selected=Number(row.dataset.compareRow)===state.compareRow;row.classList.toggle('is-selected',selected);row.setAttribute('aria-selected',String(selected));});
  updateInspector('compare-detail',comparisonInspector(comparisonRows()));
}
async function loadComparison(id){
  const request=++comparisonRequest;state.compareBase=id;state.compareRow=0;comparisonData=null;comparisonError='';comparisonLoading=Boolean(id);render();
  if(!id)return;
  try{const report=await api('/api/case/'+id);if(request===comparisonRequest)comparisonData=report;}
  catch(error){if(request===comparisonRequest)comparisonError='读取失败：'+error.message;}
  finally{if(request===comparisonRequest){comparisonLoading=false;if(state.page==='compare')render();}}
}

function fieldValue(fields,key){const values=fields?.[key]||[];return values.length===1?values[0].value:'';}
function parents(address){return XidAnalysis.upstream(data.nodes,address);}
function bridgeErrors(address){return data.events.filter(e=>e.address===address).length;}
function topologyInspector(){const g=currentGpu();if(!g)return empty('没有可显示的设备');const port=state.node;return `<div class="inspector-title"><div><h2>${port?'PCIe 桥':esc(g.label)}</h2><p>${esc(port||val(g.model))}</p></div></div><div class="detail-section"><div class="detail-list">${keyline('PCI 地址',port||g.pci,true)}${!port?keyline('GPU SN',g.sn,true)+uuidField(g):''}${keyline('NUMA 节点',port?fieldValue(data.nodes[port]?.fields,'numa'):g.numa)}${!port?keyline('槽位参考',g.slot)+keyline('上游端口',g.parent):''}</div></div>${!port?`<div class="detail-section"><h3>链路</h3><div class="detail-list">${keyline('当前链路',g.link)}${keyline('最大能力',g.linkMax)}</div></div>`:''}<div class="detail-section"><h3>PCIe 路径</h3><div class="path-line">${[...parents(port||g.pci),port||g.pci].map(a=>data.nodes[a]?.bridge?`<div><button class="link-btn mono" data-port="${esc(a)}" data-port-gpu="${g.id}">${esc(a)}</button>${bridgeErrors(a)?` <button class="record-btn" data-bridge-errors="${esc(a)}" aria-label="查看 PCIe 桥 ${esc(a)} 的错误">${bridgeErrors(a)}</button>`:''}</div>`:esc(a)).join('')}</div></div><div class="detail-actions">${!port?`<button class="btn" data-gpu-page="${g.id}">${icon('gpu','small-icon')}设备详情</button><button class="btn" data-gpu-errors="${g.id}">${icon('errors','small-icon')}错误记录${g.errors?` · ${g.errors}`:''}</button>`:''}<button class="btn quiet" data-action="path-source">${icon('file','small-icon')}查看来源</button></div>`;}
function topologyMain(){const list=state.onlyErrors?data.gpus.filter(g=>XidAnalysis.pathErrorCount(data,g)>0):data.gpus;if(!list.some(g=>g.id===state.gpu)){state.gpu=list[0]?.id??-1;state.node='';}if(!list.length)return empty('没有可显示的设备');if(state.topology==='list')return `<div class="table-scroll"><table aria-label="PCIe 路径列表"><thead><tr><th>GPU</th><th>上游端口</th><th>PCI 地址</th><th>NUMA</th><th>槽位参考</th></tr></thead><tbody>${list.map(g=>`<tr class="${g.id===state.gpu?'is-selected':''}" aria-selected="${g.id===state.gpu}"><td><button class="cell-btn" data-topology-gpu="${g.id}">${esc(g.label)}</button></td><td class="mono">${esc(val(g.parent))}</td><td class="mono">${esc(g.pci)}</td><td>${esc(val(g.numa))}</td><td>${esc(val(g.slot))}</td></tr>`).join('')}</tbody></table></div>`;return [...new Set(list.map(g=>g.numa))].map(n=>`<div class="numa-group"><div class="numa-head">${icon('server','small-icon')}${n===''?'NUMA 未提供':'NUMA '+esc(n)}<span class="muted">${list.filter(g=>g.numa===n).length} 块 GPU</span></div>${list.filter(g=>g.numa===n).map(g=>`<div class="topo-row">${g.parent?`<button class="port-node mono ${state.node===g.parent?'selected':''}" data-port="${esc(g.parent)}" data-port-gpu="${g.id}" aria-label="PCIe 桥 ${esc(g.parent)}">${esc(g.parent)}${bridgeErrors(g.parent)?` <span class="badge amber">${bridgeErrors(g.parent)}</span>`:''}</button>`:'<span class="empty-port">上游未提供</span>'}<span class="wire ${g.id===state.gpu&&!state.node?'selected':''}" style="${g.parent?'':'background:transparent'}"></span><button class="gpu-node ${g.id===state.gpu&&!state.node?'selected':''}" data-topology-gpu="${g.id}" aria-label="拓扑 ${esc(g.label)}"><span><strong>${esc(g.label)} <span class="node-model">${esc(g.model)}</span></strong>${g.index!==''&&g.index!==undefined?`<small class="mono">${esc(g.pci)}</small>`:''}</span>${g.errors?`<span class="badge amber">${g.errors}</span>`:''}</button></div>`).join('')}</div>`).join('')+`<div class="legend"><span class="legend-wire"></span>选中 GPU 的连接<span class="legend-dot"></span>错误记录数</div>`;}
function renderTopology(){if(!data.source)return heading()+empty('导入日志后查看 PCIe 拓扑');const canvas=topologyMain();return heading(`<button class="btn" data-action="topology-source">${icon('file','small-icon')}原始拓扑</button>`)+`<div class="workspace-split"><section class="workspace-main" aria-label="PCIe 连接"><div class="topology-tools"><div class="segments" aria-label="拓扑视图"><button data-view="graph" aria-pressed="${state.topology==='graph'}">连接图</button><button data-view="list" aria-pressed="${state.topology==='list'}">路径列表</button></div><label class="check-label"><input type="checkbox" id="only-errors" ${state.onlyErrors?'checked':''}>仅看含错误的路径</label></div><div class="topology-canvas ${state.topology==='list'?'list-mode':''}" id="topology-main">${canvas}</div><div class="workspace-note">${icon('info')}槽位仅供参考，以设备标识核对。</div></section><aside class="inspector" id="topology-inspector" aria-label="拓扑节点详情">${topologyInspector()}</aside></div>`;}
function closeDrawer(){state.drawer=false;$('drawer').close();drawerFocus?.isConnected&&drawerFocus.focus({preventScroll:true});}
function renderDrawer(){const el=$('drawer');if(!state.drawer){if(el.open)el.close();return;}el.innerHTML=`<div class="drawer-head"><h2 id="drawer-title">设备详情</h2><button class="btn quiet icon-btn" data-action="close-drawer" aria-label="关闭设备详情">${icon('close')}</button></div><div class="inspector drawer-inspector">${deviceInspector()}</div>`;if(!el.open)el.showModal();}
const viewPositions=new Map();let renderedView='';
const scrollAreas=()=>Array.from(document.querySelectorAll('#content,.table-scroll,.inspector,#topology-main,.resources-page,.report-list,[data-scroll-key]'));
const areaKey=(el,i)=>el.dataset.scrollKey||el.id||el.className+':'+i;
function saveViewPosition(){if(renderedView){const saved=viewPositions.get(renderedView)||new Map();scrollAreas().forEach((el,i)=>saved.set(areaKey(el,i),[el.scrollLeft,el.scrollTop]));viewPositions.set(renderedView,saved);}}
function restoreViewPosition(key){const saved=viewPositions.get(key);scrollAreas().forEach((el,i)=>{const pos=saved?.get(areaKey(el,i));if(pos){el.scrollLeft=pos[0];el.scrollTop=pos[1];}});}
function updateInspector(id,html){const el=$(id),top=el.scrollTop;el.innerHTML=html;el.scrollTop=top;}
function focusKey(el){if(!el)return null;if(el.id)return {id:el.id};if(el.dataset.diag)return {diag:el.dataset.diag,value:el.dataset.value};if(el.dataset.diagChange)return {change:el.dataset.diagChange};const key=Object.keys(el.dataset).find(k=>['page','action','view','topologyGpu','port','openGpu','errorView','selectGroup','selectComparison'].includes(k));return key?{key,value:el.dataset[key],gpu:el.dataset.portGpu}:null;}
function restoreFocus(key){if(!key)return;const el=key.id?$(key.id):key.diag?Array.from(document.querySelectorAll('button[data-diag]')).find(b=>b.dataset.diag===key.diag&&b.dataset.value===key.value):key.change?Array.from(document.querySelectorAll('[data-diag-change]')).find(b=>b.dataset.diagChange===key.change):Array.from(document.querySelectorAll('button')).find(b=>b.dataset[key.key]===key.value&&(!key.gpu||b.dataset.portGpu===key.gpu));if(el&&!el.disabled)el.focus({preventScroll:true});}
let knowledgeCode='',knowledgeTopic='';
function render(preserveScroll=true){saveViewPosition();window.XidKnowledge?.unmount();const focus=focusKey(document.activeElement);renderNav();$('content').innerHTML=['xid','manual'].includes(state.page)?'<div id="knowledge-host"></div>':state.page==='updates'?heading()+'<div class="resources-page"><div id="online-panel">'+renderOnline('app')+'</div></div>':state.page==='resources'?renderResources():state.page==='reports'?renderReports():['status','checks','topology'].includes(state.page)?XidDiagnostics.render(data,{state,heading,render,icon}):state.page==='devices'?renderDevices():state.page==='errors'?renderErrors():state.page==='compare'?renderComparison():renderTopology();$('filename').textContent=data.source?data.source.split('!').at(-1).split(/[\\/]/).at(-1):'尚未导入日志';$('filename').title=data.source;$('filename').hidden=Boolean(cases.length);$('log-switch').hidden=!cases.length;const warning=data.complete===false||data.warnings.length;$('file-description').textContent=warning?(data.complete===false?'读取不完整':'读取提示'):'';$('file-description').disabled=!warning;$('file-description').hidden=!data.source||!warning;$('file-description').classList.toggle('is-warning',Boolean(warning));$('file-description').setAttribute('title',warning?'查看读取提示':'');$('log-select').disabled=busy||!cases.length;$('export-button').hidden=['compare','reports','resources','xid','manual','updates'].includes(state.page);$('export-button').disabled=loading||busy||!data.source;$('import-button').disabled=loading||busy;$('content').inert=loading;$('content').setAttribute('aria-busy',String(loading));status(data.source?`${!data.gpus.length&&data.diagnostics?.matrices?.length?data.diagnostics.matrices.length+' 份互联矩阵':data.gpus.length+' 块 GPU'} · ${data.events.length?data.events.length+' 条错误记录 · ':''}${data.lines.toLocaleString()} 行`:'选择日志开始');renderDrawer();syncReportControls();$('manual').setAttribute('aria-pressed',String(state.page==='resources'));if(['resources','xid','manual','updates'].includes(state.page))status(titles[state.page]);
 document.querySelector('.prototype-tag').setAttribute('aria-current',state.page==='updates'?'page':'false');
 $('content').classList.toggle('knowledge-content',['xid','manual'].includes(state.page));
 if($('knowledge-host'))window.XidKnowledge.mount($('knowledge-host'),{request:api,initialPage:state.page,initialCode:knowledgeCode,initialTopic:knowledgeTopic,onNavigate:(p,k,t)=>{window.XidKnowledge?.navigate(p,k,t);if(k)knowledgeCode=k;if(t)knowledgeTopic=t;goto(p)},onManageRules:()=>goto('resources')});
renderedView=loadedCase+'|'+state.page;if(preserveScroll)restoreViewPosition(renderedView);restoreFocus(focus);XidDiagnostics.afterRender();}
function goto(page,gpu){XidDiagnostics.leave();state.page=page;if(page==='topology'&&gpu!==undefined)XidDiagnostics.locate(data.gpus.find(g=>g.id===Number(gpu))?.pci||'');if(page==='resources'){resourceTab='rules';loadCatalog();refreshOnline();}if(page==='updates'){resourceTab='updates';refreshOnline();}state.drawer=false;if(gpu!==undefined){state.gpu=Number(gpu);state.node='';if(page==='errors'){state.filter=String(gpu);state.code='all';state.errorPage=0;state.event='';state.groupFilter='';state.group='';}if(page==='devices')state.query='';if(page==='topology'&&(!currentGpu()||!XidAnalysis.pathErrorCount(data,currentGpu())))state.onlyErrors=false;}render();$('content').querySelector('h1')?.focus({preventScroll:true});}
function openGpu(id){drawerFocus=document.activeElement;state.gpu=Number(id);if(state.page==='devices'){document.querySelectorAll('[data-gpu]').forEach(row=>{const selected=Number(row.dataset.gpu)===state.gpu;row.classList.toggle('is-selected',selected);row.setAttribute('aria-selected',String(selected));});updateInspector('device-inspector',deviceInspector());}else{state.drawer=true;renderDrawer();}}
function sourceView(title,fields){const rows=Object.entries(fields||{}).flatMap(([key,values])=>(values||[]).map(v=>`<div class="source-entry"><h3>${esc(key)} · ${esc(v.value)}</h3><p class="source-meta">${esc(v.origin)} · 第 ${v.evidence.line} 行</p><pre>${esc(v.evidence.text)}${v.bus_evidence?'\n'+esc(v.bus_evidence.text):''}</pre></div>`)).join('');openDialog(title,rows||'<p class="muted">日志未提供</p>');}
async function loadCase(id,force=false){if(!id)return;if(!force&&id===loadedCase&&!loading)return true;const request=++loadRequest;loading=true;closeMenu();closeDrawer();$('content').inert=true;$('content').setAttribute('aria-busy','true');$('export-button').disabled=true;$('import-button').disabled=true;status('正在载入日志…');try{const next=await api('/api/case/'+id);if(request!==loadRequest)return false;data=next;viewPositions.clear();renderedView='';XidDiagnostics.reset();if(!data.gpus.length&&data.diagnostics?.matrices?.length&&['devices','topology'].includes(state.page)){state.page='topology';XidDiagnostics.openMatrix();}loadedCase=id;state.groupFilter='';state.group='';if(state.compareBase===id){comparisonRequest++;comparisonData=null;state.compareBase='';comparisonLoading=false;comparisonError='';}Object.assign(state,{gpu:data.gpus[0]?.id??-1,query:'',filter:'all',code:'all',event:'',errorPage:0,errorView:'groups',compareRow:0,compareChanged:false,topology:'graph',node:'',drawer:false,onlyErrors:false});$('log-select').value=id;return true;}catch(error){if(request!==loadRequest)return;$('log-select').value=loadedCase;toast('载入失败：'+error.message);return false;}finally{if(request===loadRequest){loading=false;render();}}}
async function refreshCases(selected,force=false){const d=await api('/api/cases');cases=d.cases;reportState.recovery=d.recovery||{};reportState.unreadable=d.unreadable||0;if(!reportState.notified&&(reportState.unreadable||reportState.recovery.pending||reportState.recovery.recovered||reportState.recovery.interrupted)){reportState.notified=true;toast('报告恢复情况可在报告管理中查看');}reportState.selected=new Set([...reportState.selected].filter(id=>cases.some(c=>c.id===id)));$('log-select').innerHTML=cases.length?cases.map(c=>`<option value="${c.id}">${esc(reportOption(c))}</option>`).join(''):'<option value="">尚未导入</option>';if(state.compareBase&&!cases.some(c=>c.id===state.compareBase)){comparisonRequest++;comparisonData=null;state.compareBase='';comparisonLoading=false;}if(cases.length)await loadCase(cases.some(c=>c.id===selected)?selected:cases.at(-1).id,force);else{loadRequest++;data=blank();loadedCase='';loading=false;state.drawer=false;comparisonRequest++;comparisonData=null;state.compareBase='';comparisonLoading=false;render();}}

let catalogInfo=null,catalogError='',catalogBusy=false,catalogRequest=0,ruleRows=[],ruleLimit=50;
const officialDocs=[
 ['Xid Errors','错误编号、说明与处理参考','https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html'],
 ['GPU Debug Guidelines','GPU 排查流程与检查步骤','https://docs.nvidia.com/deploy/gpu-debug-guidelines/'],
 ['nvidia-smi','命令参数与字段说明','https://docs.nvidia.com/deploy/nvidia-smi/index.html']
];
function catalogName(c){return c?.origin==='builtin'?'内置中文规则':c?.origin==='official'?'NVIDIA 英文规则':c?.importFile||c?.file||'未加载规则';}
function renderRules(){
 const c=catalogInfo,custom=c?.origin==='imported';
 return `<section class="resource-section"><div class="resource-heading"><h2>当前规则</h2><button class="btn" data-action="choose-catalog" title="XLSX 或 JSON，最大 10 MB" ${catalogBusy||busy?'disabled':''}>${icon('import','small-icon')}${catalogBusy?'正在导入…':'导入规则'}</button><input id="catalog-input" type="file" accept=".xlsx,.json" aria-label="选择规则文件" hidden></div>${catalogError?`<p class="catalog-feedback" role="alert">${esc(catalogError)}${!c?' <button class="link-btn" data-action="reload-catalog">重试</button>':''}</p>`:''}${c?`<div class="catalog-current"><strong>${esc(catalogName(c))}</strong><span>${c.count} 条 Xid</span></div>${c.count?`<div class="catalog-actions"><button class="btn" data-action="view-catalog" ${catalogBusy?'disabled':''}>查看规则</button>${c.origin!=='builtin'?`<button class="btn quiet" data-action="reset-catalog" ${catalogBusy?'disabled':''}>恢复内置规则</button>`:''}</div>${custom?`<details class="catalog-source"><summary>导入详情</summary><dl>${c.file!==c.importFile&&c.importFile?`<dt>资料名称</dt><dd>${esc(c.file)}</dd>`:''}${c.importedAt?`<dt>导入时间</dt><dd>${esc(new Date(c.importedAt).toLocaleString())}</dd>`:''}<dt>文件 SHA-256</dt><dd class="mono">${esc(c.sha256)} <button class="link-btn" data-copy="${esc(c.sha256)}">复制</button></dd>${c.sourceSha256&&c.sourceSha256!==c.sha256?`<dt>声明的来源 SHA-256</dt><dd class="mono">${esc(c.sourceSha256)}</dd>`:''}</dl></details>`:''}`:''}${c.warning?`<p class="catalog-feedback" role="alert">${esc(c.warning)}</p>`:''}`:!catalogError?'<p class="muted">正在读取规则…</p>':''}</section>`;
}
async function loadCatalog(){const request=++catalogRequest;try{const next=await api('/api/catalog');if(request!==catalogRequest)return;catalogInfo=next;catalogError='';}catch(error){if(request!==catalogRequest)return;catalogError=error.message;}if(state.page==='resources'&&resourceTab==='rules')render(true);}
async function importCatalog(file){
 if(!file||catalogBusy)return;
 if(file.size>10*1024*1024){toast('请选择 10 MB 以内的规则文件');return;}
 catalogBusy=true;catalogError='';catalogRequest++;if(state.page==='resources')render(true);
 try{catalogInfo=await api('/api/catalog/import?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});toast(`已导入 ${catalogInfo.count} 条规则，新导入或重新解析时生效`);}
 catch(error){catalogError=error.message;}
 finally{catalogBusy=false;if(state.page==='resources')render(true);}
}
function ruleResults(){
 const q=$('rule-search').value.trim().toLowerCase(),rows=ruleRows.filter(r=>[r.code,'xid '+r.code,r.title,r.symbol,r.description].some(v=>String(v).toLowerCase().includes(q)));
 $('rule-count').textContent=`${rows.length} 条规则`;
 $('rule-results').innerHTML=rows.length?rows.slice(0,ruleLimit).map(r=>`<details class="rule-item"><summary><span class="rule-code">Xid ${esc(r.code)}</span><strong>${esc(r.title||r.symbol||'—')}</strong>${icon('chevron','small-icon')}</summary><div class="rule-detail">${r.description?`<p>${esc(r.description)}</p>`:''}${r.actions.length?`<h3>参考建议</h3><ul>${r.actions.map(a=>`<li>${esc(a.text||a.label||a.key)}</li>`).join('')}</ul>`:''}${catalogInfo?.origin==='imported'?`<p class="source-meta">${r.sheet?esc(r.sheet):'规则 JSON'}${r.row?' · 第 '+esc(r.row)+' 行':''}</p>`:''}</div></details>`).join(''):'<p class="muted rule-empty">没有匹配的规则</p>';
 $('rule-more').hidden=rows.length<=ruleLimit;
}
async function viewCatalog(){
 openDialog('当前规则','<p class="muted">正在读取…</p>','','rules');
 const revision=dialogRevision,current=()=>$('dialog').open&&dialogRevision===revision;
 try{const result=await api('/api/catalog/rules');if(!current())return;ruleRows=result.rules;ruleLimit=50;
 $('dialog-body').innerHTML=`<p class="rule-source-name">${esc(catalogName(result.catalog))}</p><div class="rule-toolbar"><label class="search">${icon('search')}<input type="search" id="rule-search" placeholder="搜索 Xid 或说明" aria-label="搜索规则"></label><span id="rule-count" class="muted small"></span></div><div id="rule-results"></div><button id="rule-more" class="btn" data-action="more-rules" hidden>显示更多</button>`;ruleResults();$('rule-search').focus();
 }catch(error){if(current())$('dialog-body').innerHTML=`<p class="catalog-feedback" role="alert">${esc(error.message)}</p>`;}
}
document.addEventListener('input',event=>{if(event.target.id==='rule-search'){ruleLimit=50;ruleResults();}});
document.addEventListener('change',event=>{if(event.target.id==='catalog-input')importCatalog(event.target.files[0]);});
async function resetCatalog(){if(catalogBusy)return;catalogBusy=true;catalogRequest++;$('confirm-reset-catalog').disabled=true;try{catalogInfo=await api('/api/catalog/reset',{method:'POST'});catalogError='';catalogBusy=false;closeDialog();if(state.page==='resources')render(true);toast('已恢复内置规则，新导入或重新解析时生效');}catch(error){toast(error.message);}finally{catalogBusy=false;if($('confirm-reset-catalog'))$('confirm-reset-catalog').disabled=false;}}

let resourceTab='rules',onlineInfo=null,onlinePending=false,onlineRefreshing=false,onlineTimer=null;
const noticedVersions=new Set();let updateNoticeVersion='';
function maybeNotifyUpdate(){
 const app=onlineInfo?.app,version=app?.release?.version;
 if(!app?.notify||!version||noticedVersions.has(version)||document.hidden||busy||loading||catalogBusy||onlinePending||state.page==='updates'||$('dialog').open||$('drawer').open)return;
 if(document.activeElement?.matches('input,textarea,select,[contenteditable=true]'))return;
 noticedVersions.add(version);updateNoticeVersion=version;
 const notes=String(app.release.notes||'').split('\n').filter(s=>s.trim()).slice(0,5).join('\n').slice(0,600);
 openDialog('发现新版本',`<p class="update-notice-version">XidLens ${esc(version)}</p><p class="resource-note">当前版本 ${esc(onlineInfo.current)}</p>${notes?`<details class="update-notice-notes"><summary>更新内容</summary><p>${esc(notes)}</p></details>`:''}<label class="online-option update-notice-option"><input type="checkbox" id="ignore-update-version">不再提醒此版本</label><p id="update-notice-error" role="alert" hidden></p>`, '<button class="btn" data-online="notice-later">暂不更新</button><button class="btn primary" data-online="notice-download">下载更新</button>','update-notice');
 $('dialog-foot').querySelector('button')?.focus();
}
async function dismissUpdateNotice(download=false,closeOnly=false){
 if(onlinePending&&!closeOnly)return;
 const ignored=$('ignore-update-version')?.checked,version=updateNoticeVersion;
 const close=()=>{updateNoticeVersion='';$('dialog').dataset.kind='';closeDialog();};
 if(closeOnly||!ignored){
  close();
  if(download){goto('updates');return onlineAction('download-app');}
  // Dismissing a notice must never wait for storage or a local service response.
  api('/api/online/remind-later?version='+encodeURIComponent(version),{method:'POST'}).catch(()=>{});return;
 }
 const revision=dialogRevision;
 onlinePending=true;
 const controls=Array.from($('dialog').querySelectorAll('button:not(#dialog-close),input'));for(const b of controls)b.disabled=true;
 try{
  onlineInfo=await api('/api/online/ignore-version?version='+encodeURIComponent(version),{method:'POST'});
  if(dialogRevision===revision&&$('dialog').dataset.kind==='update-notice'){
   close();if(download){goto('updates');await api('/api/online/download-app',{method:'POST'});await refreshOnline();}
  }
 }catch(e){const error=$('update-notice-error');if(dialogRevision===revision&&$('dialog').open&&error){error.textContent=e.message;error.hidden=false;}else if(download)toast(e.message);}
 finally{onlinePending=false;for(const b of controls)if(b.isConnected)b.disabled=false;if($('online-panel'))$('online-panel').innerHTML=renderOnline(resourceTab==='rules'?'rules':'app');}
}
function renderOnline(kind){
 const info=onlineInfo,s=info?.[kind]||{state:'idle'},working=s.state==='working'||onlinePending;
 if(kind==='rules')return `<section class="resource-section"><div class="resource-heading"><h2>NVIDIA 英文规则</h2><button class="btn" data-online="check-rules" ${working||catalogBusy?'disabled':''}>检查更新</button></div><div class="online-status" role="status" ${s.message?'':'hidden'}>${esc(s.message||'')}${s.count?` · ${s.count} 条`:''}</div>${s.state==='available'?`<button class="btn primary" data-online="confirm-rules" ${catalogBusy?'disabled':''}>应用官方规则</button>`:''}<a class="link-btn online-source" href="https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html" target="_blank" rel="noopener noreferrer">NVIDIA 文档 ${icon('external','small-icon')}</a></section>`;
 const r=s.release;
 return `<section class="resource-section"><div class="resource-heading"><h2>XidLens <span class="muted">${esc(info?.current||'—')}</span></h2><button class="btn" data-online="check-app" ${working?'disabled':''}>检查更新</button></div><div class="online-status" role="status" ${s.message?'':'hidden'}>${esc(s.message||'')}${r?` · ${esc(r.version)}${r.prerelease?' · 试用版':''}`:''}</div>${s.state==='working'&&s.action==='download-app'?`<progress class="update-progress" max="${s.total||1}" ${s.total?`value="${s.bytes}"`:''}></progress><p class="resource-note">${importSize(s.bytes||0)}${s.total?' / '+importSize(s.total):''}</p><button class="btn" data-online="cancel">取消下载</button>`:''}${r?`<div class="update-notes">${esc(r.notes)}</div><div class="catalog-actions">${s.state==='available'?'<button class="btn primary" data-online="download-app">下载更新</button>':''}${s.state==='ready'?'<button class="btn primary" data-online="confirm-install">重启并更新</button>':''}</div>`:''}</section><section class="resource-section"><label class="online-option"><input type="checkbox" id="automatic-updates" ${info?.settings.automatic?'checked':''} ${!info||onlinePending?'disabled':''}>后台检查软件更新</label><label class="online-option"><input type="checkbox" id="update-notifications" ${info?.settings.notify!==false?'checked':''} ${!info||onlinePending?'disabled':''}>发现新版本时提醒</label></section>`;
}
function renderResources(){return heading()+`<div class="resources-page">${renderRules()}<div id="online-panel">${renderOnline('rules')}</div></div>`;}
async function refreshOnline(){
 if(onlineRefreshing)return;onlineRefreshing=true;clearTimeout(onlineTimer);
 try{const next=await api('/api/online'),changed=JSON.stringify(next)!==JSON.stringify(onlineInfo),old=onlineInfo;onlineInfo=next;
 if(changed&&$('online-panel')){const f=focusKey(document.activeElement);$('online-panel').innerHTML=renderOnline(resourceTab==='rules'?'rules':'app');restoreFocus(f);}
 if(old?.rules.state==='working'&&next.rules.state==='current')await loadCatalog();
 const available=next.app.state==='available';document.querySelector('.prototype-tag').classList.toggle('update-available',available);document.querySelector('.prototype-tag').title=available?'有新版本 · 查看软件更新':'软件更新';
 maybeNotifyUpdate();
 }catch{}finally{onlineRefreshing=false;onlineTimer=setTimeout(refreshOnline,onlineInfo?.app.state==='working'||onlineInfo?.rules.state==='working'?1500:15000);} }
async function onlineAction(action){
 if(action==='notice-later'||action==='notice-download')return dismissUpdateNotice(action==='notice-download');
 if(action==='check-app'&&onlineInfo?.app.release?.version)noticedVersions.add(onlineInfo.app.release.version);
 if(action==='confirm-rules')return openDialog('应用官方规则',`<p>使用 NVIDIA 英文规则替换当前规则${catalogInfo?.count?`“${esc(catalogName(catalogInfo))}”`:''}。</p><p class="resource-note">重新解析后生效。</p>`,'<button class="btn primary" data-online="apply-rules">应用规则</button>','online');
 if(action==='confirm-install')return openDialog('更新 XidLens','<p>重启并安装更新，保留报告和规则。</p>','<button class="btn primary" data-online="install">重启并更新</button>','online');
 if(action==='install'){
  if(busy||catalogBusy){toast('请等待当前操作结束');return;}
  if(!window.pywebview?.api?.install_update){toast('请在 Windows EXE 中安装更新');return;}
  onlinePending=true;const button=document.querySelector('[data-online="install"]');button.disabled=true;
  try{await window.pywebview.api.install_update();}catch(e){toast(e.message||'更新未完成，请重试');button.disabled=false;}finally{onlinePending=false;}return;
 }
 if(onlinePending)return;onlinePending=true;const setting=$('automatic-updates');if(setting)setting.disabled=true;
 if(action==='apply-rules'){catalogBusy=true;catalogRequest++;}
 try{await api('/api/online/'+action,{method:'POST'});if(action==='apply-rules'){catalogBusy=false;closeDialog();}await refreshOnline();}
 catch(e){toast(e.message);}finally{onlinePending=false;catalogBusy=false;if($('online-panel'))$('online-panel').innerHTML=renderOnline(resourceTab==='rules'?'rules':'app');}
}
document.addEventListener('click',event=>{const action=event.target.closest('[data-online]'),guide=event.target.closest('[data-guide-code]');if(guide){knowledgeCode=guide.dataset.guideCode;window.XidKnowledge?.navigate('xid',knowledgeCode);goto('xid');}if(action)onlineAction(action.dataset.online);if(event.target.closest('.prototype-tag'))goto('updates');});
document.addEventListener('change',event=>{if(event.target.id==='automatic-updates')onlineAction(event.target.checked?'enable':'disable');if(event.target.id==='update-notifications')onlineAction(event.target.checked?'notify-enable':'notify-disable');});
onlineTimer=setTimeout(refreshOnline,1500);

let activeImport=null;
let deletingReports=false;
const reportState={query:'',filter:'all',sort:'newest',selected:new Set(),pending:[],recovery:{},unreadable:0};
function reportMatches(d){const q=reportState.query.trim().toLowerCase();return !q||[d.source,d.server.sn,d.server.model,...d.identities.flatMap(g=>[g.sn,g.uuid])].some(v=>String(v||'').toLowerCase().includes(q));}
function reportTime(text){
 const raw=String(text||'').trim();let date='',clock='',zone='',m=raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(.*)$/);
 if(m){date=m[1];clock=m[2];zone=m[3].trim();}
 else{m=raw.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?\s*(UTC|GMT|[+-]\d{4})?\s+(\d{4})$/i);if(m){const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase())+1;let hour=Number(m[3]);if(m[6])hour=hour%12+(m[6].toUpperCase()==='PM'?12:0);date=`${m[8]}-${String(month).padStart(2,'0')}-${m[2].padStart(2,'0')}`;clock=`${String(hour).padStart(2,'0')}:${m[4]}:${m[5]}`;zone=m[7]||'';}}
 const suffix=/^(UTC|GMT|Z)$/i.test(zone)?'Z':/^[+-]\d{2}:?\d{2}$/.test(zone)?zone:'';
 return {raw,date,clock,zone,stamp:date?Date.parse(`${date}T${clock}${suffix}`):NaN};
}
function reportDate(d){const t=reportTime(d.server.time);return t.date?`<span class="report-date" title="${esc(t.raw)}">${esc(t.date)}</span><span class="report-clock">${esc(t.clock)}${t.zone?' '+esc(t.zone):''}</span>`:`<span class="report-date">${esc(t.raw||'—')}</span>`;}
function reportOrder(a,b,descending=false){const av=reportTime(a.server.time).stamp,bv=reportTime(b.server.time).stamp,ak=Number.isFinite(av),bk=Number.isFinite(bv);if(ak!==bk)return ak?-1:1;const order=ak?av-bv:(a.modified||0)-(b.modified||0);return descending?-order:order;}

function reportRows(){return cases.filter(d=>reportMatches(d)&&(reportState.filter==='all'||(reportState.filter==='errors'?d.events>0:!d.complete))).sort((a,b)=>reportState.sort==='errors'?b.events-a.events:reportState.sort==='oldest'?reportOrder(a,b):reportOrder(a,b,true));}
function matchIdentity(d){const q=reportState.query.trim().toLowerCase();if(!q)return '';const g=d.identities.find(g=>[g.sn,g.uuid].some(v=>v&&v.toLowerCase().includes(q)));if(!g)return '';return `${g.label} · ${String(g.sn||'').toLowerCase().includes(q)&&g.sn?'SN '+g.sn:g.uuid}`;}
function recoveryNotice(){const r=reportState.recovery,items=[];if(r.recovered)items.push('已恢复中断前的报告');else if(r.interrupted)items.push('上次导入未完成，可重新导入');if(r.pending)items.push('报告恢复未完成，请检查目录权限后重启');if(reportState.unreadable)items.push(`${reportState.unreadable} 份报告无法读取，文件已保留`);return items.length?`<p class="resource-note recovery-notice" role="status">${items.map(esc).join(' · ')}</p>`:'';}
function renderReports(){return heading()+recoveryNotice()+`<div class="report-toolbar"><label class="search report-search">${icon('search')}<input id="report-search" type="search" placeholder="文件名、服务器 SN、GPU SN / UUID" aria-label="搜索报告" value="${esc(reportState.query)}"><button class="btn quiet icon-btn clear-search" data-report-action="clear" aria-label="清除搜索" ${reportState.query?'':'hidden'}>${icon('close')}</button></label><select class="select" id="report-filter" aria-label="筛选报告"><option value="all">全部报告</option><option value="errors">含错误记录</option><option value="partial">读取不完整</option></select><select class="select report-sort" id="report-sort" aria-label="报告排序"><option value="newest">采集时间：从新到旧</option><option value="oldest">采集时间：从旧到新</option><option value="errors">错误条数：从多到少</option></select></div><div id="report-results" class="report-list">${reportResults()}</div>`;}
function reportResults(){const rows=reportRows(),selected=reportState.selected.size;return `<div class="report-selection"><span>${selected?`<strong>已选 ${selected} 份</strong> <button class="link-btn" data-report-action="deselect">取消选择</button>`:`${reportState.query||reportState.filter!=='all'?'找到 ':'共 '}${rows.length} 份报告`}</span><div class="actions"><button class="btn" data-report-action="reparse" ${selected?'':'disabled'}>${icon('refresh','small-icon')}重新解析</button><button class="btn" data-report-action="compare" ${selected===2?'':'disabled'} title="选择两份报告进行对比">${icon('compare','small-icon')}对比报告</button><button class="btn ${selected?'danger':''}" data-report-action="delete" ${selected?'':'disabled'}>${icon('trash','small-icon')}删除${selected?'（'+selected+'）':''}</button></div></div>${rows.length?`<div class="table-frame"><div class="table-scroll"><table class="report-table"><thead><tr><th><input type="checkbox" id="report-select-all" aria-label="全选当前列表"></th><th>报告</th><th>服务器</th><th>采集时间</th><th>GPU</th><th>错误条数</th><th>操作</th></tr></thead><tbody>${rows.map(d=>`<tr class="report-row ${reportState.selected.has(d.id)?'is-selected':''}" data-report-row="${d.id}"><td><input type="checkbox" data-report-check="${d.id}" aria-label="选择 ${esc(d.source)} ${esc(d.server.sn)} ${esc(d.server.time)}" ${reportState.selected.has(d.id)?'checked':''}></td><td><div class="report-name">${icon('file')}<div><button class="cell-btn report-open" data-report-open="${d.id}" title="${esc(d.source)}">${esc(d.source)}</button><div class="report-sub">${d.bytes==null?'':importSize(d.bytes)}${d.id===loadedCase?'<span class="badge">当前</span>':''}${!d.complete?'<span class="badge amber">读取不完整</span>':''}</div>${matchIdentity(d)?`<span class="report-match">${esc(matchIdentity(d))}</span>`:''}</div></div></td><td><span class="report-server">${esc(d.server.model||'—')}</span><span class="mono muted">${esc(d.server.sn||'—')}</span></td><td>${reportDate(d)}</td><td>${d.gpus}</td><td><span class="${d.events?'report-errors':'muted'}">${d.events}</span></td><td><button class="btn quiet icon-btn" data-report-delete="${d.id}" aria-label="删除 ${esc(d.source)} ${esc(d.server.sn)}" title="删除报告">${icon('trash','small-icon')}</button></td></tr>`).join('')}</tbody></table></div></div>`:`<div class="report-empty">${icon(cases.length?'search':'file')}<h2>${cases.length?'没有匹配的报告':'暂无报告'}</h2>${cases.length?'<button class="btn" data-report-action="clear-filters">清除筛选</button>':''}</div>`}`;}
paths.trash='M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7';
function syncReportControls(){const managing=state.page==='reports';$('manage-reports').setAttribute('aria-pressed',String(managing));if(!managing)return;$('report-filter').value=reportState.filter;$('report-sort').value=reportState.sort;const all=$('report-select-all'),rows=reportRows();if(all){const count=rows.filter(d=>reportState.selected.has(d.id)).length;all.checked=count===rows.length;all.indeterminate=count>0&&count<rows.length;}status('报告管理');}
function updateReports(){const scroll=$('report-results')?.querySelector('.table-scroll')?.scrollTop||0;$('report-results').innerHTML=reportResults();syncReportControls();const el=$('report-results').querySelector('.table-scroll');if(el)el.scrollTop=scroll;}
function askDelete(ids){reportState.pending=ids;const list=cases.filter(d=>ids.includes(d.id));openDialog(`删除 ${list.length} 份报告？`,`<p>删除报告及不再使用的日志副本。原始文件不受影响。</p><div class="delete-list">${list.map(d=>`<div><strong>${esc(d.source)}</strong><span>${esc(d.server.sn||'—')} · ${esc(d.server.time||'—')}</span></div>`).join('')}</div>`,`<button class="btn" data-report-action="cancel-delete">取消</button><button class="btn danger solid" data-report-action="confirm-delete">删除报告</button>`,'delete-reports');$('dialog-close').hidden=true;$('dialog-foot').querySelector('button').focus();}
document.addEventListener('input',e=>{if(e.target.id==='report-search'){reportState.query=e.target.value;reportState.selected.clear();document.querySelector('[data-report-action="clear"]').hidden=!reportState.query;updateReports();}});
document.addEventListener('change',e=>{if(e.target.dataset.reportCheck){const id=e.target.dataset.reportCheck;e.target.checked?reportState.selected.add(id):reportState.selected.delete(id);updateReports();document.querySelector(`[data-report-check="${id}"]`)?.focus({preventScroll:true});}if(e.target.id==='report-select-all'){for(const d of reportRows())e.target.checked?reportState.selected.add(d.id):reportState.selected.delete(d.id);updateReports();$('report-select-all')?.focus();}if(e.target.id==='report-filter'){reportState.filter=e.target.value;reportState.selected.clear();updateReports();}if(e.target.id==='report-sort'){reportState.sort=e.target.value;updateReports();}});
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;try{
 if(b.dataset.reparseFile!==undefined){reparsePick=Number(b.dataset.reparseFile);$('reparse-file-input').click();return;}
 if(b.dataset.reportOpen){if(await loadCase(b.dataset.reportOpen))goto('devices');return;}
 if(b.dataset.reportDelete){askDelete([b.dataset.reportDelete]);return;}
 switch(b.dataset.reportAction){
 case'clear':reportState.query='';reportState.selected.clear();$('report-search').value='';b.hidden=true;updateReports();$('report-search').focus();return;
 case'clear-filters':reportState.query='';reportState.filter='all';reportState.selected.clear();render();$('report-search').focus();return;
 case'deselect':reportState.selected.clear();updateReports();return;
 case'reparse':await reparseDialog([...reportState.selected]);return;
 case'reparse-start':await startReparse();return;
 case'delete':askDelete([...reportState.selected]);return;
 case'cancel-delete':closeDialog();$('dialog-close').hidden=false;return;
 case'confirm-delete':{if(deletingReports)return;deletingReports=true;const ids=[...reportState.pending];for(const el of $('dialog-foot').querySelectorAll('button'))el.disabled=true;b.textContent='正在删除…';let result;
 try{result=await api('/api/cases/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});}
 catch(error){let feedback=$('delete-error');if(!feedback){feedback=document.createElement('p');feedback.id='delete-error';feedback.className='import-feedback';feedback.setAttribute('role','alert');$('dialog-body').append(feedback);}feedback.textContent='删除失败，请重试';return;}
 finally{deletingReports=false;for(const el of $('dialog-foot').querySelectorAll('button'))el.disabled=false;b.textContent='删除报告';}
 const removed=new Set(result.deleted);cases=cases.filter(d=>!removed.has(d.id));removed.forEach(id=>reportState.selected.delete(id));if(removed.has(state.compareBase)){state.compareBase='';comparisonData=null;comparisonRequest++;comparisonLoading=false;}if(removed.has(loadedCase)){loadRequest++;data=blank();loadedCase='';state.drawer=false;}closeDialog();$('dialog-close').hidden=false;render();await refreshCases(loadedCase||cases.at(-1)?.id);toast(result.failed.length?`已删除 ${result.deleted.length} 份 · ${result.failed.length} 份未删除，请重试`:`已删除 ${result.deleted.length} 份报告`);$('report-search')?.focus();return;}
 case'compare':{const selected=cases.filter(d=>reportState.selected.has(d.id)).sort((a,b)=>reportOrder(a,b));if(selected.length!==2)return;if(!await loadCase(selected[1].id))return;state.compareBase=selected[0].id;goto('compare');loadComparison(selected[0].id);return;}

 }
}catch(error){toast(error.message);}});
$('dialog').addEventListener('close',()=>{$('dialog-close').hidden=false;});

let reparseRows=[],reparsePick=-1;
function importProgressMarkup(){return `<div id="import-progress" hidden><div class="import-file-row">${icon('file')}<strong id="import-file"></strong><span id="import-position"></span></div><div class="import-progress-head"><span id="import-phase" role="status"></span><span id="import-percent"></span></div><progress id="import-bar" max="100" aria-label="当前文件处理进度"></progress><p id="import-detail" class="source-meta"></p><p id="import-member" class="source-meta" hidden></p></div>`;}
async function reparseDialog(ids){
 if(busy||!ids.length)return;
 openDialog('重新解析', '<p class="muted">正在检查原日志…</p>','','reparse');
 reparseRows=cases.filter(d=>ids.includes(d.id)).map(d=>({id:d.id,source:d.source,available:false,file:null,state:'pending',message:''}));
 await Promise.all(reparseRows.map(async row=>{try{row.available=(await api('/api/reparse/source?id='+row.id)).available;}catch{row.message='原日志无法读取';}}));
 if(!$('dialog').open||$('dialog').dataset.kind!=='reparse')return;
 $('dialog-body').innerHTML='<p class="reparse-note">失败或取消时保留原报告。</p><div id="reparse-list"></div><input type="file" id="reparse-file-input" accept="' + LOG_ACCEPT + '" aria-label="重新选择原日志" hidden>'+importProgressMarkup()+'<p id="import-feedback" class="import-feedback" role="status" hidden></p>';
 updateReparse();
}
function updateReparse(){
 $('reparse-list').innerHTML=reparseRows.map((row,i)=>`<div class="reparse-row"><div><strong title="${esc(row.source)}">${esc(row.source)}</strong><span class="${row.state==='error'?'reparse-error':''}">${esc(row.state==='done'?'已更新':row.state==='running'?'正在解析':row.message||(row.file?row.file.name:row.available?'原日志可用':'请选择原日志'))}</span></div>${row.state==='done'?icon('check'):!busy?`<button class="btn" data-reparse-file="${i}">${row.file||row.available?'更换文件':'选择文件'}</button>`:''}</div>`).join('');
 if(busy)return;
 const remaining=reparseRows.filter(r=>r.state!=='done');
 $('dialog-foot').hidden=!remaining.length;
 $('dialog-foot').innerHTML=remaining.length?`<button class="btn primary" data-report-action="reparse-start" ${remaining.some(r=>!r.available&&!r.file)?'disabled':''}>重新解析${remaining.length>1?'（'+remaining.length+'）':''}</button>`:'';
}
async function startReparse(){
 if(busy)return;const pending=reparseRows.filter(r=>r.state!=='done');if(!pending.length||pending.some(r=>!r.available&&!r.file))return;
 busy=true;const op={kind:'reparse',job:'',xhr:null,cancelRequested:false};activeImport=op;
 $('dialog-close').hidden=true;$('import-progress').hidden=false;$('import-feedback').hidden=true;$('reparse-file-input').disabled=true;
 $('import-button').disabled=true;$('log-select').disabled=true;
 $('dialog-foot').innerHTML='<button class="btn" id="cancel-import" data-action="cancel-import">取消解析</button>';$('dialog-foot').hidden=false;$('cancel-import').focus();
 let completed=0,failed=0;
 try{
  for(let i=0;i<pending.length;i++){
   if(op.cancelRequested)break;
   const row=pending[i];row.state='running';row.message='';updateReparse();
   $('import-file').textContent=row.source;$('import-file').title=row.source;$('import-position').textContent=`${i+1} / ${pending.length}`;showImportProgress({phase:'queued'});
   try{
    const start=await api('/api/reparse/start?id='+row.id+(row.file?'&file=1':''),{method:'POST'});op.job=start.job;
    if(op.cancelRequested)await api('/api/job/'+op.job+'/cancel',{method:'POST'});
    else if(start.needsFile){
     if(!row.file){row.available=false;throw Error('找不到原日志，请重新选择');}
     try{await uploadImport(row.file,op);}catch(error){if(!op.cancelRequested)throw error;}
    }
    const result=await waitImport(op);op.job='';
    if(result.state==='cancelled'){row.state='pending';row.message='已取消 · 保留旧结果';break;}
    if(result.state==='error')throw Error(result.message);
    row.state='done';completed++;
   }catch(error){
    if(op.job){await api('/api/job/'+op.job+'/cancel',{method:'POST'}).catch(()=>{});op.job='';}
    row.state='error';row.message=error.message.replace(/^解析失败：[^·]+·\s*/,'');failed++;
   }
   updateReparse();
  }
  await refreshCases(loadedCase,true);
  if(state.compareBase)await loadComparison(state.compareBase);
 }catch(error){toast(error.message);}
 finally{
  for(const row of pending)if(row.state==='pending'&&!row.message)row.message='未处理';
  busy=false;activeImport=null;$('dialog-close').hidden=false;$('import-progress').hidden=true;$('reparse-file-input').disabled=false;
  $('import-feedback').hidden=false;$('import-feedback').textContent=[completed?`已更新 ${completed} 份`:'',failed?`${failed} 份未更新`:'',op.cancelRequested?'已取消':''].filter(Boolean).join(' · ')||'未更新';
  $('import-button').disabled=false;$('log-select').disabled=!cases.length;updateReparse();$('dialog-close').focus();
 }
}
document.addEventListener('change',event=>{if(event.target.id==='reparse-file-input'){const file=event.target.files[0],row=reparseRows[reparsePick];if(file&&row){const error=validateLogFile(file);if(error){toast(error);event.target.value='';return;}row.file=file;row.message='';row.state='pending';updateReparse();}event.target.value='';}});

const LOG_ACCEPT='.log,.txt,.out,.xml,.csv,.json,.gz,.zip,.tar,.tgz';
function validateLogFile(file){
 if(!/(?:\.(?:log|txt|out|xml|csv|json|gz|zip|tar|tgz)|^(?:syslog|messages|dmesg))$/i.test(file.name))return file.name+'：不支持此文件类型，请选择日志文本或 GZ、ZIP、TAR 压缩包';
 if(!file.size)return file.name+'：文件为空';
 if(file.size>512*1024*1024)return file.name+'：文件超过 512 MB';
 return '';
}
function importDialog(){openDialog('导入日志',`<div id="import-picker"><button type="button" class="dropzone" id="dropzone" data-action="choose-files">${icon('import')}<strong>选择日志文件</strong><span>或将文件拖到这里</span></button><input type="file" id="file-input" accept="${LOG_ACCEPT}" multiple aria-label="选择日志文件" hidden><p class="import-formats">LOG / TXT / OUT / XML / CSV / JSON · GZ / ZIP / TAR / TGZ<br>每个文件不超过 512 MB；也可拖入 syslog、messages、dmesg</p></div>${importProgressMarkup()}<p class="import-feedback" id="import-feedback" role="status" hidden></p>`,'','import');}
const importSize=bytes=>bytes<1024*1024?`${(bytes/1024).toFixed(0)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
function showImportProgress(p){
 const op=activeImport;if(!op)return;
 const phase=op.cancelRequested?'正在取消…':({copying:op.kind==='reparse'?'读取原日志':'保存原日志',uploading:'读取文件',queued:'等待解析',parsing:'解析日志',organizing:'整理记录',saving:'保存报告'}[p.phase]||'处理中');
 $('import-phase').textContent=phase;
 const measurable=['uploading','copying','parsing'].includes(p.phase)&&p.totalBytes>0;
 if(measurable){const percent=Math.min(100,Math.floor((p.bytes||0)/p.totalBytes*100));$('import-bar').value=percent;$('import-percent').textContent=percent+'%';}
 else{$('import-bar').removeAttribute('value');$('import-percent').textContent='';}
 $('import-detail').textContent=p.phase==='parsing'?`已解析 ${(p.lines||0).toLocaleString()} 行 · ${importSize(p.bytes||0)}`:['uploading','copying'].includes(p.phase)?`${importSize(p.bytes||0)} / ${importSize(p.totalBytes||0)}`:'';
 const member=p.source?.includes('!')?p.source.split('!').slice(1).join('!'):'';$('import-member').textContent=member;$('import-member').title=member;$('import-member').hidden=!member;
}
async function cancelImport(){
 const op=activeImport;if(!op||op.cancelRequested)return;
 op.cancelRequested=true;const button=$('cancel-import');button.disabled=true;button.textContent='正在取消…';$('import-phase').textContent='正在取消…';
 if(op.job){
  try{await api('/api/job/'+op.job+'/cancel',{method:'POST'});op.xhr?.abort();}
  catch(e){op.cancelRequested=false;button.disabled=false;button.textContent=op.kind==='reparse'?'取消解析':'取消导入';$('import-feedback').hidden=false;$('import-feedback').textContent='取消失败，请重试';}
 }
}
function uploadImport(file,op){return new Promise((resolve,reject)=>{
 const xhr=new XMLHttpRequest();op.xhr=xhr;
 xhr.open('POST','/api/import?name='+encodeURIComponent(file.name)+'&job='+op.job);xhr.setRequestHeader('X-Local-Token',token);xhr.setRequestHeader('Content-Type','application/octet-stream');
 xhr.upload.onprogress=e=>{if(!op.cancelRequested)showImportProgress({phase:'uploading',bytes:e.loaded,totalBytes:file.size});};
 xhr.onload=()=>{op.xhr=null;let result;try{result=JSON.parse(xhr.responseText);}catch{return reject(Error('文件读取失败'));}xhr.status>=200&&xhr.status<300?resolve(result):reject(Error(result.error||'文件读取失败'));};
 xhr.onerror=()=>{op.xhr=null;reject(Error('文件读取失败'));};xhr.onabort=()=>{op.xhr=null;reject(Error('已取消'));};
 xhr.send(file);
});}
async function waitImport(op){
 while(true){const result=await api('/api/job/'+op.job);if(['done','error','cancelled'].includes(result.state))return result;showImportProgress(result);await new Promise(r=>setTimeout(r,250));}
}
async function importFiles(files){
 if(!files.length||busy)return;busy=true;
 const op={job:'',xhr:null,cancelRequested:false};activeImport=op;
 let last=loadedCase,completed=0,stopped=false;const failures=[],feedback=$('import-feedback');feedback.hidden=true;feedback.setAttribute('role','status');
 $('import-picker').hidden=true;$('import-progress').hidden=false;$('dialog-close').hidden=true;$('file-input').disabled=true;$('log-select').disabled=true;$('import-button').disabled=true;
 $('dialog-foot').innerHTML='<button class="btn" id="cancel-import" data-action="cancel-import">取消导入</button>';$('dialog-foot').hidden=false;$('cancel-import').focus();
 try{
  for(let i=0;i<files.length;i++){
   if(op.cancelRequested){stopped=true;break;}
   const f=files[i];$('import-file').textContent=f.name;$('import-file').title=f.name;$('import-position').textContent=`${i+1} / ${files.length}`;showImportProgress({phase:'uploading',bytes:0,totalBytes:f.size});
   const invalid=validateLogFile(f);if(invalid){failures.push(invalid);continue;}
   try{
   op.job=(await api('/api/import/start',{method:'POST'})).job;
   if(op.cancelRequested)await api('/api/job/'+op.job+'/cancel',{method:'POST'});
   else{try{await uploadImport(f,op);}catch(e){if(!op.cancelRequested)throw e;}}
   const result=await waitImport(op);op.job='';
   if(result.state==='cancelled'){stopped=true;break;}
   if(result.state==='error')throw Error(result.message);
   last=result.ids.at(-1);completed++;
   }catch(e){
    if(op.job)await api('/api/job/'+op.job+'/cancel',{method:'POST'}).catch(()=>{});
    if(op.cancelRequested){stopped=true;break;}
    failures.push(`${f.name}：${e.message}`);
   }finally{op.job='';}
  }
  if(completed)await refreshCases(last);
  if(stopped||op.cancelRequested||failures.length){feedback.hidden=false;feedback.textContent=[`${stopped||op.cancelRequested?'已取消 · ':''}已导入 ${completed} 份文件`,...failures].join('\n');if(failures.length)feedback.setAttribute('role','alert');}
  else{busy=false;closeDialog();toast(`已导入 ${completed} 份文件`);}
 }catch(e){
  if(op.job)await api('/api/job/'+op.job+'/cancel',{method:'POST'}).catch(()=>{});
  feedback.hidden=false;feedback.textContent=completed?`已导入 ${completed} 份文件 · ${e.message}`:e.message;feedback.setAttribute('role','alert');await refreshCases(last).catch(()=>{});
 }finally{
  busy=false;activeImport=null;$('dialog-close').hidden=false;$('import-picker').hidden=false;$('import-progress').hidden=true;$('dialog-foot').hidden=true;$('dialog-foot').innerHTML='';$('file-input').disabled=false;$('file-input').value='';$('log-select').disabled=!cases.length;$('import-button').disabled=false;$('export-button').disabled=!data.source;
  const ruleImport=document.querySelector('[data-action="choose-catalog"]');if(ruleImport)ruleImport.disabled=catalogBusy;
  if($('dialog').open)$('dropzone').focus();
 }
}

function closeMenu(restore=false){const wasOpen=!$('export-menu').hidden;$('export-menu').hidden=true;if(restore&&wasOpen)$('export-button').focus();$('export-button').setAttribute('aria-expanded','false');}
function showExport(){const menu=$('export-menu');if(!menu.hidden){closeMenu();return;}menu.innerHTML=[['tsv','设备清单','TSV'],['txt','日志摘要','TXT'],['json','完整记录','JSON']].map(([format,label,type])=>`<button role="menuitem" data-export="${format}">${icon('file','small-icon')}${label}<small>${type}</small></button>`).join('');menu.hidden=false;$('export-button').setAttribute('aria-expanded','true');const r=$('export-button').getBoundingClientRect();menu.style.top=`${r.bottom+7}px`;menu.style.left=`${Math.max(12,Math.min(r.right-230,innerWidth-242))}px`;menu.querySelector('button').focus();}
document.addEventListener('click',async event=>{XidDiagnostics.dismissPicker(event.target);const b=event.target.closest('button');if(!event.target.closest('#export-menu')&&!event.target.closest('#export-button'))closeMenu();try{const diag=event.target.closest('[data-diag]');if(diag&&XidDiagnostics.click(diag))return;if(b){
if(b.dataset.compareField!==undefined){compareFieldSource(b.dataset.compareField);return;}if(b.dataset.page){goto(b.dataset.page);return;}if(b.dataset.copy!==undefined){await copy(b.dataset.copy);return;}
if(b.dataset.openGpu!==undefined){openGpu(b.dataset.openGpu);return;}if(b.dataset.gpuPage!==undefined){goto('devices',b.dataset.gpuPage);return;}if(b.dataset.gpuErrors!==undefined){goto('errors',b.dataset.gpuErrors);return;}if(b.dataset.gpuTopology!==undefined){goto('topology',b.dataset.gpuTopology);return;}
if(b.dataset.bridgeErrors){state.page='errors';state.filter='pci:'+b.dataset.bridgeErrors;state.code='all';state.groupFilter='';state.errorPage=0;state.event='';render();return;}if(b.dataset.errorView){state.errorView=b.dataset.errorView;state.groupFilter='';state.errorPage=0;render();return;}if(b.dataset.selectGroup){selectGroup(b.dataset.selectGroup);return;}if(b.dataset.drillGroup){state.groupFilter=b.dataset.drillGroup;state.errorView='records';state.errorPage=0;state.event='';render();return;}if(b.dataset.selectComparison!==undefined){selectComparison(b.dataset.selectComparison);return;}if(b.dataset.selectEvent){selectEvent(b.dataset.selectEvent);return;}if(b.dataset.view){state.topology=b.dataset.view;render();return;}if(b.dataset.topologyGpu!==undefined){state.gpu=Number(b.dataset.topologyGpu);state.node='';render(true);return;}if(b.dataset.port){state.gpu=Number(b.dataset.portGpu);state.node=b.dataset.port;render(true);return;}
if(b.dataset.export){const type=b.dataset.export;closeMenu(true);if(type==='tsv')await download('GPU设备清单.tsv',tsv(data.gpus),'text/tab-separated-values;charset=utf-8');if(type==='txt')await download('GPU日志摘要.txt',summary(),'text/plain;charset=utf-8');if(type==='json')await download('GPU日志证据.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');return;}
const g=currentGpu();switch(b.dataset.action){case'choose-catalog':$('catalog-input').click();return;case'reload-catalog':await loadCatalog();return;case'view-catalog':await viewCatalog();return;case'more-rules':ruleLimit+=50;ruleResults();return;case'reset-catalog':openDialog('恢复内置规则？','<p>恢复内置中文规则，新导入或重新解析时生效。</p>','<button class="btn primary" id="confirm-reset-catalog" data-action="confirm-reset-catalog">恢复内置规则</button>');return;case'confirm-reset-catalog':await resetCatalog();return;case'retry-comparison':loadComparison(state.compareBase);return;case'import':importDialog();return;case'cancel-import':await cancelImport();return;case'choose-files':$('file-input').click();return;case'export':showExport();return;case'close-dialog':closeDialog();return;case'close-drawer':closeDrawer();return;case'copy-excel':await copy(tsv(visibleGpus()));return;case'copy-server':await copy([['服务器型号',data.server.model],['服务器 SN',data.server.sn],['主机名',data.server.host],['系统',data.server.os],['驱动',data.server.driver]].filter(([,v])=>v).map(([k,v])=>`${k}：${v}`).join('\n'));return;case'copy-summary':copyPreview('日志摘要',summary());return;case'copy-content':await copy($('copy-text').value);return;case'clear-search':state.query='';render();$('gpu-search').focus();return;case'reset-errors':Object.assign(state,{filter:'all',code:'all',event:'',errorPage:0,groupFilter:'',group:''});render();return;case'prev-errors':case'next-errors':state.errorPage+=b.dataset.action==='next-errors'?1:-1;state.event='';render();return;case'health-source':if(g){const fields={};for(const c of g.healthCounters||[])(fields[c.path]??=[]).push({value:c.value,origin:'nvidia-smi',evidence:c.evidence});sourceView('健康计数 · 来源',fields);}return;case'scoped-source':if(g)sourceView('MIG 采集值',g.scopedMetrics);return;case'gpu-source':if(g)sourceView(g.label+' · 字段来源',{...g.fields,...g.pciFields,...g.metrics});return;case'path-source':if(state.node)sourceView('PCIe 桥 · 字段来源',data.nodes[state.node]?.fields);else if(g)sourceView(g.label+' · PCIe 字段',g.pciFields);return;case'topology-source':openDialog('原始拓扑字段',`<pre>${esc(data.topologyRaw||'日志未提供')}</pre>`);return;case'server-source':openDialog('服务器信息',`<div class="server-info-grid">${keyline('型号',data.server.model)}${keyline('服务器 SN',data.server.sn,true)}${keyline('主机名',data.server.host)}${keyline('系统',data.server.os)}${keyline('服务器 UUID',data.server.uuid,true)}${keyline('驱动',data.server.driver)}${keyline('采集时间',data.server.time)}</div><button class="btn" data-action="server-field-source">${icon('file')}查看字段来源</button>`);return;case'server-field-source':sourceView('服务器字段来源',data.server.fields);return;case'theme':{const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';b.innerHTML=icon(dark?'sun':'moon');b.setAttribute('aria-label',dark?'切换浅色外观':'切换深色外观');return;}}
}
if(event.target.closest('#file-description')&&(data.warnings.length||data.complete===false)){openDialog('读取提示',`<ul class="warning-list">${data.warnings.map(w=>`<li>${esc(w)}</li>`).join('')||'<li>读取未完成。</li>'}</ul>`);return;}
const groupRow=event.target.closest('[data-group]');if(groupRow){selectGroup(groupRow.dataset.group);return;}const comparisonRow=event.target.closest('[data-compare-row]');if(comparisonRow){selectComparison(comparisonRow.dataset.compareRow);return;}const row=event.target.closest('[data-gpu]');if(row){openGpu(row.dataset.gpu);return;}const erow=event.target.closest('[data-event]');if(erow){selectEvent(erow.dataset.event);}
}catch(e){toast(e.message);}});
document.addEventListener('focusin',event=>{XidDiagnostics.dismissPicker(event.target);});
document.addEventListener('keydown',event=>{XidDiagnostics.keydown(event);});
document.addEventListener('input',event=>{if(XidDiagnostics.input(event.target))return;if(event.target.id!=='gpu-search')return;state.query=event.target.value;const list=visibleGpus();if(list.length&&!list.some(g=>g.id===state.gpu))state.gpu=list[0].id;$('gpu-rows').innerHTML=gpuRows();$('gpu-count').textContent=`${list.length} / ${data.gpus.length}`;$('gpu-foot').textContent=`${list.length} 块 GPU`;$('copy-excel').disabled=!list.length;document.querySelector('.clear-search').hidden=!state.query;$('device-inspector').innerHTML=list.length?deviceInspector():empty('没有匹配的 GPU');$('device-inspector').scrollTop=0;document.querySelector('.table-scroll').scrollTop=0;});
document.addEventListener('change',event=>{const el=event.target;if(XidDiagnostics.change(el))return;if(el.id==='compare-base'){loadComparison(el.value);return;}if(el.id==='compare-changed'){state.compareChanged=el.checked;render();return;}if(el.id==='file-input')importFiles(Array.from(el.files));if(el.id==='log-select')loadCase(el.value).catch(e=>toast(e.message));if(el.id==='error-filter'||el.id==='code-filter'){state[el.id==='error-filter'?'filter':'code']=el.value;state.errorPage=0;state.event='';state.groupFilter='';state.group='';render();}if(el.id==='only-errors'){state.onlyErrors=el.checked;state.node='';render();}});
document.addEventListener('dragover',event=>{if(event.target.closest('#dropzone')){event.preventDefault();event.dataTransfer.dropEffect=busy?'none':'copy';if(!busy)$('dropzone').classList.add('is-dragging');}});
document.addEventListener('dragleave',event=>{if(event.target.closest('#dropzone')&&!$('dropzone').contains(event.relatedTarget))$('dropzone').classList.remove('is-dragging');});
document.addEventListener('drop',event=>{if(event.target.closest('#dropzone')){event.preventDefault();importFiles(Array.from(event.dataTransfer.files));}});
document.addEventListener('keydown',event=>{if(!$('export-menu').hidden){const buttons=Array.from($('export-menu').querySelectorAll('button'));if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const i=buttons.indexOf(document.activeElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();return;}if(event.key==='Escape'){event.preventDefault();closeMenu(true);return;}if(event.key==='Tab')closeMenu(true);}const featureButton=event.target.closest('[data-select-group],[data-select-comparison]');if(featureButton&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const attr=featureButton.hasAttribute('data-select-group')?'data-select-group':'data-select-comparison',buttons=Array.from(document.querySelectorAll('['+attr+']')),i=buttons.indexOf(featureButton),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,i+(event.key==='ArrowDown'?1:-1))),button=buttons[next];if(attr==='data-select-group')selectGroup(button.getAttribute(attr));else selectComparison(button.getAttribute(attr));button.focus({preventScroll:true});button.closest('tr').scrollIntoView({block:'nearest'});return;}const selectedButton=event.target.closest('[data-select-event]');if(selectedButton&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=Array.from(document.querySelectorAll('[data-select-event]')),i=buttons.indexOf(selectedButton),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,i+(event.key==='ArrowDown'?1:-1)));const button=buttons[next];selectEvent(button.dataset.selectEvent);button.focus({preventScroll:true});button.closest('tr').scrollIntoView({block:'nearest'});return;}if(event.key==='Escape'){closeMenu();if($('dialog').open){event.preventDefault();closeDialog();}else if(state.drawer){event.preventDefault();closeDrawer();}}const modal=$('dialog').open?$('dialog'):$('drawer').open?$('drawer'):null;if(event.key==='Tab'&&modal){const els=Array.from(modal.querySelectorAll('button,input,textarea,select,a[href],summary')).filter(e=>!e.disabled&&e.getClientRects().length),first=els[0],last=els.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
$('dialog').addEventListener('cancel',event=>{event.preventDefault();closeDialog();});$('drawer').addEventListener('cancel',event=>{event.preventDefault();closeDrawer();});window.addEventListener('resize',()=>closeMenu(true));
$('file-icon').innerHTML=icon('file');$('import-button').innerHTML=icon('import','small-icon')+'<span class="import-label">导入日志</span>';$('import-button').setAttribute('aria-label','导入日志');$('export-button').innerHTML=icon('export','small-icon')+'<span class="export-label">导出</span>';$('export-button').setAttribute('aria-label','导出');$('theme-button').innerHTML=icon('moon');$('dialog-close').innerHTML=icon('close');document.querySelector('.prototype-tag').innerHTML=icon('refresh','small-icon')+'<span class="update-label">软件更新</span>';$('manual').innerHTML=icon('book','small-icon')+'<span class="manual-text">解析规则</span>';render();refreshCases().catch(e=>toast(e.message));
})();
