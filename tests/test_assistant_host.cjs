'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to));
const A='a'.repeat(32),B='b'.repeat(32),identity='c'.repeat(64),readerRevision='reader-one';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));
const binding={caseId:A,identity,revision:readerRevision};
const report=()=>({source:'synthetic.log',contentSha256:identity,server:{},events:[],gpus:[],warnings:[]});
const packageValue=()=>({format:'xidlens-evidence',version:1,source:'报告 1',items:[{start:12,end:13,title:'',note:'',tags:[],lines:['Synthetic selected line','Synthetic second line']}]});
const protocol={version:1,system:'Synthetic fixed rules',parameters:{response_format:{type:'json_object'},stream:false,store:false,max_completion_tokens:4096}};
const modelResult={mode:'model',observations:[],uncertainties:[],summary:[{text:'Synthetic result',refs:['e1']}]};
function fixture(){
 const nodes=new Map(),requests=[],sent=[],messages=[],listeners={},key={value:''};
 const element=()=>({dataset:{},value:'',innerHTML:'',textContent:'',open:false,style:{},setAttribute(){},focus(){},close(){this.open=false;},querySelector(){return null;},classList:{toggle(){}}});
 const env={console,URL,TextEncoder,AbortController,Promise,Set,Map,structuredClone,setTimeout,clearTimeout,
  loadedCase:A,data:report(),loading:false,loadRequest:1,state:{page:'evidence'},dialogRevision:0,token:'SYNTHETIC-LOCAL-TOKEN',caseViews:new Map(),viewPositions:new Map(),comparisonSourceView:null,
  comparisonRequest:0,comparisonData:null,comparisonLoading:false,comparisonError:'',readerReturn:null,pendingSource:null,renderedView:'',sessionState:{loaded:true},
  $(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},
  document:{activeElement:null,querySelector(selector){return selector==='#assistant-key'?key:null;},querySelectorAll(){return [];},addEventListener(name,fn){listeners[name]=fn;}},
  addEventListener(name,fn){listeners[name]=fn;},
  XidDiagnostics:{leave(){},capture(){return {};},reset(){},restore(){},dismissPicker(){},input(){return false;},change(){return false;}},
  saveViewPosition(){},closeMenu(){},closeDrawer(){},status(){},openSource(){},download(){},copy(){},toast(value){messages.push(value);},esc:value=>String(value).replaceAll('<','&lt;'),
  openDialog(title,html,footer,kind){env.dialogRevision++;const dialog=env.$('dialog');dialog.open=true;dialog.dataset.kind=kind;env.$('dialog-body').innerHTML=html;},
  api(path,options){
   if(path.startsWith('/api/evidence?'))return Promise.resolve({id:A,revision:env.readerRevision,identity,items:[{id:'d'.repeat(32),start:12,end:13,title:'Synthetic bookmark',note:'',tags:[],stale:false}],lines:50});
   let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});requests.push({path,options,resolve,reject});return promise;
  },readerRevision,
  fetch(path,options){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});sent.push({path,options,resolve,reject});return promise;},
  render(){env.html=env.state.page==='assistant'?env.renderAssistant():env.state.page==='evidence'?env.renderEvidence():'';}
 };
 env.window=env;vm.createContext(env);
 vm.runInContext(fs.readFileSync(require.resolve('../app/evidence.js'),'utf8')+fs.readFileSync(require.resolve('../app/assistant.js'),'utf8'),env);
 vm.runInContext(section('function rememberCaseView()','function openSource(')+section('function goto(','function openGpu(')+section('async function loadCase(','async function refreshCases('),env);
 vm.runInContext(source.split('\n').find(line=>line.startsWith("window.addEventListener('beforeunload'")),env);
 const input=(field,value,extra={})=>env.XidAssistant.input({dataset:{assistantField:field,...extra},value});
 const click=(action,extra={})=>env.XidAssistant.click({dataset:{assistant:action,...extra},closest:()=>({querySelector:()=>key})});
 const enter=async()=>{env.state.page='evidence';env.openAssistance({package:packageValue(),binding,exportEdited:true});requests.at(-1).resolve(protocol);await tick();};
 const preview=()=>{env.XidAssistant.change({dataset:{assistantField:'mode'},value:'model'});input('model','synthetic-model');click('preview');};
 return {env,nodes,requests,sent,messages,listeners,key,input,click,enter,preview};
}

async function sendAndLeave(){
 const f=fixture(),{env,sent,key,input,click,preview}=f;await f.enter();
 assert.equal(env.state.page,'assistant');assert.match(env.html,/value="offline" selected/);assert.match(env.html,/临时编辑未带入/);assert.equal(sent.length,0);
 preview();assert.match(env.html,/自动脱敏可能遗漏自由文本/);assert.match(env.html,/完整请求/);key.value='SYNTHETIC-KEY-ONLY';click('send');
 assert.equal(sent.length,1);assert.equal(key.value,'');assert.equal(sent[0].path,'/api/assistant/run');const body=JSON.parse(sent[0].options.body);
 assert.equal(body.apiKey,'SYNTHETIC-KEY-ONLY');assert.equal(body.preview.messages[1].content,JSON.stringify({text:'',evidence:[{id:'e1',text:'Synthetic selected line\nSynthetic second line',source:'报告 1',line:12}]}));
 assert.equal(Object.hasOwn(body,'input'),false);assert.ok(!sent[0].options.body.includes(identity));assert.equal(sent[0].options.headers['X-Local-Token'],'SYNTHETIC-LOCAL-TOKEN');
 const signal=sent[0].options.signal;assert.ok(signal instanceof AbortSignal);
 env.goto('devices');assert.ok(signal.aborted);sent[0].resolve({ok:true,json:async()=>modelResult});await tick();
 assert.equal(env.state.page,'devices');assert.equal(vm.runInContext('assistantContext',env),null);
 await f.enter();assert.ok(!env.html.includes('模型辅助结果'));preview();click('send');
 sent[1].resolve({ok:false,json:async()=>({code:'busy',error:'PRIVATE ERROR KEY'})});await tick();
 assert.match(env.html,/已有模型请求正在处理/);assert.ok(!env.html.includes('PRIVATE ERROR'));
 preview();key.value='SYNTHETIC-KEY-ONLY';input('fragment','Edited after preview',{ref:'e1'});assert.equal(key.value,'');click('send');assert.equal(sent.length,2);
}

async function sourceDialog(){
 const f=fixture(),{env,requests,input,click}=f;await f.enter();input('fragment','Human line 99999',{ref:'e1'});click('offline');input('summary','Edited summary stays');
 click('source',{ref:'e1'});assert.equal(requests.at(-1).path,'/api/log/meta?id='+A);requests.at(-1).resolve({state:'ready',revision:readerRevision,identity});await tick();
 assert.equal(requests.at(-1).path,'/api/log/lines?id='+A+'&revision='+readerRevision+'&start=12&count=2');requests.at(-1).resolve({revision:readerRevision,start:12,lines:['<Synthetic raw>','Second']});await tick();
 requests.at(-1).resolve({state:'ready',revision:readerRevision,identity});await tick();
 const original=env.$('dialog-body').innerHTML;assert.match(original,/助手片段已编辑/);assert.match(original,/12: &lt;Synthetic raw>/);assert.ok(!original.includes('99999'));
 assert.match(env.renderAssistant(),/Edited summary stays/);env.$('dialog').close();assert.match(env.renderAssistant(),/Edited summary stays/);
 click('source',{ref:'e1'});requests.at(-1).resolve({state:'ready',revision:'changed',identity});await tick();assert.match(env.$('dialog-body').innerHTML,/版本已变更/);
 // A second lookup or closed dialog cannot receive a late first response.
 click('source',{ref:'e1'});const older=requests.at(-1);click('source',{ref:'e1'});const newer=requests.at(-1);
 older.resolve({state:'ready',revision:readerRevision,identity});await tick();assert.equal(requests.at(-1),newer);
 env.goto('evidence');newer.resolve({state:'ready',revision:readerRevision,identity});await tick();assert.equal(env.$('dialog').open,false);assert.equal(env.$('dialog-body').textContent,'');
}

async function protocolRaceAndUnload(){
 const f=fixture(),{env,requests,key,listeners}=f;
 env.openAssistance({package:packageValue(),binding});const old=requests.at(-1);env.goto('devices');old.resolve(protocol);await tick();assert.equal(env.state.page,'devices');assert.equal(vm.runInContext('assistantContext',env),null);
 await f.enter();f.preview();key.value='SYNTHETIC-KEY-ONLY';f.click('send');const signal=f.sent.at(-1).options.signal;listeners.beforeunload();assert.ok(signal.aborted);assert.equal(key.value,'');assert.equal(vm.runInContext('assistantContext',env),null);
 f.sent.at(-1).resolve({ok:true,json:async()=>modelResult});await tick();
}

async function failedCaseRestoresOnlyBoundDraft(){
 const f=fixture(),{env,requests}=f;env.render();await tick();
 env.XidEvidence.input({dataset:{evidenceInput:'note'},value:'Unsaved synthetic note'});
 env.XidEvidence.selectRange(3,4,A);env.XidEvidence.input({dataset:{evidenceInput:'note'},value:'Unsaved synthetic note'});
 const pending=env.loadCase(B);assert.equal(env.XidEvidence.captureDraft(),null,'Old async/export context is invalidated immediately');requests.at(-1).reject(Error('missing'));await pending;await tick();
 assert.equal(env.state.page,'evidence');assert.match(env.html,/Unsaved synthetic note/);assert.equal(env.XidEvidence.captureDraft().dirty,true);assert.ok(!env.html.includes('导出预览'));
 const stale=env.loadCase(B);env.readerRevision='reader-two';requests.at(-1).reject(Error('missing'));await stale;await tick();assert.ok(!env.html.includes('Unsaved synthetic note'),'Changed reader revision never restores stale draft');
 // A previously approved export is never restored, even when the source is unchanged.
 const clean=fixture();clean.env.render();await tick();clean.env.XidEvidence.change({dataset:{evidenceSelect:'d'.repeat(32)},checked:true});
 const preview=clean.env.XidEvidence.preview();clean.requests.at(-1).resolve({state:'ready',revision:readerRevision,identity});await tick();
 clean.requests.at(-1).resolve({text:'APPROVED SYNTHETIC EXPORT',json:'{}',package:{},replacements:{}});await preview;
 clean.env.XidEvidence.change({dataset:{},hasAttribute:name=>name==='data-evidence-reviewed',checked:true});assert.match(clean.env.html,/APPROVED SYNTHETIC EXPORT/);
 const failed=clean.env.loadCase(B);clean.requests.at(-1).reject(Error('missing'));await failed;await tick();assert.ok(!clean.env.html.includes('APPROVED SYNTHETIC EXPORT'));assert.ok(!clean.env.html.includes('data-evidence-reviewed'));
}

async function nativeDispatchAndFocus(){
 const f=fixture(),{env,listeners}=f,calls=[];
 for(const name of ['click','input','change'])env.XidAssistant[name]=el=>{calls.push([name,el]);return true;};
 vm.runInContext(section('function focusKey(','function restoreFocus(')+source.split('\n').find(line=>line.startsWith('function restoreFocus(')),env);
 const action={dataset:{assistant:'source',ref:'e1'},focus(){calls.push(['focus']);}};
 const focus=env.focusKey(action);env.document.querySelectorAll=selector=>selector==='[data-assistant]'?[action]:[];env.restoreFocus(focus);assert.deepEqual(calls.at(-1),['focus']);
 vm.runInContext(section("document.addEventListener('click',async event=>{XidDiagnostics.dismissPicker","document.addEventListener('focusin'")+
  source.split('\n').find(line=>line.startsWith("document.addEventListener('input',event=>{if(globalThis.XidTimeline"))+
  source.split('\n').find(line=>line.startsWith("document.addEventListener('change',event=>{const el=event.target;if(globalThis.XidTimeline")),env);
 const button={dataset:{assistant:'preview'},closest(selector){return ['button','[data-assistant]'].includes(selector)?this:null;}};
 await listeners.click({target:button});listeners.input({target:{dataset:{assistantField:'fragment',ref:'e1'},value:'synthetic'}});listeners.change({target:{dataset:{assistantField:'mode'},value:'model'}});
 assert.deepEqual(calls.slice(-3).map(row=>row[0]),['click','input','change']);
}

async function sendingFocusTransitions(){
 const f=fixture(),{env}=f,focused=[];
 vm.runInContext(section('function focusKey(','function restoreFocus(')+source.split('\n').find(line=>line.startsWith('function restoreFocus(')),env);
 const realRender=env.render,dom=new Map();
 env.document.querySelectorAll=selector=>selector==='[data-assistant]'?[...dom.values()].filter(node=>node.dataset.assistant):[];
 env.document.querySelector=selector=>selector==='#assistant-key'?f.key:dom.get(selector)||null;
 const originalGet=env.$;env.$=id=>id==='assistant-summary'?dom.get('#assistant-summary')||null:originalGet(id);
 env.render=()=>{
  const old=env.focusKey(env.document.activeElement);realRender();dom.clear();env.document.activeElement=null;
  for(const action of ['send','cancel'])if(env.html.includes(`data-assistant="${action}"`))dom.set(`[data-assistant="${action}"]`,{dataset:{assistant:action},focus(){env.document.activeElement=this;focused.push(action);}});
  if(env.html.includes('id="assistant-summary"'))dom.set('#assistant-summary',{id:'assistant-summary',dataset:{},focus(){env.document.activeElement=this;focused.push('summary');}});
  env.restoreFocus(old);
 };
 await f.enter();f.preview();dom.get('[data-assistant="send"]').focus();f.click('send');assert.equal(focused.at(-1),'cancel');
 f.click('cancel');assert.equal(focused.at(-1),'send');f.sent[0].resolve({ok:true,json:async()=>modelResult});await tick();assert.equal(focused.at(-1),'send','Cancelled late responses do not move focus');
 f.click('send');assert.equal(focused.at(-1),'cancel');f.sent[1].resolve({ok:false,json:async()=>({code:'busy'})});await tick();assert.equal(focused.at(-1),'send','Errors leave the next explicit action focused');
 f.click('send');assert.equal(focused.at(-1),'cancel');f.sent[2].resolve({ok:true,json:async()=>modelResult});await tick();assert.equal(focused.at(-1),'summary');
}

(async()=>{await sendAndLeave();await sourceDialog();await protocolRaceAndUnload();await failedCaseRestoresOnlyBoundDraft();await nativeDispatchAndFocus();await sendingFocusTransitions();console.log('Assistant host: explicit immutable request, cancellation, protocol/source races, bound draft recovery, dialog retention, unload and native dispatch passed');})().catch(error=>{console.error(error);process.exitCode=1;});
