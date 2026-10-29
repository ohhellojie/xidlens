/* Explicit evidence preview and opt-in model assistance. No persistent storage. */
((root) => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const blank = () => ({mode:'offline', endpoint:'http://localhost:11434/v1', model:'', note:'', selected:new Set(), edits:new Map(), fingerprint:'', scope:'', preview:null, result:null, summary:'', busy:false, error:'', status:'', generation:0});
  let state = blank(), context = {}, current = {text:'', evidence:[]}, sources = {}, controller = null;
  const fail = (text, code='invalid_input') => { const error=new Error(text); error.code=code; error.assistantSafe=true; throw error; };
  const bytes = text => new TextEncoder().encode(text).length;
  const scopeFor = ctx => JSON.stringify([ctx.caseId||ctx.reportId||'',ctx.revision||'',ctx.identity||ctx.contentSha256||'']);
  const fingerprintFor = ctx => JSON.stringify({input:ctx.input||{text:'',evidence:[]},sources:ctx.sources||{}});
  function freeze(value) {if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
  function protocolRequest(input, model, protocol) {
    if(protocol?.version!==1||typeof protocol.system!=='string'||!protocol.system||protocol.system.length>16000)fail('整理规则尚未读取，请重新打开证据辅助。');
    const parameters=protocol.parameters;
    if(!parameters||Object.keys(parameters).sort().join(',')!=='max_completion_tokens,response_format,store,stream'||parameters.stream!==false||parameters.store!==false||parameters.max_completion_tokens!==4096||JSON.stringify(parameters.response_format)!=='{"type":"json_object"}')fail('整理规则版本不兼容，请重新打开证据辅助。');
    const request={model,messages:[{role:'system',content:protocol.system},{role:'user',content:JSON.stringify(normalizeInput(input))}],response_format:{type:'json_object'},stream:false,store:false,max_completion_tokens:4096};
    if(bytes(JSON.stringify(request))>160*1024)fail('请求超过大小限制，请减少所选证据。');
    return freeze(request);
  }

  function normalizeInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!['text','evidence'].includes(key))) fail('只接受已选择证据的预览内容。');
    const text = value.text ?? '', rows = value.evidence;
    if (typeof text !== 'string' || text.length > 4000 || !Array.isArray(rows) || rows.length < 1 || rows.length > 32) fail('请选择 1 至 32 条证据，备注限 4000 字。');
    const seen = new Set();
    const evidence = rows.map(row => {
      if (!row || typeof row !== 'object' || Object.keys(row).some(key=>!['id','text','source','line'].includes(key))) fail('证据字段不符合预览格式。');
      if (typeof row.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(row.id) || seen.has(row.id)) fail('证据引用 ID 无效或重复。');
      seen.add(row.id);
      if (typeof row.text !== 'string' || !row.text.trim() || row.text.length > 16000 || typeof (row.source ?? '') !== 'string' || (row.source || '').length > 256) fail('证据文本或来源长度不符合要求。');
      if (row.line != null && (!Number.isInteger(row.line) || row.line < 1 || row.line > 2147483647)) fail('证据行号无效。');
      return {id:row.id, text:row.text, source:row.source || '', line:row.line ?? null};
    });
    const result = {text, evidence};
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text+evidence.map(row=>row.text+row.source).join(''))) fail('证据含有不支持的控制字符。');
    if (bytes(JSON.stringify(result)) > 128*1024) fail('所选证据超过 128 KiB，请减少片段。');
    return result;
  }

  function sourceMap(value, input, binding) {
    if(value==null)return {};
    if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==input.evidence.length)fail('原文引用不完整，请重新选择书签。');
    const clean={};
    for(const row of input.evidence){
      const item=value[row.id];
      if(!item||Object.keys(item).sort().join(',')!=='end,identity,reportId,revision,start'||item.reportId!==binding.caseId||item.revision!==binding.revision||item.identity!==binding.identity||!Number.isInteger(item.start)||!Number.isInteger(item.end)||item.start<1||item.end<item.start||item.end-item.start>=200||item.end>2147483647)fail('原文引用已变更，请重新选择书签。');
      clean[row.id]={reportId:item.reportId,revision:item.revision,identity:item.identity,start:item.start,end:item.end};
    }
    return freeze(clean);
  }
  function prepareEvidence(packageValue, binding) {
    if(!binding||!binding.caseId||typeof binding.caseId!=='string'||!binding.revision||typeof binding.revision!=='string'||!binding.identity||typeof binding.identity!=='string')fail('报告来源不完整，请重新选择书签。');
    if(packageValue?.format!=='xidlens-evidence'||packageValue.version!==1||typeof packageValue.source!=='string'||!Array.isArray(packageValue.items)||!packageValue.items.length||packageValue.items.length>32)fail('每次整理 1 至 32 个书签，请调整选择。');
    const refs={},rows=packageValue.items.map((item,index)=>{
      if(!item||!Number.isInteger(item.start)||!Number.isInteger(item.end)||item.start<1||item.end<item.start||item.end-item.start>=200||!Array.isArray(item.lines)||item.lines.length!==item.end-item.start+1||item.lines.some(line=>typeof line!=='string')||typeof item.title!=='string'||typeof item.note!=='string'||!Array.isArray(item.tags)||item.tags.some(tag=>typeof tag!=='string'))fail('书签预览不完整，请重新生成。');
      const id='e'+(index+1),parts=[];
      if(item.title)parts.push('标题：'+item.title);
      if(item.tags.length)parts.push('标签：'+item.tags.join('、'));
      if(item.note)parts.push('备注：'+item.note);
      if(parts.length)parts.push('片段：');
      parts.push(item.lines.join('\n'));
      const text=parts.join('\n');
      if(text.length>16000)fail(`第 ${index+1} 个书签超过 16000 字，请缩短片段或标注后重试。`);
      refs[id]={reportId:binding.caseId,revision:binding.revision,identity:binding.identity,start:item.start,end:item.end};
      return {id,text,source:packageValue.source,line:item.start};
    });
    const input=normalizeInput({text:'',evidence:rows});
    return freeze({input,sources:sourceMap(refs,input,binding),caseId:binding.caseId,revision:binding.revision,identity:binding.identity});
  }

  function endpoint(value) {
    if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)) fail('模型地址格式无效。');
    let url; try { url = new URL(value); } catch { fail('模型地址格式无效。'); }
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('请使用 HTTPS 地址或本机 HTTP 地址，不含凭据和查询参数。');
    const host = url.hostname;
    // Deliberately narrower than URL's legacy numeric host coercion.
    if (url.protocol === 'http:' && !(host === 'localhost' || host === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host))) fail('非本机模型接口必须使用 HTTPS。');
    const rawAuthority = value.match(/^https?:\/\/([^/]+)/)?.[1] || '';
    if (!rawAuthority || rawAuthority.includes('%')) fail('模型主机名无效。');
    const rawHost = rawAuthority.replace(/:\d+$/, '').toLowerCase();
    if (url.protocol==='http:' && rawHost!==host) fail('请使用完整的本机主机名或回环地址。');
    let path = url.pathname.replace(/\/+$/, '') || '/v1';
    if (!path.endsWith('/chat/completions')) path += '/chat/completions';
    // Keep the original authority so the server validates noncanonical addresses.
    return `${url.protocol}//${rawAuthority}${path}`;
  }

  function summaryText(rows) { return rows.map(row=>`${row.text} [${row.refs.join(', ')}]`).join('\n'); }
  function offline(input) {
    const rows = normalizeInput(input).evidence.map(row=>({text:row.text.slice(0,800)+(row.text.length>800?'…':''), refs:[row.id]}));
    return {mode:'offline', observations:rows, uncertainties:[], summary:rows, summaryText:summaryText(rows)};
  }
  function checkedResult(value, input) {
    const ids = new Set(input.evidence.map(row=>row.id));
    if (!value || typeof value !== 'object' || value.mode !== 'model') fail('模型结果格式无效。','invalid_response');
    const clean = {mode:'model'};
    for (const name of ['observations','uncertainties','summary']) {
      if (!Array.isArray(value[name]) || value[name].length > 16) fail('模型结果格式无效。','invalid_response');
      clean[name] = value[name].map(row=>{
        if (!row || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 1600 || !Array.isArray(row.refs) || !row.refs.length || row.refs.length > 32 || row.refs.some(ref=>typeof ref!=='string'||!ids.has(ref))) fail('模型引用了未提供的证据或结果格式无效。','unknown_reference');
        return {text:row.text, refs:[...new Set(row.refs)]};
      });
    }
    clean.summaryText = summaryText(clean.summary);
    return clean;
  }
  function selectedInput() {
    return normalizeInput({text:state.note, evidence:current.evidence.filter(row=>state.selected.has(row.id)).map(row=>({...row,text:state.edits.get(row.id)??row.text}))});
  }
  function button(action, label, extra='') { return `<button class="btn" data-assistant="${action}" ${extra}>${label}</button>`; }
  function rerender() { context.render?.(); }
  function invalidate(clearResult=false) { state.preview = null; state.error = ''; state.status = ''; if(clearResult){state.result=null;state.summary='';} }
  function abort() {
    state.generation += 1;
    controller?.abort(); controller = null;
    state.busy = false;
  }
  function references(refs) { return refs.map(id=>sources[id]?`<button class="link-btn" data-assistant="source" data-ref="${esc(id)}">[${esc(id)}]</button>`:`[${esc(id)}]`).join(' '); }
  function fragment(row) {
    const text=state.edits.get(row.id)??row.text,edited=text!==row.text;
    return `<article class="assistant-fragment"><div class="assistant-fragment-heading"><label><input type="checkbox" data-assistant-field="evidence" data-ref="${esc(row.id)}" ${state.selected.has(row.id)?'checked':''}><strong>[${esc(row.id)}] ${esc(row.source||'来源未记录')}${row.line?` · 第 ${row.line} 行`:''}</strong></label><span class="assistant-edited" data-assistant-edited="${esc(row.id)}" ${edited?'':'hidden'}>已编辑</span>${sources[row.id]?button('source','核对原文',`data-ref="${esc(row.id)}"`):''}</div><label class="assistant-fragment-label" for="assistant-fragment-${esc(row.id)}">片段内容</label><textarea id="assistant-fragment-${esc(row.id)}" data-assistant-field="fragment" data-ref="${esc(row.id)}" rows="5" spellcheck="false">${esc(text)}</textarea></article>`;
  }
  function output() {
    if (!state.result) return '';
    const result = state.result, model = result.mode === 'model';
    return `<section class="assistant-output"><h2>${model?'模型辅助结果':'本机摘录'}</h2><p class="source-meta">${model?'引用已校验；结论仍需人工核对。':'按所选片段摘录，未调用 AI。'}</p>${model?`<div class="assistant-findings"><section><h3>证据中的观察</h3>${result.observations.length?result.observations.map(row=>`<p>${esc(row.text)} ${references(row.refs)}</p>`).join(''):'<p class="source-meta">未返回观察。</p>'}</section><section><h3>待核实</h3>${result.uncertainties.length?result.uncertainties.map(row=>`<p>${esc(row.text)} ${references(row.refs)}</p>`).join(''):'<p class="source-meta">未返回待核实项。</p>'}</section></div>`:''}<label for="assistant-summary">可编辑摘要</label><textarea id="assistant-summary" data-assistant-field="summary" rows="9" maxlength="64000">${esc(state.summary)}</textarea><div class="assistant-actions">${button('copy','复制摘要')}${button('clear','清除结果')}</div></section>`;
  }
  function preview() {
    if (!state.preview) return '';
    const data = state.preview;
    return `<section class="assistant-preview" aria-label="发送预览"><h2>发送预览</h2><dl><dt>模型接口</dt><dd class="mono">${esc(data.endpoint)}</dd><dt>模型</dt><dd>${esc(data.model)}</dd><dt>内容</dt><dd>${data.input.evidence.length} 条证据 · ${bytes(JSON.stringify(data.input))} 字节</dd></dl><p class="source-meta">自动脱敏可能遗漏自由文本，请核对片段和补充说明。发送后的数据处理规则由服务方决定。</p><pre>${esc(JSON.stringify(data.input,null,2))}</pre><details><summary>完整请求 · 含整理规则与参数</summary><pre>${esc(JSON.stringify(data.request,null,2))}</pre></details><label for="assistant-key">API 密钥（仅本次，可留空）</label><input id="assistant-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096" ${state.busy?'disabled':''}><div class="assistant-actions">${state.busy?button('cancel','取消等待'):button('send','确认发送至模型')}${!state.busy?button('close-preview','返回修改'):''}</div>${state.busy?'<p role="status">正在等待模型，取消等待不会撤回已发送的内容。</p>':''}</section>`;
  }
  function render(ctx={}) {
    context = ctx;
    let incoming = ctx.input || {text:'', evidence:[]};
    // No fetching or implicit preview/export action occurs during render.
    let fingerprint;
    try { fingerprint = fingerprintFor(ctx); } catch { fingerprint = '!invalid'; }
    // This local scope never enters the model payload. Identical pseudonyms can
    // occur in separate reports, so content alone cannot identify the source.
    const scope=scopeFor(ctx);
    if (scope !== state.scope || fingerprint !== state.fingerprint) {
      if(scope!==state.scope)state.mode='offline';
      state.scope=scope;
      clearKey();abort(); state.fingerprint=fingerprint; state.preview=null; state.result=null; state.summary=''; state.error=''; state.status='';state.edits=new Map();sources={};
      try {
        current = normalizeInput(incoming);sources=sourceMap(ctx.sources,current,ctx); state.note = current.text; state.selected = new Set(current.evidence.map(row=>row.id));
      } catch (error) {
        current = {text:'',evidence:[]}; state.selected = new Set(); state.note = '';
        if (incoming?.evidence?.length || Object.keys(incoming || {}).some(key=>!['text','evidence'].includes(key))) state.error = error.message;
      }
    }
    const empty = !current.evidence.length;
    return `<section class="assistant-page"><header><h1 tabindex="-1">证据辅助</h1></header>${empty?`<div class="live-empty"><h2>尚未选择证据</h2><p>先保存并选择证据书签。</p>${context.onSelectEvidence?button('select','选择证据'):''}</div>`:`<fieldset class="assistant-inputs" ${state.busy?'disabled':''}><legend>所选证据</legend>${ctx.exportEdited?'<p class="source-meta">导出预览的临时编辑未带入，请重新核对以下片段。</p>':''}<div class="assistant-evidence">${current.evidence.map(fragment).join('')}</div><label for="assistant-note">补充说明（随所选证据发送）</label><textarea id="assistant-note" data-assistant-field="note" rows="2" maxlength="4000">${esc(state.note)}</textarea><div class="assistant-mode"><label for="assistant-mode">整理方式</label><select id="assistant-mode" data-assistant-field="mode"><option value="offline" ${state.mode==='offline'?'selected':''}>本机整理</option><option value="model" ${state.mode==='model'?'selected':''}>模型辅助</option></select></div>${state.mode==='model'?`<div class="assistant-config"><label for="assistant-endpoint">兼容 API 地址<input id="assistant-endpoint" type="url" data-assistant-field="endpoint" value="${esc(state.endpoint)}" maxlength="2048" placeholder="http://localhost:11434/v1"></label><label for="assistant-model">模型名称<input id="assistant-model" data-assistant-field="model" value="${esc(state.model)}" maxlength="200" autocomplete="off"></label></div><p class="source-meta">支持本机 HTTP 或自选 HTTPS 的 Chat Completions 接口。不会自动发送。</p>`:'<p class="source-meta">在本机摘录片段，不调用模型。</p>'}<div class="assistant-actions">${state.mode==='offline'?button('offline','整理摘要'):button('preview','检查发送内容')}</div></fieldset>`}${state.error?`<p role="alert" class="assistant-error">${esc(state.error)}</p>`:''}${state.status?`<p role="status">${esc(state.status)}</p>`:''}${preview()}${output()}</section>`;
  }

  function readKey(target) {
    const field = target?.closest?.('.assistant-page')?.querySelector?.('#assistant-key');
    const value = field?.value || '';
    if (field) field.value = '';
    return value;
  }
  function clearKey() {const field=root.document?.querySelector?.('#assistant-key');if(field)field.value='';}
  async function send(target) {
    if (state.busy || !state.preview) return;
    if (typeof context.onRequest !== 'function') { state.error='模型接口尚未接入。'; rerender(); return; }
    const frozen = state.preview, selected = selectedInput(), scope=state.scope, fingerprint=state.fingerprint;
    const sourceCurrent=()=>{try{return scopeFor(context)===scope&&fingerprintFor(context)===fingerprint;}catch{return false;}};
    try {
      if (!sourceCurrent()||JSON.stringify(frozen.input)!==JSON.stringify(selected)||frozen.endpoint!==endpoint(state.endpoint)||frozen.model!==state.model.trim()||JSON.stringify(frozen.request)!==JSON.stringify(protocolRequest(selected,frozen.model,context.protocol)))fail('内容已变化，请重新检查发送预览。');
    } catch {clearKey();invalidate(true);state.error='内容已变化，请重新检查发送预览。';rerender();return;}
    let apiKey = readKey(target);
    if(apiKey.length>4096||/[^\x21-\x7e]/.test(apiKey)){apiKey='';state.error='API 密钥格式或长度不符合要求。';rerender();return;}
    const payload = {apiKey};
    for(const [key,value] of Object.entries({mode:'model',confirmed:true,preview:frozen.request,endpoint:frozen.endpoint}))Object.defineProperty(payload,key,{value,enumerable:true});
    if(bytes(JSON.stringify(payload))>192*1024){payload.apiKey='';apiKey='';state.error='请求超过大小限制，请减少所选证据。';rerender();return;}
    const generation = ++state.generation;
    controller = new AbortController(); state.busy=true; state.error=''; state.status=''; rerender();
    try {
      const pending = context.onRequest(payload, {signal:controller.signal});
      // onRequest must synchronously serialize the body before returning its promise.
      payload.apiKey=''; apiKey='';
      const result = await pending;
      if (generation !== state.generation) return;
      if(!sourceCurrent()){abort();invalidate(true);clearKey();rerender();return;}
      state.result=checkedResult(result, frozen.input); state.summary=state.result.summaryText; state.preview=null;
    } catch (error) {
      if (generation !== state.generation) return;
      if(!sourceCurrent()){abort();invalidate(true);clearKey();rerender();return;}
      // Only known application errors are shown; arbitrary fetch/provider text may contain secrets.
      const messages={busy:'已有模型请求正在处理，请结束后重试。',input_limit:'所选证据或完整请求超过大小限制，请减少片段。',invalid_input:'请求无效，请重新检查证据和模型配置。',request_timeout:'发送预览传输超时，请重新检查后重试。',preview_changed:'发送预览已变化，请重新检查完整请求。',timeout:'模型请求超时，请稍后手动重试。',authentication_failed:'认证失败，请重新输入 API 密钥。',rate_limited:'模型接口请求过多或额度不足。',redirect_blocked:'接口重定向已阻止，请直接配置目标地址。',unknown_reference:'模型引用了未提供的证据，本次结果未采用。',invalid_response:'模型结果格式无效，本次结果未采用。',incomplete_response:'模型结果未完整返回，本次结果未采用。',response_limit:'模型响应超过大小限制。',connection_failed:'无法连接模型接口，请检查地址、证书和服务状态。',service_error:'模型接口返回错误，请检查模型名称及 JSON 输出支持。'};
      state.error = messages[error?.code] || '未能取得有效结果，请检查接口配置或稍后重试。';
    } finally {
      payload.apiKey=''; apiKey='';
      if (generation===state.generation) {state.busy=false;controller=null;rerender();}
    }
  }
  function click(target) {
    const action=target?.dataset?.assistant;
    if (!action) return false;
    try {
      if (action==='select') context.onSelectEvidence?.();
      else if (action==='offline' && !state.busy) { state.result=offline(selectedInput()); state.summary=state.result.summaryText; state.error=''; state.status=''; state.preview=null; rerender(); }
      else if (action==='preview' && !state.busy && state.mode==='model') {
        const model=state.model.trim(); if (!model || model.length>200 || /[\r\n]/.test(model)) fail('请输入模型名称。');
        const input=freeze(selectedInput());state.preview=freeze({input,endpoint:endpoint(state.endpoint),model,request:protocolRequest(input,model,context.protocol)}); state.error=''; state.status=''; rerender();
      }
      else if (action==='send') { void send(target); }
      else if (action==='cancel') { readKey(target); abort(); state.status='已取消等待；已发送的内容无法撤回。'; rerender(); }
      else if (action==='close-preview') { readKey(target); invalidate(); rerender(); }
      else if (action==='clear') { state.result=null; state.summary=''; state.status=''; rerender(); }
      else if (action==='source') {
        if(scopeFor(context)!==state.scope||fingerprintFor(context)!==state.fingerprint)fail('原文引用已变更，请重新选择书签。');
        const row=current.evidence.find(row=>row.id===target.dataset.ref),source=sources[row?.id];
        if(source)context.onSource?.(freeze({...source,refId:row.id,edited:(state.edits.get(row.id)??row.text)!==row.text}));
      }
      else if (action==='copy' && state.result) {
        const copy=context.onCopy || (text=>root.navigator?.clipboard?.writeText(text) || Promise.reject(new Error()));
        const generation=state.generation;
        Promise.resolve(copy(state.summary)).then(()=>{if(generation===state.generation){state.status='摘要已复制。';rerender();}}).catch(()=>{if(generation===state.generation){state.error='复制失败，请选择摘要文本后手动复制。';rerender();}});
      }
    } catch (error) { state.error=error?.assistantSafe?error.message:'操作未完成，请重试。'; rerender(); }
    return true;
  }
  function input(target) {
    const field=target?.dataset?.assistantField;
    if (!['mode','endpoint','model','note','summary','evidence','fragment'].includes(field)) return false;
    if (field==='summary') { state.summary=String(target.value || '').slice(0,64000); return true; }
    if (state.busy) return true;
    if (field==='fragment') {
      const row=current.evidence.find(item=>item.id===target.dataset.ref);if(!row)return true;
      const value=String(target.value??'');state.edits.set(row.id,value);
      const badge=target.closest?.('.assistant-fragment')?.querySelector?.('[data-assistant-edited]');if(badge)badge.hidden=value===row.text;
    }
    else if (field==='evidence') { if (target.checked) state.selected.add(target.dataset.ref); else state.selected.delete(target.dataset.ref); }
    else if (field==='mode') { if (!['offline','model'].includes(target.value)) return true; state.mode=target.value; }
    else state[field]=String(target.value || '');
    clearKey();invalidate(true);const page=target.closest?.('.assistant-page');page?.querySelectorAll?.('.assistant-preview,.assistant-output').forEach(element=>element.remove());return true;
  }
  // Text fields already update their state and invalidate stale panels on input.
  // Replacing the page on blur would remove the button receiving the next click.
  function change(target) { const handled=input(target); if (handled && target.dataset.assistantField==='mode') rerender(); return handled; }
  function reset() { clearKey();abort(); const generation=state.generation; state={...blank(),generation}; context={}; current={text:'',evidence:[]};sources={}; }
  const api={render,click,change,input,reset,prepareEvidence};
  if (typeof module!=='undefined'&&module.exports) module.exports={...api,normalizeInput,endpoint,offline,checkedResult,protocolRequest};
  else root.XidAssistant=api;
})(globalThis);
