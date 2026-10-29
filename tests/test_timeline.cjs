'use strict';
const assert=require('node:assert/strict');
const ui=require('../app/timeline.js');
const event=(id,time,line,extra={})=>({id,time,line,kind:'xid',code:'79',address:'0000:41:00.0',raw:`[${time}] NVRM: Xid 79`,source:'demo.log',boot:null,...extra});
const report=events=>({id:'a'.repeat(32),source:'demo.log',gpus:[],events,diagnostics:{snapshots:[]}});
const calls=[];
const context={render:()=>calls.push(['render']),openSource:(line,id)=>calls.push(['source',line,id])};
let data=report([event('one','12.000',1),event('two','2.000',4),event('three','3.000',7)]);
let model=ui.model(data);
assert.equal(model.segments.length,2,'uptime rollback splits a source without asserting a reboot');
assert.ok(model.segments[1].reason.includes('回退'));
assert.deepEqual(model.records.map(r=>r.sourceEventId),['one','two','three']);
assert.equal(ui.group(model.records).length,2,'groups must retain time segment boundaries');

data=report([event('one','2026-10-28T10:00:00.123999+08:00',1,{raw:'',boot:'-- Boot demo-a --'}),event('two','2026-10-28T02:00:00.123001Z',2,{raw:'',boot:'-- Boot demo-a --'}),event('three','2026-10-28T01:00:00Z',3,{raw:'',boot:'-- Boot demo-b --'})]);
model=ui.model(data);assert.equal(model.segments.length,2);
assert.deepEqual(model.records.map(r=>r.sourceEventId),['two','one','three'],'microseconds order within a boot, but a later file segment never moves across boot boundaries');
assert.equal(model.segments[0].order,'calendar');
data.events[1].time='2026-10-28T02:00:00';model=ui.model(data);assert.equal(model.segments[0].order,'source');
assert.deepEqual(model.records.map(r=>r.sourceEventId),['one','two','three']);

assert.equal(ui.clock('Oct 28 12:00:00').kind,'calendar-partial');
assert.equal(ui.clock('2026-10-28T12:00:00').kind,'calendar-unzoned');
assert.equal(ui.clock('2026-02-30T12:00:00Z').kind,'unknown');
assert.equal(ui.clock('2026-10-28T25:00:00Z').kind,'unknown');
assert.equal(ui.clock('2026-10-28T12:00:00+99:00').kind,'unknown');
assert.equal(ui.clock('no time').kind,'unknown');
assert.equal(ui.clock('[123.456] NVRM: Xid 79').kind,'uptime');

data=report([event('one','1.000',1,{boot:'-- Reboot --'}),event('two','2.000',2,{boot:'-- Reboot --'})]);
assert.equal(ui.model(data).segments.length,2,'generic reboot markers do not identify a shared boot');

data=report([event('one','2.000',20)]);data.diagnostics.snapshots=[{id:'s0',address:'0000:41:00.0',line:10,evidence:{line:10,text:'GPU 0000:41:00.0',boot_marker:null},fields:[{path:'ECC Errors/Volatile/DRAM Uncorrectable',value:'0'}]}];
model=ui.model(data);assert.equal(model.segments.length,1,'snapshots share their own source ID with events');
assert.equal(model.records[0].kind,'snapshot');assert.equal(model.records[0].line,10);assert.equal(model.records[0].clock.kind,'unknown');
assert.deepEqual(model.records.map(r=>r.line),[10,20]);

data=report([event('one','12.000',1),event('two','30.000',2,{address:'0000:42:00.0',kind:'aer'}),event('three','55.000',3)]);
model=ui.model(data);
let filtered=ui.filtered(model,{device:'all',kind:'all',clock:'uptime',from:'20',to:'60',query:''});assert.equal(filtered.records.length,2);
filtered=ui.filtered(model,{device:'all',kind:'xid',clock:'uptime',from:'20',to:'60',query:''});assert.equal(filtered.records.length,1);
filtered=ui.filtered(model,{device:'all',kind:'all',clock:'uptime',from:'60',to:'20',query:''});assert.ok(filtered.error);assert.equal(filtered.records.length,3,'invalid range must not silently hide records');
filtered=ui.filtered(model,{device:'all',kind:'all',clock:'calendar',from:'2026-10-28T10:00:00',to:'',query:''});assert.ok(filtered.error);

data=report([event('one','1.000',1,{kind:'unknown',raw:'[1.000] timeout channel 42 addr 0xdead'}),event('two','2.000',2,{kind:'unknown',raw:'[2.000] timeout channel 51 addr 0xbeef'}),event('three','3.000',3,{kind:'unknown',raw:'[3.000] timeout channel 51 addr 0xbeef',address:'0000:42:00.0'})]);
model=ui.model(data);let groups=ui.group(model.records);assert.equal(groups.length,2);assert.equal(groups[0].count,2);assert.equal(groups[0].heuristic,true);assert.ok(groups[0].template.includes('<n>'));assert.ok(groups[0].records[0].raw.includes('42'));
data.events.push(event('four','4.000',4,{kind:'aer',raw:'severity=Corrected, id=42'}),event('five','5.000',5,{kind:'aer',raw:'severity=Uncorrectable (Fatal), id=42'}));
assert.equal(ui.group(ui.model(data).records).length,4,'AER severity must not collapse together');

ui.reset();let html=ui.render(data,context);assert.ok(!html.includes('已恢复'));
ui.click({dataset:{timeline:'mode',value:'groups'}});html=ui.render(data,context);assert.ok(html.includes('启发式分组'));assert.ok(html.includes('组内原始记录'));
ui.click({dataset:{timeline:'select',value:'event:two'}});html=ui.render(data,context);assert.ok(html.includes('channel 51'));ui.click({dataset:{timeline:'source',value:'event:two'}});assert.deepEqual(calls.at(-1),['source',2,'a'.repeat(32)]);
ui.change({dataset:{timelineChange:'kind'},value:'aer'});html=ui.render(data,context);assert.ok(!html.includes('timeout channel'));
ui.change({dataset:{timelineChange:'kind'},value:'all'});ui.input({dataset:{timelineInput:'query'},value:'Corrected'});html=ui.render(data,context);assert.ok(html.includes('severity=Corrected'));assert.ok(!html.includes('timeout channel'));

const hostile=report([event('one','1.000',1,{raw:'<script>bad()</script>',title:'<img src=x>',kind:'unknown'})]);ui.reset();html=ui.render(hostile,context);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;script&gt;'));
ui.reset();const many=report(Array.from({length:240},(_,i)=>event('e'+i,`${i}.000`,i+1)));html=ui.render(many,context);assert.equal((html.match(/class="timeline-record /g)||[]).length,100);
ui.click({dataset:{timeline:'page',value:'2'}});html=ui.render(many,context);assert.equal((html.match(/class="timeline-record /g)||[]).length,40);
ui.click({dataset:{timeline:'mode',value:'groups'}});html=ui.render(many,context);assert.ok(html.includes('组内原始记录 · 240 条'));ui.click({dataset:{timeline:'memberPage',value:'2'}});html=ui.render(many,context);assert.ok(html.includes('第 240 行'));

const sourceA='a'.repeat(32),sourceB='b'.repeat(32);const session={manifest:{id:'s'},view:{events:[event('one','5.000',1,{reportId:sourceA,source:'first.log'}),event('two','1.000',1,{reportId:sourceB,source:'second.log'})]}};
model=ui.model(session);assert.equal(model.segments.length,2);assert.deepEqual(model.records.map(r=>r.reportId),[sourceA,sourceB]);

data=report([event('xid','12.000',2,{gpu:0})]);data.gpus=[{id:0,pci:'0000:41:00.0'}];
data.lifecycleEvents=[{id:'l0',kind:'reset',title:'GPU 重置完成',outcome:'completed',gpu:0,address:'',targetUUID:'GPU-DEMO-A',line:3,timeInfo:{kind:'uptime_seconds',raw:'13'},raw:'GPU reset executed: GPU-DEMO-A, success: true'}];
model=ui.model(data);assert.equal(model.count,2);assert.equal(model.records[1].clock.kind,'uptime');
assert.equal(model.records[0].deviceKey,model.records[1].deviceKey,'an explicit UUID association retains the device filter');
assert.equal(model.records[1].address,'','display retains the original absence of BDF');
ui.reset();ui.render(data,context);ui.click({dataset:{timeline:'select',value:'lifecycle:l0'}});html=ui.render(data,context);
assert.ok(html.includes('GPU-DEMO-A'));assert.ok(html.includes('恢复情况需结合后续验证'));assert.ok(!html.includes('已恢复'));
ui.click({dataset:{timeline:'source',value:'lifecycle:l0'}});assert.deepEqual(calls.at(-1),['source',3,sourceA]);
data.lifecycleEvents.push({...data.lifecycleEvents[0],id:'l1',title:'GPU 重置失败',outcome:'failed',line:4});
assert.equal(ui.group(ui.model(data).records).length,3,'reset failures cannot merge with completions');
data.lifecycleEvents[0].gpu=null;model=ui.model(data);assert.notEqual(model.records[0].deviceKey,model.records[1].deviceKey,'unlinked UUIDs must not borrow a GPU from the same source');

data=report([event('recovery','1.000',1,{code:'154',recoveryAction:{previous:{code:'0x1',label:'GPU Reset Required'},current:{code:'0x0',label:'None'}}}),event('required','2.000',2,{code:'154',recoveryAction:{previous:{code:'0x0',label:'None'},current:{code:'0x1',label:'GPU Reset Required'}}})]);
assert.equal(ui.group(ui.model(data).records).length,2,'Xid 154 action states cannot merge');
ui.reset();html=ui.render(data,context);assert.ok(html.includes('GPU Reset Required → None'));assert.ok(!html.includes('已恢复'));

session.view.lifecycleEvents=[{id:sourceB+':l0',kind:'driver_load',line:2,time:'2.000',reportId:sourceB,source:'second.log'}];
assert.equal(ui.model(session).records.at(-1).kind,'driver_load');
const limited={...session,view:{...session.view,warnings:[{kind:'limit',message:'联合视图最多显示 50000 条事件，完整记录保留在各来源报告中。'}]}};
ui.reset();html=ui.render(limited,context);assert.ok(html.includes(limited.view.warnings[0].message),'Timeline must preserve the session limit notice');
// Many segments stay bounded in the DOM and keep the last source record reachable.
{
 const large=report(Array.from({length:50000},(_,i)=>event('large-'+i,`${i}.000`,i+1,{boot:'-- Reboot --'})));
 const indexed=ui.model(large);assert.equal(indexed.count,50000);assert.equal(indexed.segments.length,50000);
 assert.equal(indexed.segmentIndex.get(indexed.records.at(-1).segmentId).records[0].line,50000);
 ui.reset();html=ui.render(large,context);assert.equal((html.match(/class="timeline-record /g)||[]).length,100);
 ui.click({dataset:{timeline:'page',value:'499'}});html=ui.render(large,context);assert.ok(html.includes('event:large-49999'));
 ui.click({dataset:{timeline:'select',value:'event:large-49999'}});ui.render(large,context);
 ui.click({dataset:{timeline:'source',value:'event:large-49999'}});assert.deepEqual(calls.at(-1),['source',50000,sourceA]);
 // Cached groups must be invalidated by filters and by replacement report objects.
 const grouped=report(Array.from({length:240},(_,i)=>event('cached-'+i,`${i}.000`,i+1)));
 ui.reset();ui.render(grouped,context);ui.click({dataset:{timeline:'mode',value:'groups'}});
 html=ui.render(grouped,context);assert.ok(html.includes('组内原始记录 · 240 条'));
 ui.input({dataset:{timelineInput:'query'},value:'no-such-event'});html=ui.render(grouped,context);assert.ok(html.includes('0 条记录'));assert.ok(!html.includes('240 条'));
 ui.input({dataset:{timelineInput:'query'},value:''});html=ui.render(grouped,context);assert.ok(html.includes('组内原始记录 · 240 条'));
 html=ui.render({...grouped,events:grouped.events.slice(0,3)},context);assert.ok(html.includes('组内原始记录 · 3 条'));assert.ok(!html.includes('240 条'));
}
console.log('Timeline: source/boot segmentation, clock domains, snapshots, filtering, grouping, evidence, escaping and pagination passed');

// A joint snapshot belongs to the originating report, including its device filter.
{
 const joint={manifest:{id:'snapshot-session'},view:{devices:[{key:sourceB+':0',reportId:sourceB,id:0,pci:'0000:41:00.0'}],
  events:[event(sourceB+':e0','14.000',30,{reportId:sourceB,source:'second.log',deviceKey:sourceB+':0'})],
  snapshots:[{id:sourceB+':s0',reportId:sourceB,source:'second.log',sourceMember:'logs/second.log',address:'0000:41:00.0',line:21,
    evidence:{line:21,time:{kind:'uptime_seconds',raw:'13'}},fields:[{path:'ECC Errors',value:'0'}]}]}};
 const jointModel=ui.model(joint);assert.equal(jointModel.devices.length,1);assert.equal(jointModel.records[0].kind,'snapshot');
 assert.equal(jointModel.records[0].reportId,sourceB);assert.equal(jointModel.records[0].sourceMember,'logs/second.log');
 assert.equal(jointModel.records[0].clock.kind,'uptime');assert.equal(jointModel.records[0].deviceKey,sourceB+':0');
 ui.reset();html=ui.render(joint,{...context,embedded:true});assert.ok(!html.includes('<h1'));assert.ok(html.includes('缺少日历锚点，按原文顺序'));
 ui.click({dataset:{timeline:'source',value:'snapshot:'+sourceB+':s0'}});assert.deepEqual(calls.at(-1),['source',21,sourceB]);
 const domains=report([event('a','2026-10-28T12:00:00Z',1,{raw:''}),event('b','12.000',2),event('c','2026-10-28T12:00:00',3,{raw:''})]);
 const mixed=ui.model(domains);assert.equal(mixed.segments[0].order,'source');assert.equal(ui.group(mixed.records).length,3,'Different clock domains must never collapse into one repeat group');
 ui.reset();html=ui.render(domains,context);assert.ok(html.includes('时间类型不同，按原文顺序'));
 const utc=ui.filtered(mixed,{clock:'calendar',from:'2026-10-28T20:00:00+08:00',to:'2026-10-28T12:00:00Z'});
 assert.equal(utc.records.length,1,'Calendar boundaries compare the same instant across explicit zones');
 const bad=ui.filtered(mixed,{clock:'calendar',from:'2026-10-28T12:00:01Z',to:'2026-10-28T12:00:00Z'});
 assert.ok(bad.error);assert.equal(bad.records.length,1,'Invalid calendar ranges retain the independently selected clock domain');
}
console.log('Timeline joint snapshots, device identity, embedded heading and incompatible time groups passed');

// Missing timestamps stay readable without repeating the same absence label.
{
 const kinds={ecc:'ECC 错误',channel:'通道超时',fallen:'GPU 不可访问',smi_error:'nvidia-smi 错误',lockup:'内核软锁死',mods:'MODS 错误',thermal:'温度告警'};
 const missing=report(Object.keys(kinds).map((kind,i)=>event('type-'+i,'—',i+1,{kind,raw:'Synthetic record',title:''})));
 ui.reset();html=ui.render(missing,context);
 for(const [kind,label] of Object.entries(kinds)) assert.match(html,new RegExp('<option value="'+kind+'"[^>]*>'+label+'</option>'));
 const firstRecord=html.match(/<button class="timeline-record [\s\S]*?<\/button>/)[0];assert.equal((firstRecord.match(/时间未记录/g)||[]).length,1);
 const detailTime=html.match(/<dt>时间<\/dt><dd>([\s\S]*?)<\/dd>/)[1];assert.equal(detailTime,'时间未记录');
 assert.ok(html.includes('data-scroll-key="timeline-records"'));
 // Selection uses the scrollable record area, keeping keyboard focus visible without moving the page.
 let position={top:320,bottom:350},focused=false;
 const container={scrollTop:0,getBoundingClientRect:()=>({top:10,bottom:100})};
 const selected={dataset:{timeline:'select',value:'event:type-0'},closest:()=>container,getBoundingClientRect:()=>({top:position.top-container.scrollTop,bottom:position.bottom-container.scrollTop}),focus:()=>{focused=true;}};
 const previousDocument=global.document;
 try {
  global.document={querySelector:selector=>selector==='.timeline-record.is-selected'?selected:null,querySelectorAll:()=>[selected]};
  ui.click(selected);assert.equal(container.scrollTop,250);assert.equal(focused,true);
  position={top:262,bottom:292};ui.click(selected);assert.equal(container.scrollTop,250,'An already visible selection leaves scrolling unchanged');
  position={top:240,bottom:270};ui.click(selected);assert.equal(container.scrollTop,230,'A selection above the viewport scrolls back into view');
 } finally {if(previousDocument===undefined)delete global.document;else global.document=previousDocument;}
}
console.log('Timeline labels, missing timestamps and bounded-list keyboard visibility passed');
