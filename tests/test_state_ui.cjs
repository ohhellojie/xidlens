'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ui=require('../app/diagnostics.js');
const sample={source:'sample',gpus:[{id:2,label:'GPU 2',pci:'0000:02:00.0',uuid:'GPU-find-me'},{id:7,label:'GPU 7',pci:'0000:07:00.0'}],nodes:{},diagnostics:{topology:[],matrices:[],cpuRows:[],checks:[],snapshots:[
 {id:'full',address:'0000:02:00.0',line:10,fields:[{name:'Name',path:'Name',value:'First GPU',group:'概览'},{name:'Mode',path:'Mode',value:'On',group:'配置与模式'}]},
 {id:'partial',address:'0000:02:00.0',line:20,fields:[{name:'Other',path:'Other',value:'Partial',group:'概览'}]},
 {id:'empty',address:'0000:02:00.0',line:30,fields:[]}
]}};
const ctx={state:{page:'status',gpu:2},heading:()=>'',render(){}};
ui.reset();let html=ui.render(sample,ctx);
assert.match(html,/<option value="full" selected>/,'Default to the most complete block, not an empty or partial trailing command');
assert.match(html,/1 条采集记录无字段/);
ui.change({dataset:{diagChange:'snapshot'},value:'empty'});html=ui.render(sample,ctx);
assert.match(html,/<option value="empty" selected>/);assert.match(html,/该采集记录无状态字段/,'An explicit empty block is never replaced silently');
ui.click({dataset:{diag:'detail'}});html=ui.render(sample,ctx);assert.match(html,/diag-wide/);
ctx.state.page='checks';html=ui.render(sample,ctx);assert.ok(!html.includes('checks-wide'));
ctx.state.page='status';html=ui.render(sample,ctx);assert.match(html,/diag-wide/,'Detail visibility belongs to each page');
ui.click({dataset:{diag:'group',value:'配置与模式'}});
ui.click({dataset:{diag:'gpu',value:'7'}});html=ui.render(sample,ctx);assert.match(html,/当前 GPU 7/);assert.match(html,/缺少 nvidia-smi -q/);
ctx.state.gpu=2;html=ui.render(sample,ctx);assert.match(html,/当前 GPU 7/,'Device-page selection does not overwrite the status selection');
ui.click({dataset:{diag:'status',value:'2'}});html=ui.render(sample,ctx);assert.match(html,/data-value="概览" aria-pressed="true"/);assert.ok(!html.includes('diag-wide'));
ui.click({dataset:{diag:'gpuPicker'}});html=ui.render(sample,ctx);assert.match(html,/role="dialog" aria-label="选择 GPU"/);
ui.leave();html=ui.render(sample,ctx);assert.ok(!html.includes('role="dialog"'));
ctx.state.page='topology';ui.render(sample,ctx);ui.openMatrix();html=ui.render(sample,ctx);assert.match(html,/data-value="matrix" aria-pressed="true"/);
ui.reset();html=ui.render(sample,ctx);assert.match(html,/data-value="tree" aria-pressed="true"/);
// A status filter chooses a matching cell instead of retaining an invisible error.
{
 const report=structuredClone(sample);report.diagnostics.checks=[{id:'read',address:sample.gpus[0].pci,rule:'smi-read',status:'error',title:'Read error'},{id:'link',address:sample.gpus[0].pci,rule:'pcie-link',status:'review',title:'Link review'}];
 ui.reset();ctx.state.page='checks';ui.render(report,ctx);
 ui.change({dataset:{diagChange:'filter'},value:'review'});html=ui.render(report,ctx);
 assert.match(html,/data-value="0000:02:00.0\|link"[^>]*aria-pressed="true"/);
 assert.match(html,/Link review/);
}
// Many GPUs stay out of the page layout until the bounded picker is opened.
for(const count of [1,16,64,240]){
 const report=structuredClone(sample);report.gpus=Array.from({length:count},(_,i)=>({id:i,label:'GPU '+i,pci:'bus-'+i}));
 ui.reset();ctx.state.page='status';ctx.state.gpu=0;html=ui.render(report,ctx);assert.ok(!html.includes('class="gpu-option"'));
 ui.click({dataset:{diag:'gpuPicker'}});html=ui.render(report,ctx);assert.equal((html.match(/class="gpu-option"/g)||[]).length,count);
 ui.click({dataset:{diag:'gpu',value:String(count-1)}});html=ui.render(report,ctx);assert.match(html,new RegExp('当前 GPU '+(count-1)));assert.ok(!html.includes('class="gpu-option"'));
}
const source=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const load=source.slice(source.indexOf('async function loadCase('),source.indexOf('async function refreshCases('));
const remember=source.slice(source.indexOf('function rememberCaseView('),source.indexOf('function openSource('));
function fixture(){
 const nodes=new Map(),el=id=>{if(!nodes.has(id))nodes.set(id,{setAttribute(){},value:'old'});return nodes.get(id)};
 const env={loadRequest:0,loadedCase:'old',loading:false,data:{source:'old'},state:{page:'status',gpu:7,query:'old',filter:'7',code:'79',errorPage:9,errorView:'records',compareBase:'new',compareRow:8,compareChanged:true},
  viewPositions:new Map([['old|status',new Map()]]),renderedView:'old|status',comparisonRequest:0,comparisonData:{},comparisonLoading:true,comparisonError:'old',
  resets:0,apiCalls:0,render(){},closeMenu(){},closeDrawer(){},status(){},toast(){},$:el,structuredClone,caseViews:new Map(),saveViewPosition(){},readerReturn:null,pendingSource:null,
  XidDiagnostics:{reset(){env.resets++},openMatrix(){},capture(){return {group:'temperature'}},restore(value){env.restored=value}},api:async path=>{env.apiCalls++;return {...structuredClone(sample),source:path.endsWith('/old')?'old':'sample'}}};
 vm.createContext(env);vm.runInContext(remember+load,env);return env;
}
(async()=>{
 let env=fixture();assert.equal(await env.loadCase('old'),true);assert.equal(env.apiCalls,0);assert.equal(env.state.query,'old');
 await env.loadCase('new');assert.equal(env.loadedCase,'new');assert.equal(env.state.gpu,2);assert.equal(env.state.errorView,'groups');assert.equal(env.state.query,'');assert.equal(env.state.compareChanged,false);assert.equal(env.state.compareRow,0);assert.equal(env.state.compareBase,'');assert.equal(env.comparisonData,null);assert.equal(env.resets,1);assert.equal(env.viewPositions.size,1,'Keep the previous log position');
 await env.loadCase('new',true);assert.equal(env.apiCalls,2,'Reparse explicitly refreshes an existing report');
 await env.loadCase('old');assert.equal(env.state.gpu,7);assert.equal(env.state.query,'old');assert.equal(env.state.errorPage,9);assert.equal(env.restored.group,'temperature');assert.equal(env.viewPositions.has('old|status'),true);
 await env.loadCase('old',true);assert.equal(env.state.query,'');assert.equal(env.viewPositions.has('old|status'),false,'Reparse resets analysis positions');
 env=fixture();env.api=async()=>{throw Error('missing')};assert.equal(await env.loadCase('bad'),false);assert.equal(env.loadedCase,'old');assert.equal(env.state.query,'old');assert.equal(env.loading,false);
 env=fixture();const pending={};env.api=path=>new Promise(resolve=>pending[path]=resolve);const first=env.loadCase('first'),second=env.loadCase('second');pending['/api/case/second']({...sample,source:'second'});await second;pending['/api/case/first']({...sample,source:'first'});await first;assert.equal(env.loadedCase,'second');assert.equal(env.data.source,'second');
 console.log('Page state: defaults, same-log return, new-log reset, stale loads, GPU picker scale and empty snapshots passed');
})().catch(e=>{console.error(e);process.exitCode=1});
