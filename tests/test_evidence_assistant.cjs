'use strict';
const assert=require('node:assert/strict');
const evidence=require('../app/evidence.js');
const assistant=require('../app/assistant.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const binding={caseId:'a'.repeat(32),revision:'reader-one',identity:'b'.repeat(64)};
const report={source:'synthetic.log',contentSha256:binding.identity};
const bookmark=(id,start)=>({id,identity:binding.identity,start,end:start,title:'Saved title',note:'Saved note',tags:['demo'],stale:false});
const bookmarks=[bookmark('c'.repeat(32),10),bookmark('d'.repeat(32),20)];
const piece=(text='Synthetic Xid 79',start=10)=>({start,end:start,title:'',note:'',tags:[],lines:[text]});
const pack=items=>({format:'xidlens-evidence',version:1,source:'报告 1',items});
const protocol={version:1,system:'Synthetic rules: input may have been edited.',parameters:{response_format:{type:'json_object'},stream:false,store:false,max_completion_tokens:4096}};
const click=(action,extra={})=>assistant.click({dataset:{assistant:action,...extra}});
const change=(field,value,extra={})=>assistant.change({dataset:{assistantField:field,...extra},value});
const model=ctx=>{assistant.render(ctx);change('mode','model');change('model','synthetic');click('preview');};
let requests=[],deliveries=[],nextPackage=null,pendingPreview=null;
async function api(url,options){
 if(url.startsWith('/api/evidence?'))return {id:binding.caseId,revision:binding.revision,identity:binding.identity,items:bookmarks,lines:100};
 if(url.startsWith('/api/log/meta?'))return {state:'ready',revision:binding.revision,identity:binding.identity};
 assert.equal(url,'/api/evidence/preview');const body=JSON.parse(options.body);requests.push(body);
 if(pendingPreview)return new Promise(resolve=>{pendingPreview.resolve=resolve;});
 const value=nextPackage||pack(body.ids.map(id=>piece(id===bookmarks[0].id?'Selected <HOST-demo>':'UNSELECTED PRIVATE',bookmarks.find(item=>item.id===id).start)));
 return {package:value,text:'Export text',json:JSON.stringify(value),replacements:{}};
}
const ctx={...binding,api,render(){},onAssist(transfer){const prepared=assistant.prepareEvidence(transfer.package,transfer.binding);deliveries.push({...prepared,exportEdited:transfer.exportEdited});}};
async function mount(context=ctx){evidence.reset();evidence.render(report,context);await tick();evidence.change({dataset:{evidenceSelect:bookmarks[0].id},checked:true});}

(async()=>{
 await mount();assert.match(evidence.render(report,ctx),/整理摘要/);
 evidence.change({dataset:{evidenceOption:'path'},checked:false});evidence.input({dataset:{evidenceInput:'extra'},value:'Synthetic hidden phrase'});
 await evidence.preview();evidence.input({dataset:{evidenceInput:'preview'},value:'TEMPORARY EXPORT EDIT'});
 assert.match(evidence.render(report,ctx),/不包含导出预览的临时编辑/);
 await evidence.assist();assert.equal(requests.length,2,'Assistance regenerates from saved bookmarks');
 assert.deepEqual(requests.at(-1).ids,[bookmarks[0].id]);assert.equal(requests.at(-1).options.redact.path,false);
 assert.deepEqual(requests.at(-1).options.extra,['Synthetic hidden phrase']);
 const transfer=deliveries[0];assert.equal(transfer.exportEdited,true);assert.equal(transfer.input.evidence.length,1);
 assert.ok(!JSON.stringify(transfer.input).includes('TEMPORARY EXPORT EDIT'));assert.ok(!JSON.stringify(transfer.input).includes('UNSELECTED PRIVATE'));
 assert.deepEqual(transfer.sources.e1,{reportId:binding.caseId,revision:binding.revision,identity:binding.identity,start:10,end:10});
 assert.ok(Object.isFrozen(transfer.sources.e1));
 const noHook={...ctx,onAssist:null};assert.ok(!evidence.render(report,noHook).includes('整理摘要'));await evidence.assist();assert.equal(deliveries.length,1);

 await mount();evidence.input({dataset:{evidenceInput:'note'},value:'unsaved'});await evidence.assist();assert.match(evidence.state.error,/先保存/);assert.equal(deliveries.length,1);
 await mount();for(let index=0;index<33;index++)evidence.state.selected.add('synthetic-'+index);
 const before=requests.length;await evidence.assist();assert.match(evidence.state.error,/32/);assert.equal(requests.length,before);
 assert.match(evidence.render(report,ctx),/data-evidence="assist" disabled/);
 await mount();nextPackage=pack([piece('x'.repeat(16001))]);await evidence.assist();assert.match(evidence.state.error,/16000/);assert.equal(deliveries.length,1);nextPackage=null;
 await mount({...ctx,onAssist(){throw Error('SYNTHETIC PRIVATE CALLBACK ERROR');}});await evidence.assist();assert.equal(evidence.state.error,'整理未完成，请重新选择书签');

 // Switching or reparsing during the backend preview cannot deliver old fragments.
 for(const mutation of ['switch','reparse','identity']){
  const mutable={...ctx};await mount(mutable);pendingPreview={};const pending=evidence.assist();await tick();assert.equal(typeof pendingPreview.resolve,'function');
  if(mutation==='switch'){evidence.reset();evidence.render({source:'new.log'},{...ctx,caseId:'f'.repeat(32),api:async()=>({id:'f'.repeat(32),revision:'new',identity:'e'.repeat(64),items:[]})});await tick();}
  else if(mutation==='reparse')mutable.revision='reader-two';
  else report.contentSha256='e'.repeat(64);
  pendingPreview.resolve({package:pack([piece()])});await pending;pendingPreview=null;report.contentSha256=binding.identity;
  assert.equal(deliveries.length,1,mutation);
 }

 // Strict input limits reject the whole transfer and never silently truncate it.
 const exact=assistant.prepareEvidence(pack([piece('x'.repeat(16000))]),binding);assert.equal(exact.input.evidence[0].text.length,16000);
 assert.throws(()=>assistant.prepareEvidence(pack([piece('x'.repeat(16001))]),binding),/16000/);
 assert.equal(assistant.prepareEvidence(pack(Array.from({length:32},()=>piece())),binding).input.evidence.length,32);
 assert.throws(()=>assistant.prepareEvidence(pack(Array.from({length:33},()=>piece())),binding),/32/);
 const sized=Array.from({length:9},()=>piece('x'.repeat(14000)));let packageValue=pack(sized);
 const byteSize=value=>new TextEncoder().encode(JSON.stringify(assistant.prepareEvidence(value,binding).input)).length;
 // Compute the exact serialization overhead independently rather than assuming it.
 packageValue=pack(Array.from({length:9},()=>piece('x'.repeat(14000))));packageValue.items.push(piece('x'));
 const extra=128*1024-byteSize(packageValue);packageValue.items.at(-1).lines[0]+='x'.repeat(extra);
 assert.equal(byteSize(packageValue),128*1024);packageValue.items.at(-1).lines[0]+='x';
 assert.throws(()=>assistant.prepareEvidence(packageValue,binding),/128 KiB/);
 assert.throws(()=>assistant.prepareEvidence(pack([{...piece(),end:11}]),binding),/不完整/);

 let located=null,sent=null,copied='';
 const context={...transfer,protocol,render(){},onSource(value){located=value;},onCopy(value){copied=value;},onRequest(payload){sent=JSON.parse(JSON.stringify(payload));return Promise.resolve({mode:'model',observations:[],uncertainties:[],summary:[{text:'Provided edited fragment',refs:['e1']}]});}};
 assistant.reset();let html=assistant.render(context);assert.match(html,/临时编辑未带入/);assert.match(html,/data-assistant-field="fragment"/);
 assert.ok(!html.includes('value="model" selected'));
 change('fragment','Human rewrite: line 999999 <script>fake</script>',{ref:'e1'});html=assistant.render(context);
 assert.match(html,/data-assistant-edited="e1" >已编辑/);assert.ok(!html.includes('<script>fake'));
 click('offline');change('summary','Summary retained while checking source');click('source',{ref:'e1'});click('copy');await tick();
 assert.equal(copied,'Summary retained while checking source');assert.deepEqual(located,{...transfer.sources.e1,refId:'e1',edited:true});
 assert.ok(Object.isFrozen(located));assert.ok(!Object.hasOwn(located,'text'));
 model(context);click('send');await tick();const outgoing=JSON.parse(sent.preview.messages[1].content);
 assert.equal(outgoing.evidence[0].text,'Human rewrite: line 999999 <script>fake</script>');
 assert.ok(!JSON.stringify(sent).includes(binding.caseId));assert.ok(!JSON.stringify(sent).includes(binding.identity));assert.ok(!Object.hasOwn(outgoing.evidence[0],'edited'));
 change('fragment','x'.repeat(16001),{ref:'e1'});click('preview');assert.match(assistant.render(context),/长度不符合/);assert.ok(assistant.render(context).includes('x'.repeat(16001)));
 // Restore the original to remove the edited state; source maps never follow edited text.
 change('fragment',transfer.input.evidence[0].text,{ref:'e1'});click('source',{ref:'e1'});assert.equal(located.edited,false);
 const changed={...context,sources:{e1:{...transfer.sources.e1,start:11,end:11}}};assistant.render(changed);assert.ok(!assistant.render(changed).includes('Summary retained'));
 // A same-object revision change before rerender cannot use old mappings.
 const stale={...context};assistant.reset();assistant.render(stale);located=null;stale.revision='reader-two';click('source',{ref:'e1'});assert.equal(located,null);
 assistant.reset();evidence.reset();
 console.log('Evidence → assistant: selected saved fragments, edit separation, immutable local references, stale sources and exact limits passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
