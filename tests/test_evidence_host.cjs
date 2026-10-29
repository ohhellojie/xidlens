'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to));
const A='a'.repeat(32),B='b'.repeat(32),C='c'.repeat(32);
const plain=value=>JSON.parse(JSON.stringify(value));
const report=id=>({id,source:id+'.log',contentSha256:id.repeat(2),lines:400,server:{},gpus:[],events:[],warnings:[],nodes:{}});
const element=()=>({hidden:false,disabled:false,open:false,value:'',dataset:{},style:{},classList:{toggle(){}},setAttribute(){},focus(){},querySelector(){return null;}});
function fixture(){
 const nodes=new Map(),requests=[],mounts=[],ranges=[],downloads=[],messages=[],listeners={};
 const env={loadedCase:B,data:report(B),comparisonData:report(A),comparisonSourceView:null,comparisonRequest:0,comparisonLoading:false,comparisonError:'',
  state:{page:'reader',compareBase:A,compareRow:0,compareChanged:false,drawer:false},cases:[{id:A},{id:B}],busy:false,loading:false,loadRequest:0,
  titles:{reader:'完整日志',compare:'日志对比',evidence:'证据与分享'},sessionState:{loaded:true},viewPositions:new Map(),caseViews:new Map(),renderedView:'',readerReturn:null,pendingSource:null,structuredClone,
  $(id){if(id==='reader-host'&&env.state.page!=='reader'||id==='knowledge-host')return null;if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},
  document:{activeElement:null,querySelector(){return element();},querySelectorAll(){return [];},addEventListener(name,callback){listeners[name]=callback;}},
  XidReader:{unmount(){},mount(_node,options){mounts.push(options);}},
  XidEvidence:{render(data,context){env.evidenceContext=context;return '<h1>证据与分享</h1>';},reset(){env.evidenceResets++;env.preview=null;},selectRange(...args){ranges.push(args);},click(){return true;},input(){return true;},change(){return true;}},
  XidAssistant:{reset(){env.assistantResets++;}},evidenceResets:0,assistantResets:0,preview:'approved preview',
  XidDiagnostics:{capture(){return {};},restore(){},reset(){},leave(){},afterRender(){},dismissPicker(){},input(){return false;},change(){return false;}},
  saveViewPosition(){},restoreViewPosition(){},focusKey(){return null;},restoreFocus(){},renderNav(){},renderDrawer(){},syncReportControls(){},closeMenu(){},closeDrawer(){},status(){},returnComparisonSource(){},
  toast(value){messages.push(value);},download(...args){downloads.push(args);},openSource(){},esc:value=>value,heading:()=>'',empty:()=>'',
  api(path,options){let resolve,reject;const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});requests.push({path,options,resolve,reject});return pending;}
 };
 env.window=env;vm.createContext(env);
 vm.runInContext(section('function comparisonReader()','function openComparisonSource(')+
  section('function render(preserveScroll','function openGpu(')+
  section('function rememberCaseView()','function openSource(')+
  section('async function loadCase(','async function refreshCases('),env);
 return {env,requests,mounts,ranges,downloads,messages,listeners};
}
function comparison(f){const {env}=f;env.comparisonSourceView={currentId:B,currentReport:env.data,baseId:A,baseReport:env.comparisonData,sourceId:A,sourceReport:env.comparisonData,side:'基准'};env.render();return f.mounts.at(-1);}
async function currentRange(){
 const {env,mounts,ranges,requests,downloads}=fixture();env.render();const reader=mounts.at(-1);
 assert.equal(reader.evidenceRangeLimit,200);await reader.onEvidenceRange(5,8);
 assert.equal(env.state.page,'evidence');assert.deepEqual(plain(ranges),[[5,8,B]]);assert.equal(requests.length,0);
 assert.equal(env.evidenceContext.caseId,B);env.evidenceContext.download('xidlens-evidence.txt','synthetic payload','text/plain');
 assert.deepEqual(downloads,[['xidlens-evidence.txt','synthetic payload','text/plain']],'Host preserves the filename, content, MIME argument order');
 const before=env.evidenceContext;env.state.page='devices';env.render=()=>{throw Error('Hidden evidence request must not repaint another page');};before.render();
}
async function comparedSource(){
 const f=fixture(),reader=comparison(f),{env,requests,ranges}=f;
 assert.equal(reader.caseId,A);const pending=reader.onEvidenceRange(10,12);
 assert.equal(requests[0].path,'/api/case/'+A);assert.equal(env.preview,null,'Previous approval clears before the new report request completes');
 assert.equal(env.evidenceResets,1);assert.equal(env.assistantResets,1);requests[0].resolve(report(A));await pending;
 assert.equal(env.loadedCase,A);assert.equal(env.state.page,'evidence');assert.deepEqual(plain(ranges),[[10,12,A]]);assert.equal(env.evidenceContext.caseId,A);
}
async function replacedSource(){
 const f=fixture(),reader=comparison(f),pending=reader.onEvidenceRange(10,12);
 f.requests[0].resolve({...report(A),contentSha256:'d'.repeat(64)});await pending;
 assert.equal(f.env.loadedCase,A);assert.equal(f.env.state.page,'reader');assert.equal(f.ranges.length,0);assert.match(f.messages.at(-1),/原日志已变更/);
}
async function staleCallbacksAndRaces(){
 const f=fixture(),reader=comparison(f),pending=reader.onEvidenceRange(10,12);
 const newer=f.env.loadCase(C);f.requests[1].resolve(report(C));await newer;f.requests[0].resolve(report(A));await pending;
 assert.equal(f.env.loadedCase,C);assert.equal(f.ranges.length,0);assert.equal(f.env.state.page,'reader');
 await reader.onEvidenceRange(1,2);assert.equal(f.requests.length,2,'Unmounted reader callback cannot load its old source');
 const current=f.mounts.at(-1);for(const [start,end] of [[0,1],[2,1],[1,201],[1.5,2],[1,Infinity]])await current.onEvidenceRange(start,end);
 assert.equal(f.ranges.length,0);assert.equal(f.requests.length,2);
}
async function forcedReload(){
 const f=fixture();f.env.render();const old=f.mounts.at(-1),pending=f.env.loadCase(B,true);
 assert.equal(f.env.preview,null);assert.equal(f.env.assistantResets,1);f.requests[0].resolve(report(B));await pending;
 await old.onEvidenceRange(1,2);assert.equal(f.ranges.length,0,'Even identical bytes require the current reader report object');
}
async function nativeDispatch(){
 const f=fixture(),{env,listeners}=f,calls=[];
 for(const name of ['click','input','change'])env.XidEvidence[name]=el=>{calls.push([name,el]);return true;};
 vm.runInContext(section("document.addEventListener('click',async event=>{XidDiagnostics.dismissPicker","document.addEventListener('focusin'")+
  source.split('\n').find(line=>line.startsWith("document.addEventListener('input',event=>{if(globalThis.XidTimeline"))+
  source.split('\n').find(line=>line.startsWith("document.addEventListener('change',event=>{const el=event.target;if(globalThis.XidTimeline")),env);
 const button={dataset:{evidence:'save'},closest(selector){return ['button','[data-evidence]'].includes(selector)?this:null;}};
 await listeners.click({target:button});listeners.input({target:{dataset:{evidenceInput:'note'},value:'synthetic note'}});listeners.change({target:{dataset:{evidenceOption:'host'},checked:true}});
 assert.deepEqual(calls.map(row=>row[0]),['click','input','change']);
}
async function cleanupRetry(){
 const {env,requests,messages}=fixture();env.deletingReports=false;env.dialogRevision=0;
 env.openDialog=(title,body,footer)=>{env.dialogRevision++;env.dialog={title,body,footer};env.$('dialog').open=true;};
 env.closeDialog=()=>{assert.equal(env.deletingReports,false);env.$('dialog').open=false;};
 vm.runInContext(section('const evidenceCleanup=','const reportState='),env);
 env.showEvidenceCleanup([A,B],2,1);assert.match(env.dialog.body,/已删除 2 份报告，1 份报告未删除/);assert.match(env.dialog.footer,/重试清理/);
 const failed=env.retryEvidenceCleanup();requests[0].reject(Error('SYNTHETIC_PRIVATE'));await failed;
 assert.equal(env.$('evidence-cleanup-error').textContent,'清理失败，请重试');assert.equal(env.$('dialog').open,true);
 const partial=env.retryEvidenceCleanup();requests[1].resolve({deleted:[A,B],failed:[],evidenceCleanupFailed:[B]});await partial;
 assert.match(env.dialog.body,/1 份本机书签与备注/);assert.match(env.dialog.body,/已删除 2 份报告/,'Retry must not count already deleted reports twice');
 const complete=env.retryEvidenceCleanup();assert.deepEqual(JSON.parse(requests[2].options.body),{ids:[B]});requests[2].resolve({deleted:[B],failed:[]});await complete;
 assert.equal(env.$('dialog').open,false);assert.equal(messages.at(-1),'本机标注已清理');
}
(async()=>{await currentRange();await comparedSource();await replacedSource();await staleCallbacksAndRaces();await forcedReload();await nativeDispatch();await cleanupRetry();console.log('Evidence host: source binding, hash changes, stale callbacks, load races, reset timing, download order, dispatch and cleanup retries passed');})().catch(error=>{console.error(error);process.exitCode=1;});
