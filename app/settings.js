/* Reference-package updates share one entry with application and rule updates. */
((root)=>{
 'use strict';
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let info=null,error='',context={},timer=null,request=0,pending=false;
 function render(ctx){
  context=ctx;
  return `<div class="reference-updates">${error?`<p role="alert">${esc(error)}</p>`:''}${['xid','manual'].map(kind=>{
   const entry=info?.[kind],working=entry?.state.state==='working'||pending;
   return `<section class="resource-section"><div class="resource-heading"><h2>${kind==='xid'?'Xid 中文资料':'排查手册'} <span class="muted">${entry?'v'+esc(entry.version):''}</span></h2><button class="btn" data-reference-kind="${kind}" data-reference-action="check" ${working?'disabled':''}>检查更新</button></div>${entry?`<p class="resource-note">${esc(entry.origin)} · ${esc(entry.updatedAt)}</p>${entry.warning?`<p role="status">${esc(entry.warning)}</p>`:''}<div role="status">${esc(entry.state.message||'')}${entry.candidate?' · v'+esc(entry.candidate.version):''}</div><div class="actions">${entry.candidate?`<button class="btn" data-reference-kind="${kind}" data-reference-action="apply" ${working?'disabled':''}>更新资料</button>`:''}${entry.state.state==='working'?`<button class="btn" data-reference-kind="${kind}" data-reference-action="cancel">取消</button>`:''}</div>`:'<p class="resource-note">正在读取版本…</p>'}</section>`;
  }).join('')}</div>`;
 }
 function repaint(){context.render?.();}
 async function refresh(api){
  if(api)context.api=api;
  clearTimeout(timer);const generation=++request;
  try{const value=await context.api('/api/knowledge/status');if(generation!==request)return;info=value;error='';}
  catch{if(generation!==request)return;error='资料版本读取失败，可点击检查更新重试';}
  repaint();
  if(Object.values(info||{}).some(v=>v.state.state==='working'))timer=setTimeout(refresh,900);
 }
 async function action(kind,name){
  if(!['xid','manual'].includes(kind)||!['check','apply','cancel'].includes(name)||pending)return;
  pending=true;error='';repaint();
  try{info=await context.api(`/api/knowledge/${kind}/${name}`,{method:'POST'});}
  catch{error='资料更新操作失败，请重试';}
  finally{pending=false;repaint();if(Object.values(info||{}).some(v=>v.state.state==='working')){clearTimeout(timer);timer=setTimeout(refresh,900);}}
 }
 const api={render,refresh,action};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.XidSettings=api;
})(globalThis);
