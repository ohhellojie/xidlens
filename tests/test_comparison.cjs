'use strict';
const assert=require('node:assert/strict');
const analysis=require('../app/analysis.js');
const compare=require('../app/comparison.js');
const path='ECC Errors/Volatile/DRAM Uncorrectable';
const ref=value=>({value:String(value),origin:'nvidia-smi',evidence:{line:12,text:'Uncorrectable : '+value}});
const report=(value,time='2026-10-28T10:00:00+08:00')=>({source:'synthetic.log',complete:true,server:{sn:'DEMO-SERVER',driver:'580.0',time},catalog:{sha256:'a'.repeat(64)},gpus:[{id:0,uuid:'GPU-DEMO-1',sn:'DEMO-1',pci:'0000:41:00.0',healthFields:{[path]:[ref(value)]}}],events:[]});
const field=(a,b,key=path)=>compare.assess(a,b,analysis.compareReports(a,b)).rows[0].details.find(d=>d.key==='health:'+key).comparison;
const epoch=(r,key=path,scope='volatile')=>{r.gpus[0].counterEpochs={[key]:{id:'DEMO-EPOCH-1',scope,verified:true,origin:'collector',evidence:{line:8,text:'synthetic period'}}};};
let a=report(0),b=report(7,'2026-10-28T11:00:00+08:00');
let result=field(a,b);assert.equal(result.comparable,false);assert.equal(result.delta,null);assert.ok(result.reasons.some(x=>x.includes('连续性证据')));
epoch(a);epoch(b);result=field(a,b);assert.equal(result.comparable,true);assert.equal(result.delta,'7');
const initial=structuredClone(a);field(a,b);assert.deepEqual(a,initial,'comparison must not mutate reports');
b.gpus[0].counterEpochs[path].id='DEMO-EPOCH-2';assert.ok(field(a,b).reasons.some(x=>x.includes('不能计算增量')));epoch(b);
b.events=[{kind:'reset',gpu:0,address:'0000:41:00.0',line:4}];assert.equal(field(a,b).comparable,false);b.events=[];
b.gpus[0].healthFields[path]=[ref(7),ref(8)];assert.ok(field(a,b).reasons.some(x=>x.includes('多个采集值')));b.gpus[0].healthFields[path]=[ref(7)];
b.server.time='2026-10-28T09:00:00+08:00';assert.ok(field(a,b).reasons.some(x=>x.includes('早于')));
b.server.time='2026-10-28 11:00:00';assert.equal(field(a,b).comparable,false);
b.server.time='2026-10-28T11:00:00+08:00';a.gpus[0].healthFields[path]=[ref(9)];assert.ok(field(a,b).reasons.some(x=>x.includes('计数下降')));a.gpus[0].healthFields[path]=[ref(0)];
b.server.driver='590.0';assert.equal(field(a,b).comparable,false);b.server.driver='580.0';
b.catalog.sha256='b'.repeat(64);let assessed=compare.assess(a,b);assert.equal(assessed.context.catalogChanged,true);assert.equal(field(a,b).delta,'7');assert.equal(assessed.rows[0].eventComparison.comparable,false);
b.complete=false;assert.equal(field(a,b).comparable,false);b.complete=true;
b.gpus[0].healthFields[path][0].origin='other source';assert.ok(field(a,b).reasons.some(x=>x.includes('来源')));b.gpus[0].healthFields[path][0].origin='nvidia-smi';
const aggregate='ECC Errors/Aggregate/DRAM Uncorrectable';a.gpus[0].healthFields={[aggregate]:[ref(2)]};b.gpus[0].healthFields={[aggregate]:[ref(8)]};epoch(a,aggregate,'aggregate');epoch(b,aggregate,'aggregate');assert.equal(field(a,b,aggregate).delta,'6');
a.gpus[0].counterEpochs={};assert.equal(field(a,b,aggregate).comparable,false);
const pending='Remapped Rows/Pending';a.gpus[0].healthFields={[pending]:[ref('No')]};b.gpus[0].healthFields={[pending]:[ref('Yes')]};assert.equal(field(a,b,pending).kind,'state');
a=report('9007199254740993');b=report('9007199254740999','2026-10-28T11:00:00+08:00');epoch(a);epoch(b);assert.equal(field(a,b).delta,'6','large counters must not lose integer precision');
assert.equal(compare.calendar('2026-02-30T10:00:00Z'),null);assert.equal(compare.calendar('2026-01-01T10:00:00'),null);assert.equal(compare.calendar('2026-01-01T25:00:00Z'),null);
b.lifecycleEvents=[{kind:'reset',targetUUID:'gpu-demo-1',outcome:'failed',line:18}];
result=field(a,b);assert.equal(result.comparable,false);assert.equal(result.resetEvidence[0].line,18,'failed reset attempts leave the period uncertain');
b.lifecycleEvents=[{kind:'reset',targetUUID:'GPU-OTHER',gpu:null,address:'',line:18}];assert.equal(field(a,b).comparable,true,'another UUID reset must not be applied to every GPU');
b.lifecycleEvents=[{kind:'driver_load',driverVersion:'580.0',line:19}];result=field(a,b);assert.equal(result.comparable,false);assert.equal(result.resetEvidence[0].kind,'driver_load');
assert.equal(result.resetEvidence[0].source,'synthetic.log');
b.lifecycleEvents=[{kind:'reset',gpu:0,address:'0000:42:00.0',line:19}];assert.equal(field(a,b).comparable,true,'an explicit different BDF cannot be overridden by a report-local GPU index');
b.lifecycleEvents=[];a.gpus[0].counterEpochs={};b.gpus[0].counterEpochs={};a.boot=b.boot='-- Boot demo-a --';
assert.equal(field(a,b).comparable,false,'a shared boot ID and unchanged driver cannot establish a counter period');
epoch(a);epoch(b);b.events=[{kind:'xid',code:'154',recoveryAction:{current:{code:'0x0',label:'None'}}}];
assert.equal(field(a,b).comparable,true,'the recovery action field is not itself a reset result');
// Source conflicts cannot be hidden by a convenient top-level display value.
{
 const pair=()=>{const left=report(0),right=report(7,'2026-10-28T11:00:00+08:00');epoch(left);epoch(right);return [left,right];};
 let [left,right]=pair();
 left.server.sn=right.server.sn='冲突';left.server.fields={sn:[ref('SYNTHETIC-A'),ref('SYNTHETIC-B')]};
 let assessed=compare.assess(left,right);assert.equal(assessed.context.serverIdentityConflict,true);assert.equal(field(left,right).comparable,false);
 [left,right]=pair();left.gpus[0].fields={uuid:[ref('GPU-DEMO-1'),ref('GPU-OTHER')]};
 assessed=compare.assess(left,right);assert.equal(assessed.rows[0].identity.status,'conflict');assert.equal(field(left,right).delta,null);
 [left,right]=pair();left.gpus[0].uuid=right.gpus[0].uuid='';left.gpus[0].sn=right.gpus[0].sn='';
 assert.equal(field(left,right).comparable,false,'same BDF does not supply device identity');
 [left,right]=pair();left.server.uuid='[N/A]';right.server.uuid='SYNTHETIC-UUID';
 assert.equal(compare.assess(left,right).context.serverMismatch,false);assert.equal(field(left,right).delta,'7');
 left.server.uuid='synthetic-uuid';assert.equal(field(left,right).delta,'7','UUID case is not a machine mismatch');
 left.server.uuid='SYNTHETIC-OTHER';assert.equal(field(left,right).delta,null);
 [left,right]=pair();left.server.driver=right.server.driver='550.0 / 580.0';
 assert.equal(field(left,right).comparable,false,'the same list of driver versions is not a single confirmed version');
 left.server.driver=right.server.driver='580.0';left.server.fields={driver:[ref('550.0'),ref('580.0')]};
 assert.equal(field(left,right).comparable,false,'driver evidence conflicts are not hidden by a display fallback');
 [left,right]=pair();left.gpus[0].healthFields[path]=[{value:9007199254740992,origin:'nvidia-smi',evidence:{line:8}}];
 right.gpus[0].healthFields[path]=[{value:9007199254740994,origin:'nvidia-smi',evidence:{line:8}}];
 assert.equal(field(left,right).comparable,false,'unsafe JSON numbers cannot recover their original counter precision');
}
// Conflicted identities remain visible when the base matcher separates the rows.
{
 const left=report(0),right=report(7,'2026-10-28T11:00:00+08:00');
 left.gpus[0].sn='冲突';left.gpus[0].fields={serial:[ref('DEMO-1'),ref('DEMO-2')]};
 const rows=compare.assess(left,right).rows;
 assert.equal(rows[0].matched,false);assert.equal(rows[0].identity.status,'conflict','Unpaired records keep their own identity conflict');
 left.gpus[0].sn='DEMO-1';left.gpus[0].fields={};right.gpus[0].uuid='GPU-DEMO-OTHER';
 assert.ok(compare.assess(left,right).rows.every(row=>row.identity.status==='conflict'),'A shared SN with disagreeing UUIDs stays an identity conflict');
}
// Preserve sub-millisecond order and qualify reset evidence by a known interval.
{
 const left=report(0,'2026-01-01T00:00:00.123001Z'),right=report(7,'2026-01-01T00:00:00.123002Z');epoch(left);epoch(right);
 assert.equal(compare.assess(left,right).context.timeRelation,'forward');assert.equal(field(left,right).delta,'7');
 assert.doesNotThrow(()=>JSON.stringify(compare.assess(left,right)),'timestamp precision stays JSON serializable');
 right.server.time='2026-01-01T00:00:00.123000Z';assert.equal(compare.assess(left,right).context.timeRelation,'reversed');
 right.server.time='2026-01-01T01:00:00Z';left.id='a'.repeat(32);right.id='b'.repeat(32);
 right.lifecycleEvents=[{kind:'driver_load',time:'2025-12-31T23:00:00Z',line:4},{kind:'reset',gpu:0,time:'2026-01-01T02:00:00Z',line:5}];
 let result=field(left,right);assert.equal(result.delta,'7');assert.equal(result.excludedResetEvidence.length,2);
 assert.ok(result.excludedResetEvidence.every(event=>event.reportId===right.id));
 for(const time of ['2026-01-01T00:00:00.123001Z','2026-01-01T00:30:00Z','2026-01-01T01:00:00Z','2026-01-01 00:30:00','123.000','']){
  right.lifecycleEvents=[{kind:'reset',gpu:0,time,line:9}];result=field(left,right);
  assert.equal(result.delta,null,'reset in or not provably outside the interval blocks delta: '+time);assert.equal(result.resetEvidence[0].reportId,right.id);
 }
 right.lifecycleEvents=[{kind:'reset',gpu:0,raw:'2025-12-31T23:00:00Z synthetic reset',line:10}];assert.equal(field(left,right).delta,'7');
 right.server.time='2026-01-01 01:00:00';assert.equal(field(left,right).delta,null,'unknown report time never establishes an exclusion interval');
}
// Index the event stream once per assessment, independent of GPU and field counts.
{
 const before=report(0),after=report(1,'2026-10-28T11:00:00+08:00');
 for(const current of [before,after])current.gpus=Array.from({length:128},(_,id)=>{
  const healthFields={},counterEpochs={};
  for(let i=0;i<16;i++){
   const key='ECC Errors/Volatile/Synthetic '+i+'/Uncorrectable';
   healthFields[key]=[ref(current===before?0:1)];
   counterEpochs[key]={id:'SYNTHETIC-EPOCH',scope:'volatile',verified:true,origin:'collector',evidence:{line:8,text:'synthetic period'}};
  }
  return {id,pci:'0000:'+id.toString(16).padStart(2,'0')+':00.0',uuid:'GPU-SYNTHETIC-'+id,sn:'SYNTHETIC-'+id,healthFields,counterEpochs};
 });
 const base=analysis.compareReports(before,after);let visits=0;
 before.events=Array.from({length:50000},(_,id)=>({id,get kind(){visits++;return 'xid';},code:'79'}));
 after.events=before.events;
 const value=compare.assess(before,after,base);
 assert.equal(visits,100000,'A full event scan per counter would make the view scale with events × fields');
 assert.equal(value.counterComparable,2048);
 // Sources and event order survive indexed lookups, including explicit-address priority.
 before.events=[];after.events=[{kind:'reset',line:1},{kind:'reset',targetUUID:'gpu-synthetic-0',line:2},
  {kind:'reset',address:'0000:01:00.0',gpu:0,line:3},{kind:'driver_reload',line:4},{kind:'counter_reset',gpu:0,line:5}];
 const indexed=compare.assess(before,after,base);
 const result=indexed.rows[0].details.find(d=>d.key.startsWith('health:')).comparison;
 assert.deepEqual(result.resetEvidence.map(e=>e.line),[1,2,4,5]);
 assert.ok(result.resetEvidence.every(e=>e.source==='synthetic.log'));
 after.events=[];assert.equal(compare.assess(before,after,base).counterComparable,2048,'Indexes never survive into a new assessment');
}
console.log('Counter comparison: identity, evidence, epochs, reset, chronology, scope, sources, catalog and integer precision passed');
