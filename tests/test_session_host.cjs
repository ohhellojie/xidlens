'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const sessionCode=source.slice(source.indexOf('const sessionState='),source.indexOf('function render(preserveScroll'));
const loadCode=source.slice(source.indexOf('async function loadCase('),source.indexOf('async function refreshCases('));
const openSourceCode=source.slice(source.indexOf('function openSource('),source.indexOf("document.addEventListener('click',event=>{const target=event.target.closest('[data-source-line]')"));
const renderCode=source.slice(source.indexOf('function render(preserveScroll'),source.indexOf('function goto('));
const A='a'.repeat(32),B='b'.repeat(32),S='c'.repeat(32),T='d'.repeat(32);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const bundle=id=>({manifest:{id,members:[{reportId:A},{reportId:B}]},view:{members:[{reportId:A,state:'ready'},{reportId:B,state:'ready'}],events:[],checks:[],counts:{events:6}}});
const report=id=>({source:id===A?'first.log':'second.log',contentSha256:id,gpus:[],events:[],warnings:[],lines:30});
const plain=value=>JSON.parse(JSON.stringify(value));
const node=()=>({hidden:false,disabled:false,isConnected:true,value:'',dataset:{},style:{},classList:{toggle(){}},setAttribute(){},focus(){},querySelector(){return null;}});

function fixture(){
 const elements=new Map(),requests=[],renders=[],toasts=[],navigations=[];
 elements.set('dialog',{...node(),open:false});
 const env={state:{page:'sessions',compareBase:'',drawer:false},loadedCase:A,loading:false,data:report(A),loadRequest:0,
  caseViews:new Map(),viewPositions:new Map(),renderedView:'',comparisonRequest:0,comparisonData:null,comparisonLoading:false,comparisonError:'',readerReturn:null,pendingSource:null,structuredClone,
  dialogRevision:0,reportState:{selected:new Set([A,B])},cases:[{id:A,source:'first.log',server:{time:''}},{id:B,source:'second.log',server:{time:''}}],
  $(id){if(['session-name','session-error'].includes(id)&&!elements.has(id))return null;if(!elements.has(id))elements.set(id,node());return elements.get(id);},
  document:{querySelector(selector){if(selector==='[data-report-action="confirm-session"]')return elements.get('confirm-session')||null;return node();}},
  api(path,options){const request=deferred();requests.push({...request,path,options});return request.promise;},
  render(){renders.push(env.state.page);},icon(){return '';},esc:text=>String(text),toast:text=>toasts.push(text),
  goto(page){env.state.page=page;navigations.push({page,caseId:env.loadedCase});},
  openDialog(_title,_html,_footer,kind){env.dialogRevision++;elements.get('dialog').open=true;elements.get('dialog').dataset.kind=kind;elements.set('session-name',{...node(),value:''});elements.set('session-error',node());elements.set('confirm-session',node());},
  closeDialog(){elements.get('dialog').open=false;},
  rememberCaseView(){},saveViewPosition(){},closeMenu(){},closeDrawer(){},status(){},comparisonReader(){return null;},
  XidDiagnostics:{reset(){},restore(){},openMatrix(){}},XidOverview:{reset(){},restore(){}},
  XidSessions:{render(result,context){env.lastRenderContext=context;return result?'detail':'list';}},
 };
 vm.createContext(env);vm.runInContext(sessionCode+loadCode+openSourceCode+'\nglobalThis.session=sessionState;',env);
 env.session.loaded=true;env.session.result=bundle(S);
 return {env,elements,requests,renders,toasts,navigations};
}

async function requestRaceTests(){
 const {env,requests}=fixture();
 const older=env.openSession(S),latest=env.openSession(T);
 requests[1].resolve(bundle(T));await latest;requests[0].resolve(bundle(S));await older;
 assert.equal(env.session.result.manifest.id,T);assert.equal(env.session.loading,false);assert.equal(env.session.error,'');
 const failed=env.openSession(T);requests[2].reject(Error('temporary failure'));await failed;
 assert.equal(env.session.loading,false);assert.equal(env.session.error,'temporary failure');
 const retried=env.openSession(T);requests[3].resolve(bundle(T));await retried;assert.equal(env.session.error,'');
 const refresh=env.refreshSession(T);await env.refreshSession(T);assert.equal(requests.length,5,'Concurrent refresh is ignored');
 const switchSession=env.openSession(S);requests[5].resolve(bundle(S));await switchSession;requests[4].resolve(bundle(T));await refresh;
 assert.equal(env.session.result.manifest.id,S,'Old refresh cannot overwrite a newer session');
 const failRefresh=env.refreshSession(S);requests[6].reject(Error('retry refresh'));await failRefresh;
 assert.equal(env.session.loading,false);const retryRefresh=env.refreshSession(S);requests[7].resolve(bundle(S));await retryRefresh;assert.equal(env.session.error,'');
 const oldFailure=env.openSession(T),newSuccess=env.openSession(S);requests[9].resolve(bundle(S));await newSuccess;requests[8].reject(Error('stale'));await oldFailure;assert.equal(env.session.error,'');
}

async function sourceTests(){
 const {env,requests,navigations}=fixture();
 const first=env.openSessionSource(B,12);assert.equal(requests[0].path,'/api/case/'+B);
 requests[0].resolve(report(B));await first;
 assert.equal(env.loadedCase,B);assert.deepEqual(plain(env.pendingSource),{caseId:B,line:12});
 assert.deepEqual(plain(env.readerReturn),{caseId:B,page:'sessions'});assert.equal(navigations.at(-1).page,'reader');
 env.state.page='sessions';const failed=env.openSessionSource(A,14);requests[1].reject(Error('source missing'));await failed;
 assert.equal(env.state.page,'sessions');assert.equal(env.loadedCase,B);assert.equal(navigations.length,1);
 for(const line of [0,-1,'12',NaN,Infinity,1e20]){const ignored=env.openSessionSource(A,line);assert.equal(requests.length,2,'Invalid source lines never start a report load');await ignored;}
 assert.equal(requests.length,2,'Invalid source lines never start a report load');
 const unrelated=env.openSessionSource('e'.repeat(32),12);assert.equal(requests.length,2,'Only session members can be opened');await unrelated;
 const retry=env.openSessionSource(A,14);requests[2].resolve(report(A));await retry;assert.equal(env.pendingSource.caseId,A);assert.equal(env.pendingSource.line,14);
}

async function partialListTests(){
 const {env,requests}=fixture();env.session.error='old error';
 const listing=env.openSession();requests[0].resolve({sessions:[{id:S,name:'Healthy session',members:[{reportId:A},{reportId:B}]}],unreadable:2});await listing;
 assert.equal(env.session.error,'','Unreadable manifests do not block the healthy list');assert.equal(env.session.unreadable,2);assert.equal(env.session.list.length,1);
 env.renderSessions();assert.equal(env.lastRenderContext.unreadable,2);
 const retry=env.openSession();requests[1].resolve({sessions:[],unreadable:0});await retry;assert.equal(env.session.unreadable,0);
}

async function sourceRaceTests(){
 // Starting another session request invalidates a pending source jump immediately.
 const {env,requests,navigations}=fixture();
 const opening=env.openSessionSource(B,12),switching=env.openSession(T);
 requests[0].resolve(report(B));await opening;
 assert.equal(navigations.length,0,'A stale source response must not interrupt session navigation');
 requests[1].resolve(bundle(T));await switching;assert.equal(env.state.page,'sessions');assert.equal(env.session.result.manifest.id,T);
 const jump=env.openSessionSource(A,14);env.state.page='devices';requests[2].resolve(report(A));await jump;
 assert.equal(env.state.page,'devices','Leaving sessions while loading does not reopen the reader');
 // Actual loadCase guards source clicks that race each other.
 env.state.page='sessions';const old=env.openSessionSource(B,12),newer=env.openSessionSource(A,15);
 requests[4].resolve(report(A));await newer;requests[3].resolve(report(B));await old;
 assert.equal(env.pendingSource.caseId,A);assert.equal(env.pendingSource.line,15);
}

async function createTests(){
 const {env,elements,requests}=fixture();env.state.page='reports';env.sessionDialog();
 elements.get('session-name').value='Retained name';const oldPending=plain(env.session.pending);
 const failed=env.createSession();await env.createSession();assert.equal(requests.length,1);assert.equal(env.session.saving,true);
 assert.deepEqual(JSON.parse(requests[0].options.body),{ids:[A,B],name:'Retained name'});
 requests[0].reject(Error('save failed'));await failed;
 assert.equal(elements.get('dialog').open,true);assert.equal(elements.get('session-name').value,'Retained name');
 assert.deepEqual(plain(env.session.pending),oldPending);assert.equal(elements.get('session-error').textContent,'save failed');
 assert.equal(elements.get('confirm-session').disabled,false);assert.equal(env.session.saving,false);
 const retry=env.createSession();requests[1].resolve(bundle(T));await retry;
 assert.equal(elements.get('dialog').open,false);assert.equal(env.state.page,'sessions');assert.equal(env.session.result.manifest.id,T);
}

async function dialogRaceTests(){
 const {env,elements,requests}=fixture();env.sessionDialog();elements.get('session-name').value='Background creation';
 const creating=env.createSession();env.openDialog('Other dialog','','','other');
 requests[0].resolve(bundle(T));await creating;
 assert.equal(elements.get('dialog').open,true,'Completing an older create must not close a replacement dialog');
 assert.equal(elements.get('dialog').dataset.kind,'other');assert.equal(env.session.saving,false);
 env.sessionDialog();const failed=env.createSession();env.openDialog('Replacement','','','other');elements.get('session-error').textContent='Replacement state';
 requests[1].reject(Error('old request failed'));await failed;assert.equal(elements.get('session-error').textContent,'Replacement state','An old failure does not write into a new dialog');
 env.askDeleteSession(S);const removing=env.deleteSession(S);env.openDialog('Another dialog','','','other');requests[2].resolve({deleted:S});await removing;
 assert.equal(elements.get('dialog').open,true);assert.equal(elements.get('dialog').dataset.kind,'other');assert.equal(requests.length,3,'Background deletion does not navigate or reload the list');
}

async function deleteTests(){
 const {env,elements,requests,toasts}=fixture();env.askDeleteSession(S);
 const fail=env.deleteSession(S);await env.deleteSession(S);assert.equal(requests.length,1);requests[0].reject(Error('delete failed'));await fail;
 assert.equal(env.session.saving,false);assert.equal(elements.get('dialog').open,true);assert.equal(toasts.at(-1),'delete failed');
 const retry=env.deleteSession(S);requests[1].resolve({deleted:S});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests[2].path,'/api/sessions');requests[2].resolve({sessions:[]});await retry;
 assert.equal(elements.get('dialog').open,false);assert.equal(env.session.result,null);assert.equal(env.session.saving,false);
}

function renderTests(){
 const {env,elements}=fixture();env.XidAnalysis=require('../app/analysis.js');
 const fileContext=node(),statuses=[];env.status=text=>statuses.push(text);env.document.querySelector=selector=>selector==='.file-context'?fileContext:node();env.data.events=[{},{},{}];
 const $=env.$;env.$=id=>['reader-host','knowledge-host'].includes(id)?null:$(id);
 Object.assign(env,{busy:false,window:{XidReader:{unmount(){}},XidKnowledge:{unmount(){}}},renderNav(){},focusKey(){},restoreFocus(){},restoreViewPosition(){},renderDrawer(){},syncReportControls(){},renderDevices:()=>'<p>devices</p>'});
 env.XidDiagnostics.afterRender=()=>{};env.XidOverview.afterRender=()=>{};
 vm.runInContext(renderCode,env);env.render();
 assert.equal(elements.get('export-button').hidden,true,'Session view must not export whichever single report is loaded');
 assert.equal(fileContext.style.visibility,'hidden','The loaded single report context is hidden in sessions');
 assert.equal(statuses.at(-1),'2 份来源 · 6 条事件','The status bar uses session totals');
 assert.equal(elements.get('content').innerHTML,'detail');assert.equal(env.lastRenderContext.onSource,env.openSessionSource);
 env.state.page='devices';env.render();assert.equal(elements.get('export-button').hidden,false);assert.equal(fileContext.style.visibility,'');assert.ok(statuses.at(-1).includes('3 次事件'));
}

const watchdog=setTimeout(()=>{throw Error('Session host test timed out with an unresolved request');},5000);
(async()=>{await requestRaceTests();await partialListTests();await sourceTests();await sourceRaceTests();await createTests();await dialogRaceTests();await deleteTests();renderTests();console.log('Session host: request races, partial lists, source navigation, retries, retained form input, dialog isolation and export visibility passed');})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
