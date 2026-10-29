/* DCGM results retain their local entity identifiers and original JSON evidence. */
((root)=>{
 'use strict';
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const labels={pass:'通过',fail:'失败',warn:'警告',skip:'已跳过',not_run:'未运行',not_recorded:'未记录结果',unknown:'未知结果',error:'运行错误'};
 const PAGE_SIZE=100,RAW_LIMIT=65536;
 const defaults=(identity='',revision='')=>({identity,revision,status:'all',entity:'all',run:'all',query:'',page:0,selected:'',raw:false});
 const state=defaults(),views=new Map();
 let context={},active=null,lastReport=null,cache=null;
 const list=value=>Array.isArray(value)?value.filter(row=>row&&typeof row==='object'&&!Array.isArray(row)):[];
 const text=(value,limit=2000)=>value==null?'':String(value).slice(0,limit);
 const identityOf=report=>'case:'+text(report?.id||report?.source||'');
 const testKey=row=>JSON.stringify([row.run,row.category,row.test]);
 function json(value,limit=RAW_LIMIT){
  let raw;try{raw=typeof value==='string'?value:JSON.stringify(value,null,2)??'';}catch(_){return {text:'无法显示此原始值，请查看来源。',truncated:false};}
  return {text:raw.slice(0,limit),truncated:raw.length>limit};
 }
 function entityLabel(entity){
  if(!entity||typeof entity!=='object'||!Object.keys(entity).length)return '未归属设备';
  if(entity.gpu_id!=null)return 'GPU '+text(entity.gpu_id);
  if(entity.gpu_ids!=null)return 'GPU '+text(Array.isArray(entity.gpu_ids)?entity.gpu_ids.join(', '):entity.gpu_ids);
  const group=text(entity.entity_group)||(entity.entity_group_id!=null?'实体组 '+text(entity.entity_group_id):'实体');
  return entity.entity_id!=null?group+' '+text(entity.entity_id):group+'（编号未记录）';
 }
 function rawAt(document,pointer,fallback){
  if(typeof pointer!=='string'||(pointer&&!pointer.startsWith('/')))return fallback;
  let value=document;
  for(const part of pointer?pointer.slice(1).split('/'):[]){const key=part.replace(/~1/g,'/').replace(/~0/g,'~');if(value==null||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,key))return fallback;value=value[key];}
  return value===undefined?fallback:value;
 }
 function model(report){
  const bundle=report?.structured||{},dcgm=bundle.dcgm||{},runs=list(dcgm.runs),results=list(dcgm.results),summaries=list(dcgm.summaries);
  const recognized=bundle.format==='dcgm-json',keys=new Set(results.map(testKey)),summaryByTest=new Map();
  for(const row of summaries){const key=testKey(row);if(!summaryByTest.has(key))summaryByTest.set(key,[]);summaryByTest.get(key).push(row);}
  const rows=recognized?[...results,...summaries.filter(row=>!keys.has(testKey(row)))].map((row,index)=>{
   const entity=row.entity&&typeof row.entity==='object'?row.entity:{},summary=row.resultKind==='summary';
   const name=summary?'测试汇总':entityLabel(entity),entityKey=summary?'summary':json(entity,8192).text;
   return {...row,key:'result:'+index,status:labels[row.status]&&row.status!=='error'?row.status:'unknown',entity,entityKey,entityLabel:name,
    source:row.evidence?.source||bundle.source||report.source||'',reportId:report.id||'',summaries:summary?[]:summaryByTest.get(testKey(row))||[]};
  }):[];
  if(recognized)for(const [index,run] of runs.entries())if(run.runtimeError){
   const evidence=run.runtimeEvidence||run.evidence||{};
   rows.push({key:'runtime:'+index,run:run.run,test:'诊断运行',category:'',status:'error',runtimeError:run.runtimeError,raw:rawAt(bundle.rawDocument,run.rawPointer??run.evidence?.jsonPointer,run),
    entity:{},entityKey:'runtime',entityLabel:'运行级别',evidence,source:evidence.source||bundle.source||report.source||'',reportId:report.id||'',summaries:[]});
  }
  const counts=Object.fromEntries(Object.keys(labels).map(key=>[key,rows.filter(row=>row.status===key).length]));
  return {recognized,rows,index:new Map(rows.map(row=>[row.key,row])),runs,counts,complete:bundle.complete!==false,
   entities:[...new Map(rows.map(row=>[row.entityKey,row.entityLabel])).entries()],
   warnings:[...new Set((Array.isArray(bundle.warnings)?bundle.warnings:[]).map(value=>text(value,8000)))],parserVersion:text(bundle.parserVersion),
   source:bundle.source||report?.source||'',resultCount:rows.filter(row=>row.status!=='error').length};
 }
 function remember(){if(!state.identity)return;views.delete(state.identity);views.set(state.identity,{...state});while(views.size>32)views.delete(views.keys().next().value);}
 function capture(identity=state.identity){const saved=identity===state.identity?state:views.get(identity);return saved?{...saved}:null;}
 function restore(saved,identity=saved?.identity){
  if(!saved||typeof identity!=='string'||saved.identity!==identity)return false;
  const next=defaults(identity,text(saved.revision));
  next.status=labels[saved.status]?saved.status:'all';
  for(const key of ['entity','run','query','selected'])if(typeof saved[key]==='string')next[key]=saved[key].slice(0,8192);
  if(Number.isSafeInteger(saved.page)&&saved.page>=0)next.page=saved.page;
  next.raw=saved.raw===true;views.set(identity,next);if(state.identity===identity)Object.assign(state,next);return true;
 }
 function reset(identity){if(identity){views.delete(identity);if(state.identity!==identity)return;}else views.clear();Object.assign(state,defaults());lastReport=null;cache=null;active=null;}
 function filtered(data){const query=state.query.trim().toLowerCase();return data.rows.filter(row=>(state.status==='all'||row.status===state.status)&&(state.entity==='all'||row.entityKey===state.entity)&&(state.run==='all'||String(row.run)===state.run)&&(!query||`${row.test} ${row.category} ${row.entityLabel}`.toLowerCase().includes(query)));}
 function source(row){
  const ev=row.evidence||{},line=ev.line,end=ev.endLine;
  const link=Number.isSafeInteger(line)&&line>0?`<button class="link-btn" data-structured="source" data-value="${esc(row.key)}">${esc(row.source||'原始结果')} · 第 ${line}${Number.isSafeInteger(end)&&end>line?'–'+end:''} 行 ${context.icon?.('external','small-icon')||''}</button>`:'<span class="source-meta">原始行号未记录</span>';
  return `<div class="structured-source">${link}${typeof ev.jsonPointer==='string'?`<code>${esc(ev.jsonPointer||'/')}</code>`:''}</div>`;
 }
 function messages(title,value){
  const rows=Array.isArray(value)?value:value==null||value===''?[]:[value];if(!rows.length)return '';
  return `<section class="structured-messages"><h3>${title}</h3><ul>${rows.slice(0,20).map(row=>`<li>${esc(json(typeof row==='object'&&row!==null?(row.warning??row.message??row):row,4000).text)}</li>`).join('')}</ul>${rows.length>20?'<p class="source-meta">其余内容见原始结果。</p>':''}</section>`;
 }
 function detail(row){
  if(!row)return '<p class="source-meta">没有匹配结果。</p>';
  const run=active.runs.find(item=>item.run===row.run),status=labels[row.status]+(row.status==='unknown'&&row.statusRaw!=null?' · '+json(row.statusRaw,200).text:'');
  const raw=state.raw?json(row.raw):null;
  const summary=row.summaries.length?`<details class="structured-summary"><summary>测试汇总</summary>${row.summaries.map(item=>`<p>${esc(labels[item.status]||labels.unknown)}</p>${messages('说明',item.warnings)}`).join('')}</details>`:'';
  return `<h2>${esc(row.test||'未命名测试')}</h2><p class="structured-outcome">${esc(status)}</p><dl class="structured-meta">${row.category?`<dt>类别</dt><dd>${esc(row.category)}</dd>`:''}<dt>实体</dt><dd>${esc(row.entityLabel)}</dd><dt>运行</dt><dd>${esc(row.run??'未记录')}${run?.version?' · DCGM '+esc(run.version):''}</dd></dl>${row.status==='error'?`<pre class="structured-message">${esc(json(row.runtimeError,8000).text)}</pre><p class="source-meta">诊断未完成，未生成的测试结果保持未知。</p>`:''}${messages('警告',row.warnings)}${messages('说明',row.info)}${summary}${source(row)}<button class="btn" data-structured="raw" data-value="${esc(row.key)}" aria-expanded="${state.raw}">${state.raw?'收起原始结果':'原始结果'}</button>${raw?`<pre class="structured-raw" tabindex="0" aria-label="所选结果的原始 JSON">${esc(raw.text)}</pre>${raw.truncated?'<p class="source-meta">预览已截断，完整内容见来源。</p>':''}`:''}`;
 }
 function versions(){
  return `<details class="structured-versions"><summary>版本与格式</summary><p>支持 DCGM Diagnostic 与 DCGM GPU Diagnostic 字段结构；按字段读取，版本号不保证全部字段兼容。</p><p>通过仅对应本结果中的测试与实体。实体编号仅用于本结果。</p>${active.runs.map(run=>`<div><strong>运行 ${esc(run.run)}</strong><span>DCGM ${esc(run.version||'版本未记录')}${run.driverVersion?' · 驱动 '+esc(run.driverVersion):''}</span></div>`).join('')}${active.parserVersion?`<p class="source-meta">解析器 ${esc(active.parserVersion)}</p>`:''}</details>`;
 }
 function pager(length){return length<=PAGE_SIZE?'':`<nav class="structured-pager" aria-label="DCGM 结果分页"><span>${state.page*PAGE_SIZE+1}–${Math.min((state.page+1)*PAGE_SIZE,length)} / ${length}</span><div><button class="btn" data-structured="page" data-value="${state.page-1}" ${state.page===0?'disabled':''}>上一页</button><button class="btn" data-structured="page" data-value="${state.page+1}" ${(state.page+1)*PAGE_SIZE>=length?'disabled':''}>下一页</button></div></nav>`;}
 function render(report,ctx={}){
  context=ctx;report=report||{};if(lastReport!==report){cache=model(report);lastReport=report;}active=cache;
  const identity=text(ctx.identity)||identityOf(report),revision=text(ctx.revision||report.contentSha256||report.structured?.source||report.source||'');
  if(state.identity!==identity||state.revision!==revision){remember();const saved=views.get(identity);Object.assign(state,saved?.revision===revision?saved:defaults(identity,revision));}
  const rows=filtered(active);state.page=Math.min(state.page,Math.max(0,Math.ceil(rows.length/PAGE_SIZE)-1));
  const shown=rows.slice(state.page*PAGE_SIZE,(state.page+1)*PAGE_SIZE),selected=shown.find(row=>row.key===state.selected)||shown[0];
  if(state.selected!==(selected?.key||'')){state.selected=selected?.key||'';state.raw=false;}
  const heading=ctx.embedded?'':'<header><h1 tabindex="-1">DCGM 结果</h1></header>';
  if(!active.recognized)return `<section class="structured-page" aria-label="DCGM 结果">${heading}<div class="live-empty"><h2>未发现 DCGM 结果</h2></div></section>`;
  const notes=active.warnings.filter(value=>!value.startsWith('DCGM JSON 随版本变化；'));
  const notice=notes.length?`<details class="structured-notices" ${active.complete?'':'open'}><summary>${notes.length} 项读取提示</summary><ul>${notes.map(value=>`<li>${esc(value)}</li>`).join('')}</ul></details>`:'';
  const filters=`<div class="structured-filters"><label>结果<select class="select" data-structured-change="status" aria-label="筛选 DCGM 结果"><option value="all">全部结果</option>${Object.entries(labels).filter(([key])=>active.counts[key]).map(([key,label])=>`<option value="${key}" ${state.status===key?'selected':''}>${label} · ${active.counts[key]}</option>`).join('')}</select></label><label>实体<select class="select" data-structured-change="entity" aria-label="筛选 DCGM 实体"><option value="all">全部实体</option>${active.entities.map(([key,label])=>`<option value="${esc(key)}" ${state.entity===key?'selected':''}>${esc(label)}</option>`).join('')}</select></label>${active.runs.length>1?`<label>运行<select class="select" data-structured-change="run" aria-label="筛选 DCGM 运行"><option value="all">全部运行</option>${active.runs.map(run=>`<option value="${esc(run.run)}" ${state.run===String(run.run)?'selected':''}>运行 ${esc(run.run)}</option>`).join('')}</select></label>`:''}<label class="structured-search">搜索<input class="select" type="search" data-structured-input="query" aria-label="搜索 DCGM 测试" value="${esc(state.query)}" placeholder="测试名、实体或类别"></label></div>`;
  const listing=shown.map(row=>`<button class="structured-row ${row.key===state.selected?'is-selected':''}" data-structured="select" data-value="${esc(row.key)}" aria-pressed="${row.key===state.selected}"><span><strong>${esc(row.test||'未命名测试')}</strong><small>${esc(row.category||'运行 '+row.run)}</small></span><span>${esc(labels[row.status])}</span><span>${esc(row.entityLabel)}</span></button>`).join('');
  return `<section class="structured-page" aria-label="DCGM 结果">${heading}<p class="structured-count">${active.resultCount} 项结果${active.counts.error?' · '+active.counts.error+' 项运行错误':''}${active.complete?'':' · 读取不完整'}</p>${notice}${versions()}${active.rows.length?`${filters}<div class="structured-split"><section><div class="structured-list" data-scroll-key="structured-list">${listing||'<div class="live-empty"><h2>没有匹配结果</h2></div>'}</div>${pager(rows.length)}</section><aside class="structured-detail">${detail(selected)}</aside></div>`:'<div class="live-empty"><h2>未记录可读取的测试结果</h2></div>'}</section>`;
 }
 function update(target){
  const start=target?.selectionStart,end=target?.selectionEnd,attr=target?.dataset||{};context.render?.();if(typeof document==='undefined')return;
  const selector=attr.structured?'[data-structured]':attr.structuredChange?'[data-structured-change]':'[data-structured-input]';
  const candidates=Array.from(document.querySelectorAll(selector));
  let replacement=candidates.find(el=>attr.structured?el.dataset.structured===attr.structured&&el.dataset.value===attr.value:attr.structuredChange?el.dataset.structuredChange===attr.structuredChange:el.dataset.structuredInput===attr.structuredInput);
  if(attr.structured==='page')replacement=candidates.find(el=>el.dataset.structured==='page'&&el.textContent===target.textContent&&!el.disabled)||candidates.find(el=>el.dataset.structured==='page'&&!el.disabled);
  if(replacement&&!replacement.disabled){replacement.focus({preventScroll:true});if(start!=null&&end!=null&&replacement.setSelectionRange)replacement.setSelectionRange(start,end);}
  const selected=document.querySelector?.('.structured-row.is-selected'),container=selected?.closest?.('.structured-list');
  if(container&&selected.getBoundingClientRect&&container.getBoundingClientRect){const row=selected.getBoundingClientRect(),area=container.getBoundingClientRect();if(row.top<area.top)container.scrollTop-=area.top-row.top;else if(row.bottom>area.bottom)container.scrollTop+=row.bottom-area.bottom;}
 }
 function click(target){
  const action=target?.dataset?.structured,value=target?.dataset?.value;if(!action)return false;
  if(action==='source'){const row=active?.index.get(value),line=row?.evidence?.line;if(Number.isSafeInteger(line)&&line>0)context.openSource?.(line,row.reportId);return true;}
  if(action==='select'&&active?.index.has(value)){state.selected=value;state.raw=false;}
  else if(action==='raw'&&value===state.selected)state.raw=!state.raw;
  else if(action==='page'){const page=Number(value);if(Number.isSafeInteger(page)&&page>=0)state.page=page;state.selected='';state.raw=false;}
  update(target);return true;
 }
 function change(target){const key=target?.dataset?.structuredChange;if(!['status','entity','run'].includes(key))return false;state[key]=text(target.value,8192);Object.assign(state,{page:0,selected:'',raw:false});update(target);return true;}
 function input(target){if(target?.dataset?.structuredInput!=='query')return false;state.query=text(target.value,8192);Object.assign(state,{page:0,selected:'',raw:false});update(target);return true;}
 const api={render,click,change,input,reset,capture,restore,identityOf};
 if(typeof module!=='undefined'&&module.exports)module.exports={...api,model};else root.XidStructured=api;
})(globalThis);
