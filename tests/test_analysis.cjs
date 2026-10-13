'use strict';
const assert=require('node:assert/strict');
const {groupEvents,eventKey,compareReports}=require('../app/analysis.js');
const gpu=(id,extra={})=>({id,sn:'',uuid:'',pci:'0000:41:00.0',...extra});
const report=(gpus,events=[])=>({gpus,events,server:{},complete:true});
const event=(id,gpu,code,time,extra={})=>({id,gpu,address:'0000:41:00.0',kind:'xid',code,time,title:'Error',...extra});
const results=[];
function test(name,fn){fn();results.push(name);}
test('aggregation keeps every source record and separates GPU and type',()=>{
  const events=[event('a',0,'79','2026-01-02T00:00:00Z'),event('b',0,'79','2026-01-01T00:00:00Z'),event('c',1,'79','—'),event('d',0,'31','—')];
  const groups=groupEvents(events);assert.equal(groups.length,3);assert.equal(groups[0].count,2);assert.equal(groups[0].first.id,'b');assert.equal(groups[0].last.id,'a');assert.equal(groups.flatMap(g=>g.events).length,4);
});
test('boot-relative and missing timestamps retain log order',()=>{
  const group=groupEvents([event('a',0,'79','[500.000]'),event('b',0,'79','[2.000]')])[0];
  assert.equal(group.clock,false);assert.equal(group.first.id,'a');assert.equal(group.last.id,'b');
});
test('microsecond timestamps and timezones preserve first and last evidence',()=>{
  const g=groupEvents([event('a',0,'79','2026-01-01T08:00:00.123999+08:00'),event('b',0,'79','2026-01-01T00:00:00.123001Z')])[0];
  assert.equal(g.first.id,'b');assert.equal(g.last.id,'a');assert.doesNotThrow(()=>JSON.stringify(g));
});
test('different non-Xid descriptions and unassigned devices stay separate',()=>{
  const a=event('a',null,'','—',{kind:'aer',title:'Corrected'}),b={...a,id:'b',title:'Fatal'};
  assert.notEqual(eventKey(a),eventKey(b));assert.equal(groupEvents([a,b]).length,2);
});
test('UUID matches a consumer GPU even when PCI address and index change',()=>{
  const result=compareReports(report([gpu(0,{uuid:'GPU-A'})]),report([gpu(3,{uuid:'gpu-a',pci:'0000:61:00.0'})]));
  assert.equal(result.matched,1);assert.equal(result.rows[0].basis,'UUID');assert.ok(result.rows[0].changes.includes('PCI 地址'));
});
test('same PCI without identity must never identify a card',()=>{
  const r=compareReports(report([gpu(0)]),report([gpu(0)]));assert.equal(r.matched,0);assert.equal(r.rows.length,2);assert.equal(r.rows[0].reason,'缺少 SN / UUID');
});
test('placeholder identities are not matched',()=>{
  for(const sn of ['—','N/A','Unknown','Default String','[N/A]','[ n/a ]','[Not Supported]','Not Supported'])assert.equal(compareReports(report([gpu(0,{sn})]),report([gpu(1,{sn})])).matched,0);
});

test('placeholder SN in saved reports cannot block a valid UUID match',()=>{
  for(const sn of ['[N/A]','[Not Supported]']){
    const a=report([gpu(0,{sn,uuid:'GPU-A'})]),b=report([gpu(1,{sn:'REAL-SN',uuid:'gpu-a'})]);
    for(const r of [compareReports(a,b),compareReports(b,a)]){assert.equal(r.matched,1);assert.equal(r.rows[0].basis,'UUID');}
    const blank=report([gpu(0,{sn:'',uuid:'GPU-A'})]);
    assert.equal(compareReports(a,blank).changed,0);
  }
});

test('system errors retain every unassigned record without changing GPU counts',()=>{
  const a=report([gpu(0,{sn:'S'})],[event('a',0,'79','—'),event('b',null,'','—',{kind:'smi_error',address:''}),event('c',null,'','—',{kind:'smi_error',address:''})]);
  const b=report([gpu(3,{sn:'S'})],[event('d',3,'79','—'),event('e',undefined,'','—',{kind:'smi_error',address:''})]);
  const r=compareReports(a,b);assert.equal(r.matched,1);assert.equal(r.changed,0);assert.equal(r.rows.length,1);
  assert.deepEqual([r.system.before,r.system.after,r.system.changed],[2,1,true]);
  assert.equal(r.system.errors[0].kind,'smi_error');
  assert.equal(r.system.before+r.rows.reduce((n,row)=>n+row.errors.reduce((m,e)=>m+e.before,0),0),a.events.length);
});

test('system comparison retains PCI addresses, type changes and dangling GPU references',()=>{
  const a=report([],[event('a',null,'','—',{kind:'aer',address:'0000:00:01.0'})]);
  const b=report([],[event('b',99,'','—',{kind:'aer',address:'0000:00:02.0'})]);
  const r=compareReports(a,b);assert.equal(r.rows.length,0);assert.equal(r.system.errors.length,2);assert.equal(r.system.changed,true);
  assert.deepEqual([r.system.before,r.system.after],[1,1]);
  assert.equal(compareReports(a,a).system.changed,false);
  assert.equal(compareReports(report([]),report([])).system.errors.length,0);
});
test('SN match cannot override a conflicting UUID',()=>{
  const r=compareReports(report([gpu(0,{sn:'S',uuid:'GPU-A'})]),report([gpu(0,{sn:'S',uuid:'GPU-B'})]));assert.equal(r.matched,0);assert.equal(r.rows[0].reason,'标识有冲突');
});
test('UUID match cannot override a conflicting SN or explicit conflict',()=>{
  for(const sn of ['OTHER','冲突'])assert.equal(compareReports(report([gpu(0,{sn:'S',uuid:'GPU-A'})]),report([gpu(0,{sn,uuid:'GPU-A'})])).matched,0);
});
test('duplicate identities stay unpaired',()=>{
  const r=compareReports(report([gpu(0,{sn:'S'}),gpu(1,{sn:'S'})]),report([gpu(0,{sn:'S'})]));assert.equal(r.matched,0);assert.equal(r.rows[0].reason,'标识重复');
});
test('a unique UUID can disambiguate a shared SN',()=>{
  const r=compareReports(report([gpu(0,{sn:'S',uuid:'GPU-A'}),gpu(1,{sn:'S',uuid:'GPU-B'})]),report([gpu(3,{sn:'S',uuid:'GPU-B'}),gpu(4,{sn:'S',uuid:'GPU-A'})]));assert.equal(r.matched,2);assert.equal(r.rows[0].after.id,4);
});
test('partial identities cannot greedily pair several records with one card',()=>{
  const a=report([gpu(0,{sn:'S'}),gpu(1,{uuid:'GPU-A'})]),b=report([gpu(0,{sn:'S',uuid:'GPU-A'})]);
  for(const r of [compareReports(a,b),compareReports(b,a)]){assert.equal(r.matched,0);assert.equal(r.rows.length,3);assert.equal(r.rows[0].reason,'匹配不唯一');}
});
test('error-type changes are detected even when total count stays equal',()=>{
  const r=compareReports(report([gpu(0,{sn:'S'})],[event('a',0,'79','—')]),report([gpu(2,{sn:'S'})],[event('b',2,'31','—')]));assert.equal(r.changed,1);assert.equal(r.rows[0].errors.length,2);assert.ok(r.rows[0].changes.includes('错误记录'));
});
test('empty reports, incomplete reports and different servers remain explicit',()=>{
  const r=compareReports({...report([]),server:{sn:'A'},complete:false},{...report([]),server:{sn:'B'}});assert.equal(r.rows.length,0);assert.equal(r.incomplete,true);assert.equal(r.serverMismatch,true);
});
console.log(`${results.length} analysis tests passed`);
