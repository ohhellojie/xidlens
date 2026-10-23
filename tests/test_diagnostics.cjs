'use strict';
const assert=require('node:assert/strict');
const ui=require('../app/diagnostics.js');
const report={source:'<script>log</script>',gpus:[{id:0,pci:'0000:41:00.0',label:'GPU 0'}],nodes:{'0000:41:00.0':{kind:'gpu',fields:{}}},diagnostics:{snapshots:[{id:'s0',address:'0000:41:00.0',line:1,fields:[{name:'Current',path:'PCI/Link Width/Current',group:'PCIe 链路',value:'8x',description:'<img onerror=alert(1)>',evidence:{line:2,text:'<script>alert(1)</script>'}},{name:'Used',path:'FB Memory Usage/Used',group:'显存与 ECC',value:'0 MiB',evidence:{line:3,text:'Used : 0 MiB'}}]}],checks:[{id:'c0',address:'0000:41:00.0',title:'Link',status:'review',snapshot:'s0',path:'PCI/Link Width/Current',evidence:[]}],topology:[],matrices:[],cpuRows:[]}};
const ctx={state:{page:'status',gpu:0},heading:()=>'<h1>Test</h1>',render:()=>{}};
report.diagnostics.snapshots[0].fields.push({name:'Product Name',path:'Product Name',group:'概览',value:'Test GPU',evidence:{line:4,text:'Product Name : Test GPU'}});
let html=ui.render(report,ctx);
assert.match(html,/data-diag="group" data-value="概览" aria-pressed="true"/);assert.ok(html.includes('Test GPU'));
ui.click({dataset:{diag:'group',value:'PCIe 链路'}});html=ui.render(report,ctx);
ctx.state.page='checks';ui.render(report,ctx);ctx.state.page='status';html=ui.render(report,ctx);
assert.match(html,/data-diag="group" data-value="PCIe 链路" aria-pressed="true"/,'Returning to the same report preserves the selected group');
assert.ok(html.includes('8x'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<script>'));
ui.click({dataset:{diag:'group',value:'显存与 ECC'}});html=ui.render(report,ctx);assert.ok(html.includes('0 MiB'));assert.ok(!html.includes('8x'));
ui.click({dataset:{diag:'check',value:'c0'}});html=ui.render(report,ctx);assert.equal(ctx.state.page,'checks');assert.ok(html.includes('定位到拓扑'));
ui.click({dataset:{diag:'snapshot',value:'s0'}});html=ui.render(report,ctx);assert.equal(ctx.state.page,'status');assert.ok(html.includes('8x'));
ui.click({dataset:{diag:'locate',value:'0000:41:00.0'}});html=ui.render(report,ctx);assert.equal(ctx.state.page,'topology');assert.ok(html.includes('0000:41:00.0'));
ui.click({dataset:{diag:'view',value:'matrix'}});html=ui.render(report,ctx);assert.ok(html.includes('缺少 GPU 互联矩阵'));
report.diagnostics.matrices=[{id:'m0',mode:'m',labels:['GPU0'],rows:[{label:'GPU0',cells:['X'],affinity:['0-15','0'],evidence:{line:5,text:'GPU0 X 0-15 0'}}],mapping:{GPU0:'0000:41:00.0'},complete:true,evidence:{line:4,text:'GPU0 CPU Affinity'}}];
html=ui.render(report,ctx);assert.ok(html.includes('topo -m'));ui.click({dataset:{diag:'cell',value:'GPU0|GPU0'}});html=ui.render(report,ctx);assert.ok(html.includes('设备自身'));
ui.reset();html=ui.render({...report,diagnostics:undefined},ctx);assert.ok(html.includes('此报告需要重新解析'));
console.log('Diagnostic views: navigation, evidence escaping, zero values, matrix and legacy reports passed');

ui.reset();ctx.state.page='status';html=ui.render(structuredClone(report),ctx);
assert.match(html,/data-diag="group" data-value="概览" aria-pressed="true"/,'A new report starts at Overview');

// Ordinary values stay quiet; a passing check must not mask another failed check.
{
 const sample=structuredClone(report),field=sample.diagnostics.snapshots[0].fields[0];
 sample.diagnostics.checks=[{id:'pass',address:sample.gpus[0].pci,status:'ok',snapshot:'s0',path:field.path,title:'Pass'}];
 ui.reset();ctx.state.page='status';ui.render(sample,ctx);ui.click({dataset:{diag:'group',value:'PCIe 链路'}});html=ui.render(sample,ctx);assert.ok(!html.includes('<th>提示</th>'));assert.ok(html.includes('8x'));
 sample.diagnostics.checks.push({id:'fail',address:sample.gpus[0].pci,status:'error',snapshot:'s0',path:field.path,title:'Failure'});
 html=ui.render(sample,ctx);assert.ok(html.includes('<th>提示</th>'));assert.ok(html.includes('<td><span class="badge diag-error">发现错误</span></td>'));
 sample.diagnostics.checks=[];field.availability='unavailable';ui.reset();ui.render(sample,ctx);ui.click({dataset:{diag:'group',value:'PCIe 链路'}});html=ui.render(sample,ctx);assert.ok(html.includes('<td><span class="badge diag-missing">数据不足</span></td>'));
 ui.reset();
}

// Multiple checks share a cell without losing their original evidence or categories.
{
 const sample={source:'sample',gpus:[{id:0,pci:'0000:01:00.0',model:'Test GPU'}],nodes:{'0000:01:00.0':{kind:'gpu',fields:{}},'0000:02:00.0':{kind:'nic',fields:{}},'0000:03:00.0':{kind:'device',fields:{}}},diagnostics:{snapshots:[],topology:[],matrices:[],cpuRows:[],checks:[
  {id:'r1',rule:'smi-read',address:'0000:01:00.0',status:'error',title:'Read error',observation:'Unknown Error',evidence:[{line:1,text:'<script>unsafe</script>'}]},
  {id:'r2',rule:'smi-read',address:'0000:01:00.0',status:'error',title:'Read error',observation:'GPU requires reset',evidence:[]},
  {id:'ce',rule:'pcie-status',address:'0000:02:00.0',status:'error',title:'CESta 错误状态位置位',observation:'RxErr',evidence:[]},
  {id:'future',rule:'unknown-future-rule',address:'0000:03:00.0',status:'review',title:'Future check',evidence:[]},
  {id:'global',rule:'topology-data',address:'',status:'missing',title:'Matrix missing',evidence:[]}
 ]}};
 const model=ui.checksModel(sample);assert.equal(model.rows[0].cells.get('read').length,2);assert.ok(model.columns.includes('other'));assert.ok(model.columns.includes('report'));
 ui.reset();ctx.state.page='checks';html=ui.render(sample,ctx);
 assert.ok(html.includes('Unknown Error')&&html.includes('GPU requires reset'));assert.ok(html.includes('不适用'));assert.ok(html.includes('未采集'));assert.ok(!html.includes('&lt;script&gt;unsafe'),'Evidence stays collapsed');
 ui.click({dataset:{diag:'checkEvidence'}});html=ui.render(sample,ctx);assert.ok(html.includes('&lt;script&gt;unsafe'));assert.ok(!html.includes('<script>unsafe'));
 ui.click({dataset:{diag:'checkCell',value:'0000:02:00.0|CESta'}});html=ui.render(sample,ctx);assert.ok(html.includes('RxErr'));
 ui.change({dataset:{diagChange:'checkOnly'},type:'checkbox',checked:true});html=ui.render(sample,ctx);assert.ok(html.includes('Matrix missing'),'Attention filter retains missing evidence');
 ui.click({dataset:{diag:'check',value:'global'}});html=ui.render(sample,ctx);assert.ok(html.includes('Matrix missing'),'External deep links reveal a collapsed report group');
 ui.reset();ctx.state.page='checks';
}

// Many devices remain independently selectable, with bounded rendering and reachable pages.
for(const count of [1,16,64,240]){
 const many={source:'many',gpus:[],nodes:{},diagnostics:{snapshots:[],topology:[],matrices:[],cpuRows:[],checks:[]}};
 for(let i=0;i<count;i++){const address=`0000:${i.toString(16).padStart(2,'0')}:00.0`;many.gpus.push({id:i,pci:address,label:'GPU '+i});many.diagnostics.checks.push({id:'m'+i,rule:'pcie-link',address,status:'review',title:'Link '+i,evidence:[]});}
 ui.reset();ctx.state.page='checks';html=ui.render(many,ctx);assert.equal((html.match(/class="check-device"/g)||[]).length,Math.min(count,100));
 ui.click({dataset:{diag:'check',value:'m'+(count-1)}});html=ui.render(many,ctx);assert.ok(html.includes('Link '+(count-1)));
}

// Large reports stay bounded; navigation and filters still include every record.
{
 const large=structuredClone(report);large.diagnostics.snapshots[0].fields=Array.from({length:10001},(_,i)=>({name:'Value '+i,path:'PCI/'+i,value:String(i),group:'PCIe 链路',evidence:{line:i+1,text:'Value '+i}}));
 large.diagnostics.checks=Array.from({length:10001},(_,i)=>({id:'large'+i,title:'Check '+i,status:i===10000?'error':'ok',snapshot:'s0',path:'PCI/'+i,evidence:[]}));
 ui.reset();ctx.state.page='status';ui.render(large,ctx);ui.click({dataset:{diag:'group',value:'PCIe 链路'}});html=ui.render(large,ctx);
 assert.equal((html.match(/<tr data-diag="field"/g)||[]).length,100);assert.ok(html.includes('1–100 / 10001'));
 ui.click({dataset:{diag:'fieldPage',value:'100'}});html=ui.render(large,ctx);assert.equal((html.match(/<tr data-diag="field"/g)||[]).length,1);assert.ok(html.includes('Value 10000'));
 ui.click({dataset:{diag:'check',value:'large10000'}});html=ui.render(large,ctx);assert.ok(html.includes('1–100 / 10001'));assert.ok(html.includes('Check 10000'));
 ui.click({dataset:{diag:'filter',value:'error'}});html=ui.render(large,ctx);assert.equal((html.match(/data-diag="checkItem"/g)||[]).length,1);
 ui.click({dataset:{diag:'snapshot',value:'s0'}});html=ui.render(large,ctx);assert.ok(html.includes('Value 10000'));
 ui.reset();ctx.state.page='status';
}

ui.reset();ctx.state.page='checks';
report.diagnostics.checks.push({id:'c1',status:'ok',title:'Clean',evidence:[]});
ui.render(report,ctx);ui.click({dataset:{diag:'filter',value:'review'}});ui.render(report,ctx);
ui.click({dataset:{diag:'check',value:'c0'}});html=ui.render(report,ctx);
assert.ok(!html.includes('>Clean<'),'Selecting a check must preserve its status filter');
assert.ok(html.includes('class="check-cell"'),'The whole matrix cell is selectable');
report.nodes['0000:00:01.0']={kind:'bridge',fields:{}};
report.nodes['0000:20:00.0']={kind:'bridge',fields:{}};
report.diagnostics.topology=[{address:'0000:00:01.0',parent:null},{address:'0000:20:00.0',parent:'0000:00:01.0'},{address:'0000:41:00.0',parent:'0000:20:00.0'}];
ui.click({dataset:{diag:'locate',value:'0000:41:00.0'}});html=ui.render(report,ctx);
assert.ok(html.includes('aria-label="选中设备路径"'));assert.equal((html.match(/class="diag-node"/g)||[]).length,3);
// Explicit collapse remains stable when another node is selected.
ui.reset();ctx.state.page='topology';ui.render(report,ctx);ui.click({dataset:{diag:'branch',value:'0000:20:00.0'}});
html=ui.render(report,ctx);assert.equal((html.match(/class="diag-node"/g)||[]).length,2);
ui.click({dataset:{diag:'node',value:'0000:00:01.0'}});html=ui.render(report,ctx);assert.equal((html.match(/class="diag-node"/g)||[]).length,2);
ui.change({dataset:{diagChange:'kind'},value:'gpu'});html=ui.render(report,ctx);assert.equal((html.match(/class="diag-node"/g)||[]).length,3,'Filtering retains the entire ancestor path');
ui.change({dataset:{diagChange:'kind'},value:'all'});html=ui.render(report,ctx);assert.equal((html.match(/class="diag-node"/g)||[]).length,2,'Filtering does not overwrite expansion state');
ui.click({dataset:{diag:'detail',value:''}});html=ui.render(report,ctx);assert.ok(html.includes('diag-wide'));
const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const validate=vm.runInNewContext(source.slice(source.indexOf('function validateLogFile('),source.indexOf('function importDialog('))+';validateLogFile');
for(const name of ['report.LOG','nvidia-bug-report.log.gz','dmesg','syslog','messages','lspci.txt','bundle.tar.gz'])assert.equal(validate({name,size:100}),'');
for(const name of ['photo.png','report.pdf','log.txt.exe','syslog.exe'])assert.ok(validate({name,size:100}));
assert.ok(validate({name:'gpu.log',size:0}));assert.ok(validate({name:'gpu.log',size:513*1024*1024}));
console.log('Experience: row selection, filter persistence, topology paths/collapse, import preflight passed');

ui.reset();ctx.state.page='topology';
report.diagnostics.matrices=[{id:'m1',mode:'m',labels:['GPU0','GPU1','NIC0'],rows:[
 {label:'NIC0',cells:['PXB','SYS','X'],affinity:[]},
 {label:'GPU1',cells:['SYS','X','SYS'],affinityValues:{'CPU Affinity':'2-3','NUMA Affinity':'1'},evidence:{line:3,text:'GPU1 SYS X SYS 2-3 1'}},
 {label:'GPU0',cells:['X','SYS','PXB'],affinityValues:{'CPU Affinity':'0-1','NUMA Affinity':'0'},evidence:{line:4,text:'GPU0 X SYS PXB 0-1 0'}}
],mapping:{},nicNames:{NIC0:[{name:'mlx5_0'}]},complete:true,evidence:{line:1,text:'GPU0 GPU1 NIC0 CPU Affinity NUMA Affinity'}}];
ui.render(report,ctx);ui.click({dataset:{diag:'view',value:'matrix'}});html=ui.render(report,ctx);
assert.equal((html.match(/data-matrix-row=/g)||[]).length,4,'Default view contains only GPU pairs');
assert.ok(html.includes('GPU0 到 GPU1：SYS'));assert.ok(!html.includes('NIC0 到'));
ui.click({dataset:{diag:'matrixScope',value:'nic'}});html=ui.render(report,ctx);
assert.equal((html.match(/data-matrix-row=/g)||[]).length,2);
assert.ok(html.includes('GPU0 到 NIC0：PXB'));assert.ok(html.includes('mlx5_0'));
assert.ok(html.includes('CPU Affinity'));assert.ok(html.includes('0-1'));
ui.change({dataset:{diagChange:'matrixFocus'},value:'GPU1'});html=ui.render(report,ctx);
assert.equal((html.match(/data-matrix-row=/g)||[]).length,1);assert.ok(html.includes('GPU1 到 NIC0：SYS'));
ui.change({dataset:{diagChange:'matrixFocus'},value:''});ui.click({dataset:{diag:'matrixScope',value:'all'}});html=ui.render(report,ctx);
assert.equal((html.match(/data-matrix-row=/g)||[]).length,9);
report.diagnostics.matrices[0].rows=report.diagnostics.matrices[0].rows.filter(r=>r.label!=='GPU1');
report.diagnostics.matrices[0].complete=false;html=ui.render(report,ctx);
assert.ok(html.includes('GPU1 到 GPU0：未采集'));assert.ok(html.includes('缺少 1 行数据'));
ui.click({dataset:{diag:'view',value:'tree'}});
report.nodes['0000:81:00.0']={kind:'nic',fields:{}};
report.diagnostics.topology.push({address:'0000:81:00.0',parent:'',rootConfirmed:false});
html=ui.render(report,ctx);assert.ok(html.includes('上游未确认'));assert.ok(!html.includes('data-value="0000:81:00.0"'));
ui.click({dataset:{diag:'unlinked'}});html=ui.render(report,ctx);assert.ok(html.includes('data-value="0000:81:00.0"'));
console.log('Matrix: GPU/NIC scopes, shuffled row lookup, affinity, focus, missing cells; unlinked endpoints passed');

for(const count of [1,16,32,64]){
 ui.reset();ctx.state.page='topology';ui.openMatrix();
 const names=Array.from({length:count},(_,i)=>'GPU'+i);
 const rows=names.map((label,i)=>({label,cells:names.map((_,j)=>i===j?'X':(i+j)%2?'SYS':'PIX'),affinity:[],evidence:{line:i+2,text:label}})).reverse();
 report.diagnostics.matrices=[{id:'scale',labels:names,rows,mapping:{},complete:true,mode:'m',evidence:{line:1,text:names.join(' ')}}];
 html=ui.render(report,ctx);
 assert.equal((html.match(/data-matrix-row=/g)||[]).length,Math.min(count,16)**2,'Rendered size must stay bounded');
 if(count>16){
  ui.click({dataset:{diag:'matrixRowPage',value:'1'}});ui.click({dataset:{diag:'matrixColPage',value:'1'}});html=ui.render(report,ctx);
  assert.ok(html.includes('GPU16 到 GPU17：SYS'));assert.ok(!html.includes('GPU0 到 GPU1：'));
  ui.change({dataset:{diagChange:'matrixFocus'},value:'GPU31'});html=ui.render(report,ctx);
  assert.equal((html.match(/data-matrix-row=/g)||[]).length,16);assert.ok(html.includes('GPU31 到 GPU0：SYS'));
 }
}
console.log('Matrix scale: 1, 16, 32, 64 GPUs; bounded row/column paging and device focus passed');
ui.reset();ui.openMatrix();
report.diagnostics.matrices[0].rows.find(r=>r.label==='GPU0').cells[1]='FUTURE';
report.diagnostics.matrices[0].warnings=['Unknown <script> relation'];
report.diagnostics.matrices[0].complete=false;
html=ui.render(report,ctx);
assert.ok(html.includes('GPU0 到 GPU1：FUTURE'));assert.ok(html.includes('未识别的关系码，保留日志原值。'));
assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
