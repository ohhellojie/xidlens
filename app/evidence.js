/* Local annotations and explicit preview-before-download sharing. */
((root)=>{'use strict';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const categories={host:'主机名',serial:'序列号',uuid:'UUID',ip:'IP 地址',path:'路径'};
const warning='自动脱敏不能覆盖全部自由文本。请检查预览中的名称、备注和原文，再下载分享。';
const freshDraft=()=>({id:'',start:1,end:1,title:'',note:'',tags:''});
let context=null,report=null,activeId='',activeScope='',revision=0,pendingRange=null;
const state={data:null,loading:false,busy:false,message:'',error:'',draft:freshDraft(),dirty:false,selected:new Set(),deleteId:'',options:{host:true,serial:true,uuid:true,ip:true,path:true},extra:'',preview:null,format:'text',reviewed:false};
function invalidate(){state.preview=null;state.reviewed=false;}
function repaint(){context?.render?.();}
const api=(url,options)=>context.api(url,options);
const post=(action,payload)=>api('/api/evidence/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:activeId,revision:state.data.revision,identity:state.data.identity,...payload})});
function reset(){revision++;activeId='';activeScope='';pendingRange=null;Object.assign(state,{data:null,loading:false,busy:false,message:'',error:'',draft:freshDraft(),dirty:false,selected:new Set(),deleteId:'',options:{host:true,serial:true,uuid:true,ip:true,path:true},extra:'',preview:null,format:'text',reviewed:false});}
function acceptData(result,id){
 if(result?.id!==id)throw Error('书签来源不匹配，请刷新后重试');
 const changed=state.data&&(result.revision!==state.data.revision||result.identity!==state.data.identity);
 if(changed){invalidate();state.draft=freshDraft();state.dirty=false;state.selected=new Set();state.deleteId='';}
 state.data=result;const valid=new Set(result.items.filter(x=>!x.stale).map(x=>x.id));state.selected=new Set([...state.selected].filter(id=>valid.has(id)));
 return changed;
}
async function load(){
 if(!activeId||state.loading)return;
 const request=++revision,id=activeId;state.loading=true;state.error='';invalidate();repaint();
 try{const result=await api('/api/evidence?id='+encodeURIComponent(id));if(request!==revision)return;acceptData(result,id);}
 catch(error){if(request===revision)state.error=error.message;}
 finally{if(request===revision){state.loading=false;repaint();}}
}
async function ready(){
 const id=activeId,expected=revision;
 for(let i=0;i<160;i++){
  const meta=await api('/api/log/meta?id='+encodeURIComponent(id));
  if(id!==activeId||expected!==revision)throw Error('已切换报告，请重新操作');
  if(meta.revision!==state.data.revision||meta.identity!==state.data.identity)throw Error('报告已变更，请刷新书签后重新选择片段');
  if(meta.state==='ready')return;
  if(meta.state==='error')throw Error(meta.message||'原日志无法读取');
  state.message='正在准备原文…';repaint();
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw Error('原文仍在索引，请稍后重试');
}
async function run(action){
 if(state.busy||state.loading||!state.data)return;
 const id=activeId,request=revision;state.busy=true;state.error='';state.message='';repaint();
 const guard=()=>{if(activeId!==id||revision!==request)throw Error('已切换报告，请重新操作');};
 try{await action(guard);}
 catch(error){if(activeId===id&&revision===request)state.error=error.message;}
 finally{if(activeId===id&&revision===request){state.busy=false;repaint();}}
}
async function refreshItems(guard){const data=await api('/api/evidence?id='+encodeURIComponent(activeId));guard();if(acceptData(data,activeId))throw Error('报告已变更，请重新选择片段');}
function serializeDraft(){const draft=state.draft;return {...draft,id:draft.id||undefined,start:Number(draft.start),end:Number(draft.end),tags:draft.tags.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean)};}
async function save(){return run(async guard=>{await ready();guard();const result=await post('save',{entry:serializeDraft()});guard();await refreshItems(guard);state.selected.add(result.item.id);state.draft={...result.item,tags:result.item.tags.join('，')};state.dirty=false;state.message='标注已保存';invalidate();});}
async function remove(id){return run(async guard=>{await post('delete',{bookmarkId:id});guard();await refreshItems(guard);state.selected.delete(id);state.deleteId='';if(state.draft.id===id){state.draft=freshDraft();state.dirty=false;}state.message='书签已删除';invalidate();});}
async function preview(){return run(async guard=>{if(state.dirty)throw Error('请先保存标注，再生成预览');if(!state.selected.size)throw Error('请先选择要分享的书签');if(state.selected.size>100)throw Error('每次最多导出 100 个书签，请减少选择');await ready();guard();const result=await post('preview',{ids:[...state.selected],options:{redact:state.options,extra:state.extra.split('\n').map(s=>s.trim()).filter(Boolean)}});guard();state.preview=result;state.reviewed=false;state.message='预览已生成，请检查后下载';});}
function entryRow(item){
 return `<article class="evidence-bookmark ${state.draft.id===item.id?'is-selected':''}"><div class="evidence-bookmark-main"><input type="checkbox" id="evidence-select-${esc(item.id)}" data-evidence-select="${esc(item.id)}" aria-label="选择 ${esc(item.title||'第 '+item.start+' 行片段')}" ${state.selected.has(item.id)?'checked':''} ${item.stale||state.busy?'disabled':''}><button class="evidence-bookmark-open" data-evidence="edit" data-value="${esc(item.id)}"><strong>${esc(item.title||'证据片段')}</strong><span>第 ${item.start}–${item.end} 行</span>${item.tags.length?`<span class="evidence-tags">${item.tags.map(esc).join(' · ')}</span>`:''}</button></div>${item.note?`<p class="evidence-bookmark-note">${esc(item.note)}</p>`:''}${item.stale?'<p class="evidence-stale">原日志已变更，请重新选取片段。</p>':''}<div class="evidence-bookmark-actions"><button class="link-btn" data-evidence="source" data-value="${esc(item.id)}" ${item.stale?'disabled':''}>查看原文</button>${state.deleteId===item.id?`<span>删除此书签？</span><button class="link-btn" data-evidence="confirm-delete" data-value="${esc(item.id)}" ${state.busy?'disabled':''}>删除</button><button class="link-btn" data-evidence="cancel-delete">取消</button>`:`<button class="link-btn" data-evidence="delete" data-value="${esc(item.id)}" ${state.busy?'disabled':''}>删除</button>`}</div></article>`;
}
function editor(){
 const d=state.draft,disabled=state.busy||state.loading||!state.data,stale=state.data?.items.find(x=>x.id===d.id)?.stale;
 return `<section class="evidence-editor" aria-label="编辑证据标注"><div class="evidence-section-heading"><h2>${d.id?'编辑标注':'添加证据片段'}</h2><button class="link-btn" data-evidence="new" ${state.busy?'disabled':''}>新建</button></div><div class="evidence-range"><label>起始行<input class="select" type="number" min="1" step="1" id="evidence-start" data-evidence-input="start" value="${esc(d.start)}" ${disabled?'disabled':''}></label><label>结束行<input class="select" type="number" min="1" step="1" id="evidence-end" data-evidence-input="end" value="${esc(d.end)}" ${disabled?'disabled':''}></label><span>最多 200 行</span></div><label class="evidence-field">标题<input class="select" maxlength="120" id="evidence-title" data-evidence-input="title" value="${esc(d.title)}" ${disabled?'disabled':''}></label><label class="evidence-field">备注<textarea rows="4" maxlength="4000" id="evidence-note" data-evidence-input="note" ${disabled?'disabled':''}>${esc(d.note)}</textarea></label><label class="evidence-field">标签<input class="select" maxlength="500" id="evidence-tags" data-evidence-input="tags" placeholder="用逗号分隔，最多 12 项" value="${esc(d.tags)}" ${disabled?'disabled':''}></label>${stale?'<p class="evidence-stale">此书签属于旧内容。先新建书签，再核对当前原文的行号。</p>':''}<div class="actions"><button class="btn primary" data-evidence="save" ${disabled||stale?'disabled':''}>保存标注</button><button class="btn" data-evidence="range-source" ${!state.data?'disabled':''}>打开原文</button></div><p class="evidence-note">标注保存在本机；原日志不变。</p></section>`;
}
function sharing(){
 const disabled=state.busy||state.loading||!state.data;
 return `<section class="evidence-sharing"><div class="evidence-section-heading"><h2>分享选中片段</h2><span>${state.selected.size} / 100 个书签</span></div><fieldset class="evidence-redactions" ${disabled?'disabled':''}><legend>脱敏字段</legend>${Object.entries(categories).map(([key,label])=>`<label><input type="checkbox" id="evidence-option-${key}" data-evidence-option="${key}" ${state.options[key]?'checked':''}>${label}</label>`).join('')}</fieldset><label class="evidence-field">其他需隐藏的文字<textarea rows="2" maxlength="20100" id="evidence-extra" data-evidence-input="extra" placeholder="每行一项，如自由文本中的名称" ${disabled?'disabled':''}>${esc(state.extra)}</textarea></label><p class="evidence-note">备注和标签一并脱敏。</p>${Object.values(state.options).some(v=>!v)?'<p class="evidence-stale">已关闭部分字段脱敏，请核对预览。</p>':''}${state.selected.size>100?'<p class="evidence-stale" role="status">每次最多导出 100 个书签，请减少选择。</p>':''}<button class="btn" data-evidence="preview" ${disabled||!state.selected.size||state.selected.size>100?'disabled':''}>生成预览</button></section>`;
}
function previewHtml(){
 if(!state.preview)return '';
 const count=Object.entries(state.preview.replacements||{}).map(([key,value])=>(categories[key]||({custom:'自定义',secret:'凭据',source:'来源名'}[key])||key)+' '+value).join(' · ');
 const text=state.format==='json'?state.preview.json:state.preview.text;
 return `<section class="evidence-preview" aria-label="导出预览"><div class="evidence-section-heading"><h2>导出预览</h2><label>格式 <select class="select" id="evidence-format" data-evidence-format><option value="text" ${state.format==='text'?'selected':''}>TXT</option><option value="json" ${state.format==='json'?'selected':''}>JSON</option></select></label></div><p class="evidence-note">${count?'已替换：'+esc(count):'没有匹配到自动替换项。'}</p><p class="evidence-warning">${esc(state.preview.warning||warning)}</p><textarea id="evidence-preview-text" data-evidence-input="preview" spellcheck="false" aria-label="可编辑的导出内容">${esc(text)}</textarea><label class="evidence-reviewed"><input type="checkbox" id="evidence-reviewed" data-evidence-reviewed ${state.reviewed?'checked':''}>已检查本次导出的内容</label><div class="actions"><button class="btn primary" data-evidence="download" ${state.reviewed?'':'disabled'}>下载 ${state.format==='json'?'JSON':'TXT'}</button><button class="btn" data-evidence="close-preview">关闭预览</button></div></section>`;
}
function render(data,ctx){
 context=ctx;report=data;
 const id=ctx.caseId||ctx.id||'';
 const scope=JSON.stringify([id,data?.contentSha256||'',ctx.revision||'',data?.source||'',data?.sourceMember||'']);
 if(id!==activeId||scope!==activeScope){const range=pendingRange;reset();pendingRange=range;activeId=id;activeScope=scope;if(id)Promise.resolve().then(load);}
 if(pendingRange){if(!pendingRange.caseId||pendingRange.caseId===id){state.draft={...freshDraft(),start:pendingRange.start,end:pendingRange.end};state.dirty=false;}pendingRange=null;}
 if(!data?.source||!id)return '<div class="evidence-workspace"><h1 tabindex="-1">证据与分享</h1><div class="live-empty"><h2>导入日志后标注证据</h2></div></div>';
 const items=state.data?.items||[];
 return `<div class="evidence-workspace"><header class="evidence-heading"><div><h1 tabindex="-1">证据与分享</h1></div><button class="btn" data-evidence="refresh" ${state.loading||state.busy?'disabled':''}>刷新</button></header>${state.error?`<p class="evidence-error" role="alert">${esc(state.error)}</p>`:''}${state.message?`<p class="evidence-feedback" role="status">${esc(state.message)}</p>`:''}${state.loading?'<p class="evidence-note" role="status">正在读取书签…</p>':''}<div class="evidence-layout"><section class="evidence-list" aria-label="证据书签"><div class="evidence-section-heading"><h2>书签 <span>${items.length}</span></h2><button class="link-btn" data-evidence="select-all" ${state.busy||!items.some(x=>!x.stale)?'disabled':''}>${state.selected.size?'取消选择':'选择可用书签'}</button></div>${items.map(entryRow).join('')||'<p class="evidence-list-empty">暂无书签。选择原文片段或输入行号。</p>'}</section><div class="evidence-editing">${editor()}${sharing()}</div></div>${previewHtml()}</div>`;
}
function selectRange(start,end=start,caseId=activeId){pendingRange={start:Number(start),end:Number(end),caseId};state.draft={...freshDraft(),start:pendingRange.start,end:pendingRange.end};state.dirty=false;state.error='';state.message='';invalidate();return state.draft;}
function click(el){
 const action=el?.dataset?.evidence;if(!action||!context)return false;
 if((state.busy||state.loading)&&['refresh','edit','new','delete','confirm-delete','cancel-delete','select-all','save','preview','download'].includes(action))return true;
 const id=el.dataset.value,item=state.data?.items.find(x=>x.id===id);
 if(action==='refresh'){invalidate();load();return true;}
 if(action==='save'){save();return true;}
 if(action==='preview'){preview();return true;}
 if(action==='confirm-delete'){remove(id);return true;}
 if(action==='edit'&&item){state.draft={...item,tags:item.tags.join('，')};state.dirty=false;state.error='';}
 else if(action==='new')selectRange(1);
 else if(action==='delete')state.deleteId=id;
 else if(action==='cancel-delete')state.deleteId='';
 else if(action==='select-all'){state.selected=state.selected.size?new Set():new Set(state.data.items.filter(x=>!x.stale).map(x=>x.id));invalidate();}
 else if(action==='source'&&item&&!item.stale){context.openSource?.(item.start,item.end);return true;}
 else if(action==='range-source'){const start=Number(state.draft.start);if(Number.isInteger(start)&&start>0)context.openSource?.(start,Number(state.draft.end)||start);return true;}
 else if(action==='close-preview')invalidate();
 else if(action==='download'){
  if(!state.preview||!state.reviewed)return true;
  const json=state.format==='json',text=json?state.preview.json:state.preview.text;
  if(json)try{JSON.parse(text);}catch{state.error='JSON 格式无效，请修正预览内容后下载';repaint();return true;}
  context.download?.('xidlens-evidence.'+(json?'json':'txt'),text,json?'application/json':'text/plain');return true;
 }else if(!['edit','new','delete','cancel-delete','select-all','close-preview'].includes(action))return false;
 repaint();return true;
}
function input(el){
 const key=el?.dataset?.evidenceInput;if(!key)return false;
 if(state.busy||state.loading)return true;
 if(key==='extra'){state.extra=el.value;invalidate();if(typeof document!=='undefined')document.querySelector('.evidence-preview')?.remove();}
 else if(key==='preview'&&state.preview){state.preview[state.format==='json'?'json':'text']=el.value;state.reviewed=false;const check=typeof document==='undefined'?null:document.querySelector('[data-evidence-reviewed]');if(check)check.checked=false;const button=typeof document==='undefined'?null:document.querySelector('[data-evidence="download"]');if(button)button.disabled=true;}
 else if(Object.hasOwn(state.draft,key)){state.draft[key]=el.value;state.dirty=true;invalidate();if(typeof document!=='undefined')document.querySelector('.evidence-preview')?.remove();}
 else return false;
 return true;
}
function change(el){
 if(!el?.dataset?.evidenceSelect&&!el?.dataset?.evidenceOption&&!el?.hasAttribute?.('data-evidence-format')&&!el?.hasAttribute?.('data-evidence-reviewed'))return false;
 if(state.busy||state.loading)return true;
 if(el?.dataset?.evidenceSelect){if(el.checked)state.selected.add(el.dataset.evidenceSelect);else state.selected.delete(el.dataset.evidenceSelect);invalidate();}
 else if(el?.dataset?.evidenceOption){state.options[el.dataset.evidenceOption]=el.checked;invalidate();}
 else if(el?.hasAttribute?.('data-evidence-format')){state.format=el.value==='json'?'json':'text';state.reviewed=false;}
 else if(el?.hasAttribute?.('data-evidence-reviewed'))state.reviewed=el.checked;
 else return false;
 repaint();return true;
}
const exported={render,click,input,change,reset,selectRange,load,save,preview,serializeDraft};
if(typeof module!=='undefined'&&module.exports)module.exports={...exported,state,esc};else root.XidEvidence=exported;
})(globalThis);
