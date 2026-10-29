/* Counter changes require a documented common epoch; missing evidence is not zero. */
((root) => {
  'use strict';
  function calendar(value) {
    const raw=String(value || '').trim();
    const match=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/.exec(raw);
    if (!match) return null;
    const [,year,month,day,hour,minute,second,fraction='',zone]=match;
    if (+month<1||+month>12||+day<1||+day>new Date(Date.UTC(+year,+month,0)).getUTCDate()||+hour>23||+minute>59||+second>59) return null;
    if (zone!=='Z' && (+zone.slice(1,3)>23 || +zone.slice(-2)>59)) return null;
    const milliseconds=Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction.slice(0,4)}${zone}`);
    if (!Number.isFinite(milliseconds)) return null;
    const seconds=Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`);
    return {raw,milliseconds,nanoseconds:(BigInt(seconds)*1000000n+BigInt(fraction.slice(1).padEnd(9,'0'))).toString()};
  }
  function captureTime(report) {
    return calendar(report?.collectionTime?.raw || report?.server?.time);
  }
  function catalog(report) {
    const data=report?.catalog || {};
    return {origin:data.origin || '',file:data.file || '',sha256:data.sha256 || data.sourceSha256 || '',version:data.version || ''};
  }
  function identityField(record,field,sourceField=field) {
    const supplied=[record?.[field],...(record?.fields?.[sourceField]||[]).map(row=>row.value)];
    const markers=supplied.map(value=>String(value??'').trim().toLowerCase().replace(/^\[\s*(.*?)\s*\]$/,'$1'));
    const conflict=markers.some(value=>['冲突','多个采集值','有冲突'].includes(value));
    const missing=['','冲突','多个采集值','有冲突','—','n/a','na','none','unknown','not specified','not available','not supported','to be filled by o.e.m.','default string','0'];
    const values=[...new Set(supplied.filter((_,index)=>!missing.includes(markers[index])).map(value=>field==='uuid'?String(value).trim().toLowerCase():String(value).trim()))];
    return {values,conflict:conflict||values.length>1};
  }
  function deviceIdentity(row) {
    const pairs=['sn','uuid'].map(field=>[identityField(row.before,field,field==='sn'?'serial':field),identityField(row.after,field,field==='sn'?'serial':field)]);
    if (pairs.some(pair=>pair.some(side=>side.conflict))) return {status:'conflict',reasons:['GPU 身份字段存在多个值。']};
    if (!row.before||!row.after||!row.matched) return row.reason==='标识有冲突'?{status:'conflict',reasons:['GPU SN 与 UUID 的匹配结果冲突。']}:{status:'unmatched',reasons:['设备身份未唯一匹配。']};
    if (pairs.some(([a,b])=>a.values.length&&b.values.length&&a.values[0]!==b.values[0])) return {status:'conflict',reasons:['GPU 身份字段不一致。']};
    if (!pairs.some(([a,b])=>a.values.length===1&&b.values.length===1&&a.values[0]===b.values[0])) return {status:'unmatched',reasons:['缺少共同的 GPU SN 或 UUID。']};
    return {status:'matched',reasons:[]};
  }
  function sameDriver(before,after) {
    const values=[before,after].map(report=>identityField(report.server,'driver'));
    return values.every(side=>!side.conflict&&side.values.length===1&&!side.values[0].includes(' / '))&&values[0].values[0]===values[1].values[0];
  }
  function reportContext(before,after) {
    const a=captureTime(before),b=captureTime(after),ac=catalog(before),bc=catalog(after);
    const knownCatalog=Boolean(ac.sha256&&bc.sha256),catalogChanged=knownCatalog&&ac.sha256!==bc.sha256;
    const timeRelation=!a||!b?'unknown':BigInt(b.nanoseconds)>BigInt(a.nanoseconds)?'forward':BigInt(b.nanoseconds)<BigInt(a.nanoseconds)?'reversed':'same';
    const machines=['sn','uuid'].map(field=>[identityField(before.server,field),identityField(after.server,field)]);
    const serverIdentityConflict=machines.some(pair=>pair.some(side=>side.conflict));
    const serverMismatch=machines.some(([a,b])=>!a.conflict&&!b.conflict&&a.values.length===1&&b.values.length===1&&a.values[0]!==b.values[0]);
    const warnings=[];
    if (timeRelation==='unknown') warnings.push('采集时间缺失、包含多个时点或未记录时区，无法确认前后顺序。');
    if (timeRelation==='reversed') warnings.push('当前报告早于基准报告，请核对报告顺序。');
    if (timeRelation==='same') warnings.push('两份报告采集时点相同；字段差异不能直接解释为新增变化。');
    if (catalogChanged) warnings.push('规则版本不同；原始采集值变化与规则解释变化分别核对。');
    if (!knownCatalog) warnings.push('至少一份报告未记录规则校验值，规则版本是否相同无法确认。');
    if (before.complete===false||after.complete===false) warnings.push('存在读取不完整的报告，计数覆盖范围不完整。');
    if (serverIdentityConflict) warnings.push('机器身份字段存在多个值，来源需核对。');
    if (serverMismatch) warnings.push('机器 SN 或 UUID 不一致。');
    return {beforeTime:a,afterTime:b,timeRelation,beforeCatalog:ac,afterCatalog:bc,catalogChanged,catalogKnown:knownCatalog,serverIdentityConflict,serverMismatch,warnings};
  }
  function scopeFor(path) {
    if (/(?:^|\/)Volatile(?:\/|$)/i.test(path)) return 'volatile';
    if (/(?:^|\/)Aggregate(?:\/|$)/i.test(path)) return 'aggregate';
    return 'unknown';
  }
  function fieldOrigins(side) {
    return [...new Set((side?.refs||[]).map(ref=>String(ref.origin || '').trim().toLowerCase().replace(/^nvidia[-_ ]smi(?:\s+-q)?$/,'nvidia-smi')).filter(Boolean))].sort();
  }
  function numeric(side) {
    if (!side?.provided||side.ambiguous||!/^\d+$/.test(String(side.value))) return null;
    if ([side.value,...(side.refs||[]).map(ref=>ref.value)].some(value=>typeof value==='number'&&!Number.isSafeInteger(value))) return null;
    try {return BigInt(side.value);} catch {return null;}
  }
  function periodFor(report,gpu,path) {
    const map=gpu?.counterEpochs || report?.counterEpochs?.[gpu?.uuid] || report?.counterEpochs?.[gpu?.pci] || {};
    const period=map[path];
    // A boot marker or unchanged driver string alone cannot prove no counter reset.
    if (!period || typeof period!=='object' || period.verified!==true || !period.id ||
        !['volatile','aggregate'].includes(period.scope) || !period.origin ||
        !Number.isInteger(period.evidence?.line) || period.evidence.line<1) return null;
    return period;
  }
  function resetEvidence(report,gpu,scope) {
    return [...(report?.events||[]),...(report?.lifecycleEvents||[])].filter(event=>{
      if (['driver_load','driver_reload'].includes(event.kind)) return scope==='volatile';
      if (!['reset','counter_reset'].includes(event.kind)) return false;
      if (event.targetUUID) return Boolean(gpu?.uuid)&&event.targetUUID.toLowerCase()===gpu.uuid.toLowerCase();
      if (event.address) return event.address===gpu?.pci;
      if (event.gpu!=null) return event.gpu===gpu?.id;
      return true;
    }).map(event=>({...event,reportId:event.reportId||report?.id||'',source:event.source||report?.source||''}));
  }
  function resetLookup(report) {
    const byUuid=new Map(),byAddress=new Map(),byGpu=new Map(),global=[],drivers=[],memo=new Map();
    let order=0;
    for (const source of [report?.events||[],report?.lifecycleEvents||[]]) for (const event of source) {
      const current=order++,kind=event.kind;
      if (!['driver_load','driver_reload','reset','counter_reset'].includes(kind)) continue;
      const entry={order:current,event:{...event,reportId:event.reportId||report?.id||'',source:event.source||report?.source||''}};
      if (kind==='driver_load'||kind==='driver_reload') {drivers.push(entry);continue;}
      let index,key;
      if (event.targetUUID) {index=byUuid;key=event.targetUUID.toLowerCase();}
      else if (event.address) {index=byAddress;key=event.address;}
      else if (event.gpu!=null) {index=byGpu;key=event.gpu;}
      else {global.push(entry);continue;}
      if (!index.has(key)) index.set(key,[]);
      index.get(key).push(entry);
    }
    return (gpu,scope)=>{
      if (!memo.has(gpu)) memo.set(gpu,new Map());
      const cached=memo.get(gpu);
      if (!cached.has(scope)) {
        const rows=[...global,...(scope==='volatile'?drivers:[]),...(byUuid.get(gpu?.uuid?.toLowerCase())||[]),
          ...(byAddress.get(gpu?.pci)||[]),...(byGpu.get(gpu?.id)||[])];
        rows.sort((a,b)=>a.order-b.order);
        cached.set(scope,rows.map(row=>row.event));
      }
      return cached.get(scope);
    };
  }
  function resetWindow(records,ctx) {
    const relevant=[],outside=[];
    for (const event of records) {
      const raw=event.timeInfo?.raw||event.evidence?.time?.raw||(typeof event.time==='object'?event.time.raw:event.time)||'';
      const prefix=/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2}))(?=$|\s)/.exec(event.raw||'');
      const time=calendar(raw)||calendar(prefix?.[1]);
      const excluded=ctx.timeRelation==='forward'&&time&&(BigInt(time.nanoseconds)<BigInt(ctx.beforeTime.nanoseconds)||BigInt(time.nanoseconds)>BigInt(ctx.afterTime.nanoseconds));
      (excluded?outside:relevant).push(event);
    }
    return {relevant,outside};
  }
  function checkField(before,after,row,detail,ctx,resetsFor,identity=deviceIdentity(row)) {
    const path=detail.key?.startsWith('health:')?detail.key.slice(7):'';
    const result={kind:path?'counter':'field',scope:scopeFor(path),comparable:false,delta:null,reasons:[],notes:[]};
    if (!path) {result.kind='field';result.reasons.push('显示字段前后值，不计算计数增量。');return result;}
    if (/(?:^|\/)(?:Pending|Remapping Failure Occurred|Mode|Enabled|Supported)$/i.test(path)) {
      result.kind='state';result.reasons.push('状态字段按前后值核对，不计算增量。');return result;
    }
    result.reasons.push(...identity.reasons);
    if (detail.state==='missing'||!detail.before?.provided||!detail.after?.provided) result.reasons.push('前后至少一侧缺少采集值。');
    if (detail.state==='ambiguous'||detail.before?.ambiguous||detail.after?.ambiguous) result.reasons.push('字段含多个采集值，无法选择唯一计数。');
    const av=numeric(detail.before),bv=numeric(detail.after);
    if ((av===null||bv===null)&&detail.before?.provided&&detail.after?.provided&&!detail.before?.ambiguous&&!detail.after?.ambiguous) result.reasons.push('缺少唯一的非负整数计数。');
    if (ctx.timeRelation!=='forward') result.reasons.push(ctx.timeRelation==='reversed'?'当前采集时间早于基准。':ctx.timeRelation==='same'?'采集时间相同。':'无法确认带时区的采集先后。');
    if (before.complete===false||after.complete===false) result.reasons.push('报告读取不完整。');
    if (ctx.serverMismatch) result.reasons.push('机器身份不一致。');
    if (ctx.serverIdentityConflict) result.reasons.push('机器身份字段存在多个值。');
    const originsBefore=fieldOrigins(detail.before),originsAfter=fieldOrigins(detail.after);
    if (!originsBefore.length||!originsAfter.length||JSON.stringify(originsBefore)!==JSON.stringify(originsAfter)) result.reasons.push('字段来源未明确或不一致。');
    const ap=periodFor(before,row.before,path),bp=periodFor(after,row.after,path);
    result.beforePeriod=ap;result.afterPeriod=bp;
    if (result.scope==='unknown') result.reasons.push('计数统计周期未明确。');
    else if (!ap||!bp) result.reasons.push(result.scope==='volatile'?'缺少同一易失性计数周期的连续性证据。':'缺少同一累计计数周期及未清零的证据。');
    else if (ap.id!==bp.id||ap.scope!==result.scope||bp.scope!==result.scope||ap.origin!==bp.origin) result.reasons.push('计数周期或周期证据来源不同，不能计算增量。');
    const resets=resetsFor?resetsFor(row,result.scope):resetWindow([...resetEvidence(before,row.before,result.scope),...resetEvidence(after,row.after,result.scope)],ctx);
    if (resets.relevant.length) {result.reasons.push('存在重置尝试或驱动加载记录，计数边界待核对。');result.resetEvidence=resets.relevant;}
    if (resets.outside.length) result.excludedResetEvidence=resets.outside;
    if (result.scope==='volatile' && !sameDriver(before,after)) result.reasons.push('易失性计数的驱动版本未确认一致。');
    if (av!==null&&bv!==null&&bv<av) result.reasons.push('计数下降，可能存在清零、重置或采集范围差异。');
    if (ctx.catalogChanged) result.notes.push('规则版本变化不作为原始计数变化。');
    result.reasons=[...new Set(result.reasons)];
    if (!result.reasons.length) {
      result.comparable=true;result.delta=(bv-av).toString();
      result.notes.push('增量以记录的共同计数周期和采集时点为条件。');
    }
    return result;
  }
  function assess(before,after,existing) {
    const base=existing || (root.XidAnalysis || (typeof require==='function'?require('./analysis.js'):null))?.compareReports(before,after);
    if (!base) throw new Error('缺少设备身份对比结果');
    const ctx=reportContext(before,after);
    const beforeResets=resetLookup(before),afterResets=resetLookup(after),memo=new Map();
    const resetsFor=(row,scope)=>{
      if (!memo.has(row)) memo.set(row,new Map());
      if (!memo.get(row).has(scope)) memo.get(row).set(scope,resetWindow([...beforeResets(row.before,scope),...afterResets(row.after,scope)],ctx));
      return memo.get(row).get(scope);
    };
    const rows=base.rows.map(row=>{
      const identity=deviceIdentity(row);
      return {...row,identity,details:(row.details||[]).map(detail=>({...detail,comparison:checkField(before,after,row,detail,ctx,resetsFor,identity)})),
        eventComparison:{comparable:false,reason:'记录条数受日志时间范围、重复采集及筛选影响，前后条数差不等于新增事件。'}};
    });
    return {...base,rows,context:ctx,counterComparable:rows.flatMap(row=>row.details).filter(detail=>detail.comparison.comparable).length};
  }
  const api={assess,reportContext,checkField,calendar,scopeFor};
  if (typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.XidComparison=api;
})(globalThis);
