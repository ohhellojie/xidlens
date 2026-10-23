import React,{useState,useRef,useEffect,useLayoutEffect,useCallback} from 'react';
import {Search,ChevronDown,ChevronUp,ArrowLeft,ArrowUpRight,Maximize,WrapText,X,CornerDownLeft,Copy,Check,FileText} from './icons';
import {ScrollRail} from './ScrollRail';
import {advance,endPosition,boundPosition,clamp,expandTabs,highlightParts,sanitize} from './model';
const fmt=n=>n.toLocaleString('en-US');
const IconButton=({label,children,...props})=><button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
const Highlight=({text,query})=>highlightParts(text,query).map((part,i)=>typeof part==='string'?part:<mark key={i}>{part.match}</mark>);

export function Reader({meta,initial,options,onSave}){
 const total=meta.lines,log={sections:meta.outline,lines:{length:total},errors:meta.errors,name:options.source.split('!').at(-1).split(/[\\/]/).at(-1)};
 const [view,setView]=useState(()=>sanitize(initial,total)),[dims,setDims]=useState({width:800,height:600}),[focus,setFocus]=useState(false),[eventsOpen,setEventsOpen]=useState(false),[warningsOpen,setWarningsOpen]=useState(false);
 const [jumpOpen,setJumpOpen]=useState(false),[jumpInput,setJumpInput]=useState(''),[jumpError,setJumpError]=useState(''),[search,setSearch]=useState({state:'ready',count:0,markers:[]}),[searchRetry,setSearchRetry]=useState(0),[navBusy,setNavBusy]=useState(false),[toast,setToast]=useState(''),[readError,setReadError]=useState(''),[revision,setRevision]=useState(0);
 const scrollRef=useRef(null),linesRef=useRef(null),searchRef=useRef(null),jumpRef=useRef(null),viewRef=useRef(view),cache=useRef(new Map()),pending=useRef(new Set()),heights=useRef(new Map()),alive=useRef(true),toastTimer=useRef(),handlers=useRef({}),horizontalReady=useRef(false),lastSearch=useRef('');
 const api=useCallback((action,params={})=>options.request('/api/log/'+action+'?'+new URLSearchParams({id:options.caseId,revision:meta.revision,...params})),[options,meta.revision]);
 const canvas=useMemoCanvas();
 viewRef.current=view;
 if(!cache.current.has(view.top))horizontalReady.current=false;
 const active=[...log.sections].reverse().find(s=>s.line<=view.top)||{line:1,title:'日志正文',end:total,children:[]};
 const errors=new Map(log.errors.map(e=>[e.line,e.title]));
 const rowCount=Math.min(total-view.top+1,Math.ceil(dims.height/26)+8),rows=Array.from({length:Math.max(0,rowCount)},(_,i)=>view.top+i);
 function change(patch){setView(v=>({...v,...patch}));}
 function heightFor(n){if(!viewRef.current.wrap)return 26;if(heights.current.has(n))return heights.current.get(n);const raw=cache.current.get(n);if(raw===undefined)return 26;const height=26*Math.max(1,Math.ceil(canvas.measureText(expandTabs(raw)).width/Math.max(100,dims.width-118)));heights.current.set(n,height);return height;}
 function scrollBy(delta){setView(v=>({...v,...boundPosition(advance(v,clamp(delta,-20000,20000),total,heightFor),total,dims.height,heightFor)}));}
 function scrollLine(n){change(boundPosition({top:clamp(Math.floor(n),1,Math.max(1,total)),offset:0},total,dims.height,heightFor));}
 function scrollEnd(){change(endPosition(total,dims.height,heightFor));}
 function go(line,center=true){const n=clamp(Math.trunc(Number(line))||1,1,Math.max(1,total)),position=center?advance({top:n,offset:0},-dims.height*.32,total,heightFor):{top:n,offset:0};change({...position,selected:n});setEventsOpen(false);}
 async function fetchRows(start){
  if(pending.current.has(start)||readError)return;pending.current.add(start);
  try{const result=await api('lines',{start,count:128});if(!alive.current)return;for(let i=0;i<result.lines.length;i++)cache.current.set(result.start+i,result.lines[i]);while(cache.current.size>4096){const old=cache.current.keys().next().value;cache.current.delete(old);heights.current.delete(old);}setRevision(r=>r+1);}
  catch(e){if(alive.current)setReadError(e.message||'原文读取失败');}
  finally{pending.current.delete(start);}
 }
 useEffect(()=>{const missing=rows.find(n=>!cache.current.has(n));if(missing&&!readError)fetchRows(missing);},[view.top,dims.height,revision,readError]);
 useLayoutEffect(()=>{const el=scrollRef.current;const observer=new ResizeObserver(()=>{if(!el.clientWidth||!el.clientHeight)return;heights.current.clear();setDims({width:el.clientWidth,height:el.clientHeight});});observer.observe(el);return()=>observer.disconnect();},[]);
 useLayoutEffect(()=>{for(const row of linesRef.current?.children||[]){if(!row.classList.contains('loading'))heights.current.set(Number(row.dataset.line),row.getBoundingClientRect().height);}const h=heightFor(view.top);if(cache.current.has(view.top)&&view.offset>=h)change(advance({top:view.top,offset:0},view.offset,total,heightFor));},[revision,view.top,view.wrap,dims.width]);
 useLayoutEffect(()=>{if(!cache.current.has(view.top))return;const el=scrollRef.current;el.scrollLeft=view.wrap?0:view.left||0;horizontalReady.current=true;},[revision,view.top,view.wrap]);
 useEffect(()=>{onSave(view);},[view]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;clearTimeout(toastTimer.current);options.onFocus(false);onSave(viewRef.current,true);};},[]);
 async function nextMatch(direction=1){
  if(!search.count||search.state!=='ready'||navBusy)return;setNavBusy(true);
  try{const from=search.current?view.selected:direction>0?Math.max(0,view.top-1):view.top;const hit=await api('match',{q:view.query,selected:from,direction:direction>0?'next':'previous'});if(alive.current&&hit.line){go(hit.line);setSearch(s=>({...s,current:hit.index}));}}
  catch(e){if(alive.current){setSearch({...search,state:'error'});showToast(e.message);}}
  finally{if(alive.current)setNavBusy(false);}
 }
 useEffect(()=>{
  let stopped=false,timer;const q=view.query;
  if(!q){lastSearch.current='';setSearch({state:'ready',count:0,markers:[]});return;}
  if(lastSearch.current!==q){setSearch({state:'searching',count:0,markers:[]});lastSearch.current=q;}
  async function poll(){try{const result=await api('search',{q,selected:view.selected});if(stopped)return;setSearch(result);if(result.state==='searching')timer=setTimeout(poll,400);}catch{if(!stopped)setSearch({state:'error',count:0,markers:[]});}}
  timer=setTimeout(poll,220);return()=>{stopped=true;clearTimeout(timer);};
 },[view.query,view.selected,searchRetry]);
 function toggleWrap(){heights.current.clear();change({wrap:!view.wrap,offset:0});}
 function toggleFocus(value){setFocus(value);options.onFocus(value);}
 function openJump(){setJumpInput(String(view.selected));setJumpError('');setJumpOpen(true);}
 function submitJump(e){e.preventDefault();const n=Number(jumpInput.replace(/,/g,''));if(!Number.isInteger(n)||n<1||n>total){setJumpError(`请输入 1–${fmt(total)} 之间的行号`);return;}go(n);setJumpOpen(false);}
 function showToast(message){clearTimeout(toastTimer.current);setToast(message);toastTimer.current=setTimeout(()=>setToast(''),1800);}
 async function copyLine(){try{let raw=cache.current.get(view.selected);if(raw===undefined)raw=(await api('lines',{start:view.selected,count:1})).lines[0];await navigator.clipboard.writeText(raw);if(alive.current)showToast('已复制原文');}catch{if(alive.current)showToast('可选中文字后按 Ctrl+C 复制');}}
 useEffect(()=>{if(jumpOpen)jumpRef.current?.focus();},[jumpOpen]);
 handlers.current={scrollBy,scrollEnd,scrollLine,nextMatch,openJump,escape(){if(jumpOpen)setJumpOpen(false);else if(warningsOpen)setWarningsOpen(false);else if(eventsOpen)setEventsOpen(false);else if(focus)toggleFocus(false);}};
 useEffect(()=>{const el=scrollRef.current;const wheel=e=>{if(e.ctrlKey||e.shiftKey||!e.deltaY)return;e.preventDefault();handlers.current.scrollBy(e.deltaY*(e.deltaMode===1?26:e.deltaMode===2?el.clientHeight:1));};el.addEventListener('wheel',wheel,{passive:false});const key=e=>{if(document.querySelector('dialog[open]'))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();searchRef.current?.focus();searchRef.current?.select();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='g'){e.preventDefault();handlers.current.openJump();}if(e.key==='Escape')handlers.current.escape();if(e.key==='F3'){e.preventDefault();handlers.current.nextMatch(e.shiftKey?-1:1);}};window.addEventListener('keydown',key);return()=>{el.removeEventListener('wheel',wheel);window.removeEventListener('keydown',key);};},[]);
 function logKey(e){if(e.shiftKey)return;if((e.ctrlKey||e.metaKey)&&!['Home','End'].includes(e.key))return;const values={ArrowDown:26,ArrowUp:-26,PageDown:dims.height*.9,PageUp:-dims.height*.9};if(e.key in values){e.preventDefault();scrollBy(values[e.key]);}else if(e.key==='Home'){e.preventDefault();scrollLine(1);}else if(e.key==='End'){e.preventDefault();scrollEnd();}}
 const searching=search.state==='searching',disabled=!search.count||search.state!=='ready'||navBusy;
 return <div className={'reader-page '+(focus?'focus-mode':'')}><h1 className="sr-only">完整日志</h1>
  {focus?<div className="focus-header"><button className="text-button" onClick={()=>toggleFocus(false)}><ArrowLeft size={17}/>退出专注</button><span className="focus-file" title={options.source}><FileText size={17}/><span>{log.name}</span></span>{options.backLabel&&<button className="text-button focus-return" onClick={options.onBack}>返回{options.backLabel}<ArrowUpRight size={16}/></button>}</div>:null}
  <div className="reading-workspace">
   <section className="reader-panel" aria-label="完整日志阅读器"><div className="reader-toolbar">
    {!focus&&options.backLabel&&<button className="text-button back-analysis" onClick={options.onBack} aria-label={`返回${options.backLabel}`} title={`返回${options.backLabel}`}><ArrowLeft size={16}/><span>返回{options.backLabel}</span></button>}<div className="searchbox"><Search size={17}/><input ref={searchRef} maxLength={512} aria-label="搜索完整日志" placeholder="搜索日志" value={view.query} onChange={e=>change({query:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();nextMatch(e.shiftKey?-1:1);}}}/>{view.query?<IconButton label="清除搜索" onClick={()=>{change({query:''});searchRef.current?.focus();}}><X size={15}/></IconButton>:<kbd>Ctrl F</kbd>}</div>
    {search.state==='error'?<button className="footer-line reader-warning" onClick={()=>setSearchRetry(n=>n+1)}>重试搜索</button>:<span className={'match-count '+(!search.count&&view.query?'no-match':'')} aria-live="polite">{searching?'查找中…':view.query?(search.count?`${search.current||'—'} / ${fmt(search.count)}`:'无匹配'):''}</span>}<div className="match-arrows"><IconButton label="上一个匹配" disabled={disabled} onClick={()=>nextMatch(-1)}><ChevronUp size={18}/></IconButton><IconButton label="下一个匹配" disabled={disabled} onClick={()=>nextMatch(1)}><ChevronDown size={18}/></IconButton></div><span className="tool-divider"/>
    <button className="button jump-trigger" onClick={openJump} title="跳转行 · Ctrl+G">跳转行</button><button className={'button wrap-toggle '+(view.wrap?'active':'')} aria-label="换行" title="自动换行" aria-pressed={view.wrap} onClick={toggleWrap}><WrapText size={17}/><span>换行</span></button><IconButton label="复制当前行" onClick={copyLine}><Copy size={16}/></IconButton>{!focus&&<IconButton label="专注阅读" className="icon-button focus-trigger" onClick={()=>toggleFocus(true)}><Maximize size={16}/></IconButton>}
   </div><div className="log-body"><div id="raw-log" ref={scrollRef} className={'log-scroll '+(view.wrap?'wrapped':'')} tabIndex={0} aria-label="日志原文" onKeyDown={logKey} onScroll={e=>{if(e.currentTarget.scrollTop)e.currentTarget.scrollTop=0;if(horizontalReady.current&&!view.wrap&&e.currentTarget.scrollLeft!==view.left)change({left:e.currentTarget.scrollLeft});}}><div className="virtual-canvas"><div ref={linesRef} className="visible-lines" style={{top:-view.offset}}>
    {rows.map(n=>{const raw=cache.current.get(n);return <div key={n} data-line={n} className={'log-row '+(view.selected===n?'current ':'')+(raw===undefined?'loading':'')} onClick={()=>change({selected:n})}><button tabIndex={-1} className="line-number" aria-label={`第 ${n} 行${errors.has(n)?'，'+errors.get(n):''}`} onClick={()=>change({selected:n})}>{errors.has(n)&&<span className="error-dot" title={errors.get(n)}/>}<span>{n}</span></button><pre className={'code '+(raw===undefined?'placeholder':'')}><Highlight text={raw===undefined?'…':expandTabs(raw)||' '} query={view.query}/></pre></div>;})}
   </div></div></div><ScrollRail top={view.top} visibleLines={Math.max(1,Math.floor(dims.height/26))} height={dims.height} log={log} onChoose={go} onScrollLine={scrollLine} onScrollBy={scrollBy} onEnd={scrollEnd} matches={search.markers||[]}/>{readError&&<div className="read-error" role="alert"><p>{readError}</p><button className="button" onClick={options.onReload}>重试</button></div>}</div>
   <footer className="reader-footer"><button className="footer-line" onClick={openJump}>第 {fmt(view.selected)} 行</button><span>共 {fmt(total)} 行</span><span className="footer-section" title={active.title}>{active.title}</span>{meta.warnings.length>0&&<button className="footer-line reader-warning" onClick={()=>setWarningsOpen(true)}>读取提示</button>}{meta.errorCount>0&&<div className="events-anchor"><button className="footer-line" onClick={()=>setEventsOpen(!eventsOpen)} aria-expanded={eventsOpen}>异常 {fmt(meta.errorCount)}<ChevronUp size={12}/></button>{eventsOpen&&<div className="event-popover">{log.errors.map((e,i)=><button key={i} onClick={()=>go(e.line)}><span>{e.title}</span><small>L{fmt(e.line)}</small></button>)}</div>}</div>}<span className="encoding">{meta.encoding}</span></footer></section>
  </div>
  {jumpOpen&&<div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setJumpOpen(false);}}><form className="jump-dialog" onSubmit={submitJump} role="dialog" aria-modal="true" aria-labelledby="jump-title" onKeyDown={trapFocus}><div className="dialog-title"><h2 id="jump-title">跳转到行</h2><IconButton label="关闭" type="button" onClick={()=>setJumpOpen(false)}><X size={17}/></IconButton></div><label htmlFor="jump-input">行号<span>1–{fmt(total)}</span></label><div className="jump-input-wrap"><input id="jump-input" ref={jumpRef} inputMode="numeric" value={jumpInput} onChange={e=>{setJumpInput(e.target.value);setJumpError('');}}/><button className="button primary" type="submit">跳转<CornerDownLeft size={15}/></button></div>{jumpError&&<p className="field-error" role="alert">{jumpError}</p>}</form></div>}
  {warningsOpen&&<div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setWarningsOpen(false);}}><section className="jump-dialog warning-dialog" role="dialog" aria-modal="true" aria-label="读取提示" onKeyDown={trapFocus}><div className="dialog-title"><h2>读取提示</h2><IconButton label="关闭读取提示" autoFocus onClick={()=>setWarningsOpen(false)}><X size={17}/></IconButton></div>{meta.warnings.map((w,i)=><p key={i}>{w}</p>)}</section></div>}
  {toast&&<div className="toast" role="status"><Check size={16}/>{toast}</div>}
 </div>;
}
function trapFocus(e){if(e.key!=='Tab')return;const nodes=[...e.currentTarget.querySelectorAll('button,input')],active=e.currentTarget.getRootNode().activeElement;if(e.shiftKey&&active===nodes[0]){e.preventDefault();nodes.at(-1)?.focus();}else if(!e.shiftKey&&active===nodes.at(-1)){e.preventDefault();nodes[0]?.focus();}}
function useMemoCanvas(){const ref=useRef();if(!ref.current){ref.current=document.createElement('canvas').getContext('2d');ref.current.font='15px Consolas';}return ref.current;}
