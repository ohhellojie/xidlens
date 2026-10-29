'use strict';
const assert=require('node:assert/strict');
const ui=require('../app/evidence.js');
const key='a'.repeat(32),identity='c'.repeat(64),revision='revision-one';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const control=(name,value={})=>({dataset:{evidence:name,...value}});
const checkbox=(attribute,checked)=>({checked,dataset:{},hasAttribute:name=>name===attribute});
const sample=()=>({id:'b'.repeat(32),identity,start:2,end:3,title:'<script>Title</script>',note:'<img src=x onerror=bad()>',tags:['<tag>'],stale:false});
let items=[sample()],calls=[],downloads=[],rendered=0;
async function api(url,options){
 calls.push({url,options});
 if(url.startsWith('/api/evidence?'))return {id:key,revision,identity,items,lines:100};
 if(url.startsWith('/api/log/meta?'))return {state:'ready',revision,identity};
 const body=JSON.parse(options.body);assert.equal(body.id,key);assert.equal(body.identity,identity);assert.equal(body.revision,revision);
 if(url==='/api/evidence/save'){const item={...body.entry,id:body.entry.id||'d'.repeat(32),identity,stale:false};items=items.filter(x=>x.id!==item.id).concat(item);return {saved:true,item};}
 if(url==='/api/evidence/delete'){items=items.filter(x=>x.id!==body.bookmarkId);return {deleted:true};}
 if(url==='/api/evidence/preview')return {text:'Safe <HOST-demo>\n<svg onload=bad()>',json:'{"safe":true}',package:{safe:true},replacements:{host:1},warning:'自动脱敏不能覆盖全部自由文本。'};
 throw Error('Unknown route');
}
const report={source:'demo.log'},ctx={caseId:key,api,render:()=>rendered++,download:(...args)=>downloads.push(args),openSource:()=>{}};
(async()=>{
 ui.reset();ui.selectRange(10,12);ui.render(report,ctx);await tick();
 assert.equal(ui.state.draft.start,10,'Range selected before entering the page survives initial load');
 assert.equal(ui.state.draft.end,12);
 let html=ui.render(report,ctx);assert.ok(html.includes('&lt;script&gt;Title'));assert.ok(html.includes('&lt;img'));assert.ok(html.includes('&lt;tag&gt;'));assert.ok(!html.includes('<script>Title'));assert.ok(!html.includes('<img src=x'));
 ui.input({dataset:{evidenceInput:'title'},value:'Evidence'});ui.input({dataset:{evidenceInput:'note'},value:'A note'});ui.input({dataset:{evidenceInput:'tags'},value:'gpu，review'});
 await ui.save();assert.ok(ui.state.selected.has('d'.repeat(32)));assert.deepEqual(items.at(-1).tags,['gpu','review']);assert.equal(ui.state.dirty,false);assert.equal(ui.state.error,'');
 await ui.preview();assert.ok(ui.state.preview);assert.equal(ui.state.reviewed,false);
 html=ui.render(report,ctx);assert.ok(html.includes('&lt;svg onload=bad()&gt;'));assert.ok(!html.includes('<svg onload'));
 ui.click(control('download'));assert.equal(downloads.length,0,'Downloading requires reviewing the preview');
 ui.change(checkbox('data-evidence-reviewed',true));ui.click(control('download'));assert.equal(downloads.length,1);assert.equal(downloads[0][0],'xidlens-evidence.txt');assert.ok(!downloads[0][1].includes('redactionKey'));
 ui.input({dataset:{evidenceInput:'preview'},value:'Edited'});assert.equal(ui.state.reviewed,false);ui.click(control('download'));assert.equal(downloads.length,1,'Editing invalidates the review flag');
 ui.change({dataset:{evidenceOption:'ip'},checked:false});assert.equal(ui.state.preview,null);await ui.preview();
 const previewCall=calls.filter(x=>x.url==='/api/evidence/preview').at(-1);assert.equal(JSON.parse(previewCall.options.body).options.redact.ip,false);
 ui.change({...checkbox('data-evidence-format',false),value:'json'});ui.input({dataset:{evidenceInput:'preview'},value:'{broken'});ui.change(checkbox('data-evidence-reviewed',true));ui.click(control('download'));assert.equal(downloads.length,1);assert.match(ui.state.error,/JSON/);
 ui.input({dataset:{evidenceInput:'note'},value:'Unsaved'});await ui.preview();assert.match(ui.state.error,/先保存/,'Unsaved notes cannot silently be omitted from the preview');
 await ui.save();ui.click(control('delete',{value:'d'.repeat(32)}));assert.equal(ui.state.deleteId,'d'.repeat(32));assert.equal(items.length,2);ui.click(control('cancel-delete'));assert.equal(ui.state.deleteId,'');
 ui.click(control('select-all'));assert.equal(ui.state.selected.size,0);ui.click(control('select-all'));assert.equal(ui.state.selected.size,2);
 items[0].stale=true;await ui.load();assert.ok(!ui.state.selected.has(items[0].id));html=ui.render(report,ctx);assert.ok(html.includes('原日志已变更'));
 // A request finishing after a report switch must not overwrite the new editor.
 let resolveSave;const slowContext={...ctx,api:async(url,options)=>url==='/api/evidence/save'?new Promise(resolve=>{resolveSave=resolve;}):api(url,options)};
 ui.render(report,slowContext);ui.input({dataset:{evidenceInput:'note'},value:'Pending'});const pending=ui.save();await tick();assert.ok(resolveSave);
 ui.render({source:'other.log'},{...ctx,caseId:'e'.repeat(32),api:async()=>({id:'e'.repeat(32),revision:'new',identity:'f'.repeat(64),items:[],lines:5})});await tick();resolveSave({item:{...sample(),note:'old result'}});await pending;
 assert.equal(ui.state.draft.note,'');assert.equal(ui.state.data.id,'e'.repeat(32));assert.equal(ui.state.selected.size,0);

 // Replacing bytes under the same report ID invalidates an approved export.
 let sourceIdentity=identity,sourceRevision=revision;
 const scopedContext={...ctx,api:async()=>({id:key,revision:sourceRevision,identity:sourceIdentity,items:[],lines:5})};
 ui.reset();ui.render({source:'demo.log',contentSha256:identity},scopedContext);await tick();
 ui.state.preview={text:'OLD SOURCE TEXT',json:'{}'};ui.state.reviewed=true;
 sourceIdentity='8'.repeat(64);sourceRevision='revision-two';
 html=ui.render({source:'demo.log',contentSha256:sourceIdentity},scopedContext);
 assert.ok(!html.includes('OLD SOURCE TEXT'));assert.equal(ui.state.preview,null);assert.equal(ui.state.reviewed,false);await tick();
 ui.state.preview={text:'OLD REVISION TEXT',json:'{}'};ui.state.reviewed=true;
 sourceRevision='revision-three';await ui.load();assert.equal(ui.state.preview,null);assert.equal(ui.state.reviewed,false);

 // Clicking another bookmark while a save waits for indexing cannot change its target.
 items=[sample(),{...sample(),id:'d'.repeat(32),title:'Second'}];
 let resolveMeta;
 const delayedMeta={...ctx,api:(url,options)=>url.startsWith('/api/log/meta?')?new Promise(resolve=>{resolveMeta=resolve;}):api(url,options)};
 ui.reset();ui.render(report,delayedMeta);await tick();ui.click(control('edit',{value:items[0].id}));
 ui.input({dataset:{evidenceInput:'note'},value:'First bookmark only'});const saving=ui.save();await tick();
 assert.equal(ui.change({dataset:{},hasAttribute:()=>false}),false,'busy state must not consume unrelated host controls');
 ui.click(control('edit',{value:items[1].id}));assert.equal(ui.state.draft.id,items[0].id);
 resolveMeta({state:'ready',revision,identity});await saving;
 const saved=JSON.parse(calls.filter(call=>call.url==='/api/evidence/save').at(-1).options.body).entry;
 assert.equal(saved.id,'b'.repeat(32));assert.equal(saved.note,'First bookmark only');
 items=Array.from({length:101},(_,index)=>({...sample(),id:index.toString(16).padStart(32,'0')}));
 ui.render(report,ctx);await ui.load();ui.click(control('select-all'));
 assert.equal(ui.state.selected.size,101,'Select all keeps its full meaning');
 html=ui.render(report,ctx);assert.match(html,/101 \/ 100 个书签/);assert.match(html,/data-evidence="preview" disabled/);
 const previewRequests=calls.filter(call=>call.url==='/api/evidence/preview').length;
 await ui.preview();assert.match(ui.state.error,/最多导出 100/);
 assert.equal(calls.filter(call=>call.url==='/api/evidence/preview').length,previewRequests,'Over-limit selection fails locally before any preview request');
 assert.ok(rendered>0);console.log('Evidence UI: escaping, ranges, save, review gate, edit invalidation, stale data and report-switch races passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
