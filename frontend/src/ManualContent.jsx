import React,{useState} from 'react';
import data from './catalog.json';
import {topics,sources} from './manuals';
import {paths} from './icons';
const External=()=> <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths.external}/></svg>;

function Extract({code}){
 const item=data.cn.codes[code];
 const actions=[...new Map(item.actions.map(a=>[a.text,a])).values()];
 return <details className="manual-extract"><summary>Xid {code} · 完整目录说明</summary>
 {item.description&&<p className="prose">{item.description}</p>}
 {actions.map((a,i)=><section key={i}><h4>{a.label}</h4><p className="prose">{a.text}</p></section>)}
 <p className="extract-source">中文译本 · 2026-09-09 · Xids 第 {item.row} 行</p></details>
}
export default function ManualContent({current,onTopic,onXid,onNotice}){
 const [branch,setBranch]=useState(0);
 const selected=current.branches?.[branch];
 async function copy(code){try{await navigator.clipboard.writeText(code);onNotice('已复制命令')}catch{onNotice('复制失败，请选中命令复制')}}
 return <div className="manual-content">
 <div className="manual-scope"><span>适用与前提</span><p>{current.scope}</p></div>
 <div className="steps">{current.steps.map(([title,text],i)=><section key={title}><span className="step-number">{String(i+1).padStart(2,'0')}</span><div><h3>{title}</h3><p>{text}</p></div></section>)}</div>
 {current.branches&&<section className="manual-section"><h3>按错误组合查看</h3><div className="branch-tabs" role="group" aria-label="ECC 错误分支">{current.branches.map((b,i)=><button key={b.label} aria-pressed={i===branch} onClick={()=>setBranch(i)}>Xid {b.label}</button>)}</div><div className="branch-content"><h3>{selected.title}</h3><p>{selected.text}</p>{selected.extra&&<div className="note"><strong>A100 平台补充</strong>{selected.extra}<a href={sources.triage[1]} target="_blank" rel="noreferrer">平台表原文<External/></a></div>}<Extract key={selected.code} code={selected.code}/></div></section>}
 {current.table&&<section className="manual-section"><h3>{current.table.title}</h3><table className="manual-table"><thead><tr>{current.table.head.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{current.table.rows.map(([a,b])=><tr key={a}><th scope="row">{a}</th><td>{b}</td></tr>)}</tbody></table></section>}
 {current.note&&<div className="note">{current.note}</div>}
 {current.commands?.map(c=><section className="command-block" key={c.code}><div><h3>{c.title}</h3><button className="text-button" aria-label={'复制命令：'+c.title} onClick={()=>copy(c.code)}>复制</button></div><pre><code>{c.code}</code></pre><p>{c.note}</p></section>)}
 {current.extracts&&<section className="manual-section"><h3>详细说明</h3>{current.extracts.map(code=><Extract key={code} code={code}/>)}</section>}
 <section className="manual-section manual-next"><h3>继续查看</h3><div className="chip-row">{current.next.map(id=><button key={id} className="btn" onClick={()=>onTopic(id)}>{topics.find(t=>t.id===id).title}</button>)}</div></section>
 {current.related.length>0&&<section className="manual-section"><h3>相关 Xid</h3><div className="chip-row">{current.related.map(k=><button className="text-button xid-link" key={k} onClick={()=>onXid(k)}>Xid {k}</button>)}</div></section>}
 <div className="manual-sources"><span>来源 · 核对于 2026-10-14</span>{current.refs.map(k=><a key={k} href={sources[k][1]} target="_blank" rel="noreferrer">{sources[k][0]}<External/></a>)}</div>
 </div>
}
