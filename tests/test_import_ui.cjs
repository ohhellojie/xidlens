'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const body=source.slice(source.indexOf('async function importFiles('),source.indexOf('function closeMenu('));
async function run(files,cancelAfter=0){
 const nodes=new Map(),uploaded=[],refreshed=[];let current,closed=false;
 const el=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,open:true,setAttribute(){},focus(){}});return nodes.get(id);};
 const env={busy:false,activeImport:null,loadedCase:'old',cases:[],data:{source:''},catalogBusy:false,$:el,document:{querySelector:()=>null},
  validateLogFile:f=>f.name.endsWith('.exe')?f.name+'：类型不支持':'',showImportProgress(){},toast(){},closeDialog(){closed=true;},
  api:async path=>path==='/api/import/start'?{job:'job'}:{},refreshCases:async id=>refreshed.push(id),
  uploadImport:async(f,op)=>{current=f;uploaded.push(f.name);if(f.uploadError)throw Error('读取失败');if(uploaded.length===cancelAfter)op.cancelRequested=true;},
  waitImport:async op=>op.cancelRequested?{state:'cancelled'}:current.bad?{state:'error',message:'没有可解析记录'}:{state:'done',ids:[current.name]}};
 vm.createContext(env);vm.runInContext(body,env);await env.importFiles(files);
 assert.equal(env.busy,false);assert.equal(env.activeImport,null);assert.equal(el('file-input').disabled,false);
 return {uploaded,refreshed,closed,message:el('import-feedback').textContent};
}
(async()=>{
 let r=await run([{name:'first.log'},{name:'bad.log',bad:true},{name:'last.log'}]);
 assert.deepEqual(r.uploaded,['first.log','bad.log','last.log']);assert.deepEqual(r.refreshed,['last.log']);assert.match(r.message,/已导入 2 份文件/);assert.match(r.message,/bad.log/);assert.equal(r.closed,false);
 r=await run([{name:'image.exe'},{name:'unreadable.log',uploadError:true},{name:'good.log'}]);
 assert.deepEqual(r.uploaded,['unreadable.log','good.log']);assert.match(r.message,/image.exe/);assert.match(r.message,/unreadable.log/);assert.deepEqual(r.refreshed,['good.log']);
 r=await run([{name:'first.log'},{name:'cancel.log'},{name:'skip.log'}],2);
 assert.deepEqual(r.uploaded,['first.log','cancel.log']);assert.match(r.message,/已取消 · 已导入 1 份文件/);assert.deepEqual(r.refreshed,['first.log']);
 r=await run([{name:'good.log'}]);assert.equal(r.closed,true);
 console.log('Import UI: per-file failure isolation, invalid types, cancellation and successful batches passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
