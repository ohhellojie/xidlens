'use strict';
const assert = require('node:assert/strict');
const ui = require('../app/assistant.js');
const tick = () => new Promise(resolve=>setImmediate(resolve));
const protocol = () => ({version:1,system:'Synthetic fixed JSON rules',parameters:{response_format:{type:'json_object'},stream:false,store:false,max_completion_tokens:4096}});
const sentInput = payload => JSON.parse(payload.preview.messages[1].content);
const input = () => ({text:'仅整理所选片段', evidence:[
  {id:'e1', text:'Synthetic Xid 79 <script>unsafe()</script>', source:'sample.log', line:12},
  {id:'e2', text:'Test status: not recorded', source:'sample.json', line:30}
]});
const result = () => ({mode:'model', observations:[{text:'记录了 Xid 79。',refs:['e1']}], uncertainties:[{text:'测试结果待核实。',refs:['e2']}],summary:[{text:'Xid 79；测试结果未记录。',refs:['e1','e2']}]});
const click = (action, extra={}) => ui.click({dataset:{assistant:action,...extra}});
const change = (field,value) => ui.change({dataset:{assistantField:field},value});
const model = ctx => {ui.render(ctx);change('mode','model');change('model','synthetic-model');click('preview');};

(async()=>{
  const calls=[];
  let copied='', source=null;
  let ctx={input:input(),protocol:protocol(),render:()=>{},onRequest:(payload,options)=>{calls.push({payload:JSON.parse(JSON.stringify(payload)),options});return Promise.resolve(result());},onCopy:text=>{copied=text;},onSource:row=>{source=row;}};
  let html=ui.render(ctx);
  assert.equal(calls.length,0);assert.ok(html.includes('本机整理'));assert.ok(!html.includes('发送预览'));
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
  click('send');await tick();assert.equal(calls.length,0);
  click('offline');html=ui.render(ctx);assert.ok(html.includes('在本机摘录片段，不调用模型'));assert.ok(!html.includes('将发送给模型'));assert.ok(!html.includes('随所选证据发送'));assert.ok(html.includes('可编辑摘要'));assert.equal(calls.length,0);
  ui.input({dataset:{assistantField:'summary'},value:'人工编辑的摘要'});click('copy');await tick();assert.equal(copied,'人工编辑的摘要');
  click('source',{ref:'e1'});assert.equal(source,null,'Unmapped text cannot navigate to a claimed line');click('source',{ref:'unknown'});assert.equal(source,null);

  model(ctx);html=ui.render(ctx);assert.ok(html.includes('补充说明（将发送给模型）'));assert.ok(html.includes('http://localhost:11434/v1/chat/completions'));assert.ok(html.includes('synthetic-model'));assert.ok(html.includes('确认发送至模型'));assert.equal(calls.length,0);
  const field={value:'SYNTHETIC-KEY-ONLY'};
  ui.click({dataset:{assistant:'send'},closest:()=>({querySelector:()=>field})});
  assert.equal(field.value,'');assert.equal(calls.length,1);assert.equal(calls[0].payload.apiKey,'SYNTHETIC-KEY-ONLY');
  assert.equal(calls[0].payload.confirmed,true);assert.deepEqual(sentInput(calls[0].payload),ctx.input);assert.ok(calls[0].options.signal instanceof AbortSignal);
  html=ui.render(ctx);assert.ok(!html.includes('SYNTHETIC-KEY-ONLY'));assert.ok(html.includes('取消等待'));
  await tick();html=ui.render(ctx);assert.ok(html.includes('模型辅助结果'));assert.ok(html.includes('证据中的观察'));assert.ok(html.includes('待核实'));assert.ok(!html.includes('发送预览'));
  assert.ok(!JSON.stringify(result()).includes('apiKey'));

  click('preview');change('model','new-model');click('send');await tick();assert.equal(calls.length,1);assert.ok(!ui.render(ctx).includes('发送预览'));
  click('preview');ui.input({dataset:{assistantField:'note'},value:'changed without blur'});click('send');await tick();assert.equal(calls.length,1);
  change('note','only one');ui.change({dataset:{assistantField:'evidence',ref:'e2'},checked:false});click('preview');click('send');await tick();
  assert.equal(calls.length,2);assert.equal(sentInput(calls[1].payload).evidence.length,1);assert.equal(sentInput(calls[1].payload).evidence[0].id,'e1');
  // The mock returns e2 after it was deselected: the result must be rejected by UI too.
  html=ui.render(ctx);assert.ok(html.includes('模型引用了未提供的证据'));

  let resolve;
  ui.reset();ctx={...ctx,input:input(),onRequest:(payload,{signal})=>{calls.push({signal});return new Promise(done=>{resolve=done;});}};
  model(ctx);click('send');click('cancel');assert.ok(calls.at(-1).signal.aborted);resolve(result());await tick();html=ui.render(ctx);
  assert.ok(html.includes('已取消等待'));assert.ok(!html.includes('模型辅助结果'));assert.ok(!html.includes('正在等待模型'));

  // Reset/new report must never let an older request overwrite the new report's result.
  ui.reset();model(ctx);click('send');const oldResolve=resolve;
  ui.reset();const different={...ctx,input:{text:'new evidence',evidence:[{id:'new',text:'New source only',source:'new.log',line:1}]}};
  model(different);click('send');oldResolve(result());await tick();assert.ok(ui.render(different).includes('正在等待模型'));assert.ok(!ui.render(different).includes('模型辅助结果'));
  click('cancel');resolve({mode:'model',observations:[],uncertainties:[],summary:[]});await tick();

  ui.reset();ctx={...ctx,onRequest:()=>Promise.reject(new Error('SYNTHETIC-KEY-ONLY PRIVATE INPUT'))};model(ctx);click('send');await tick();html=ui.render(ctx);
  assert.ok(html.includes('未能取得有效结果'));assert.ok(!html.includes('SYNTHETIC-KEY-ONLY'));assert.ok(!html.includes('PRIVATE INPUT'));
  ctx={...ctx,onRequest:()=>Promise.reject(Object.assign(new Error('secret'),{code:'authentication_failed'}))};ui.render(ctx);click('send');await tick();assert.ok(ui.render(ctx).includes('认证失败'));

  ui.reset();ctx={...ctx,onRequest:()=>Promise.resolve({...result(),summary:[{text:'<img src=x onerror=alert(1)>',refs:['e1']}]})};model(ctx);click('send');await tick();html=ui.render(ctx);
  assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('onerror="'));

  ui.reset();html=ui.render({input:{...input(),report:{raw:'PRIVATE'}}});assert.ok(html.includes('只接受已选择证据'));assert.ok(!html.includes('PRIVATE'));
  ui.reset();html=ui.render({input:{evidence:[]},onSelectEvidence:()=>calls.push('select')});assert.ok(html.includes('尚未选择证据'));click('select');assert.equal(calls.at(-1),'select');
  assert.throws(()=>ui.normalizeInput({evidence:[{id:'bad id',text:'a'}]}));
  assert.throws(()=>ui.normalizeInput({evidence:[{id:'e1',text:'x'},{id:'e1',text:'y'}]}));
  assert.throws(()=>ui.normalizeInput({evidence:[{id:'e1',text:'a',line:0}]}));
  assert.throws(()=>ui.normalizeInput({evidence:Array.from({length:33},(_,i)=>({id:`e${i}`,text:'a'}))}));
  assert.throws(()=>ui.normalizeInput({evidence:Array.from({length:4},(_,i)=>({id:`e${i}`,text:'大'.repeat(16000)}))}));
  for(const url of ['file:///secret','http://example.invalid','https://user:secret@example.invalid','https://example.invalid/?key=secret','https://example.invalid/#secret','http://localhost.evil.invalid','http://192.0.2.1','http://127.1/v1','http://2130706433/v1','https://example.invalid\\@evil.invalid']) assert.throws(()=>ui.endpoint(url));
  assert.equal(ui.endpoint('https://example.invalid/v1'),'https://example.invalid/v1/chat/completions');
  assert.equal(ui.endpoint('http://[::1]:9000/v1'),'http://[::1]:9000/v1/chat/completions');
  assert.throws(()=>ui.checkedResult({...result(),summary:[{text:'claim',refs:['missing']}]},input()));
  const expanded={text:'',evidence:Array.from({length:8},(_,i)=>({id:'e'+i,text:'\\'.repeat(8000)}))};
  assert.ok(new TextEncoder().encode(JSON.stringify(ui.normalizeInput(expanded))).length<128*1024);
  assert.throws(()=>ui.protocolRequest(expanded,'synthetic-model',protocol()),/请求超过大小限制/);

  // Identical pseudonymized evidence is still a different source/revision.
  ui.reset();let finishOld;
  const scoped={...ctx,input:input(),caseId:'report-a',revision:'one',identity:'a'.repeat(64),
    onRequest:(_payload,{signal})=>{calls.push({signal});return new Promise(done=>{finishOld=done;});}};
  model(scoped);click('send');
  const switched={...scoped,caseId:'report-b'};html=ui.render(switched);
  assert.ok(calls.at(-1).signal.aborted);assert.ok(html.includes('value="offline" selected'));
  finishOld(result());await tick();assert.ok(!ui.render(switched).includes('模型辅助结果'));
  click('offline');assert.ok(ui.render(switched).includes('id="assistant-summary"'));
  html=ui.render({...switched,revision:'two'});assert.ok(!html.includes('id="assistant-summary"'));
  click('offline');change('note','Revised selected context');assert.ok(!ui.render({...switched,revision:'two'}).includes('id="assistant-summary"'));

  // The only request body is the immutable, displayed protocol preview.
  ui.reset();let sent;
  ctx={input:input(),protocol:protocol(),render(){},onRequest(payload){
    sent=payload;assert.ok(Object.isFrozen(payload.preview));assert.ok(Object.isFrozen(payload.preview.messages[1]));
    assert.throws(()=>{payload.preview.messages[1].content='unpreviewed';},TypeError);
    assert.throws(()=>{payload.endpoint='https://other.example.invalid';},TypeError);
    assert.equal(Object.hasOwn(payload,'input'),false);assert.equal(Object.hasOwn(payload,'model'),false);
    return Promise.resolve(result());
  }};
  model(ctx);html=ui.render(ctx);assert.ok(html.includes('完整请求'));assert.ok(html.includes('Synthetic fixed JSON rules'));
  const key={value:'SYNTHETIC-KEY-ONLY'};ui.click({dataset:{assistant:'send'},closest:()=>({querySelector:()=>key})});await tick();
  assert.equal(key.value,'');assert.equal(sent.apiKey,'');assert.deepEqual(sentInput(sent),ctx.input);

  // Changed fixed rules require a new preview, even if evidence is unchanged.
  ui.reset();let modelCalls=0;ctx={...ctx,protocol:protocol(),onRequest(){modelCalls++;return Promise.resolve(result());}};
  model(ctx);ctx.protocol.system='Changed local protocol';click('send');await tick();assert.equal(modelCalls,0);assert.ok(ui.render(ctx).includes('重新检查发送预览'));

  // A host revision change cannot accept an old response even before its next render.
  ui.reset();let delayed;
  ctx={...ctx,protocol:protocol(),caseId:'report-a',revision:'one',identity:'a'.repeat(64),onRequest(){return new Promise(done=>{delayed=done;});}};
  model(ctx);click('send');ctx.revision='two';delayed(result());await tick();assert.ok(!ui.render(ctx).includes('模型辅助结果'));
  model(ctx);ctx.input.evidence[0].text='changed after preview';click('send');await tick();assert.ok(ui.render(ctx).includes('changed after preview'));assert.ok(!ui.render(ctx).includes('发送预览'));

  // An input event immediately clears the password and visible stale panels without blur.
  ui.reset();ctx={...ctx,input:input()};model(ctx);const removed=[];
  global.document={querySelector:()=>key};key.value='SYNTHETIC-KEY-ONLY';
  ui.input({dataset:{assistantField:'note'},value:'updated note',closest:()=>({querySelectorAll:()=>[{remove(){removed.push('preview');}},{remove(){removed.push('result');}}]})});
  assert.deepEqual(removed,['preview','result']);assert.equal(key.value,'');key.value='SYNTHETIC-KEY-ONLY';ui.reset();assert.equal(key.value,'');delete global.document;

  // Host callbacks cannot expose arbitrary exception text through the page.
  ctx={input:input(),protocol:protocol(),render(){},onCopy(){throw Error('SYNTHETIC-KEY-ONLY PRIVATE INPUT');}};
  ui.render(ctx);click('offline');click('copy');html=ui.render(ctx);assert.ok(html.includes('操作未完成'));assert.ok(!html.includes('SYNTHETIC-KEY-ONLY'));assert.ok(!html.includes('PRIVATE INPUT'));
  ui.reset();model({...ctx,protocol:null});assert.ok(ui.render({...ctx,protocol:null}).includes('整理规则尚未读取'));
  ui.reset();
  console.log('Evidence assistant UI: offline default, explicit preview/send, key clearing, cancel/race protection, reference checks, editing/copy and HTML escaping passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
