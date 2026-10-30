'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const host=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const comparison=require('../app/comparison.js');
const section=(from,to)=>host.slice(host.indexOf(from),host.indexOf(to));
const A='a'.repeat(32),B='b'.repeat(32),C='c'.repeat(32),path='ECC Errors/Volatile/DRAM Uncorrectable';
const plain=value=>JSON.parse(JSON.stringify(value));
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ref=(value,line)=>({value:String(value),origin:'nvidia-smi',evidence:{line,text:'Uncorrectable : '+value}});
const report=(id,value,time)=>({id,source:id===A?'baseline.log':'current.log',contentSha256:id,lines:500,complete:true,warnings:[],server:{sn:'DEMO-SERVER',driver:'580.0',time},catalog:{sha256:'a'.repeat(64)},nodes:{},gpus:[{id:0,label:'GPU 0',uuid:'GPU-DEMO-1',sn:'DEMO-1',pci:'0000:41:00.0',healthFields:{[path]:[ref(value,id===A?12:24)]}}],events:[]});
const epoch=r=>{r.gpus[0].counterEpochs={[path]:{id:'DEMO-EPOCH',scope:'volatile',verified:true,origin:'collector',evidence:{line:8,text:'synthetic period'}}};};
const node=()=>({hidden:false,disabled:false,open:false,value:'',dataset:{},style:{},classList:{toggle(){}},setAttribute(){},focus(){},querySelector(){return null;}});
function fixture(){
 const elements=new Map(),requests=[],mounts=[],focused=[];
 const env={data:report(B,'9007199254740999','2026-10-28T11:00:00+08:00'),comparisonData:report(A,'9007199254740993','2026-10-28T10:00:00+08:00'),
  loadedCase:B,comparisonRequest:0,comparisonLoading:false,comparisonError:'',busy:false,loading:false,loadRequest:0,readerReturn:null,pendingSource:null,
  state:{page:'compare',compareBase:A,compareRow:0,compareChanged:false,drawer:false},cases:[{id:A,source:'baseline.log'},{id:B,source:'current.log'}],
  titles:{compare:'日志对比',reader:'原文阅读',overview:'诊断概览'},sessionState:{loaded:true},viewPositions:new Map(),caseViews:new Map(),renderedView:'',structuredClone,
  $(id){if(id==='reader-host'&&env.state.page!=='reader'||id==='knowledge-host')return null;if(!elements.has(id))elements.set(id,node());return elements.get(id);},
  document:{activeElement:null,querySelector(selector){return {...node(),focus(){focused.push(selector);}};},querySelectorAll(){return [];}},
  XidComparison:{assess(...args){env.assessments++;return comparison.assess(...args);}},assessments:0,
  XidDiagnostics:{leave(){},reset(){},restore(){},capture(){return {};},afterRender(){}},
  XidReader:{unmount(){},mount(_element,options){mounts.push(options);}},
  saveViewPosition(){},restoreViewPosition(){},focusKey(){return null;},restoreFocus(){},renderNav(){},renderDrawer(){},syncReportControls(){},closeMenu(){},closeDrawer(){},
  heading:()=>'<h1>日志对比</h1>',empty:text=>'<p>'+text+'</p>',esc:escape,val:value=>value||'—',icon:()=>'',codeLabel:e=>e.code||e.kind,status:text=>{env.statusText=text;},toast(){},
  openDialog(title,html){env.dialog={title,html};env.$('dialog').open=true;},closeDialog(){env.$('dialog').open=false;},
  updateInspector(_id,html){env.inspector=html;},
  api(url){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});requests.push({url,resolve,reject});return promise;}
 };
 env.window=env;vm.createContext(env);vm.runInContext(section('const reportOption=','function fieldValue(')+section('function render(preserveScroll','function openGpu(')+section('function rememberCaseView()','function openSource(')+section('async function loadCase(','async function refreshCases('),env);
 return {env,elements,requests,mounts,focused};
}
function cacheAndIdentity(){
 const {env}=fixture(),first=env.comparisonRows();assert.equal(env.comparisonRows(),first);env.render();env.selectComparison(0);assert.equal(env.assessments,1,'Rendering and selection reuse assessment by report objects');
 env.data={...env.data};assert.notEqual(env.comparisonRows(),first);assert.equal(env.assessments,2);env.comparisonData={...env.comparisonData};env.comparisonRows();assert.equal(env.assessments,3);
 env.data=structuredClone(env.data);env.data.gpus[0].fields={serial:[{value:'CONFLICT-DEMO'}]};const row=env.comparisonRows().rows[0];assert.equal(row.matched,true);assert.equal(row.identity.status,'conflict');assert.equal(env.comparisonStatus(row),'身份冲突');
 const html=env.renderComparison();assert.match(html,/匹配 0/);assert.match(html,/身份冲突 1/);assert.ok(!html.includes('匹配 1'));
 const missing={...row,identity:{status:'matched',reasons:[]},changes:[],details:[{state:'missing'}]};assert.equal(env.comparisonStatus(missing),'1 项缺失');assert.equal(Boolean(env.comparisonNeedsReview(missing)),true);
}
function fieldEvidence(){
 const {env}=fixture();let row=env.comparisonRows().rows[0],index=row.details.findIndex(f=>f.key==='health:'+path),field=row.details[index];
 assert.equal(field.comparison.delta,null);assert.ok(!env.comparisonField(field,index).includes('增量'));env.compareFieldSource(index);
 assert.match(env.dialog.html,/无法计算增量/);assert.match(env.dialog.html,/缺少同一易失性计数周期/);
 assert.match(env.dialog.html,new RegExp('data-compare-source="'+A+'" data-line="12"'));assert.match(env.dialog.html,new RegExp('data-compare-source="'+B+'" data-line="24"'));
 epoch(env.data);epoch(env.comparisonData);env.data={...env.data};field=env.comparisonRows().rows[0].details[index];assert.match(env.comparisonField(field,index),/增量 \+6/,'Verified bigint delta remains exact');
 const altered={...field,comparison:{...field.comparison,comparable:false,delta:'6'}};assert.ok(!env.comparisonField(altered,index).includes('增量'),'A numeric difference alone is never shown as an increment');
 env.data={...env.data,server:{...env.data.server,time:''}};const warnings=env.comparisonRows().context.warnings,html=env.renderComparison();for(const warning of warnings)assert.equal(html.split(escape(warning)).length-1,1,'Global conditions appear once');
 assert.ok(!env.comparisonCounterDetail({kind:'field'}));assert.ok(!env.comparisonCounterDetail({kind:'state'}));
 env.data=structuredClone(env.data);env.data.gpus[0].healthFields[path]=[ref('<img src=x onerror=alert(1)>',24)];env.compareFieldSource(index);assert.ok(!env.dialog.html.includes('<img'));assert.match(env.dialog.html,/&lt;img/);
 assert.equal(env.comparisonSourceLink(C,12),'','Unrelated report IDs cannot become source links');
}
function resetOwnershipAndBounds(){
 const {env}=fixture();env.comparisonData.lifecycleEvents=Array.from({length:25},(_,i)=>({kind:'reset',targetUUID:'GPU-DEMO-1',line:40+i,raw:'synthetic reset '+i}));env.data.lifecycleEvents=[{kind:'driver_load',line:80,raw:'synthetic driver'}];
 const row=env.comparisonRows().rows[0],index=row.details.findIndex(f=>f.key==='health:'+path);env.compareFieldSource(index);
 assert.match(env.dialog.html,/重置或驱动记录 · 26/);assert.match(env.dialog.html,/显示前 20 条/);assert.match(env.dialog.html,new RegExp('data-compare-source="'+A+'" data-line="40"'));assert.ok(!env.dialog.html.includes('synthetic reset 24'));
 const evidence=row.details[index].comparison.resetEvidence;assert.equal(evidence[25].reportId,B,'A reset retains the report that supplied it');
 const html=env.comparisonCounterDetail({...row.details[index].comparison,resetEvidence:[evidence[25]]});assert.match(html,new RegExp('data-compare-source="'+B+'" data-line="80"'));
}
function sourceReturn(){
 const {env,mounts,requests,focused}=fixture(),before=env.comparisonData,current=env.data;env.state.compareChanged=true;env.render();env.compareFieldSource(0);env.openComparisonSource(A,12);
 assert.equal(env.state.page,'reader');assert.equal(env.loadedCase,B);assert.equal(env.data,current);assert.equal(env.state.compareBase,A);assert.equal(env.comparisonData,before);assert.equal(requests.length,0,'Opening a comparison source must not load or replace the active case');
 assert.equal(mounts.at(-1).caseId,A);assert.equal(mounts.at(-1).source,'baseline.log');assert.equal(mounts.at(-1).sourceLine,12);assert.equal(mounts.at(-1).backLabel,'日志对比');assert.equal(env.$('log-select').value,A);assert.equal(env.$('log-select').disabled,true);
 mounts.at(-1).onBack();assert.equal(env.state.page,'compare');assert.equal(env.state.compareChanged,true);assert.equal(env.state.compareRow,0);assert.equal(env.loadedCase,B);assert.equal(env.state.compareBase,A);assert.equal(env.$('log-select').value,B);assert.equal(env.$('log-select').disabled,false);
 assert.equal(focused.at(-1),'[data-select-comparison="0"]','Keyboard focus returns to the selected comparison row');
 env.openComparisonSource(B,24);assert.equal(mounts.at(-1).caseId,B);assert.equal(mounts.at(-1).sourceLine,24);mounts.at(-1).onBack();
 for(const [id,line] of [[C,12],[A,0],[A,-1],[A,'12'],[A,NaN],[A,1.5],[A,1e20]]){env.openComparisonSource(id,line);assert.equal(env.state.page,'compare');}
 env.loading=true;env.openComparisonSource(A,12);assert.equal(env.state.page,'compare');env.loading=false;
 env.openComparisonSource(A,12);const back=mounts.at(-1).onBack;env.data={...env.data};assert.equal(env.comparisonReader(),null,'A changed report object invalidates the source return context');env.render=()=>{};back();assert.equal(env.state.page,'overview');assert.equal(env.loadedCase,B);
}
async function requestRaces(){
 const {env,requests}=fixture();const older=env.loadComparison(A),latest=env.loadComparison(C);requests[1].resolve(report(C,3,'2026-10-28T09:00:00+08:00'));await latest;requests[0].resolve(report(A,1,'2026-10-28T08:00:00+08:00'));await older;assert.equal(env.comparisonData.id,C);assert.equal(env.state.compareBase,C);
 const failed=env.loadComparison(A);requests[2].reject(Error('synthetic failure'));await failed;assert.equal(env.comparisonLoading,false);assert.match(env.comparisonError,/synthetic failure/);assert.equal(env.comparisonRows(),null);
 const retry=env.loadComparison(A);requests[3].resolve(report(A,1,'2026-10-28T08:00:00+08:00'));await retry;assert.equal(env.comparisonError,'');assert.ok(env.comparisonRows());
}
async function actualLoadAfterSource(){
 const {env,requests,mounts}=fixture();env.openComparisonSource(A,12);const oldBack=mounts.at(-1).onBack;const load=env.loadCase(C);requests[0].resolve(report(C,4,'2026-10-28T12:00:00+08:00'));await load;
 assert.equal(env.loadedCase,C);assert.equal(env.comparisonReader(),null);assert.equal(mounts.at(-1).caseId,C);assert.equal(mounts.at(-1).backLabel,'');env.render=()=>{};oldBack();assert.equal(env.loadedCase,C,'A stale reader callback cannot restore the former report');
}
async function nativeSourceDispatch(){
 const {env,mounts}=fixture(),listeners={};env.document.addEventListener=(event,callback)=>{listeners[event]=callback;};env.XidDiagnostics.dismissPicker=()=>{};
 vm.runInContext(section("document.addEventListener('click',async event=>{XidDiagnostics.dismissPicker","document.addEventListener('focusin'"),env);
 const button={dataset:{compareSource:A,line:'12'},closest(selector){return selector==='button'?this:null;}};await listeners.click({target:button});
 assert.equal(mounts.at(-1).caseId,A);assert.equal(mounts.at(-1).sourceLine,12);assert.equal(env.state.compareBase,A);assert.equal(env.loadedCase,B);
}
(async()=>{cacheAndIdentity();fieldEvidence();resetOwnershipAndBounds();sourceReturn();await requestRaces();await actualLoadAfterSource();await nativeSourceDispatch();console.log('Comparison host: cache, identity, counter evidence, reset ownership, source return/focus, request races, stale context and native dispatch passed');})().catch(error=>{console.error(error);process.exitCode=1;});
