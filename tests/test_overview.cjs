'use strict';
const assert=require('node:assert/strict');
const ui=require('../app/overview.js');
const ref=(line,text,extra={})=>({line,text,section:'nvidia-smi -q',time:{raw:''},...extra});
const gpu=(id,pci,extra={})=>({id,label:'GPU '+id,pci,fields:{},pciFields:{},...extra});
const field=(path,value,line,extra={})=>({path,name:path.split('/').at(-1),value,evidence:ref(line,path+': '+value),...extra});
const a='0000:41:00.0',b='0000:81:00.0',c='0000:c1:00.0';
const normalFields=[field('ECC Errors/Volatile/DRAM/Uncorrectable','0',101),field('Remapped Rows/Pending','No',112)];
const base=()=>({source:'demo-node.log',server:{time:'2026-01-01 14:20 +08:00'},complete:true,gpus:[gpu(0,a),gpu(1,b,{pciEvidence:ref(82,'PCI device')}),gpu(2,c,{fields:{model:[{value:'NVIDIA A100',origin:'nvidia-smi',evidence:ref(128,'Product Name: NVIDIA A100')},{value:'NVIDIA H100',origin:'/proc',evidence:ref(246,'Model: NVIDIA H100')}],uuid:[{value:'GPU-DEMO-003',evidence:ref(129,'GPU UUID: GPU-DEMO-003')}]}})],nodes:{},events:[],diagnostics:{snapshots:[{id:'s0',address:a,fields:normalFields},{id:'s2',address:c,fields:[field('Product Name','NVIDIA A100',128)]}],checks:[{id:'driver0',address:a,rule:'driver',status:'ok',title:'内核驱动绑定',observation:'nvidia',evidence:[ref(44,'Kernel driver in use: nvidia')]}]}});
const results=[];
function test(name,fn){fn();results.push(name);}
let renderCount=0;
const ctx={state:{page:'overview'},render:()=>renderCount++,icon:()=>''};
test('mixed report keeps normal scope, missing data and conflicting sources separate',()=>{
 const m=ui.buildModel(base());
 assert.equal(m.counts.ok,1);assert.equal(m.counts.conflict,1);assert.equal(m.counts.missing,1);
 const ok=m.findings.find(f=>f.status==='ok');assert.equal(ok.scope.length,3);assert.ok(ok.scope.some(s=>s.name.includes('易失性')&&s.value==='0'));
 const missing=m.findings.find(f=>f.status==='missing');assert.equal(missing.address,b);assert.deepEqual(missing.gaps,['smi']);assert.equal(missing.evidence[0].line,82);
 const conflict=m.findings.find(f=>f.status==='conflict');assert.deepEqual(conflict.values.map(v=>v.value),['NVIDIA A100','NVIDIA H100']);assert.deepEqual(conflict.evidence.map(e=>e.line),[128,246]);
});
test('detail has source jumps and no inferred collection times',()=>{
 const d=base();ui.reset();let html=ui.render(d,ctx);
 assert.ok(html.includes('诊断概览'));assert.ok(html.includes('需要关注'));assert.ok(html.includes('已检查项'));
 assert.ok(html.includes('时间未记录'));assert.ok(html.includes('data-source-line="128"'));assert.ok(html.includes('data-source-line="246"'));
 assert.ok(!html.includes('整机健康'));assert.ok(!html.includes('故障已排除'));assert.ok(!html.includes('置信度'));
 ui.click({dataset:{overview:'select',value:'missing:smi:'+b}});html=ui.render(d,ctx);assert.ok(html.includes('ECC、行重映射等状态无法判断'));assert.ok(html.includes('查看补采清单'));
 ui.click({dataset:{overview:'collect'}});html=ui.render(d,ctx);assert.ok(html.includes('nvidia-smi -q'));assert.ok(html.includes('不会执行这些命令'));
 ui.click({dataset:{overview:'select',value:'ok:'+a}});html=ui.render(d,ctx);assert.ok(html.includes('以下项目在采集时未见异常'));assert.ok(html.includes('未采集项目无法判断'));
});
test('zero cannot hide conflicting numeric samples or another failed check',()=>{
 const d=base();d.diagnostics.snapshots.push({id:'s3',address:a,fields:[field('ECC Errors/Volatile/DRAM/Uncorrectable','9',200)]});
 d.diagnostics.checks.push({id:'ecc9',rule:'smi-health',address:a,status:'error',path:'ECC Errors/Volatile/DRAM/Uncorrectable',title:'ECC 非零计数',observation:'9',evidence:[ref(200,'Uncorrectable : 9')]});
 const m=ui.buildModel(d),ok=m.findings.find(f=>f.id==='ok:'+a);assert.ok(!ok.scope.some(s=>s.name.includes('ECC')));assert.equal(m.counts.error,1);assert.ok(m.findings.find(f=>f.status==='error').next.includes('计数重置'));
 d.diagnostics.checks.push({id:'driver1',rule:'driver',address:a,status:'review',title:'内核驱动绑定',observation:'vfio-pci',evidence:[ref(45,'Kernel driver in use: vfio-pci')]});
 assert.ok(!ui.buildModel(d).findings.find(f=>f.id==='ok:'+a).scope.some(s=>s.name==='内核驱动绑定'));
});
test('not supported stays distinct from unknown and an empty snapshot is missing',()=>{
 const d=base();d.diagnostics.snapshots[0].fields=[field('ECC Errors/Volatile/DRAM/Uncorrectable','Not Supported',3,{availability:'unavailable'})];
 assert.ok(!ui.buildModel(d).findings.some(f=>f.id==='missing:fields:'+a));
 d.diagnostics.snapshots[0].fields=[field('ECC Errors/Volatile/DRAM/Uncorrectable','N/A',3,{availability:'unavailable'})];
 assert.ok(ui.buildModel(d).findings.some(f=>f.id==='missing:fields:'+a));
 d.diagnostics.snapshots[0].fields=[];assert.ok(ui.buildModel(d).findings.some(f=>f.id==='missing:smi:'+a));
});
test('equal identity values do not conflict; changing measurements are not identity conflicts',()=>{
 const d=base();d.gpus[2].fields.model[1].value='NVIDIA A100';d.gpus[0].pciFields.link=[{value:'16 GT/s'},{value:'2.5 GT/s'}];
 assert.equal(ui.buildModel(d).counts.conflict,0);
 d.server.fields={sn:[{value:'DEMO-A',evidence:ref(1,'Serial: DEMO-A')},{value:'DEMO-B',evidence:ref(2,'Serial: DEMO-B')}]};
 assert.equal(ui.buildModel(d).counts.conflict,1);
});
test('events retain members and do not double count diagnostic evidence',()=>{
 const d=base();d.events=[{id:'a',kind:'xid',code:'79',address:a,line:300,raw:'NVRM: Xid 79',title:'GPU event'},{id:'b',kind:'xid',code:'79',address:a,line:301,raw:'NVRM: Xid 79',title:'GPU event'},{id:'c',kind:'init',address:a,line:302,raw:'init'},{id:'d',kind:'aer',address:a,line:303,raw:'AER',title:'PCIe AER'}];
 d.diagnostics.checks.push({id:'aer',rule:'aer',address:a,status:'error',title:'AER',evidence:[ref(303,'AER')]});
 const m=ui.buildModel(d);assert.equal(m.counts.error,3);assert.ok(m.findings.some(f=>f.title==='初始化失败'));const e=m.findings.find(f=>f.event);assert.equal(e.count,2);assert.equal(e.evidence.length,2);
 ui.reset();assert.doesNotThrow(()=>ui.render(d,ctx));
});
test('all raw values, conflict sources and collection markup are escaped',()=>{
 const d=base();d.gpus[2].fields.model[0]={value:'<script>unsafe</script>',origin:'<img src=x onerror=bad()>',evidence:ref(128,'<script>unsafe</script>')};
 ui.reset();const html=ui.render(d,ctx);assert.ok(html.includes('&lt;script&gt;unsafe'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<script>unsafe'));assert.ok(!html.includes('<img src=x'));
});
test('legacy and truncated reports do not look normal',()=>{
 const legacy={source:'old.log',gpus:[],events:[],nodes:{},server:{},complete:false};
 const m=ui.buildModel(legacy);assert.ok(m.findings.some(f=>f.id==='missing:legacy'));assert.ok(m.findings.some(f=>f.id==='missing:complete'));assert.equal(m.counts.ok,0);
 const d=base();d.complete=false;d.diagnostics.checks.push({id:'incomplete',rule:'incomplete',status:'missing',title:'日志读取不完整'});assert.equal(ui.buildModel(d).findings.filter(f=>f.title==='日志读取不完整').length,1);
});
test('large findings are bounded, searchable and reachable',()=>{
 const d={source:'many.log',gpus:[],events:[],nodes:{},server:{},diagnostics:{snapshots:[],checks:Array.from({length:151},(_,i)=>({id:'c'+i,status:'error',rule:'smi-read',title:'Read '+i,observation:'Observation '+i,evidence:[ref(i+1,'Error '+i)]}))}};
 ui.reset();let html=ui.render(d,ctx);assert.equal((html.match(/class="overview-row /g)||[]).length,50);assert.ok(html.includes('1–50 / 151'));
 ui.click({dataset:{overview:'page',value:'3'}});html=ui.render(d,ctx);assert.equal((html.match(/class="overview-row /g)||[]).length,1);assert.ok(html.includes('Read 150'));
 ui.input({id:'overview-search',value:'Read 125'});html=ui.render(d,ctx);assert.ok(html.includes('Read 125'));assert.equal((html.match(/class="overview-row /g)||[]).length,1);
 ui.change({dataset:{overviewChange:'filter'},value:'missing'});html=ui.render(d,ctx);assert.ok(html.includes('没有匹配的发现'));
});
test('selection and filter capture restore without losing context',()=>{
 const d=base();ui.reset();ui.render(d,ctx);ui.change({dataset:{overviewChange:'filter'},value:'missing'});ui.render(d,ctx);const saved=ui.capture();
 ui.reset();ui.restore(saved);const html=ui.render(d,ctx);assert.ok(html.includes('value="missing" selected'));assert.ok(html.includes('缺少 GPU 详细状态'));assert.ok(renderCount>0);
});
test('empty report offers a demo, collection guide and import',()=>{
 ui.reset();const html=ui.render({gpus:[],events:[]},ctx);assert.ok(html.includes('data-action="load-demo"'));assert.ok(html.includes('data-action="import"'));assert.ok(html.includes('采集说明'));
 assert.deepEqual(ui.collectionPlan(['smi','smi','pci']).map(p=>p.key),['smi','pci']);assert.ok(ui.collectionPlan(['smi'])[0].command==='nvidia-smi -q');
});
test('matrix exposes quiet state meanings and places health results before wide columns',()=>{
 const diagnostics=require('../app/diagnostics.js'),d=base();
 d.diagnostics.topology=[];d.diagnostics.matrices=[];d.diagnostics.cpuRows=[];
 d.diagnostics.checks.push({id:'ecc',rule:'smi-health',status:'error',title:'ECC 非零计数',observation:'1',address:a,path:'ECC Errors/Aggregate/DRAM/Uncorrectable',snapshot:'s0',evidence:[ref(150,'Uncorrectable : 1')]});
 const model=diagnostics.checksModel(d);assert.equal(model.columns[0],'health');
 diagnostics.reset();const html=diagnostics.render(d,{...ctx,state:{page:'checks',gpu:0},heading:()=>''});assert.ok(html.includes('check-neutral-state'));assert.ok(html.includes('未采集'));assert.ok(html.includes('nvidia'));
});
test('structured event findings keep namespace, count and every source pointer',()=>{
 const d={source:'synthetic.json',gpus:[gpu(0,a)],nodes:{},server:{},diagnostics:{snapshots:[],checks:[]},events:[
  {id:'s',gpu:0,address:a,kind:'sxid',code:'119',line:5,raw:'Synthetic switch',occurrenceCount:1,structured:{switch:2,representations:[{line:5}]}},
  {id:'g',gpu:null,address:a,kind:'goe',code:'1',line:7,raw:'Synthetic GOE',occurrenceCount:1,representationCount:2,targetUUID:'GPU-SYNTHETIC',structured:{moduleSignature:'GPU-GSP',category:1,moduleEventCode:1,severity:'Fatal',severityDomain:'host-cper',scope:'HOST',legacyXid:119,representations:[{line:7,jsonPointer:'/events/0'},{line:7,jsonPointer:'/events/1'}]}},
  {id:'x',gpu:0,address:a,kind:'xid',code:'119',line:8,raw:'Synthetic Xid'}]};
 const m=ui.buildModel(d),events=m.findings.filter(f=>f.event),goe=events.find(f=>f.event.kind==='goe');
 assert.equal(events.length,3);assert.equal(events.find(f=>f.event.kind==='sxid').device,'NVSwitch 2');assert.equal(goe.device,'GPU-SYNTHETIC');assert.equal(goe.status,'review');assert.equal(goe.count,1);assert.equal(goe.evidence.length,2);assert.match(goe.observation,/1 次事件 · 2 处来源/);assert.match(goe.basis,/主机 CPER 严重性/);assert.match(goe.basis,/HOST/);assert.match(goe.basis,/仅关联提示，未合并/);
 const other={...d.events[1],id:'g2',structured:{...d.events[1].structured,moduleEventCode:2}};d.events.push(other);assert.equal(ui.buildModel(d).findings.filter(f=>f.event?.kind==='goe').length,2);
 ui.reset();ui.render(d,ctx);ui.click({dataset:{overview:'select',value:goe.id}});const html=ui.render(d,ctx);assert.ok(html.includes('/events/0'));assert.ok(html.includes('/events/1'));assert.ok(html.includes('GOE · 实验性'));
});
test('DCGM passes do not become normal GPU state or a missing test claim',()=>{
 const d={source:'synthetic.json',structured:{format:'dcgm-json'},gpus:[],events:[],server:{},nodes:{},diagnostics:{checks:[{id:'p',rule:'dcgm',status:'ok',address:'',title:'DCGM memory',observation:'GPU 0 · 通过'}],snapshots:[]}};
 assert.equal(ui.buildModel(d).counts.ok,0);ui.reset();const html=ui.render(d,ctx);assert.ok(html.includes('data-page="structured"'));assert.ok(!html.includes('日志未提供检查所需的数据'));assert.ok(!html.includes('0 块 GPU'));
});
console.log('Overview: '+results.length+' tests passed');
