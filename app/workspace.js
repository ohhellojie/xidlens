/* Navigation and source-aware presentation shared by single and combined reports. */
((root) => {
  'use strict';
  const groups = [
    {id:'overview',label:'分析结果',icon:'check',pages:['overview','checks','structured']},
    {id:'devices',label:'设备',icon:'server',pages:['devices','status','topology']},
    {id:'errors',label:'事件',icon:'errors',pages:['errors','timeline']},
    {id:'reader',label:'原文',icon:'file',pages:['reader']},
    {id:'xid',label:'资料',icon:'book',pages:['xid','manual']},
    {id:'updates',label:'设置',icon:'panel',pages:['updates','resources']},
  ];
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function groupFor(page) { return groups.find(group=>group.pages.includes(page))?.id || ''; }
  function views(page, report, combined=false) {
    if(combined) {
      if(page==='overview')return [['overview','重点发现']];
      if(page==='devices')return [['devices','设备与来源']];
      if(page==='errors')return [['events','聚合'],['timeline','时间顺序']];
      if(page==='reader')return [['sources','来源文件']];
      return [];
    }
    const group=groupFor(page),diag=report?.diagnostics;
    if(group==='overview')return [['overview','重点发现'],...(report?.structured?.format==='dcgm-json'?[['structured','DCGM 结果']]:[]),...(diag?.checks?.length?[['checks','检查矩阵']]:[])];
    if(group==='devices')return [['devices','设备清单'],...(diag?.snapshots?.length?[['status','状态参数']]:[]),...(Object.keys(report?.nodes||{}).length||diag?.matrices?.length||diag?.topology?.length?[['topology','连接关系']]:[])];
    if(group==='errors')return [['errors','错误聚合'],['timeline','时间顺序']];
    if(group==='reader')return [['reader','完整日志']];
    if(group==='xid')return [['xid','Xid 查询'],['manual','排查手册']];
    if(group==='updates')return [['updates','更新'],['resources','解析规则']];
    return [];
  }
  function navigation(page, report, icon, combined=false) {
    const current=combined?page:groupFor(page);
    return groups.filter(g=>report?.source||combined||['overview','xid','updates'].includes(g.id)).map(g=>`<button class="nav-item" data-workspace="${g.id}" aria-label="${g.label}" ${current===g.id?'aria-current="page"':''}>${icon(g.icon)}<span class="nav-text">${g.label}</span></button>`).join('');
  }
  function tabs(page,report,combined=false,active='') {
    const items=views(page,report,combined);
    if(items.length<2)return '';
    return `<nav class="workspace-tabs" aria-label="当前工作区视图">${items.map(([id,label])=>`<button class="btn" ${combined?'data-workspace-view':'data-page'}="${id}" aria-current="${(combined?active:page)===id?'page':'false'}">${label}</button>`).join('')}</nav>`;
  }
  function sessionOverview(bundle, buildModel) {
    const findings=[],gaps=new Set(),view=bundle.view;
    // Build each source independently: a shared PCI address never implies shared identity.
    for(const member of view.members.filter(m=>m.state==='ready')) {
      const report={source:member.source,gpus:view.devices.filter(d=>d.reportId===member.reportId),server:{},nodes:{},events:view.events.filter(e=>e.reportId===member.reportId),complete:member.complete!==false,
        diagnostics:{snapshots:view.snapshots.filter(s=>s.reportId===member.reportId),checks:view.checks.filter(c=>c.reportId===member.reportId)}};
      const model=buildModel(report);
      for(const f of model.findings)findings.push({...f,id:member.reportId+':'+f.id,source:member.source,reportId:member.reportId,device:f.device+' · '+member.source});
      for(const gap of model.gaps)gaps.add(gap);
    }
    const priority={error:0,conflict:1,review:2,missing:3,ok:4};
    findings.sort((a,b)=>priority[a.status]-priority[b.status]||a.device.localeCompare(b.device));
    return {findings,gaps:[...gaps],counts:Object.fromEntries(Object.keys(priority).map(k=>[k,findings.filter(f=>f.status===k).length])),gpuCount:view.deviceGroups?.length||0,source:bundle.manifest.name,complete:view.complete!==false};
  }
  function reportSummary(report) {
    const dcgm=report?.diagnostic;
    if(dcgm)return {devices:dcgm.entities?`${dcgm.entities} 个诊断实体`:'未记录实体',result:`${dcgm.results} 项测试 · ${dcgm.failed} 失败${dcgm.warnings?' · '+dcgm.warnings+' 警告':''}${dcgm.runtimeErrors?' · '+dcgm.runtimeErrors+' 运行错误':''}`,attention:dcgm.failed+dcgm.warnings+(dcgm.runtimeErrors||0),kind:'DCGM'};
    return {devices:`${report.gpus} 块 GPU`,result:`${report.events} 条事件`,attention:report.events,kind:'日志'};
  }
  const api={groups,groupFor,views,navigation,tabs,sessionOverview,reportSummary,esc};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.XidWorkspace=api;
})(globalThis);
