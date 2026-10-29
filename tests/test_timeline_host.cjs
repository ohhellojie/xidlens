'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const host=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const timeline=fs.readFileSync(require.resolve('../app/timeline.js'),'utf8');
const sessions=fs.readFileSync(require.resolve('../app/sessions.js'),'utf8');
const section=(from,to)=>host.slice(host.indexOf(from),host.indexOf(to));
const A='a'.repeat(32),B='b'.repeat(32),S='c'.repeat(32);
const plain=value=>JSON.parse(JSON.stringify(value));
const node=()=>({id:'',value:'',dataset:{},disabled:false,hidden:false,open:false,setAttribute(){},focus(){},querySelector(){return node();}});
const report=id=>({id,source:id===A?'first.log':'second.log',contentSha256:id,gpus:[],warnings:[],lines:500,diagnostics:{snapshots:[]},events:Array.from({length:240},(_,i)=>({id:'e'+i,kind:'xid',code:'79',line:i+1,time:i+'.000',raw:'TARGET '+i,address:'0000:41:00.0'}))});
const bundle=()=>({manifest:{id:S,name:'Synthetic session',members:[{reportId:A},{reportId:B}]},view:{members:[{reportId:A,source:'first.log',state:'ready'},{reportId:B,source:'second.log',state:'ready'}],counts:{events:240},warnings:[],devices:[],events:report(B).events.map(event=>({...event,id:B+':'+event.id,reportId:B,source:'second.log'}))}});
function fixture(){
 const elements=new Map(),requests=[],focusables=[];
 const env={state:{page:'timeline',drawer:false,compareBase:''},loadedCase:A,data:report(A),loading:false,loadRequest:0,
  viewPositions:new Map(),caseViews:new Map(),renderedView:'',readerReturn:null,pendingSource:null,structuredClone,
  comparisonRequest:0,comparisonData:null,comparisonLoading:false,comparisonError:'',reportState:{},cases:[],
  $(id){if(!elements.has(id))elements.set(id,node());return elements.get(id);},
  document:{querySelectorAll(){return focusables;},activeElement:null},
  api(path){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});requests.push({path,resolve,reject});return promise;},
  closeMenu(){},closeDrawer(){},closeDialog(){},saveViewPosition(){},status(){},toast(){},icon(){return '';},
  XidDiagnostics:{reset(){},restore(){},capture(){return {};},leave(){},openMatrix(){}},XidOverview:{reset(){},restore(){},capture(){return {};}}
 };
 vm.createContext(env);vm.runInContext(timeline+sessions+
  section('const sessionState=','function render(preserveScroll')+
  section('function rememberCaseView()','function openSource(')+
  section('function openSource(',"document.addEventListener('click',event=>{const target=event.target.closest('[data-source-line]')")+
  section('async function loadCase(','async function refreshCases(')+
  section('function goto(','function openGpu(')+
  section('function focusKey(','let knowledgeCode=')+
  '\nglobalThis.session=sessionState;',env);
 env.render=()=>{env.html=env.state.page==='timeline'?env.renderTimeline():env.state.page==='sessions'?env.renderSessions():'reader';};
 env.session.loaded=true;env.session.result=bundle();env.render();
 const load=async(id,next=report(id),force=false)=>{const pending=env.loadCase(id,force);requests.at(-1).resolve(next);await pending;};
 return {env,elements,requests,focusables,load};
}
function action(env,key,value){env.XidTimeline.click({dataset:{timeline:key,value}});}
function input(env,key,value){env.XidTimeline.input({dataset:{timelineInput:key},value});}
function change(env,key,value){env.XidTimeline.change({dataset:{timelineChange:key},value});}
async function caseState(){
 const {env,load}=fixture();input(env,'query','TARGET 2');change(env,'clock','uptime');input(env,'from','20');action(env,'mode','groups');
 const saved=plain(env.XidTimeline.capture());await load(B);assert.equal(env.XidTimeline.capture().query,'');
 input(env,'query','TARGET 1');await load(A);assert.deepEqual(plain(env.XidTimeline.capture()),saved,'Returning to a report restores only that report state');
 await load(B);await load(A,{...report(A),contentSha256:'new-content'});assert.equal(env.XidTimeline.capture().query,'','Reparsed content does not inherit stale filters');
 input(env,'query','TARGET');await load(A,report(A),true);assert.equal(env.XidTimeline.capture().query,'','Forced reload resets the report state');
}
async function sourceReturn(){
 const {env,requests}=fixture();input(env,'query','TARGET 1');
 env.state.page='sessions';env.render();env.XidSessions.click({dataset:{session:'tab',value:'timeline'}});
 assert.equal((env.html.match(/<h1 /g)||[]).length,1,'Embedded timeline does not repeat the session heading');
 input(env,'query','TARGET');change(env,'clock','uptime');input(env,'from','0');action(env,'mode','groups');action(env,'memberPage','2');action(env,'select','event:'+B+':e205');
 const saved=plain(env.XidTimeline.capture()),original=env.openSessionSource;
 env.openSessionSource=(...args)=>env.sourcePromise=original(...args);
 action(env,'source','event:'+B+':e205');assert.equal(requests.at(-1).path,'/api/case/'+B);
 requests.at(-1).resolve(report(B));await env.sourcePromise;
 assert.equal(env.state.page,'reader');assert.deepEqual(plain(env.pendingSource),{caseId:B,line:206});assert.deepEqual(plain(env.readerReturn),{caseId:B,page:'sessions'});
 assert.equal(env.caseViews.get(A).timeline.query,'TARGET 1','Joint filters never overwrite the loaded report snapshot');
 env.goto(env.readerReturn.page);assert.deepEqual(plain(env.XidTimeline.capture()),saved,'Returning from another report retains joint filter, range, group and member page');
 assert.ok(env.html.includes('第 206 行'));assert.ok(env.html.includes('timeline-embedded'));
 env.state.page='timeline';env.render();assert.equal(env.XidTimeline.capture().identity,'case:'+B);assert.equal(env.XidTimeline.capture().query,'');
 env.state.page='sessions';env.render();assert.deepEqual(plain(env.XidTimeline.capture()),saved);
}
async function separateIdentity(){
 const {env}=fixture();input(env,'query','first-only');const single=plain(env.XidTimeline.capture());
 const result=bundle();result.manifest.id=A;env.session.result=result;env.state.page='sessions';env.render();env.XidSessions.click({dataset:{session:'tab',value:'timeline'}});
 assert.equal(env.XidTimeline.capture().identity,'session:'+A);assert.equal(env.XidTimeline.capture().query,'');
 assert.equal(env.XidTimeline.restore(single,'session:'+A),false,'A case state cannot be restored as a session');
 env.XidTimeline.reset('case:'+A);assert.equal(env.XidTimeline.capture().identity,'session:'+A,'Scoped reset leaves active joint state intact');
}
async function nativeFocus(){
 const {env,focusables}=fixture();const focused=[];
 assert.match(env.html,/<select[^>]+data-timeline-change="device"[^>]+aria-label="筛选时间线设备"/);
 assert.match(env.html,/<input[^>]+type="search"[^>]+aria-label="搜索时间线"/);
 const inputNode={...node(),id:'timeline-query',dataset:{timelineInput:'query'},focus(){focused.push('query');},setSelectionRange(a,b){focused.push([a,b]);}};
 focusables.push(inputNode);env.$('timeline-query').focus=()=>focused.push('host-query');
 env.XidTimeline.input({dataset:{timelineInput:'query'},value:'TARGET',selectionStart:2,selectionEnd:4});assert.deepEqual(focused,['query',[2,4]]);
 const select={...node(),dataset:{timelineChange:'clock'},focus(){focused.push('clock');}};focusables.splice(0,1,select);
 const key=env.focusKey(select);env.restoreFocus(key);assert.equal(focused.at(-1),'clock');
 const previous={...node(),dataset:{timeline:'page',value:'1'},textContent:'上一页',focus(){focused.push('previous');}};
 const next={...node(),dataset:{timeline:'page',value:'3'},textContent:'下一页',disabled:true,focus(){throw Error('Disabled pagination must never be focused');}};
 focusables.splice(0,1,previous,next);env.XidTimeline.click({dataset:{timeline:'page',value:'2'},textContent:'下一页'});assert.equal(focused.at(-1),'previous','The last page leaves keyboard focus on an available page action');
}
async function eventDispatch(){
 const {env}=fixture(),listeners={};env.document.addEventListener=(name,callback)=>{listeners[name]=callback;};env.XidDiagnostics.dismissPicker=()=>{};
 vm.runInContext(section("document.addEventListener('click',async event=>{XidDiagnostics.dismissPicker", "document.addEventListener('focusin'")+host.split('\n').find(line=>line.startsWith("document.addEventListener('input',event=>{if(globalThis.XidTimeline"))+host.split('\n').find(line=>line.startsWith("document.addEventListener('change',event=>{const el=event.target;if(globalThis.XidTimeline")),env);
 listeners.input({target:{dataset:{timelineInput:'query'},value:'TARGET 12'}});assert.equal(env.XidTimeline.capture().query,'TARGET 12');
 listeners.change({target:{dataset:{timelineChange:'clock'},value:'uptime'}});assert.equal(env.XidTimeline.capture().clock,'uptime');
 const button={dataset:{timeline:'mode',value:'groups'},closest(selector){return selector==='button'||selector==='[data-timeline]'?this:null;}};
 await listeners.click({target:button});assert.equal(env.XidTimeline.capture().mode,'groups');
}
const watchdog=setTimeout(()=>{throw Error('Timeline host test timed out');},5000);
(async()=>{await caseState();await sourceReturn();await separateIdentity();await nativeFocus();await eventDispatch();clearTimeout(watchdog);console.log('Timeline host: 5 groups passed (per-case restore, joint source return, identity isolation, keyboard focus, native dispatch)');})().catch(error=>{clearTimeout(watchdog);console.error(error);process.exitCode=1;});
