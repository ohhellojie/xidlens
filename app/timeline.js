/* Time domains remain separate until their source supplies an explicit anchor. */
((root) => {
  'use strict';
  const eventTools=typeof module!=='undefined'&&module.exports?require('./analysis.js'):root.XidAnalysis;
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const kindLabels={xid:'Xid',aer:'PCIe AER',ecc:'ECC 错误',channel:'通道超时',fallen:'GPU 不可访问',smi_error:'nvidia-smi 错误',lockup:'内核软锁死',mods:'MODS 错误',thermal:'温度告警',init:'初始化记录',reset:'重置记录',counter_reset:'计数清零',driver_load:'驱动加载',driver_reload:'驱动重载',recovery:'恢复记录',snapshot:'状态快照',sxid:'SXid',dcgm:'DCGM',goe:'GOE',unknown:'未分类文本',text:'文本记录',log:'文本记录'};
  const timeLabels={calendar:'带时区的日历时间','calendar-unzoned':'日历时间，时区未记录','calendar-partial':'年份或时区未记录',uptime:'启动后秒数',unknown:'时间未记录'};
  const defaults=identity=>({identity,device:'all',kind:'all',clock:'all',from:'',to:'',query:'',mode:'records',page:0,selected:'',group:'',memberPage:0,evidencePage:0});
  const state=defaults(''),views=new Map();
  const PAGE_SIZE=100;
  let context={},activeModel=null,lastReport=null,cache=null,filterCache=null;
  const identityOf=report=>report?.manifest?.id?'session:'+report.manifest.id:'case:'+(report?.id||report?.source||'');
  function remember() {
    if (!state.identity) return;
    views.delete(state.identity);views.set(state.identity,{...state});
    while (views.size>64) views.delete(views.keys().next().value);
  }
  function capture(identity=state.identity) {
    const value=identity===state.identity?state:views.get(identity);
    return value?{...value}:null;
  }
  function restore(value,identity=state.identity) {
    if (!value||value.identity!==identity||typeof identity!=='string') return false;
    const saved=defaults(identity);
    for (const key of ['device','kind','clock','from','to','query','selected','group']) if (typeof value[key]==='string') saved[key]=value[key].slice(0,key==='group'?16384:4000);
    saved.mode=value.mode==='groups'?'groups':'records';
    for (const key of ['page','memberPage','evidencePage']) if (Number.isSafeInteger(value[key])&&value[key]>=0) saved[key]=value[key];
    views.set(identity,saved);
    if (state.identity===identity) {Object.assign(state,saved);filterCache=null;}
    return true;
  }

  function clock(value) {
    const raw=String(value??'').trim();
    let match=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?(?=$|\s)/.exec(raw);
    if (match) {
      const [,y,mo,d,h,mi,s,fraction='',zone]=match;
      if (+mo<1||+mo>12||+d<1||+d>new Date(Date.UTC(+y,+mo,0)).getUTCDate()||+h>23||+mi>59||+s>59) return {kind:'unknown',raw,order:null};
      if (!zone) return {kind:'calendar-unzoned',raw:match[0].trim(),order:null};
      if (+zone.slice(1,3)>23||+zone.slice(-2)>59) return {kind:'unknown',raw,order:null};
      const milliseconds=Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
      if (!Number.isFinite(milliseconds)) return {kind:'unknown',raw,order:null};
      return {kind:'calendar',raw:match[0].trim(),order:(BigInt(milliseconds)*1000000n+BigInt(fraction.padEnd(9,'0').slice(0,9))).toString()};
    }
    match=/^(?:\[\s*)?(\d+\.\d+)(?:\])?(?=$|\s)/.exec(raw);
    if (match) return {kind:'uptime',raw:match[1],order:match[1]};
    match=/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d/.exec(raw);
    if (match) return {kind:'calendar-partial',raw:match[0],order:null};
    return {kind:'unknown',raw:raw==='—'?'':raw,order:null};
  }
  function recordClock(record) {
    const provided=record.timeInfo?.raw||record.evidence?.time?.raw||record.time;
    if ((record.timeInfo?.kind||record.evidence?.time?.kind)==='uptime_seconds'&&/^\d+(?:\.\d+)?$/.test(String(provided))) return {kind:'uptime',raw:String(provided),order:String(provided)};
    let parsed=clock(provided);
    if (parsed.kind==='unknown') {
      const fromRaw=clock(record.raw||record.evidence?.text);
      if (fromRaw.kind!=='unknown') parsed=fromRaw;
    }
    return parsed;
  }
  function label(row) {
    return ['xid','sxid','goe'].includes(row.kind)?eventTools.eventTitle(row):row.title||kindLabels[row.kind]||row.kind;
  }
  function model(report) {
    const input=report?.view||report||{},defaultId=report?.id||report?.manifest?.id||report?.source||'current';
    const rows=[...(input.events||[]).map(event=>({event,category:'event'})),...(input.lifecycleEvents||[]).map(event=>({event,category:'lifecycle'}))];
    const records=rows.map(({event,category},index)=>({...event,id:category+':'+(event.id||index),sourceEventId:event.id,
      source:event.source||report.source||'',reportId:event.reportId||report.id||'',
      sourceKey:event.reportId||report.id||event.source||defaultId,ordinal:index,clock:recordClock(event),
      boot:event.boot||event.timeInfo?.boot||null}));
    for (const snapshot of input.snapshots||input.diagnostics?.snapshots||[]) {
      const evidence=snapshot.evidence||{};
      const reportId=snapshot.reportId||report.id||'',sourceKey=reportId||defaultId;
      records.push({id:'snapshot:'+snapshot.id,snapshotId:snapshot.id,kind:'snapshot',title:'GPU 状态快照',address:snapshot.address,
        source:snapshot.source||report.source||'',sourceMember:snapshot.sourceMember,reportId,sourceKey,line:evidence.line||snapshot.line||0,
        raw:evidence.text||'GPU '+snapshot.address,boot:evidence.boot_marker||null,clock:recordClock({evidence}),
        fields:snapshot.fields||[],ordinal:records.length});
    }
    const bySource=new Map(),deviceIndex=new Map();
    for (const device of input.devices||input.gpus||[]) {
      const sourceKey=device.reportId||report.id||defaultId;
      for (const key of [sourceKey+'|id:'+device.id,sourceKey+'|pci:'+device.pci]) {
        if (!deviceIndex.has(key)) deviceIndex.set(key,[]);
        deviceIndex.get(key).push(device);
      }
    }
    for (const row of records) {
      const namespace=eventTools.eventNamespace(row),target=row.targetUUID||row.structured?.deviceUUID||'';
      const candidates=namespace==='nvswitch'||(row.kind==='goe'&&row.gpu==null)?[]:deviceIndex.get(row.sourceKey+(row.gpu!=null?'|id:'+row.gpu:'|pci:'+row.address))||[];
      const device=candidates.length===1?candidates[0]:null;
      row.deviceKey=namespace==='nvswitch'?String(row.sourceKey)+'|nvswitch|'+(row.address||''):
        row.deviceKey||device?.key||String(row.sourceKey)+'|'+(device?.pci||target||row.address||'');
      row.deviceLabel=namespace==='nvswitch'?'NVSwitch'+(row.structured?.switch==null?'':' '+row.structured.switch)+(row.address?' · '+row.address:''):device?.pci||target||row.address||'';
      if (!bySource.has(row.sourceKey)) bySource.set(row.sourceKey,[]);
      bySource.get(row.sourceKey).push(row);
    }
    const segments=[],ordered=[];
    for (const [sourceKey,sourceRows] of bySource) {
      sourceRows.sort((a,b)=>(a.line>0?a.line:Number.MAX_SAFE_INTEGER)-(b.line>0?b.line:Number.MAX_SAFE_INTEGER)||a.ordinal-b.ordinal);
      let segment=null,previous=null;
      for (const row of sourceRows) {
        const bootChanged=previous&&previous.boot!==row.boot;
        const rewind=previous&&previous.clock.kind==='uptime'&&row.clock.kind==='uptime'&&Number(row.clock.order)<Number(previous.clock.order);
        // Generic reboot delimiters do not carry a unique boot ID. Keep entries separate.
        const genericReboot=row.boot==='-- Reboot --';
        if (!segment||bootChanged||rewind||genericReboot) {
          segment={id:'segment:'+segments.length,sourceKey,source:row.source,reportId:row.reportId,boot:row.boot,
            reason:rewind?'启动后时间回退，分段核对':genericReboot?'重启分隔符缺少唯一启动标识':bootChanged?'启动标识变化':row.boot?'按启动标识分段':'启动标识未记录',records:[]};
          segments.push(segment);
        }
        row.segmentId=segment.id;segment.records.push(row);previous=row;
      }
    }
    for (const segment of segments) {
      segment.order=segment.records.every(row=>row.clock.kind==='calendar')?'calendar':'source';
      const domains=new Set(segment.records.map(row=>row.clock.kind));
      segment.orderReason=segment.order==='calendar'?'段内日历时间排序':domains.size>1?'时间类型不同，按原文顺序':domains.has('uptime')?'缺少日历锚点，按原文顺序':domains.has('calendar-unzoned')?'时区未记录，按原文顺序':domains.has('calendar-partial')?'年份或时区未记录，按原文顺序':'时间未记录，按原文顺序';
      if (segment.order==='calendar') segment.records.sort((a,b)=>BigInt(a.clock.order)<BigInt(b.clock.order)?-1:BigInt(a.clock.order)>BigInt(b.clock.order)?1:a.ordinal-b.ordinal);
      ordered.push(...segment.records);
    }
    const devices=[...new Map(ordered.map(row=>[row.deviceKey,{key:row.deviceKey,address:row.deviceLabel,source:row.source}])).values()];
    return {records:ordered,segments,segmentIndex:new Map(segments.map(segment=>[segment.id,segment])),multipleSources:new Set(segments.map(segment=>segment.source)).size>1,
      devices,kinds:[...new Set(ordered.map(row=>row.kind))],count:ordered.length};
  }
  function pattern(raw) {
    return String(raw||'').slice(0,8192)
      .replace(/^\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?\s*/,'')
      .replace(/^\[\s*\d+\.\d+\]\s*/,'')
      .replace(/\bGPU-[\da-f-]+\b/gi,'<uuid>')
      .replace(/\b(?:[\da-f]{4,8}:)?[\da-f]{2}:[\da-f]{2}\.[0-7]\b/gi,'<pci>')
      .replace(/\b0x[\da-f]+\b/gi,'<hex>')
      .replace(/\b\d+(?:\.\d+)?\b/g,'<n>').replace(/\s+/g,' ').trim();
  }
  function group(records) {
    const groups=new Map();
    for (const row of records) {
      const heuristic=['unknown','text','log'].includes(row.kind),template=heuristic?pattern(row.raw):'';
      const severity=row.kind==='aer'?(/severity=([^,]+)/i.exec(row.raw||'')?.[1]||row.title||''):'';
      const key=JSON.stringify([row.segmentId,row.clock.kind,row.deviceKey,eventTools.eventNamespace(row),row.kind,eventTools.eventType(row),severity,row.outcome||'',row.recoveryAction?.current||null,
        ['sxid','goe'].includes(row.kind)?[row.structured?.severityDomain,row.structured?.severity,row.structured?.scope,row.structured?.link]:null,
        row.kind==='snapshot'?row.id:heuristic?template:['xid','sxid','goe'].includes(row.kind)?'':row.title||'']);
      if (!groups.has(key)) groups.set(key,{key,records:[],first:row,last:row,heuristic,template});
      const item=groups.get(key);item.records.push(row);item.last=row;
    }
    return [...groups.values()].map(item=>({...item,count:eventTools.countEvents(item.records),recordCount:item.records.length}));
  }
  function filtered(data,filters=state) {
    const query=String(filters.query||'').trim().toLowerCase(),from=String(filters.from||'').trim(),to=String(filters.to||'').trim();
    let low=null,high=null,error='';
    if (from||to) {
      if (filters.clock==='calendar') {
        const a=from?clock(from):null,b=to?clock(to):null;
        if ((a&&a.kind!=='calendar')||(b&&b.kind!=='calendar')) error='日历时间范围须包含完整日期和时区。';
        else {low=a?.order==null?null:BigInt(a.order);high=b?.order==null?null:BigInt(b.order);}
      } else if (filters.clock==='uptime') {
        if ((from&&!/^\d+(?:\.\d+)?$/.test(from))||(to&&!/^\d+(?:\.\d+)?$/.test(to))) error='启动后时间范围须为非负秒数。';
        else {low=from?Number(from):null;high=to?Number(to):null;if ((low!==null&&!Number.isFinite(low))||(high!==null&&!Number.isFinite(high))) error='时间范围超出可用数值范围。';}
      } else error='请先选择带时区的日历时间或启动后秒数，再设置时间范围。';
      if (!error&&low!==null&&high!==null&&low>high) error='开始时间不能晚于结束时间。';
    }
    const rows=data.records.filter(row=>{
      if (filters.device!=='all'&&filters.device&&row.deviceKey!==filters.device) return false;
      if (filters.kind!=='all'&&filters.kind&&row.kind!==filters.kind) return false;
      if (filters.clock!=='all'&&filters.clock&&row.clock.kind!==filters.clock) return false;
      if (query&&!`${row.raw} ${label(row)} ${row.address} ${row.targetUUID||''} ${row.source}`.toLowerCase().includes(query)) return false;
      if (!error&&(low!==null||high!==null)) {
        const value=filters.clock==='calendar'?BigInt(row.clock.order):Number(row.clock.order);
        if ((low!==null&&value<low)||(high!==null&&value>high)) return false;
      }
      return true;
    });
    return {records:rows,error};
  }
  function source(row) {
    if (!Number.isInteger(row.line)||row.line<1) return '<span class="source-meta">原始行号未记录</span>';
    return `<button class="link-btn" data-timeline="source" data-value="${esc(row.id)}">${esc(row.source||'原日志')} · 第 ${row.line} 行 ${context.icon?.('external','small-icon')||''}</button>`;
  }
  function pager(length,key='page') {
    if (length<=PAGE_SIZE) return '';
    const page=state[key];
    return `<nav class="timeline-pager" aria-label="${key==='memberPage'?'组内原始记录分页':key==='evidencePage'?'来源记录分页':'时间线分页'}"><span>${page*PAGE_SIZE+1}–${Math.min((page+1)*PAGE_SIZE,length)} / ${length}</span><div><button class="btn" data-timeline="${key}" data-value="${page-1}" ${page===0?'disabled':''}>上一页</button><button class="btn" data-timeline="${key}" data-value="${page+1}" ${(page+1)*PAGE_SIZE>=length?'disabled':''}>下一页</button></div></nav>`;
  }
  function evidenceSources(row) {
    const refs=eventTools.sourceEvidence(row);
    if (!refs.length) return source(row);
    state.evidencePage=Math.min(state.evidencePage,Math.max(0,Math.ceil(refs.length/PAGE_SIZE)-1));
    return `<div class="timeline-evidence">${refs.slice(state.evidencePage*PAGE_SIZE,(state.evidencePage+1)*PAGE_SIZE).map((ref,index)=>`<div>${ref.line>0?`<button class="link-btn" data-timeline="evidence" data-value="${esc(row.id)}" data-evidence-index="${state.evidencePage*PAGE_SIZE+index}">${esc(ref.source||'原日志')} · 第 ${ref.line}${ref.endLine>ref.line?'–'+ref.endLine:''} 行</button>`:'<span class="source-meta">原始行号未记录</span>'}${ref.jsonPointer?`<small class="mono">${esc(ref.jsonPointer)}</small>`:''}</div>`).join('')}</div>${pager(refs.length,'evidencePage')}`;
  }
  function detail(row) {
    if (!row) return '<div class="live-empty"><h2>没有匹配记录</h2></div>';
    const metadata=eventTools.eventMetadata(row).map(([key,value])=>`<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
    const action=row.recoveryAction?`<dt>恢复动作</dt><dd>${esc(row.recoveryAction.previous?.label)} → ${esc(row.recoveryAction.current?.label)}</dd>`:'';
    const time=row.clock.raw?`${esc(row.clock.raw)}<small>${esc(timeLabels[row.clock.kind])}</small>`:esc(timeLabels[row.clock.kind]);
    return `<h2>${esc(label(row))}</h2><p class="mono">${esc(row.deviceLabel||row.address||row.targetUUID||'报告')}</p><dl class="timeline-meta"><dt>时间</dt><dd>${time}</dd><dt>启动区间</dt><dd>${esc(row.boot||'标识未记录')}</dd>${action}${metadata}</dl>${row.kind==='snapshot'?`<p>${row.fields.length} 个状态字段</p><div class="timeline-snapshot-fields">${row.fields.slice(0,12).map(field=>`<div><span>${esc(field.path||field.name)}</span><strong>${esc(field.value)}</strong></div>`).join('')}</div>${row.fields.length>12?'<p class="source-meta">其余字段见原文。</p>':''}`:`<pre>${esc(row.raw||'')}</pre>`}${row.truncated?'<p class="source-meta">原文预览已截断，完整内容见来源。</p>':''}${evidenceSources(row)}${row.kind==='reset'&&row.outcome==='completed'?'<p class="source-meta">恢复情况需结合后续验证。</p>':''}`;
  }
  function render(report,ctx={}) {
    context=ctx;
    if (lastReport!==report) {cache=model(report);lastReport=report;filterCache=null;}
    activeModel=cache;
    const identity=identityOf(report);
    if (state.identity!==identity) {remember();Object.assign(state,views.get(identity)||defaults(identity));filterCache=null;}
    const filterKey=JSON.stringify([state.device,state.kind,state.clock,state.from,state.to,state.query]);
    if (filterCache?.key!==filterKey) filterCache={key:filterKey,result:filtered(activeModel),groups:null};
    const filteredResult=filterCache.result,rows=filteredResult.records;
    const groups=state.mode==='groups'?(filterCache.groups??=group(rows)):[],items=state.mode==='groups'?groups:rows;
    state.page=Math.max(0,Math.min(state.page,Math.max(0,Math.ceil(items.length/PAGE_SIZE)-1)));
    const visible=items.slice(state.page*PAGE_SIZE,(state.page+1)*PAGE_SIZE);
    let selected,selectedGroup;
    if (state.mode==='groups') {
      selectedGroup=visible.find(item=>item.key===state.group)||visible[0];state.group=selectedGroup?.key||'';
      const members=selectedGroup?.records||[];
      state.memberPage=Math.max(0,Math.min(state.memberPage,Math.max(0,Math.ceil(members.length/PAGE_SIZE)-1)));
      const pageMembers=members.slice(state.memberPage*PAGE_SIZE,(state.memberPage+1)*PAGE_SIZE);
      selected=pageMembers.find(row=>row.id===state.selected)||pageMembers[0];
    } else selected=visible.find(row=>row.id===state.selected)||visible[0];
    state.selected=selected?.id||'';
    const empty=!activeModel.count;
    const limits=[...new Set((report?.view?.warnings||[]).filter(warning=>warning.kind==='limit').map(warning=>warning.message))];
    const filters=`<div class="timeline-filters"><label>设备<select class="select" data-timeline-change="device" aria-label="筛选时间线设备"><option value="all">全部设备</option>${activeModel.devices.map(device=>`<option value="${esc(device.key)}" ${state.device===device.key?'selected':''}>${esc(device.address||'报告')}${activeModel.multipleSources?' · '+esc(device.source):''}</option>`).join('')}</select></label><label>类型<select class="select" data-timeline-change="kind" aria-label="筛选时间线类型"><option value="all">全部类型</option>${activeModel.kinds.map(kind=>`<option value="${esc(kind)}" ${state.kind===kind?'selected':''}>${esc(kindLabels[kind]||kind)}</option>`).join('')}</select></label><label>时间<select class="select" data-timeline-change="clock" aria-label="筛选时间类型"><option value="all">全部时间类型</option>${Object.entries(timeLabels).map(([key,text])=>`<option value="${key}" ${state.clock===key?'selected':''}>${text}</option>`).join('')}</select></label><label class="timeline-search">搜索<input class="select" type="search" id="timeline-query" data-timeline-input="query" aria-label="搜索时间线" value="${esc(state.query)}" placeholder="内容、代码或来源"></label></div>`;
    const ranges=['calendar','uptime'].includes(state.clock)?`<div class="timeline-range"><label>开始<input class="select" id="timeline-from" data-timeline-input="from" aria-label="开始时间" value="${esc(state.from)}" placeholder="${state.clock==='uptime'?'0.000':'完整日期、时间和时区'}"></label><label>结束<input class="select" id="timeline-to" data-timeline-input="to" aria-label="结束时间" value="${esc(state.to)}" placeholder="${state.clock==='uptime'?'120.000':'完整日期、时间和时区'}"></label><span class="source-meta">${state.clock==='uptime'?'各启动区间分别筛选，保留分段。':'仅筛选带时区的日历时间。'}</span></div>`:'';
    const toolbar=`<div class="timeline-toolbar"><span>${rows.length} 条记录${eventTools.countEvents(rows)!==rows.length?' · '+eventTools.countEvents(rows)+' 次事件':''}${state.mode==='groups'?' · '+groups.length+' 组':''}</span><div class="segments" aria-label="时间线视图"><button data-timeline="mode" data-value="records" aria-pressed="${state.mode==='records'}">时间顺序</button><button data-timeline="mode" data-value="groups" aria-pressed="${state.mode==='groups'}">重复聚合</button></div></div>`;
    let previousSegment='';
    const listing=visible.map(item=>{
      const row=state.mode==='groups'?item.first:item,segment=activeModel.segmentIndex.get(row.segmentId);
      const separator=previousSegment!==row.segmentId?`<div class="timeline-segment"><strong>${esc(segment.source||'当前来源')}</strong><span>${esc(segment.reason)} · ${esc(segment.orderReason)}</span></div>`:'';
      previousSegment=row.segmentId;
      const timeNote=state.mode==='groups'&&item.heuristic?'文本模式 · 启发式分组':row.clock.raw?timeLabels[row.clock.kind]:'';
      return separator+`<button class="timeline-record ${(state.mode==='groups'?state.group===item.key:state.selected===row.id)?'is-selected':''}" data-timeline="${state.mode==='groups'?'group':'select'}" data-value="${esc(state.mode==='groups'?item.key:row.id)}" aria-pressed="${state.mode==='groups'?state.group===item.key:state.selected===row.id}"><span class="timeline-clock mono">${esc(row.clock.raw||'时间未记录')}</span><span class="timeline-record-main"><strong>${esc(label(row))}${state.mode==='groups'?' · '+item.count+' 条':''}</strong><span class="mono">${esc(row.deviceLabel||row.address||row.targetUUID||'报告')}</span>${timeNote?`<small>${esc(timeNote)}</small>`:''}</span></button>`;
    }).join('');
    const groupMembers=selectedGroup?`<section class="timeline-group-members"><h3>组内原始记录 · ${selectedGroup.recordCount} 条</h3>${selectedGroup.heuristic?`<p class="source-meta">按文本中的可变数字归组，不表示同一原因。</p><pre>${esc(selectedGroup.template)}</pre>`:''}<div data-scroll-key="timeline-members">${selectedGroup.records.slice(state.memberPage*PAGE_SIZE,(state.memberPage+1)*PAGE_SIZE).map(row=>`<button class="link-btn ${selected?.id===row.id?'timeline-member-selected':''}" data-timeline="select" data-value="${esc(row.id)}">第 ${row.line||'?'} 行 · ${esc(row.clock.raw||'时间未记录')}</button>`).join('')}</div>${pager(selectedGroup.recordCount,'memberPage')}</section>`:'';
    return `<section class="timeline-page${ctx.embedded?' timeline-embedded':''}" aria-label="事件时间线">${ctx.embedded?'':'<header><h1 tabindex="-1">事件时间线</h1></header>'}${limits.length&&!ctx.embedded?`<p class="source-meta" role="status">${limits.map(esc).join(" ")}</p>`:""}${empty?'<div class="live-empty"><h2>暂无事件或状态快照</h2></div>':`${filters}${ranges}${filteredResult.error?`<p class="timeline-filter-error" role="alert">${esc(filteredResult.error)} 时间范围暂未应用。</p>`:''}${toolbar}<div class="timeline-split"><section><div class="timeline-records" data-scroll-key="timeline-records">${listing||'<p class="source-meta">没有匹配记录。</p>'}</div>${pager(items.length)}</section><aside class="timeline-detail">${detail(selected)}${groupMembers}</aside></div>`}</section>`;
  }
  function keepVisible(element) {
    const container=element?.closest?.('[data-scroll-key="timeline-records"],[data-scroll-key="timeline-members"]');
    if (!container||!element.getBoundingClientRect||!container.getBoundingClientRect) return;
    const row=element.getBoundingClientRect(),area=container.getBoundingClientRect();
    if (row.top<area.top) container.scrollTop-=area.top-row.top;
    else if (row.bottom>area.bottom) container.scrollTop+=row.bottom-area.bottom;
  }
  function update(target) {
    const data=target?.dataset||{},start=target?.selectionStart,end=target?.selectionEnd;
    context.render?.();
    if (typeof document==='undefined') return;
    keepVisible(document.querySelector?.('.timeline-record.is-selected'));
    keepVisible(document.querySelector?.('.timeline-member-selected'));
    const selector=data.timeline?'[data-timeline]':data.timelineChange?'[data-timeline-change]':data.timelineInput?'[data-timeline-input]':'';
    if (!selector) return;
    const candidates=Array.from(document.querySelectorAll(selector));
    let replacement=candidates.find(element=>
      data.timeline?element.dataset.timeline===data.timeline&&element.dataset.value===data.value&&element.dataset.evidenceIndex===data.evidenceIndex:
      data.timelineChange?element.dataset.timelineChange===data.timelineChange:element.dataset.timelineInput===data.timelineInput);
    if (['page','memberPage','evidencePage'].includes(data.timeline)) replacement=candidates.find(element=>element.dataset.timeline===data.timeline&&element.textContent===target.textContent&&!element.disabled)||candidates.find(element=>element.dataset.timeline===data.timeline&&!element.disabled);
    if (replacement?.disabled) return;
    replacement?.focus({preventScroll:true});
    keepVisible(replacement);
    if (replacement&&start!=null&&end!=null&&typeof replacement.setSelectionRange==='function') replacement.setSelectionRange(start,end);
  }
  function click(target) {
    const action=target?.dataset?.timeline,value=target?.dataset?.value;
    if (!action) return false;
    if (action==='mode'&&['records','groups'].includes(value)) Object.assign(state,{mode:value,page:0,selected:'',group:'',memberPage:0,evidencePage:0});
    else if (action==='select') {state.selected=value;state.evidencePage=0;}
    else if (action==='group') Object.assign(state,{group:value,selected:'',memberPage:0,evidencePage:0});
    else if (action==='page'||action==='memberPage') {state[action]=Math.max(0,Number(value)||0);state.selected='';state.evidencePage=0;if(action==='page')state.memberPage=0;}
    else if (action==='evidencePage') state.evidencePage=Math.max(0,Number(value)||0);
    else if (action==='evidence') {const row=activeModel?.records.find(row=>row.id===value),index=Number(target.dataset.evidenceIndex);const ref=row&&Number.isInteger(index)&&index>=0?eventTools.sourceEvidence(row)[index]:null;if(ref?.line>0)context.openSource?.(ref.line,ref.reportId);return true;}
    else if (action==='source') {const row=activeModel?.records.find(row=>row.id===value);if(row?.line>0)context.openSource?.(row.line,row.reportId);return true;}
    update(target);return true;
  }
  function change(target) {
    const key=target?.dataset?.timelineChange;
    if (!['device','kind','clock'].includes(key)) return false;
    state[key]=target.value;Object.assign(state,{page:0,selected:'',group:'',memberPage:0,evidencePage:0});
    if (key==='clock') {state.from='';state.to='';}
    update(target);return true;
  }
  function input(target) {
    const key=target?.dataset?.timelineInput;
    if (!['query','from','to'].includes(key)) return false;
    state[key]=target.value;Object.assign(state,{page:0,selected:'',group:'',memberPage:0,evidencePage:0});update(target);return true;
  }
  function reset(identity) {
    if (identity) {views.delete(identity);if(state.identity!==identity)return;}
    else views.clear();
    Object.assign(state,defaults(''));lastReport=null;cache=null;activeModel=null;filterCache=null;
  }
  const api={render,click,change,input,reset,capture,restore,identityOf,model,clock,group,filtered,pattern};
  if (typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.XidTimeline=api;
})(globalThis);
