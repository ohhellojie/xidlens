'use strict';
const assert=require('node:assert/strict'),settings=require('../app/settings.js');
const info=()=>Object.fromEntries(['xid','manual'].map(kind=>[kind,{version:'1.0.0',origin:'Built in',updatedAt:'2026-10-01',state:{state:'idle'},candidate:null}]));
(async()=>{
 const calls=[];let value=info(),paints=0;
 const api=async(path,options)=>{calls.push([path,options]);if(path.endsWith('/apply'))throw Error('PRIVATE DETAILS');return value;};
 settings.render({api,render:()=>paints++});await settings.refresh();assert.match(settings.render({api,render:()=>paints++}),/Xid 中文资料/);
 await settings.action('xid','check');assert.equal(calls.at(-1)[0],'/api/knowledge/xid/check');
 await settings.action('manual','apply');const html=settings.render({api});assert.match(html,/操作失败/);assert.ok(!html.includes('PRIVATE DETAILS'));
 const count=calls.length;await settings.action('unknown','apply');assert.equal(calls.length,count);assert.ok(paints>0);
 console.log('Settings: shared update actions, refresh and safe failures passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
