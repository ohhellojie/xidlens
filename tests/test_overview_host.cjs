'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const demoSource=source.slice(source.indexOf('async function loadDemo('),source.indexOf('function closeMenu('));
const focusSource=source.slice(source.indexOf('function focusKey('),source.indexOf('let knowledgeCode='));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function demoFixture(){
 const fetches=[],files=[];
 const env={busy:false,loading:false,demoPending:false,state:{page:'devices'},opened:0,imports:0,
  File:class{constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options.type;}},
  fetch(path){assert.equal(path,'/demo.txt');const request=deferred();fetches.push(request);return request.promise;},
  importDialog(){env.opened++;},
  async importFiles(selected){assert.equal(env.busy,false);env.imports++;files.push(...selected);},
 };
 vm.createContext(env);vm.runInContext(demoSource,env);
 return {env,fetches,files};
}
function response(text='Synthetic sample'){return {ok:true,text:async()=>text};}
function node(dataset,id=''){
 return {dataset,id,disabled:false,focused:false,focus(options){this.focused=true;this.focusOptions=options;}};
}
function focusFixture(){
 const dom=[];
 const env={document:{querySelectorAll(selector){
  if(selector.includes('data-overview-change'))return dom.filter(el=>el.dataset.overviewChange);
  if(selector.includes('data-overview'))return dom.filter(el=>el.dataset.overview);
  if(selector.includes('data-diag-change'))return dom.filter(el=>el.dataset.diagChange);
  if(selector.includes('data-diag'))return dom.filter(el=>el.dataset.diag);
  if(selector==='button')return dom;
  throw Error('Unexpected selector: '+selector);
 }},$:id=>dom.find(el=>el.id===id)};
 vm.createContext(env);vm.runInContext(focusSource,env);
 return {env,dom};
}
function focusTests(){
 const {env,dom}=focusFixture();
 for(const dataset of [
  {overview:'select',value:'event:["0000:41:00.0","init"]'},
  {overviewChange:'filter'},
  {overview:'page',value:'1'},
  {overview:'collect'},
 ]){
  const old=node(dataset),key=env.focusKey(old);
  assert.ok(key,'Every overview control retains a focus key before render');
  const replacement=node({...dataset});dom.splice(0,dom.length,node({overview:'select',value:'other'}),replacement);
  env.restoreFocus(key);
  assert.equal(replacement.focused,true,'Focus returns to the replacement after render');
  assert.equal(old.focused,false);assert.equal(dom[0].focused,false);
  assert.equal(replacement.focusOptions.preventScroll,true);
 }
 const old=node({overview:'page',value:'2'}),key=env.focusKey(old);
 const disabled=node({...old.dataset});disabled.disabled=true;dom.splice(0,dom.length,disabled);
 env.restoreFocus(key);assert.equal(disabled.focused,false,'A disabled page control is not focused');
 dom.length=0;assert.doesNotThrow(()=>env.restoreFocus(key),'A removed control is safe');
 const search=node({},'overview-search'),searchKey=env.focusKey(search),replacement=node({},'overview-search');
 dom.push(replacement);env.restoreFocus(searchKey);assert.equal(replacement.focused,true,'Search input focus still works');
}
(async()=>{
 // A second click must not start another fetch or replace an active import dialog.
 {
  const {env,fetches,files}=demoFixture(),importDone=deferred();
  env.importFiles=async selected=>{env.imports++;files.push(...selected);env.busy=true;await importDone.promise;env.busy=false;};
  const first=env.loadDemo(),second=env.loadDemo();await second;
  assert.equal(fetches.length,1);assert.equal(env.demoPending,true);
  fetches[0].resolve(response());await tick();
  assert.equal(env.opened,1);assert.equal(env.imports,1);assert.equal(env.busy,true);
  await env.loadDemo();assert.equal(fetches.length,1);assert.equal(env.opened,1);
  importDone.resolve();await first;
  assert.equal(env.demoPending,false);assert.equal(env.state.page,'overview');
  assert.equal(files[0].name,'xidlens-demo.txt');assert.equal(files[0].type,'text/plain');
 }
 // Fetch failure leaves the existing report and dialog intact and permits a retry.
 for(const failure of ['http','network','body']){
  const {env,fetches}=demoFixture(),pending=env.loadDemo();
  if(failure==='http')fetches[0].resolve({ok:false,text:async()=>{throw Error('must not read');}});
  else if(failure==='network')fetches[0].reject(Error('connection failed'));
  else fetches[0].resolve({ok:true,text:async()=>{throw Error('read failed');}});
  await assert.rejects(pending);assert.equal(env.demoPending,false);assert.equal(env.busy,false);
  assert.equal(env.opened,0);assert.equal(env.imports,0);assert.equal(env.state.page,'devices');
  const retry=env.loadDemo();fetches[1].resolve(response());await retry;
  assert.equal(env.imports,1);assert.equal(env.demoPending,false);
 }
 // A real import or report load may start while the demo fetch is pending.
 for(const flag of ['busy','loading']){
  const {env,fetches}=demoFixture(),pending=env.loadDemo();env[flag]=true;
  fetches[0].resolve(response());await pending;
  assert.equal(env.opened,0,'Pending demo does not replace an existing operation');
  assert.equal(env.imports,0);assert.equal(env.state.page,'devices');assert.equal(env.demoPending,false);
  await env.loadDemo();assert.equal(fetches.length,1,'An already active operation prevents fetch');
 }
 // The same guard applies when reading the response body takes time.
 {
  const {env,fetches}=demoFixture(),body=deferred(),pending=env.loadDemo();
  fetches[0].resolve({ok:true,text:()=>body.promise});await tick();env.busy=true;body.resolve('Synthetic sample');await pending;
  assert.equal(env.opened,0);assert.equal(env.imports,0);assert.equal(env.demoPending,false);
 }
 focusTests();
 console.log('Overview host: demo concurrency, failure recovery, import isolation and focus restoration passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
