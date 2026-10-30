/* Source-aware collections. Cross-file navigation always carries the report ID. */
((root) => {
  'use strict';
  const eventTools=typeof module!=='undefined'&&module.exports?require('./analysis.js'):root.XidAnalysis;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const states = {ready:'可用', missing:'报告缺失', changed:'报告已变化', duplicate:'重复内容'};
  const checkStates = {error:'发现错误', review:'待核实', missing:'数据缺失', ok:'未见异常', conflict:'字段冲突'};
  const timeStates = {uptime_seconds:'启动后秒数', calendar_without_year_or_zone:'年份和时区未记录', calendar_without_zone:'时区未记录', unknown:'时间未记录', calendar:'日历时间'};
  const tabs = {sources:'来源文件', devices:'设备关联', events:'事件', timeline:'时间线', checks:'检查'};
  const state = {id:'', tab:'sources', page:0, source:'all', selected:'', evidencePage:0};
  let context = {}, bundle = null;
  const PAGE_SIZE = 100;

  function action(name, value, label, extra='') {
    return `<button class="btn" data-session="${name}" data-value="${esc(value)}" ${extra}>${esc(label)}</button>`;
  }
  function location(reportId, line, label='查看原文') {
    if (!reportId || !Number.isInteger(line) || line < 1) return '';
    return `<button class="link-btn session-source-link" data-session="source" data-report="${esc(reportId)}" data-line="${line}">${esc(label)}${context.icon?.('external','small-icon') || ''}</button>`;
  }
  function rowsFor(view, tab) {
    const rows = tab === 'events' ? view.events || [] : tab === 'checks' ? view.checks || [] : [];
    return state.source === 'all' ? rows : rows.filter(row => row.reportId === state.source);
  }
  function list(sessions, unreadable=0) {
    const notice=Number.isSafeInteger(unreadable)&&unreadable>0?`<p class="session-scope" role="status">${unreadable} 份关联记录无法读取，文件已保留。</p>`:'';
    return `<section class="session-page"><header class="session-heading"><div><h1 tabindex="-1">联合分析</h1><p>从报告管理选择同次采集的 2 至 32 份报告。</p></div><button class="btn primary" data-page="reports">选择报告</button></header>${notice}${sessions.length ? `<div class="session-list">${sessions.map(item => `<div class="session-list-row"><div>${action('open',item.id,item.name)}<p>${item.members.length} 份来源 · 人工关联</p></div><span class="source-meta">${esc(item.createdAt)}</span></div>`).join('')}</div>` : '<div class="live-empty"><h2>尚未建立联合分析</h2></div>'}</section>`;
  }
  function warnings(view) {
    const rows = view.warnings || [];
    if (!rows.length) return '';
    const seen = new Set(), unique = rows.filter(row => { const key = row.kind+'|'+row.message; if (seen.has(key)) return false; seen.add(key); return true; });
    return `<details class="session-notices" ${rows.some(row => ['missing','changed','machine-conflict','identity-conflict','limit'].includes(row.kind)) ? 'open' : ''}><summary>${unique.length} 项关联提示</summary><ul>${unique.map(row => `<li>${esc(row.message)}</li>`).join('')}</ul></details>`;
  }
  function sources(view) {
    const machine = member => {
      const entries = Object.entries(member.machine || {}).filter(([,value])=>value);
      if (!entries.length) return '身份未记录';
      const refs = Object.values(member.machineEvidence || {}).flat();
      return `${entries.map(([field,value])=>`<small class="mono">${({sn:'SN',uuid:'UUID',host:'主机名'})[field]} ${esc(value)}</small>`).join('')}${refs.length?`<details><summary>身份来源</summary>${refs.map(row=>`<small>${esc(row.value)}</small>${location(row.evidence.reportId,row.evidence.line,`第 ${row.evidence.line} 行`)}`).join('')}</details>`:''}`;
    };
    return `<div class="session-table-wrap"><table class="session-table" aria-label="来源文件"><thead><tr><th>来源</th><th>机器身份</th><th>采集时间</th><th>记录</th><th>状态</th></tr></thead><tbody>${view.members.map(member => `<tr><td><strong>${esc(member.source)}</strong>${member.sourceMember ? `<small>${esc(member.sourceMember)}</small>` : ''}${member.state !== 'missing' ? location(member.reportId,1,'打开来源报告') : ''}</td><td>${machine(member)}</td><td>${esc(member.time || '时间未记录')}</td><td>${member.gpus == null ? '不可读取' : `${member.gpus} 块 GPU · ${member.events} 条事件`}</td><td>${esc(states[member.state] || member.state)}${member.complete === false ? '<small>读取不完整</small>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function devices(view) {
    const byKey = new Map(view.devices.map(device => [device.key,device]));
    const groups = view.deviceGroups || [];
    if (!groups.length) return '<div class="live-empty"><h2>这些来源未提供 GPU 身份</h2></div>';
    state.page = Math.max(0,Math.min(state.page,Math.max(0,Math.ceil(groups.length/PAGE_SIZE)-1)));
    const rows = groups.slice(state.page * PAGE_SIZE,(state.page + 1) * PAGE_SIZE);
    const selected = rows.find(group => group.key === state.selected) || rows[0];
    state.selected = selected.key;
    const detailDevices = selected.deviceKeys.map(key => byKey.get(key)).filter(Boolean);
    const differences = (view.fieldDifferences || []).filter(diff => diff.groupKey === selected.key);
    const links = (view.links || []).filter(link => link.deviceKeys.every(key => selected.deviceKeys.includes(key)));
    const identities = [...new Set(links.flatMap(link => link.basis.map(basis => `${basis.field === 'uuid' ? 'UUID' : 'SN'} ${basis.value}`)))];
    return `<div class="session-split"><section><div class="session-device-list">${rows.map(group => {const first=byKey.get(group.deviceKeys[0]);return `<button class="session-device ${selected.key===group.key?'is-selected':''}" data-session="select" data-value="${esc(group.key)}" aria-pressed="${selected.key===group.key}"><strong>${esc(first?.label?.startsWith('GPU · ')?'GPU':first?.label||'GPU')} · ${esc(first?.pci)}</strong><span>${group.deviceKeys.length > 1 ? `${group.deviceKeys.length} 处身份匹配` : '仅此来源，未跨文件关联'}</span><small>${esc(first?.source)}</small></button>`;}).join('')}</div>${pager(groups.length)}</section><aside class="session-detail"><h2>${detailDevices.length > 1 ? '设备身份匹配' : '独立设备记录'}</h2>${identities.length ? `<p class="mono">${identities.map(esc).join('<br>')}</p>` : '<p class="source-meta">未发现可用于跨文件匹配的唯一身份。</p>'}<div class="session-evidence-list">${detailDevices.map(device=>`<section><h3>${esc(device.source)}</h3><p class="mono">${esc(device.pci)}</p><p>${esc(device.model || '型号未记录')}</p>${location(device.reportId,1,'打开来源报告')}</section>`).join('')}</div>${differences.length ? `<h3>来源值差异</h3>${differences.map(diff=>`<section class="session-difference"><strong>${esc(({model:'产品名称',serial:'GPU SN',uuid:'GPU UUID',pci:'PCI 地址'})[diff.field]||diff.field)}</strong>${diff.values.map(row=>`<div><span>${esc(row.value)}</span>${location(row.evidence.reportId,row.evidence.line,`${row.evidence.source} · 第 ${row.evidence.line} 行`)}</div>`).join('')}</section>`).join('')}<p class="source-meta">按对应采集时点核对差异。</p>` : ''}</aside></div>`;
  }
  function pager(length) {
    if (length <= PAGE_SIZE) return '';
    return `<nav class="session-pagination" aria-label="联合分析分页"><span>${state.page * PAGE_SIZE + 1}–${Math.min((state.page+1)*PAGE_SIZE,length)} / ${length}</span><div>${action('page',state.page-1,'上一页',state.page===0?'disabled':'')}${action('page',state.page+1,'下一页',(state.page+1)*PAGE_SIZE>=length?'disabled':'')}</div></nav>`;
  }
  function records(view, kind) {
    const rows = rowsFor(view,kind);
    state.page = Math.max(0,Math.min(state.page,Math.max(0,Math.ceil(rows.length/PAGE_SIZE)-1)));
    const shown = rows.slice(state.page*PAGE_SIZE,(state.page+1)*PAGE_SIZE);
    const selected = shown.find(row => row.id===state.selected) || shown[0];
    state.selected = selected?.id || '';
    const selectedName = row => kind==='events' ? eventTools.eventTitle(row) : row.title || row.status;
    const deviceLabel = row => row.kind==='sxid'||row.deviceNamespace==='nvswitch'?'NVSwitch'+(row.structured?.switch==null?'':' '+row.structured.switch)+(row.address?' · '+row.address:''):row.address||row.targetUUID||'报告';
    const filters = `<div class="session-toolbar"><label>来源<select class="select" data-session-change="source" aria-label="筛选联合分析来源"><option value="all">全部来源</option>${view.members.filter(member=>member.state==='ready').map(member=>`<option value="${esc(member.reportId)}" ${state.source===member.reportId?'selected':''}>${esc(member.source)}</option>`).join('')}</select></label><span class="source-meta">${kind==='events'?eventTools.countEvents(rows):rows.length} 条${kind==='events' ? ` · ${view.timeOrder==='calendar'?'按带时区的日历时间排序':'按来源及原文顺序'}` : ''}</span></div>`;
    const main = shown.length ? `<div class="session-record-list">${shown.map(row=>`<button class="session-record ${selected?.id===row.id?'is-selected':''}" data-session="select" data-value="${esc(row.id)}" aria-pressed="${selected?.id===row.id}"><div><strong>${esc(selectedName(row))}</strong>${kind==='checks'?`<span>${esc(checkStates[row.status] || row.status)}</span>`:`<span class="mono">${esc(row.timeInfo?.raw || '时间未记录')}</span>`}</div><span class="mono">${esc(deviceLabel(row))}</span><small>${esc(row.source)}${row.line?` · 第 ${row.line} 行`:''}</small></button>`).join('')}</div>` : '<div class="live-empty"><h2>没有匹配记录</h2></div>';
    let detail = '<p class="source-meta">选择一条记录查看来源。</p>';
    if (selected) {
      detail = `<h2>${esc(selectedName(selected))}</h2><p class="mono">${esc(deviceLabel(selected))}</p>`;
      if (kind === 'events') {
        detail += eventDetails(selected);
        detail += `<p>${esc(timeStates[selected.timeInfo?.kind] || '时间未记录')}${selected.timeInfo?.boot?` · ${esc(selected.timeInfo.boot)}`:''}</p><pre>${esc(selected.raw || '')}</pre>${eventSources(selected)}`;
      } else {
        detail += `${selected.observation?`<h3>观察结果</h3><p>${esc(selected.observation)}</p>`:''}${selected.basis?`<h3>说明</h3><p>${esc(selected.basis)}</p>`:''}${(selected.evidence || []).map(ref=>`<section class="session-check-reference"><pre>${esc(ref.text || '')}</pre>${location(ref.reportId,ref.line,`${ref.source} · 第 ${ref.line} 行`)}</section>`).join('')}`;
      }
    }
    return filters + `<div class="session-split"><section>${main}${pager(rows.length)}</section><aside class="session-detail">${detail}</aside></div>`;
  }
  function eventDetails(row) {
    return eventTools.eventMetadata(row).map(([label,value])=>`<p><strong>${esc(label)}</strong> ${esc(value)}</p>`).join('');
  }
  function eventSources(row) {
    const refs=eventTools.sourceEvidence(row);
    if (!refs.length) return location(row.reportId,row.line,`${row.source} · 第 ${row.line} 行`);
    state.evidencePage=Math.min(state.evidencePage,Math.max(0,Math.ceil(refs.length/PAGE_SIZE)-1));
    const page=state.evidencePage;
    return `<div class="session-evidence-list session-event-sources">${refs.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).map(ref=>`<div>${location(ref.reportId,ref.line,`${ref.source} · 第 ${ref.line}${ref.endLine>ref.line?'–'+ref.endLine:''} 行`)}${ref.jsonPointer?`<small class="mono">${esc(ref.jsonPointer)}</small>`:''}</div>`).join('')}</div>${refs.length>PAGE_SIZE?`<nav class="session-pagination" aria-label="来源记录分页"><span>${page*PAGE_SIZE+1}–${Math.min((page+1)*PAGE_SIZE,refs.length)} / ${refs.length}</span><div>${action('evidencePage',page-1,'上一页',page===0?'disabled':'')}${action('evidencePage',page+1,'下一页',(page+1)*PAGE_SIZE>=refs.length?'disabled':'')}</div></nav>`:''}`;
  }
  function render(result, ctx={}) {
    context=ctx;bundle=result;
    if (ctx.loading) return '<section class="session-page"><h1 tabindex="-1">联合分析</h1><p role="status">正在载入关联文件…</p></section>';
    if (ctx.error) return `<section class="session-page"><h1 tabindex="-1">联合分析</h1><p role="alert">${esc(ctx.error)}</p>${action('list','','返回关联列表')}</section>`;
    if (!result?.manifest || !result?.view) return list(ctx.sessions || [],ctx.unreadable);
    const {manifest,view}=result;
    if (state.id!==manifest.id) Object.assign(state,{id:manifest.id,tab:'sources',page:0,source:'all',selected:'',evidencePage:0});
    return `<section class="session-page"><header class="session-heading"><div><h1 tabindex="-1">${esc(manifest.name)}</h1><p>${view.members.length} 份来源 · ${view.counts.events} 条事件 · 人工关联</p></div><div class="actions">${action('list','','关联列表')}${action('refresh',manifest.id,'更新来源')}${action('delete',manifest.id,'移除关联')}</div></header>${warnings(view)}<nav class="session-tabs" aria-label="联合分析视图">${Object.entries(tabs).map(([key,label])=>`<button class="btn" data-session="tab" data-value="${key}" aria-pressed="${state.tab===key}">${label}</button>`).join('')}</nav>${state.tab==='sources'?sources(view):state.tab==='devices'?devices(view):state.tab==='timeline'?(context.renderTimeline?.(result)||''):records(view,state.tab)}</section>`;
  }
  function rerender() { context.render?.(); }
  function click(target) {
    const actionName=target?.dataset?.session;
    if (!actionName) return false;
    const value=target.dataset.value || '';
    if (actionName==='tab' && tabs[value]) {Object.assign(state,{tab:value,page:0,selected:'',evidencePage:0});rerender();}
    else if (actionName==='select') {state.selected=value;state.evidencePage=0;rerender();}
    else if (actionName==='page') {state.page=Math.max(0,Number(value)||0);state.evidencePage=0;rerender();}
    else if (actionName==='evidencePage') {state.evidencePage=Math.max(0,Number(value)||0);rerender();}
    else if (actionName==='source') {
      const reportId=target.dataset.report, line=Number(target.dataset.line);
      if (/^[a-f0-9]{32}$/.test(reportId || '') && Number.isInteger(line) && line>0) context.onSource?.(reportId,line);
    }
    else if (actionName==='open') context.onOpen?.(value);
    else if (actionName==='list') context.onOpen?.('');
    else if (actionName==='refresh') context.onRefresh?.(value);
    else if (actionName==='delete') context.onDelete?.(value);
    return true;
  }
  function change(target) {
    if (target?.dataset?.sessionChange!=='source') return false;
    state.source=target.value;state.page=0;state.selected='';state.evidencePage=0;rerender();return true;
  }
  function reset() { Object.assign(state,{id:'',tab:'sources',page:0,source:'all',selected:'',evidencePage:0}); }
  const api={render,click,change,reset};
  if (typeof module!=='undefined'&&module.exports) module.exports={...api,esc,rowsFor};
  else root.XidSessions=api;
})(globalThis);
