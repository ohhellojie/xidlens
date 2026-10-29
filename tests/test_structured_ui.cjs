'use strict';
const assert=require('node:assert/strict'),ui=require('../app/structured.js');
const A='a'.repeat(32),B='b'.repeat(32),calls=[];
const ctx={render:()=>calls.push(['render']),openSource:(line,id)=>calls.push(['source',line,id])};
const row=(id,status,extra={})=>({id,run:1,test:'memory',category:'Hardware',entity:{gpu_id:0},resultKind:'entity',status,statusRaw:status,raw:{status,secretExtension:'RAW-ONLY-'+id},warnings:[],info:[],evidence:{source:'synthetic.json',line:10,endLine:14,jsonPointer:'/DCGM Diagnostic/test_categories/0/tests/0/results/'+id},...extra});
const report=(rows,extra={})=>({id:A,source:'synthetic.json',contentSha256:'r1',gpus:[{id:0,uuid:'GPU-DEMO-OTHER',pci:'0000:41:00.0'}],structured:{format:'dcgm-json',source:'synthetic.json',parserVersion:'structured-v1',recognized:true,complete:true,warnings:[],dcgm:{runs:[{run:1,version:'4.6.0',driverVersion:'580.0',evidence:{line:2,jsonPointer:'/DCGM Diagnostic'}}],results:rows,summaries:[]},...extra}});
const click=(key,value)=>ui.click({dataset:{structured:key,value}}),change=(key,value)=>ui.change({dataset:{structuredChange:key},value}),input=value=>ui.input({dataset:{structuredInput:'query'},value});
let passed=0;
function test(name,fn){ui.reset();calls.length=0;fn();passed++;console.log('Structured UI: '+name);}
test('every result state is distinct; missing values never become pass',()=>{
 const statuses=['pass','fail','warn','skip','not_run','not_recorded','unknown'],data=report(statuses.map((status,i)=>row(String(i),status)));
 const model=ui.model(data);assert.equal(model.rows.length,7);for(const status of statuses)assert.equal(model.counts[status],1);
 let html=ui.render(data,ctx);for(const label of ['通过','失败','警告','已跳过','未运行','未记录结果','未知结果'])assert.ok(html.includes(label));
 change('status','skip');html=ui.render(data,ctx);assert.equal((html.match(/class="structured-row /g)||[]).length,1);assert.ok(html.includes('已跳过'));
 const unknown=ui.model(report([row('x','new-result',{statusRaw:'New Result'})]));assert.equal(unknown.rows[0].status,'unknown');
});
test('entity results count once while the test summary remains in details',()=>{
 const data=report([row('a','fail'),row('b','pass',{entity:{gpu_id:1}})]);data.structured.dcgm.summaries=[row('s','fail',{resultKind:'summary',entity:{}})];
 const model=ui.model(data);assert.equal(model.resultCount,2);assert.equal(model.rows[0].summaries.length,1);
 const html=ui.render(data,ctx);assert.ok(html.includes('<summary>测试汇总</summary>'));assert.ok(html.includes('2 项结果'));
});
test('a global summary without entities remains a result',()=>{
 const data=report([]);data.structured.dcgm.summaries=[row('s','not_recorded',{resultKind:'summary',entity:{}})];
 const model=ui.model(data);assert.equal(model.resultCount,1);assert.equal(model.rows[0].entityLabel,'测试汇总');assert.equal(model.counts.pass,0);
 assert.ok(ui.render(data,ctx).includes('未记录结果'));
});
test('runtime failure is separate from hardware test failures',()=>{
 const data=report([]);data.structured.dcgm.runs[0].runtimeError='Synthetic host engine unavailable';
 const model=ui.model(data);assert.equal(model.resultCount,0);assert.equal(model.counts.error,1);assert.equal(model.counts.fail,0);
 const html=ui.render(data,ctx);assert.ok(html.includes('0 项结果 · 1 项运行错误'));assert.ok(html.includes('诊断未完成'));assert.ok(html.includes('Synthetic host engine unavailable'));
 click('source','runtime:0');assert.deepEqual(calls.at(-1),['source',2,A]);
});
test('runtime raw view follows its JSON Pointer and preserves unknown original fields',()=>{
 const data=report([]);data.structured.dcgm.runs[0].runtimeError='Synthetic unavailable';
 data.structured.rawDocument={'DCGM Diagnostic':{runtime_error:'Synthetic unavailable',error_code:-51,future:{original:true}}};
 ui.render(data,ctx);click('raw','runtime:0');const html=ui.render(data,ctx);
 assert.ok(html.includes('&quot;error_code&quot;: -51'));assert.ok(html.includes('&quot;future&quot;'));
});
test('unassigned and non-GPU entities are never guessed from GPU inventory',()=>{
 const data=report([row('a','fail',{entity:{}}),row('b','pass',{entity:{entity_group:'CPU',entity_id:0}}),row('c','pass',{entity:{entity_group_id:1,entity_id:0}})]);
 const model=ui.model(data);assert.deepEqual(model.rows.map(r=>r.entityLabel),['未归属设备','CPU 0','实体组 1 0']);
 const html=ui.render(data,ctx);assert.ok(html.includes('未归属设备'));assert.ok(!html.includes('0000:41:00.0'));assert.ok(!html.includes('GPU-DEMO-OTHER'));
 change('entity',model.rows[1].entityKey);assert.equal((ui.render(data,ctx).match(/class="structured-row /g)||[]).length,1);
});
test('runtime source uses precise value while raw preview retains the complete iteration',()=>{
 const data=report([]);Object.assign(data.structured.dcgm.runs[0],{runtimeError:'Synthetic unavailable',rawPointer:'',runtimeEvidence:{line:25,jsonPointer:'/runtime_error'}});
 data.structured.rawDocument={'DCGM Diagnostic':{},runtime_error:'Synthetic unavailable',future_error_code:-51};
 ui.render(data,ctx);click('source','runtime:0');assert.deepEqual(calls.at(-1),['source',25,A]);click('raw','runtime:0');const html=ui.render(data,ctx);
 assert.ok(html.includes('/runtime_error'));assert.ok(html.includes('&quot;future_error_code&quot;: -51'));
});
test('versions and iterations remain local to each run',()=>{
 const data=report([row('a','pass'),row('b','fail',{run:2})]);data.structured.dcgm.runs.push({run:2,version:'3.3.9',driverVersion:'',evidence:{line:30}});
 let html=ui.render(data,ctx);assert.ok(html.includes('4.6.0'));assert.ok(html.includes('3.3.9'));assert.ok(html.includes('版本号不保证全部字段兼容'));
 change('run','2');html=ui.render(data,ctx);assert.equal((html.match(/class="structured-row /g)||[]).length,1);assert.ok(html.includes('2 · DCGM 3.3.9'));
});
test('raw payload is lazy, bounded and does not execute markup',()=>{
 const data=report([row('a','fail',{test:'<img src=x onerror=bad()>',raw:{extension:'<script>bad()</script>',large:'Z'.repeat(70000)}})]);
 let html=ui.render(data,ctx);assert.ok(!html.includes('<img'));assert.ok(!html.includes('bad()</script>'));assert.ok(!html.includes('ZZZZ'));
 click('raw','result:0');html=ui.render(data,ctx);assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('预览已截断'));assert.ok(html.length<80000);
 click('raw','result:0');assert.ok(!ui.render(data,ctx).includes('ZZZZ'));
});
test('unknown status and extension fields remain accessible',()=>{
 const data=report([row('a','unknown',{statusRaw:'Future State',raw:{status:'Future State',extension:{x:1}}})]);
 let html=ui.render(data,ctx);assert.ok(html.includes('未知结果 · Future State'));assert.ok(!html.includes('&quot;extension&quot;'));
 click('raw','result:0');html=ui.render(data,ctx);assert.ok(html.includes('&quot;extension&quot;'));
});
test('source jumps use the current report and preserve JSON Pointer',()=>{
 const data=report([row('a','pass')]);ui.render(data,ctx);click('source','result:0');assert.deepEqual(calls.at(-1),['source',10,A]);
 const html=ui.render(data,ctx);assert.ok(html.includes('第 10–14 行'));assert.ok(html.includes('/DCGM Diagnostic/test_categories/0/tests/0/results/a'));
 const before=calls.length;click('source','not-a-row');assert.equal(calls.length,before);
 data.id=B;ui.render({...data},ctx);click('source','result:0');assert.deepEqual(calls.at(-1),['source',10,B]);
});
test('one-line JSON still retains distinct pointers and records',()=>{
 const data=report([row('a','pass',{evidence:{line:1,endLine:1,jsonPointer:'/results/0'}}),row('b','fail',{evidence:{line:1,endLine:1,jsonPointer:'/results/1'}})]);
 ui.render(data,ctx);click('select','result:1');const html=ui.render(data,ctx);assert.ok(html.includes('/results/1'));click('source','result:1');assert.deepEqual(calls.at(-1),['source',1,A]);
});
test('invalid line references are not clickable source actions',()=>{
 for(const line of [0,-1,'12',NaN,Infinity]){const data=report([row('a','pass',{evidence:{line}})]);const html=ui.render(data,ctx);assert.ok(!html.includes('data-structured="source"'));const before=calls.length;click('source','result:0');assert.equal(calls.length,before);}
});
test('10,000 results use bounded pages with last source reachable',()=>{
 const data=report(Array.from({length:10000},(_,i)=>row(String(i),'pass',{test:'test-'+i,evidence:{line:i+1}})));
 let html=ui.render(data,ctx);assert.equal((html.match(/class="structured-row /g)||[]).length,100);
 click('page','99');html=ui.render(data,ctx);assert.equal((html.match(/class="structured-row /g)||[]).length,100);assert.ok(html.includes('9901–10000 / 10000'));
 click('select','result:9999');ui.render(data,ctx);click('source','result:9999');assert.deepEqual(calls.at(-1),['source',10000,A]);
 input('test-9999');html=ui.render(data,ctx);assert.equal((html.match(/class="structured-row /g)||[]).length,1);assert.equal(ui.capture().page,0);
});
test('report state and raw expansion are isolated by identity and content revision',()=>{
 const first=report([row('a','pass')]),second={...report([row('b','fail')]),id:B,contentSha256:'r2'};
 ui.render(first,ctx);input('memory');click('raw','result:0');ui.render(first,ctx);const saved=ui.capture();
 ui.render(second,ctx);assert.equal(ui.capture().query,'');assert.equal(ui.capture().raw,false);ui.render(first,ctx);assert.deepEqual(ui.capture(),saved);
 ui.render({...first,contentSha256:'r3'},ctx);assert.equal(ui.capture().query,'');assert.equal(ui.capture().raw,false);
 assert.equal(ui.restore(saved,'case:'+B),false);assert.equal(ui.restore({...saved,page:Infinity}),true);assert.equal(ui.capture().page,0);
 ui.reset('case:'+B);assert.equal(ui.capture().identity,'case:'+A);
});
test('host identity and revision override fallback source identity',()=>{
 const data=report([row('a','pass')]);ui.render(data,{...ctx,identity:'case:host',revision:'first'});input('memory');
 assert.equal(ui.capture().identity,'case:host');ui.render(data,{...ctx,identity:'case:host',revision:'second'});assert.equal(ui.capture().query,'');
 ui.render(data,{...ctx,identity:'case:other',revision:'second'});assert.equal(ui.capture().identity,'case:other');
});
test('warnings and incomplete input stay visible without claiming success',()=>{
 const data=report([],{complete:false,warnings:['DCGM 结果达到保存上限。','<script>bad()</script>']});const html=ui.render(data,ctx);
 assert.ok(html.includes('读取不完整'));assert.ok(html.includes('structured-notices" open'));assert.ok(html.includes('未记录可读取的测试结果'));assert.ok(!html.includes('<script>'));
});
test('missing producer version is explicit; non-DCGM input has no fabricated result',()=>{
 const data=report([row('a','pass')]);data.structured.dcgm.runs[0].version='';assert.ok(ui.render(data,ctx).includes('DCGM 版本未记录'));
 const unknown=report([],{format:'goe-json',events:[{kind:'goe',code:'GPU:1:1'}]});assert.ok(ui.render(unknown,ctx).includes('未发现 DCGM 结果'));assert.equal(ui.model(unknown).rows.length,0);
});
test('native controls have names and rendering restores input focus and cursor',()=>{
 const data=report([row('a','pass')]);const html=ui.render(data,ctx);assert.ok(html.includes('aria-label="筛选 DCGM 结果"'));assert.ok(html.includes('aria-label="筛选 DCGM 实体"'));assert.ok(html.includes('aria-label="搜索 DCGM 测试"'));
 const focused=[],replacement={dataset:{structuredInput:'query'},focus:()=>focused.push('query'),setSelectionRange:(a,b)=>focused.push([a,b])},previous=global.document;
 try{global.document={querySelectorAll:()=>[replacement]};ui.input({dataset:{structuredInput:'query'},value:'mem',selectionStart:1,selectionEnd:2});assert.deepEqual(focused,['query',[1,2]]);}finally{if(previous===undefined)delete global.document;else global.document=previous;}
});
test('embedded results do not repeat the host heading',()=>{
 assert.ok(!ui.render(report([row('a','pass')]),{...ctx,embedded:true}).includes('<h1'));
});
test('unserializable local payload does not break the results screen',()=>{
 const cycle={};cycle.self=cycle;const data=report([row('a','unknown',{raw:cycle})]);ui.render(data,ctx);click('raw','result:0');assert.ok(ui.render(data,ctx).includes('无法显示此原始值'));
});
console.log('Structured UI: '+passed+' tests passed');
