'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const host=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const section=(from,to)=>{const a=host.indexOf(from),b=host.indexOf(to,a);assert.ok(a>=0&&b>a,from);return host.slice(a,b);};
const A='a'.repeat(32),B='b'.repeat(32),C='c'.repeat(32),pci='0000:41:00.0';
const plain=value=>JSON.parse(JSON.stringify(value));
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const node=()=>({id:'',value:'',dataset:{},disabled:false,hidden:false,open:false,style:{},classList:{toggle(){}},setAttribute(){},focus(){},querySelector(){return null;}});
function report(id,dcgm=true){return {id,source:'synthetic-'+id[0]+'.json',contentSha256:id,lines:600,server:{},gpus:[],events:[],nodes:{},warnings:[],diagnostics:{checks:[],snapshots:[]},...(dcgm?{structured:{format:'dcgm-json',dcgm:{runs:[{run:1,version:'4.0'}],results:Array.from({length:240},(_,i)=>({run:1,test:'TEST '+i,category:'Synthetic',entity:{gpu_id:i%2},status:i%2?'fail':'pass',raw:{status:'Synthetic'},evidence:{line:i+1,jsonPointer:'/results/'+i}})),summaries:[]}}}:{})};}
function fixture(){
 const nodes=new Map(),requests=[],mounts=[],focusables=[],contexts=[],listeners={};
 const env={state:{page:'overview',compareBase:'',drawer:false},data:report(A),loadedCase:A,loading:false,busy:false,loadRequest:0,cases:[{id:A},{id:B}],
  viewPositions:new Map(),caseViews:new Map(),renderedView:'',readerReturn:null,pendingSource:null,structuredClone,comparisonSourceView:null,comparisonRequest:0,comparisonData:null,comparisonLoading:false,comparisonError:'',
  sessionState:{loaded:true},titles:{overview:'诊断概览',structured:'DCGM 结果',reader:'完整日志',compare:'日志对比'},
  $(id){if(id==='knowledge-host'||id==='reader-host'&&env.state.page!=='reader')return null;if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},
  document:{activeElement:null,querySelector(){return node();},querySelectorAll(){return focusables;},addEventListener(name,callback){listeners[name]=callback;}},
  XidReader:{unmount(){},mount(_node,options){mounts.push(options);}},
  XidDiagnostics:{reset(){},restore(){},capture(){return {};},leave(){},openMatrix(){},afterRender(){},dismissPicker(){},input(){return false;},change(){return false;}},
  XidOverview:{afterRender(){},reset(){},restore(){},capture(){return {};},render(){return '<h1>诊断概览</h1>';}},
  saveViewPosition(){},restoreViewPosition(){},renderDrawer(){},syncReportControls(){},closeMenu(){},closeDrawer(){},closeDialog(){},status(){},toast(){},icon(){return '';},esc,
  comparisonReader(){return null;},api(path){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});requests.push({path,resolve,reject});return promise;}
 };
 env.window=env;vm.createContext(env);
 vm.runInContext(fs.readFileSync(require.resolve('../app/analysis.js'),'utf8')+fs.readFileSync(require.resolve('../app/structured.js'),'utf8')+
  section('function renderNav()','function gpuRows(')+section('function focusKey(','let knowledgeCode=')+
  section('function renderStructured()','function renderTimeline(')+section('function render(preserveScroll','function openGpu(')+
  section('function rememberCaseView()','function openSource(')+section('function openSource(',"document.addEventListener('click',event=>{const target=event.target.closest('[data-source-line]')")+
  section('async function loadCase(','async function refreshCases('),env);
 const render=env.XidStructured.render;env.XidStructured.render=(data,ctx)=>{contexts.push(ctx);return render(data,ctx);};
 const load=async(id,next=report(id),force=false)=>{const pending=env.loadCase(id,force);requests.at(-1).resolve(next);await pending;};
 return {env,nodes,requests,mounts,focusables,contexts,listeners,load};
}
async function stateAndNavigation(){
 const f=fixture(),{env,load}=f;await load(B);assert.equal(env.state.page,'structured');assert.match(env.$('navigation').innerHTML,/data-page="structured"/);assert.match(env.$('content').innerHTML,/DCGM 结果/);assert.equal(env.$('export-button').hidden,true);
 env.XidStructured.change({dataset:{structuredChange:'status'},value:'fail'});env.XidStructured.input({dataset:{structuredInput:'query'},value:'TEST 1'});const saved=plain(env.XidStructured.capture());
 await load(A);assert.equal(env.XidStructured.capture().query,'');await load(B);assert.deepEqual(plain(env.XidStructured.capture()),saved);
 await load(A);await load(B,{...report(B),contentSha256:'new-revision'});assert.equal(env.XidStructured.capture().query,'');
 env.XidStructured.input({dataset:{structuredInput:'query'},value:'TEST'});await load(B,report(B),true);assert.equal(env.XidStructured.capture().query,'');
 await load(C,report(C,false));assert.equal(env.state.page,'overview');assert.ok(!env.$('navigation').innerHTML.includes('data-page="structured"'));
 env.state.page='structured';env.render();assert.equal(env.state.page,'overview','A removed or non-DCGM report cannot retain the DCGM route');
}
async function sourceAndStaleCallbacks(){
 const f=fixture(),{env,load,focusables,mounts,contexts}=f;await load(B);env.XidStructured.change({dataset:{structuredChange:'status'},value:'pass'});env.XidStructured.click({dataset:{structured:'page',value:'1'}});env.XidStructured.click({dataset:{structured:'select',value:'result:204'}});
 const saved=plain(env.XidStructured.capture()),focused=[],sourceNode={...node(),dataset:{structured:'source',value:'result:204'},focus(){focused.push('source');}};
 focusables.push(sourceNode);env.document.activeElement=sourceNode;const before=contexts.at(-1);env.XidStructured.click(sourceNode);
 assert.equal(env.state.page,'reader');assert.equal(mounts.at(-1).caseId,B);assert.equal(mounts.at(-1).sourceLine,205);assert.equal(mounts.at(-1).backLabel,'DCGM 结果');
 mounts.at(-1).onBack();assert.equal(env.state.page,'structured');assert.deepEqual(plain(env.XidStructured.capture()),saved);assert.equal(focused.at(-1),'source');
 const pending=env.loadCase(A);before.openSource(42,B);assert.equal(env.state.page,'structured','Loading blocks callbacks from the previous report');f.requests.at(-1).resolve(report(A));await pending;
 before.openSource(42,B);assert.equal(env.state.page,'structured');assert.equal(env.loadedCase,A);const oldHTML=env.$('content').innerHTML;before.render();assert.equal(env.$('content').innerHTML,oldHTML);
 const older=env.loadCase(B),newer=env.loadCase(C, true);f.requests.at(-1).resolve(report(C,false));await newer;f.requests.at(-2).resolve(report(B));await older;assert.equal(env.loadedCase,C);assert.equal(env.state.page,'overview');
}
async function focusAndDispatch(){
 const f=fixture(),{env,load,focusables,listeners}=f;await load(B);const focused=[];
 for(const dataset of [{structured:'select',value:'result:3'},{structuredChange:'status'},{structuredInput:'query'}]){const el={...node(),dataset,focus(){focused.push(dataset);}};focusables.splice(0,focusables.length,el);env.restoreFocus(env.focusKey(el));assert.deepEqual(focused.at(-1),dataset);}
 const calls=[];for(const name of ['click','input','change'])env.XidStructured[name]=target=>{calls.push([name,target]);return true;};
 vm.runInContext(section("document.addEventListener('click',async event=>{XidDiagnostics.dismissPicker","document.addEventListener('focusin'")+
  host.split('\n').find(line=>line.startsWith("document.addEventListener('input',event=>{if(globalThis.XidTimeline"))+
  host.split('\n').find(line=>line.startsWith("document.addEventListener('change',event=>{const el=event.target;if(globalThis.XidTimeline")),env);
 const button={dataset:{structured:'raw'},closest(selector){return ['button','[data-structured]'].includes(selector)?this:null;}};
 await listeners.click({target:button});listeners.input({target:{dataset:{structuredInput:'query'},value:'TEST'}});listeners.change({target:{dataset:{structuredChange:'status'},value:'pass'}});assert.deepEqual(calls.map(row=>row[0]),['click','input','change']);
}
const xid={id:'xid',gpu:0,address:pci,kind:'xid',code:'119',line:1,time:'1.0',title:'Synthetic Xid',raw:'Synthetic Xid',occurrenceCount:1};
const sxid={...xid,id:'sxid',kind:'sxid',deviceNamespace:'nvswitch',title:'NVSwitch SXid 119',structured:{switch:2,link:3,severity:'Fatal',representations:[{line:2}]}};
const goe={...xid,id:'goe',gpu:null,kind:'goe',code:'1',title:'GOE GPU-GSP/0x0001/0x0001',raw:'Synthetic GOE',targetUUID:'GPU-SYNTHETIC',representationCount:2,structured:{moduleSignature:'GPU-GSP',category:1,moduleEventCode:1,severity:'Fatal',severityDomain:'host-cper',scope:'HOST',legacyXid:119,representations:[{line:4,jsonPointer:'/events/0'},{line:6,jsonPointer:'/events/1'}],rawFields:{hostSeverity:'<script>raw value</script>',traceId:'synthetic-trace'}}};
function eventFixture(events=[xid,sxid,goe]){
 const env={data:{...report(A,false),events,gpus:[{id:0,label:'GPU 0',pci,index:0}],nodes:{[pci]:{address:pci,bridge:true}}},state:{page:'errors',event:'goe',errorEvidencePage:0,errorPage:0,errorView:'groups',filter:'all',code:'all',groupFilter:''},XidAnalysis:require('../app/analysis.js'),esc,val:value=>value??'—',icon:()=>'',heading:extra=>extra||'',empty:text=>text,reliable:value=>value!=null,document:{querySelectorAll(){return [];}},updateInspector(){}};
 vm.createContext(env);vm.runInContext(section('const filteredEvents=','function status(')+section('function keyline(','function field(')+section('function gpuOptions()','const reportOption=')+host.split('\n').find(line=>line.startsWith('function bridgeErrors(')),env);vm.runInContext('globalThis.filteredEvents=filteredEvents;',env);return env;
}
function eventSemantics(){
 const env=eventFixture();assert.equal(env.eventDeviceLabel(sxid),'NVSwitch 2');env.state.filter='0';assert.deepEqual(plain(env.filteredEvents()).map(e=>e.id),['xid']);env.state.filter='pci:'+pci;assert.deepEqual(plain(env.filteredEvents()).map(e=>e.id),['xid','goe']);env.state.filter='namespace:nvswitch';assert.deepEqual(plain(env.filteredEvents()).map(e=>e.id),['sxid']);env.state.filter='all';
 env.state.code='type:goe:GPU-GSP/0x0001/0x0001';assert.deepEqual(plain(env.filteredEvents()).map(e=>e.id),['goe']);env.state.code='all';assert.match(env.codeOptions(),/NVSwitch SXid 119/);assert.match(env.codeOptions(),/GOE GPU-GSP\/0x0001\/0x0001/);
 let html=env.errorDetail();for(const value of ['GOE · 实验性','主机 CPER 严重性','HOST','仅关联提示，未合并','/events/0','/events/1','data-source-line="6"','traceId','&lt;script&gt;'])assert.ok(html.includes(value),value);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('data-open-gpu="0"'));
 env.state.event='sxid';html=env.errorDetail();assert.match(html,/NVSwitch 2/);assert.ok(!html.includes('data-open-gpu="0"'));assert.equal(env.bridgeErrors(pci),2);
 html=env.renderGroupedErrors();assert.match(html,/3 次事件/);assert.match(html,/事件次数/);env.state.errorView='records';html=env.renderErrors();assert.match(html,/3 次事件/);
}
function boundedEvidenceAndTypes(){
 const refs=Array.from({length:240},(_,i)=>({line:i+1,jsonPointer:'/events/'+i})),env=eventFixture([{...goe,representationCount:240,structured:{...goe.structured,representations:refs}}]);
 let html=env.structuredEventDetail(env.data.events[0]);assert.equal((html.match(/data-source-line=/g)||[]).length,100);env.state.eventEvidencePage=2;html=env.structuredEventDetail(env.data.events[0]);assert.equal((html.match(/data-source-line=/g)||[]).length,40);assert.match(html,/data-source-line="240"/);assert.match(html,/201–240 \/ 240/);
 env.data.events=Array.from({length:500},(_,i)=>({...goe,structured:{...goe.structured,moduleEventCode:i}}));env.state.code='type:goe:GPU-GSP/0x0001/0x01f3';html=env.codeOptions();assert.equal((html.match(/value="type:/g)||[]).length,257);assert.match(html,/其余类型可在聚合列表中选择/);assert.match(html,/0x01f3" selected/);
}
function assets(){
 const read=file=>fs.readFileSync(require.resolve('../'+file),'utf8'),index=read('app/index.html');
 for(const asset of ['structured.js','structured.css']){assert.ok(index.includes('/'+asset));assert.ok(read('app/server.py').includes("'/"+asset+"'"));assert.ok(read('tools/build_windows.py').includes("'"+asset+"'"));assert.ok(JSON.parse(read('.privacy-policy.json')).public_data_files.includes(asset));}
 assert.ok(index.indexOf('/analysis.js')<index.indexOf('/structured.js'));assert.ok(index.indexOf('/structured.js')<index.indexOf('/app.js'));assert.ok(JSON.parse(read('.privacy-policy.json')).owned_python_modules.includes('structured_events'));
 for(const file of ['test_structured_ui.cjs','test_structured_views.cjs','test_structured_host.cjs'])assert.ok(read('.github/workflows/checks.yml').includes(file));
}
(async()=>{await stateAndNavigation();await sourceAndStaleCallbacks();await focusAndDispatch();eventSemantics();boundedEvidenceAndTypes();assets();console.log('Structured host: report/revision isolation, DCGM routing, source return/focus, stale loads, dispatch, namespaces, full types, bounded sources and asset wiring passed');})().catch(error=>{console.error(error);process.exitCode=1;});
