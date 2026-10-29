'use strict';
const assert=require('node:assert/strict');
const analysis=require('../app/analysis.js'),timeline=require('../app/timeline.js'),sessions=require('../app/sessions.js');
const A='a'.repeat(32),B='b'.repeat(32),pci='0000:41:00.0';
const results=[];const test=(name,fn)=>{fn();results.push(name);};
const xid={id:'xid',gpu:0,address:pci,kind:'xid',code:'119',line:1,time:'12.000',raw:'Synthetic GPU Xid'};
const sxid={...xid,id:'sxid',kind:'sxid',deviceNamespace:'nvswitch',structured:{kind:'sxid',switch:2,link:3,severity:'fatal',evidence:{line:2},representations:[{line:2},{line:3}]},line:2,representationCount:2,raw:'Synthetic NVSwitch SXid'};
const goe={id:'goe',kind:'goe',code:'1',gpu:null,address:pci,line:4,time:'13.000',targetUUID:'GPU-DEMO-A',raw:'Synthetic GOE',occurrenceCount:1,representationCount:2,structured:{moduleSignature:'GPU-GSP',category:1,moduleEventCode:1,severity:'Fatal',severityDomain:'host-cper',scope:'HOST',legacyXid:119,deviceUUID:'GPU-DEMO-A',experimental:true,representations:[{line:4,jsonPointer:'/events/0'},{line:6,jsonPointer:'/events/1'}]}};
const report=events=>({id:A,source:'synthetic.log',gpus:[{id:0,pci,uuid:'GPU-DEMO-A'}],events,server:{},diagnostics:{snapshots:[]}});
test('namespace wins over an erroneous GPU index',()=>{
 assert.equal(analysis.eventNamespace(sxid),'nvswitch');assert.notEqual(analysis.eventKey(xid),analysis.eventKey(sxid));
 const comparison=analysis.compareReports(report([xid,sxid]),report([xid]));
 assert.equal(comparison.rows[0].errors.length,1);assert.equal(comparison.system.before,1);assert.equal(comparison.system.errors[0].namespace,'nvswitch');
 assert.equal(analysis.pathErrorCount(report([xid,sxid]),{pci}),1);
});
test('representations never multiply event counts',()=>{
 assert.equal(analysis.countEvents([goe,sxid]),2);const group=analysis.groupEvents([goe,{...goe,id:'b',occurrenceCount:3}])[0];
 assert.equal(group.count,4);assert.equal(group.recordCount,2);assert.equal(group.events.length,2);
});
test('full GOE type and scope define event groups',()=>{
 assert.equal(analysis.eventTitle(goe),'GOE GPU-GSP/0x0001/0x0001');
 for(const fields of [{moduleSignature:'GPU-NVLINK'},{category:2},{moduleEventCode:2},{severityDomain:'event-scope'},{scope:'GPU'},{severity:'Warn'}])
  assert.equal(analysis.groupEvents([goe,{...goe,structured:{...goe.structured,...fields}}]).length,2);
});
test('source and unassigned UUID separate aggregate keys',()=>{
 assert.equal(analysis.groupEvents([{...goe,reportId:A},{...goe,reportId:B}]).length,2);
 assert.equal(analysis.groupEvents([goe,{...goe,targetUUID:'GPU-DEMO-B'}]).length,2);
});
test('comparison distinguishes GOE full types with equal event totals',()=>{
 const after={...goe,structured:{...goe.structured,category:2}};
 const result=analysis.compareReports(report([goe]),report([after]));assert.equal(result.system.errors.length,2);assert.equal(result.system.changed,true);
});
test('timeline device filters cannot merge NVSwitch into GPU at the same PCI',()=>{
 const m=timeline.model(report([xid,sxid,goe]));assert.equal(m.devices.length,3);
 assert.notEqual(m.records[0].deviceKey,m.records[1].deviceKey);assert.notEqual(m.records[0].deviceKey,m.records[2].deviceKey);
 assert.ok(m.records[1].deviceLabel.startsWith('NVSwitch 2'));assert.equal(m.records[2].deviceLabel,'GPU-DEMO-A');
 const onlySwitch=timeline.filtered(m,{device:m.records[1].deviceKey}).records;assert.equal(onlySwitch.length,1);assert.equal(onlySwitch[0].kind,'sxid');
});
test('an explicit GOE GPU association can share its inventory filter',()=>{
 const m=timeline.model(report([xid,{...goe,gpu:0}]));assert.equal(m.records[0].deviceKey,m.records[1].deviceKey);
});
test('timeline groups keep types severity and occurrence counts',()=>{
 const data=report([goe,{...goe,id:'second',line:5,occurrenceCount:4},{...goe,id:'third',line:6,structured:{...goe.structured,moduleEventCode:2}}]);
 const groups=timeline.group(timeline.model(data).records);assert.equal(groups.length,2);assert.equal(groups[0].count,5);assert.equal(groups[0].recordCount,2);
 timeline.reset();timeline.render(data);timeline.click({dataset:{timeline:'mode',value:'groups'}});const html=timeline.render(data);
 assert.ok(html.includes('组内原始记录 · 2 条'));assert.ok(html.includes(' · 5 条'));
});
test('timeline shows experimental GOE and host CPER severity without a GPU verdict',()=>{
 timeline.reset();const html=timeline.render(report([goe]));
 for(const value of ['GOE GPU-GSP/0x0001/0x0001','GOE · 实验性','主机 CPER 严重性','Fatal','仅关联提示，未合并','/events/0','/events/1'])assert.ok(html.includes(value),value);
 assert.ok(!html.includes('GPU 严重性'));assert.ok(html.includes('2 处 · 1 次事件'));
});
test('identity conflicts and malformed content remain escaped',()=>{
 timeline.reset();const html=timeline.render(report([{...goe,structured:{...goe.structured,identityConflict:true,scope:'<img src=x>',representations:[{line:5,jsonPointer:'/<script>'}]}}]));
 assert.ok(html.includes('分别保留'));assert.ok(html.includes('&lt;img'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<img'));
});
test('structured source links retain originating report IDs and exact lines',()=>{
 const calls=[];timeline.reset();timeline.render({manifest:{id:'joint'},view:{events:[{...goe,id:B+':goe',reportId:B,source:'second.json'}]}},{openSource:(line,id)=>calls.push([line,id])});
 timeline.click({dataset:{timeline:'evidence',value:'event:'+B+':goe',evidenceIndex:'1'}});assert.deepEqual(calls,[[6,B]]);
 timeline.click({dataset:{timeline:'evidence',value:'event:'+B+':goe',evidenceIndex:'-1'}});assert.equal(calls.length,1);
});
const manyRefs=Array.from({length:240},(_,i)=>({line:i+1,jsonPointer:'/events/'+i}));
test('all duplicate GOE representations stay reachable through bounded pages',()=>{
 const data=report([{...goe,structured:{...goe.structured,representations:manyRefs},representationCount:240}]);const calls=[];const ctx={openSource:(line,id)=>calls.push([line,id])};
 timeline.reset();let html=timeline.render(data,ctx);assert.equal((html.match(/data-timeline="evidence"/g)||[]).length,100);
 timeline.click({dataset:{timeline:'evidencePage',value:'2'}});html=timeline.render(data,ctx);assert.equal((html.match(/data-timeline="evidence"/g)||[]).length,40);
 assert.ok(html.includes('201–240 / 240'));timeline.click({dataset:{timeline:'evidence',value:'event:goe',evidenceIndex:'239'}});assert.deepEqual(calls.at(-1),[240,A]);
 const saved=timeline.capture();timeline.reset();assert.equal(timeline.restore(saved,'case:'+A),true);timeline.render(data,ctx);assert.equal(timeline.capture().evidencePage,2);
});
test('source representation IDs cannot redirect to another report',()=>{
 assert.equal(analysis.sourceEvidence({...goe,reportId:B,structured:{representations:[{line:1,reportId:A}]}})[0].reportId,B);
});
const session=event=>({manifest:{id:'c'.repeat(32),name:'Synthetic session'},view:{members:[{reportId:A,source:'synthetic.json',state:'ready',events:1,gpus:0}],counts:{events:1},warnings:[],events:[{...event,id:A+':'+event.id,reportId:A,source:'synthetic.json'}],devices:[],deviceGroups:[],checks:[]}});
test('joint event details show full GOE type and source pointers',()=>{
 const data=session(goe);sessions.reset();sessions.render(data);sessions.click({dataset:{session:'tab',value:'events'}});const html=sessions.render(data);
 assert.ok(html.includes('GOE GPU-GSP/0x0001/0x0001'));assert.ok(html.includes('主机 CPER 严重性'));assert.ok(html.includes('/events/1'));assert.ok(html.includes('data-line="6"'));
});
test('joint NVSwitch title and device label remain separate from GPU',()=>{
 const data=session(sxid);sessions.reset();sessions.render(data);sessions.click({dataset:{session:'tab',value:'events'}});const html=sessions.render(data);
 assert.ok(html.includes('NVSwitch SXid 119'));assert.ok(html.includes('NVSwitch 2 · '+pci));assert.ok(html.includes('SXid 严重性'));
});
test('joint source pages keep final representation and filter reset usable',()=>{
 const data=session({...goe,representationCount:240,structured:{...goe.structured,representations:manyRefs}});const calls=[],ctx={onSource:(id,line)=>calls.push([id,line])};
 sessions.reset();sessions.render(data,ctx);sessions.click({dataset:{session:'tab',value:'events'}});let html=sessions.render(data,ctx);
 assert.equal((html.match(/session-source-link/g)||[]).length,100);sessions.click({dataset:{session:'evidencePage',value:'2'}});html=sessions.render(data,ctx);
 assert.equal((html.match(/session-source-link/g)||[]).length,40);assert.ok(html.includes('data-line="240"'));
 sessions.click({dataset:{session:'source',report:A,line:'240'}});assert.deepEqual(calls.at(-1),[A,240]);
 sessions.change({dataset:{sessionChange:'source'},value:A});html=sessions.render(data,ctx);assert.ok(html.includes('1–100 / 240'));
});
console.log(`${results.length} structured event view tests passed`);
