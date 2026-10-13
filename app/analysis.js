(function(root){
  'use strict';
  const available = value => {
    if(value === undefined || value === null)return false;
    const marker=String(value).trim().toLowerCase().replace(/^\[\s*(.*?)\s*\]$/,'$1');
    return !['','冲突','—','n/a','na','none','unknown','not specified','not available','not supported','to be filled by o.e.m.','default string','0'].includes(marker);
  };
  const identity = (gpu, field) => available(gpu[field]) ? (field === 'uuid' ? String(gpu[field]).trim().toLowerCase() : String(gpu[field]).trim()) : '';
  const eventKey = e => JSON.stringify([e.gpu ?? null, e.address || '', e.kind, e.code || '', e.kind === 'xid' ? '' : e.title || '']);
  function groupEvents(events){
    const groups = new Map();
    for(const event of events){
      const key = eventKey(event);
      if(!groups.has(key))groups.set(key,{key,events:[],first:event,last:event,clock:true,min:null,max:null});
      const group = groups.get(key);
      group.events.push(event);
      const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(event.time || '');
      const seconds = match ? Date.parse(match[1]+match[3]) : NaN;
      if(!Number.isFinite(seconds))group.clock=false;
      else {
        const time=BigInt(seconds)*1000000n+BigInt((match[2]||'').padEnd(9,'0').slice(0,9));
        if(group.min===null||time<group.min){group.min=time;group.first=event;}
        if(group.max===null||time>=group.max){group.max=time;group.last=event;}
      }
    }
    return [...groups.values()].map(group=>{
      if(!group.clock){group.first=group.events[0];group.last=group.events.at(-1);}
      const {key,events,first,last,clock}=group;
      return {key,events,first,last,clock,count:events.length};
    }).sort((a,b)=>b.count-a.count);
  }
  const fields = [['model','型号'],['sn','GPU SN'],['uuid','GPU UUID'],['pci','PCI 地址'],['slot','槽位参考'],['numa','NUMA 节点'],['link','当前链路'],['linkMax','最大能力'],['status','读取状态']];
  const provided=value=>value===0||String(value??'').trim()==='0'||available(value);
  function fieldSide(value,refs=[],key=''){
    const values=[...new Set(refs.map(r=>r.value).filter(provided).map(v=>String(v).trim()))];
    const ambiguous=values.length>1||['冲突','多个采集值','有冲突'].includes(String(value))||(key==='driver'&&String(value).includes(' / '));
    const text=values.length?values.join(' / '):provided(value)?String(value).trim():'';
    return {value:text,refs,provided:Boolean(text)||ambiguous,ambiguous};
  }
  function healthFields(g){
    if(g?.healthFields)return g.healthFields;
    const out={};for(const c of g?.healthCounters||[]){if(c.path.startsWith('MIG'))continue;(out[c.path]??=[]).push({value:c.value,evidence:c.evidence,origin:'nvidia-smi'});}return out;
  }
  function compareFields(before,after,a,b){
    const normalize=(value,key)=>(key==='uuid'||key.startsWith('health:'))?(key.startsWith('health:')&&/^\d+$/.test(value)?BigInt(value).toString():value.trim().toLowerCase()):['link','linkMax'].includes(key)?value.replace(/\d+(?:\.\d+)?/g,n=>String(Number(n))).replace(/\s+/g,'').toLowerCase():/^\d+$/.test(value)?BigInt(value).toString():value.trim();
    const entry=(key,label,av,bv,ar=[],br=[])=>{
      const left=fieldSide(av,ar,key),right=fieldSide(bv,br,key);
      if(['sn','uuid'].includes(key)){if(!available(left.value)&&!left.ambiguous)left.provided=false;if(!available(right.value)&&!right.ambiguous)right.provided=false;}
      const state=!left.provided||!right.provided?'missing':left.ambiguous||right.ambiguous?'ambiguous':normalize(left.value,key)!==normalize(right.value,key)?'changed':'same';
      return {key,label,before:left,after:right,state};
    };
    function refs(g,key,report){
      if(!g)return [];
      if(key==='driver')return report.server?.fields?.driver||[];
      if(key==='pci')return g.pciEvidence?[{value:g.pci,evidence:g.pciEvidence,origin:'lspci'}]:g.fields?.pci||[];
      const map={sn:'serial',uuid:'uuid',model:'model',numa:'numa',link:'link',linkMax:'link_max',slotPhysical:'slot',slotDesignation:'slotDesignation'};
      if(['sn','uuid','model'].includes(key))return g.fields?.[map[key]]||(key==='model'?g.pciFields?.pci_model:[])||[];
      return g.pciFields?.[map[key]]||[];
    }
    const base=fields.filter(([key])=>!['status','slot'].includes(key));
    const slots=a?.pciFields?.slot||a?.pciFields?.slotDesignation||b?.pciFields?.slot||b?.pciFields?.slotDesignation;
    base.push(...(slots?[['slotPhysical','物理槽位'],['slotDesignation','槽位名称']]:[['slot','槽位参考']]),['driver','驱动版本']);
    const result=base.map(([key,label])=>entry(key,label,key==='driver'?(a?before.server?.driver:''):a?.[key],key==='driver'?(b?after.server?.driver:''):b?.[key],refs(a,key,before),refs(b,key,after)));
    const ah=healthFields(a),bh=healthFields(b);
    const labels={'ECC Errors':'ECC','Volatile':'易失性','Aggregate':'累计','Double Bit':'双比特','Single Bit':'单比特','Device Memory':'显存','DRAM Uncorrectable':'DRAM 不可纠正','DRAM Correctable':'DRAM 可纠正','Remapped Rows':'行重映射','Correctable Error':'可纠正','Uncorrectable Error':'不可纠正','Pending':'待处理','Remapping Failure Occurred':'重映射失败','Retired Pages':'退役页'};
    for(const path of new Set([...Object.keys(ah),...Object.keys(bh)]))result.push(entry('health:'+path,path.split('/').map(p=>labels[p]||p).join(' / '),undefined,undefined,ah[path]||[],bh[path]||[]));
    return result.filter(f=>f.before.provided||f.after.provided);
  }
  function compareReports(before,after){
    const left=before.gpus || [],right=after.gpus || [];
    const index = list => Object.fromEntries(['sn','uuid'].map(field=>{
      const values=new Map();
      for(const g of list){const value=identity(g,field);if(value)values.set(value,(values.get(value)||0)+1);}
      return [field,values];
    }));
    const aIndex=index(left),bIndex=index(right),used=new Set(),rows=[];
    const conflicts=(a,b)=>['sn','uuid'].some(k=>a[k]==='冲突'||b[k]==='冲突'||(identity(a,k)&&identity(b,k)&&identity(a,k)!==identity(b,k)));
    function reason(g,others,own,other){
      if(['sn','uuid'].some(k=>g[k]==='冲突'))return '标识有冲突';
      if(others.some(o=>['sn','uuid'].some(k=>identity(g,k)&&identity(g,k)===identity(o,k))&&conflicts(g,o)))return '标识有冲突';
      if(['sn','uuid'].some(k=>identity(g,k)&&(own[k].get(identity(g,k))>1||other[k].get(identity(g,k))>1)))return '标识重复';
      return ['sn','uuid'].some(k=>identity(g,k))?'未找到相同标识':'缺少 SN / UUID';
    }
    const counts = report => {
      const map=new Map(),ids=new Set((report.gpus||[]).map(g=>g.id));
      for(const e of report.events||[]){
        const gpu=ids.has(e.gpu)?e.gpu:null,address=gpu===null?(e.address||''):'';
        if(!map.has(gpu))map.set(gpu,new Map());
        const bucket=map.get(gpu),key=JSON.stringify([e.kind,e.code||'',address]);
        if(!bucket.has(key))bucket.set(key,{kind:e.kind,code:e.code||'',address,count:0});
        bucket.get(key).count++;
      }
      return map;
    };
    const aCounts=counts(before),bCounts=counts(after);
    const mergedCounts=(a=new Map(),b=new Map())=>[...new Set([...a.keys(),...b.keys()])].map(key=>{
      const {kind,code,address}=a.get(key)||b.get(key);
      return {kind,code,address,before:a.get(key)?.count||0,after:b.get(key)?.count||0};
    });
    function row(a,b,basis,why){
      const details=compareFields(before,after,a,b);
      const changes=a&&b?details.filter(f=>f.state==='changed').map(f=>f.label):[];
      const ac=aCounts.get(a?.id)||new Map(),bc=bCounts.get(b?.id)||new Map();
      const errors=mergedCounts(ac,bc);
      if(errors.some(e=>e.before!==e.after))changes.push('错误记录');
      rows.push({before:a||null,after:b||null,basis,reason:why,changes,details,errors,matched:Boolean(a&&b)});
    }
    const candidatesByGpu=new Map(),rightCandidates=new Map();
    for(const a of left){
      const candidates=right.filter(b=>!conflicts(a,b)&&['sn','uuid'].some(k=>{
        const v=identity(a,k);return v&&v===identity(b,k)&&aIndex[k].get(v)===1&&bIndex[k].get(v)===1;
      }));
      candidatesByGpu.set(a,candidates);
      for(const b of candidates)rightCandidates.set(b,(rightCandidates.get(b)||0)+1);
    }
    for(const a of left){
      const candidates=candidatesByGpu.get(a);
      if(candidates.length===1&&rightCandidates.get(candidates[0])===1){
        const b=candidates[0];used.add(b);
        const basis=['sn','uuid'].filter(k=>identity(a,k)&&identity(a,k)===identity(b,k)&&aIndex[k].get(identity(a,k))===1&&bIndex[k].get(identity(b,k))===1).map(k=>k==='sn'?'SN':'UUID').join(' + ');
        row(a,b,basis,'');
      }else row(a,null,'',candidates.length?'匹配不唯一':reason(a,right,aIndex,bIndex));
    }
    for(const b of right)if(!used.has(b))row(null,b,'',rightCandidates.get(b)?'匹配不唯一':reason(b,left,bIndex,aIndex));
    const systemErrors=mergedCounts(aCounts.get(null),bCounts.get(null));
    const system={errors:systemErrors,before:systemErrors.reduce((n,e)=>n+e.before,0),after:systemErrors.reduce((n,e)=>n+e.after,0),changed:systemErrors.some(e=>e.before!==e.after)};
    return {rows,system,matched:rows.filter(r=>r.matched).length,changed:rows.filter(r=>r.matched&&r.changes.length).length,
      beforeOnly:rows.filter(r=>!r.after).length,afterOnly:rows.filter(r=>!r.before).length,
      serverMismatch:available(before.server?.sn)&&available(after.server?.sn)&&before.server.sn!==after.server.sn,
      incomplete:before.complete===false||after.complete===false};
  }
  function upstream(nodes,address){
    const path=[],seen=new Set([address]);let current=address;
    while(path.length<32){
      const matches=Object.values(nodes||{}).filter(n=>n.bridge&&n.address.split(':')[0]===current.split(':')[0]&&n.fields?.secondary?.length===1&&n.fields.secondary[0].value===current.split(':')[1]);
      if(matches.length!==1||seen.has(matches[0].address))break;
      current=matches[0].address;seen.add(current);path.unshift(current);
    }
    return path;
  }
  function pathErrorCount(report,gpu){
    const addresses=new Set([...upstream(report.nodes,gpu.pci),gpu.pci]);
    return (report.events||[]).filter(e=>addresses.has(e.address)).length;
  }
  const api={eventKey,groupEvents,compareReports,compareFields,fields,upstream,pathErrorCount};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.XidAnalysis=api;
})(globalThis);
