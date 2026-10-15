import React,{useEffect,useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import css from './prototype.css?inline';
import extra from './integration.css?inline';
let root;
function Library(props){
 const [payload,setPayload]=useState(null),[error,setError]=useState('');
 const current=useRef(null),alive=useRef(true);
 const remember=value=>{current.current=value;if(alive.current)setPayload(value)};
 async function load(){try{const result=await props.request('/api/knowledge/content');remember(result);if(alive.current)setError('')}catch(e){if(alive.current)setError('资料读取失败，请重试')}}
 async function sync(status){
  if(!alive.current)return;
  if(['xid','manual'].some(k=>status[k].version!==current.current?.packages[k].version)){await load();return}
  remember({...current.current,status});
 }
 async function action(kind,name){try{setError('');await sync(await props.request(`/api/knowledge/${kind}/${name}`,{method:'POST'}))}catch(e){if(alive.current)setError(e.message||'操作失败，请重试')}}
 useEffect(()=>{alive.current=true;load();return()=>{alive.current=false}},[]);
 const busy=payload&&Object.values(payload.status).some(v=>v.state.state==='working');
 useEffect(()=>{if(!busy)return;let stopped=false,running=false;const timer=setInterval(async()=>{if(stopped||running)return;running=true;try{const status=await props.request('/api/knowledge/status');if(!stopped)await sync(status)}catch(e){if(!stopped)setError('更新状态读取失败，请重试')}finally{running=false}},700);return()=>{stopped=true;clearInterval(timer)}},[busy]);
 if(!payload)return <div className="empty"><p>{error||'正在读取资料…'}</p>{error&&<button className="btn" onClick={load}>重试</button>}</div>;
 return <>{error&&<div className="library-error" role="status">{error}<button className="text-button" onClick={load}>重试</button></div>}<App {...props} packages={payload.packages} status={payload.status} onUpdate={action}/></>;
}
export function mount(host,options){
 if(root)root.unmount();
 const shadow=host.attachShadow({mode:'open'});
 const style=document.createElement('style');style.textContent=css+extra;shadow.append(style);
 const body=document.createElement('div');body.className='knowledge-mount';shadow.append(body);
 root=createRoot(body);root.render(<Library {...options}/>);
}
export function unmount(){if(root){root.unmount();root=null}}
