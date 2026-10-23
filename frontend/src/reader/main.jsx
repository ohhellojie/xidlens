import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Reader} from './Reader';
import {defaults,sanitize} from './model';
import css from './reader.css?inline';
let root;
const sessions=new Map();
function Page({options}){
 const [meta,setMeta]=useState(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{let active=true,timer,first=true;async function load(){try{const result=await options.request('/api/log/meta?'+new URLSearchParams({id:options.caseId,...(retry&&first?{retry:'1'}:{})}));first=false;if(!active)return;setMeta(result);setError('');if(result.state==='indexing')timer=setTimeout(load,400);}catch(e){if(active)setError(e.message||'原日志读取失败');}}setMeta(null);load();return()=>{active=false;clearTimeout(timer);};},[retry]);
 if(!meta||meta.state!=='ready'||!meta.lines)return <div className="reader-page"><h1 className="sr-only">完整日志</h1><div className="reader-loader"><p>{error||meta?.message||(meta?.state==='ready'?'日志为空':'正在准备原文…')}{meta?.state==='indexing'&&meta.lines>0?` ${meta.lines.toLocaleString()} 行`:''}</p>{(error||meta?.state==='error')&&<div className="actions"><button className="button" onClick={()=>setRetry(n=>n+1)}>重试</button><button className="button" onClick={options.onImport}>导入日志</button></div>}</div></div>;
 return <Loaded key={meta.revision} options={{...options,onReload:()=>setRetry(n=>n+1)}} meta={meta}/>;
}
function Loaded({options,meta}){
 const stored=sessions.get(options.caseId),saved=stored?.identity===meta.identity?stored.view:meta.position;
 const [initial]=useState(()=>{const view=sanitize({...defaults(),...saved},meta.lines);return options.sourceLine?sanitize({...view,selected:options.sourceLine,top:Math.max(1,options.sourceLine-8),offset:0,left:0,query:''},meta.lines):view;});
 const [save]=useState(()=>{let timer;return (view,flush=false)=>{sessions.delete(options.caseId);sessions.set(options.caseId,{identity:meta.identity,view});while(sessions.size>50)sessions.delete(sessions.keys().next().value);clearTimeout(timer);const persist=()=>options.request('/api/log/position?'+new URLSearchParams({id:options.caseId,revision:meta.revision}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(['top','offset','left','selected','query','wrap'].map(k=>[k,view[k]])))}).catch(()=>{});if(flush)persist();else timer=setTimeout(persist,600);};});
 return <Reader meta={meta} initial={initial} options={options} onSave={save}/>;
}
export function mount(host,options){unmount();const shadow=host.attachShadow({mode:'open'}),style=document.createElement('style');style.textContent=css;shadow.append(style);const body=document.createElement('div');body.className='reader-mount';shadow.append(body);root=createRoot(body);root.render(<Page options={options}/>);}
export function unmount(){if(root){root.unmount();root=null;}}
