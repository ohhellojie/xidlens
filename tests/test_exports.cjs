'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const data={source:'sample.log',complete:true,server:{sn:'SERVER-1',model:'Demo'},
  gpus:[0,1].map(id=>({id,index:id,label:'GPU '+id,model:'GPU',pci:'0000:'+id+'1:00.0',sn:'SN-'+id,uuid:'GPU-'+id,slot:'Slot '+id,errors:1})),
  events:[0,1].map(gpu=>({gpu,address:'0000:'+gpu+'1:00.0',kind:'xid',code:'79',title:'GPU 已从总线掉线'}))};
const state={page:'devices'};
const api=vm.runInNewContext(source.slice(source.indexOf('const safeCell='),source.indexOf('function keyline('))+';({tsv,summary})',
  {data,state,XidAnalysis:require('../app/analysis.js'),eventDeviceLabel:e=>'GPU '+e.gpu,filteredEvents:()=>data.events.filter(e=>e.gpu===1),codeLabel:e=>'Xid '+e.code});
let summary=api.summary();
assert.equal(summary.split('\n').filter(l=>l.startsWith('服务器 SN：')).length,1);
for(const g of data.gpus){assert.ok(summary.includes('GPU SN：'+g.sn));assert.ok(summary.includes('GPU UUID：'+g.uuid));}
state.page='errors';summary=api.summary();
assert.ok(summary.includes('GPU SN：SN-1'));assert.ok(!summary.includes('GPU SN：SN-0'));
assert.equal(summary.split('\n').filter(l=>l.endsWith('：1 次事件')).length,1);
data.complete=false;assert.ok(api.summary().includes('读取不完整'));
data.server.sn='';assert.ok(!api.summary().includes('服务器 SN：'));
const tsv=api.tsv(data.gpus),lines=tsv.split('\r\n');
assert.equal(lines.length,3);assert.ok(lines.every(l=>l.split('\t').length===11));
assert.ok(lines[1].includes('\t0\t'));assert.ok(lines[2].includes('\tGPU-1\t'));
data.gpus[0].sn='=SUM(1,2)\nnew\tline';
assert.ok(api.tsv(data.gpus).includes("'=SUM(1,2) new line"));
console.log('Summary and TSV export checks passed');
