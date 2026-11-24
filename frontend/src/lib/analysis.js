export function shortUuid(uuid) {
  if (!uuid) return '—';
  return uuid.length > 22 ? `${uuid.slice(0, 14)}…${uuid.slice(-4)}` : uuid;
}

export function formatNumber(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString('en-US') : String(n ?? '');
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatTemp(raw) {
  if (!raw) return '—';
  const m = String(raw).trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:C|°C)$/i);
  return m ? `${m[1]} °C` : String(raw).trim();
}

export function formatLink(link) {
  if (!link) return '—';
  return String(link).replace(/\s*·\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isLinkDegraded(gpu, checks = []) {
  if (checks.some((c) => c.address === gpu.pci && (c.rule === 'pcie-link' || c.rule === 'smi-link') && c.status !== 'ok')) {
    return true;
  }
  if (gpu.link && gpu.linkMax && gpu.link !== gpu.linkMax) return true;
  return false;
}

export function gpuHealthSummary(gpu, checks = []) {
  const hf = gpu.healthFields || {};
  const firstVal = (pred) => {
    for (const [k, rows] of Object.entries(hf)) {
      if (pred(k) && rows?.length) return rows[0].value;
    }
    return '';
  };
  const volEcc = gpu.ecc || firstVal((k) => /ECC Errors\/Volatile\/.*Uncorrect/i.test(k));
  const aggEcc = firstVal((k) => /ECC Errors\/Aggregate\/.*Uncorrect/i.test(k));
  const remapPending = firstVal((k) => /Remapped Rows\/.*Pending/i.test(k));
  const remapFailure = firstVal((k) => /Remapped Rows\/.*Failure/i.test(k));

  const volNum = /^\d+$/.test(String(volEcc)) ? Number(volEcc) : 0;
  const aggNum = /^\d+$/.test(String(aggEcc)) ? Number(aggEcc) : 0;
  const pendingYes = String(remapPending).toLowerCase() === 'yes';
  const failureYes = String(remapFailure).toLowerCase() === 'yes';
  const linkBad = isLinkDegraded(gpu, checks);
  const gpuChecks = checks.filter((c) => c.address === gpu.pci);
  const hasErrorCheck = gpuChecks.some((c) => c.status === 'error');
  const hasReviewCheck = gpuChecks.some((c) => c.status === 'review');

  const abnormal = Boolean(
    gpu.errors > 0 ||
    volNum > 0 ||
    pendingYes ||
    failureYes ||
    linkBad ||
    hasErrorCheck ||
    hasReviewCheck ||
    gpu.status === '有冲突'
  );

  return {
    volEcc: volEcc !== '' ? String(volEcc) : '',
    aggEcc: aggEcc !== '' ? String(aggEcc) : '',
    volNum,
    aggNum,
    remapPending: remapPending || '',
    remapFailure: remapFailure || '',
    pendingYes,
    failureYes,
    linkBad,
    abnormal,
    gpuChecks,
  };
}

export function eventCodeLabel(e) {
  if (!e) return '';
  if (e.kind === 'xid') return `Xid ${e.code}`;
  if (e.kind === 'sxid') return `SXid ${e.code}`;
  if (e.kind === 'goe') return e.code ? `GOE ${e.code}` : 'GOE';
  if (e.kind === 'aer') return 'PCIe AER';
  if (e.kind === 'init') return '初始化失败';
  if (e.kind === 'fallen') return '总线掉线';
  if (e.kind === 'channel') return '通道超时';
  if (e.kind === 'lockup') return '软死锁';
  return e.code || e.kind || '事件';
}

export function eventDeviceLabel(e, gpus = []) {
  if (e.deviceNamespace === 'nvswitch') return e.address ? `NVSwitch · ${e.address}` : 'NVSwitch';
  if (e.gpu !== null && e.gpu !== undefined) {
    const found = gpus.find((g) => g.id === e.gpu);
    if (found) return found.label;
  }
  return e.address || '系统';
}

export function displayXidActions(entry, lang = 'cn') {
  const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const groups = new Map();
  for (const [index, action] of (entry.actions || []).entries()) {
    const label = normalize(action.label);
    const text = action.text?.trim() || '';
    if (!label && !text) continue;
    const key = JSON.stringify([label, normalize(text)]);
    const item = groups.get(key) || { label, text, immediate: false, investigative: false };
    if (index === 0) item.immediate = true;
    else item.investigative = true;
    groups.set(key, item);
  }
  const english = lang === 'en';
  const seen = new Set([normalize(entry.description)]);
  return Array.from(groups.values(), ({ label, text, immediate, investigative }) => {
    const normalized = normalize(text);
    const body = !seen.has(normalized) && normalized !== label ? text : '';
    seen.add(normalized);
    const stage = immediate && investigative ? (english ? 'Immediate and investigative actions' : '即时与调查操作')
      : immediate ? (english ? 'Immediate action' : '即时操作') : (english ? 'Investigative action' : '调查操作');
    return { label, text: body, stage };
  });
}

export function groupEvents(events = []) {
  const map = new Map();
  for (const e of events) {
    const key = `${e.deviceNamespace || 'gpu'}|${e.gpu ?? ''}|${e.address || ''}|${e.kind}|${e.code}`;
    const existing = map.get(key);
    const occ = Number(e.occurrenceCount) > 0 ? Number(e.occurrenceCount) : 1;
    if (!existing) {
      map.set(key, { key, first: e, last: e, count: occ, items: [e] });
    } else {
      existing.count += occ;
      existing.last = e;
      existing.items.push(e);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || (a.first.line || 0) - (b.first.line || 0));
}

function eventClock(event) {
  const time = event.timeInfo || {};
  if (/^\d+$/.test(time.epochMicroseconds || '')) {
    return { domain: 'calendar', value: BigInt(time.epochMicroseconds) * 1000n };
  }
  const iso = time.utc || time.raw || event.time || '';
  const date = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/.exec(iso);
  if (date) {
    const [, day, seconds, fraction = '', zone] = date;
    const milliseconds = Date.parse(`${day}T${seconds}${zone}`);
    if (Number.isFinite(milliseconds)) {
      return { domain: 'calendar', value: BigInt(milliseconds) * 1000000n + BigInt(fraction.padEnd(9, '0').slice(0, 9)) };
    }
  }
  const boot = time.boot || event.boot;
  if (time.kind === 'uptime_seconds' && boot && boot !== '-- Reboot --' && /^\d+(?:\.\d+)?$/.test(iso)) {
    const [seconds, fraction = ''] = iso.split('.');
    return { domain: JSON.stringify([event.source || '', boot]), value: BigInt(seconds) * 1000000000n + BigInt(fraction.padEnd(9, '0').slice(0, 9)) };
  }
  return null;
}

export function sortEventsChronologically(events = []) {
  const rows = [...events].sort((a, b) => (a.line || 0) - (b.line || 0));
  const byClock = new Map();
  rows.forEach((event, index) => {
    const clock = eventClock(event);
    if (!clock) return;
    if (!byClock.has(clock.domain)) byClock.set(clock.domain, []);
    byClock.get(clock.domain).push({ event, index, time: clock.value });
  });
  // Keep positions from unrelated clocks and unknown timestamps in source order.
  for (const group of byClock.values()) {
    const positions = group.map(({ index }) => index);
    group.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : a.index - b.index);
    group.forEach(({ event }, index) => { rows[positions[index]] = event; });
  }
  return rows;
}

// ==================== REPORT COMPARISON ====================
const HEALTH_FIELDS = {
  aggEcc: /ECC Errors\/Aggregate\/.*Uncorrect/i,
  remapPending: /Remapped Rows\/.*Pending/i,
  remapFailure: /Remapped Rows\/.*Failure/i,
};

function comparisonHealthField(gpu, key) {
  return Object.entries(gpu.healthFields || {})
    .find(([name, rows]) => HEALTH_FIELDS[key].test(name) && rows?.length)?.[1][0];
}

function singleField(gpu, key) {
  if (!gpu) return '';
  if (key === 'model') return gpu.model || '';
  if (key === 'pci') return gpu.pci || '';
  if (key === 'slot') return gpu.slot || '';
  if (key === 'link') return gpu.link || '';
  if (key === 'linkMax') return gpu.linkMax || '';
  if (key === 'ecc') return gpu.ecc || '';
  if (key === 'numa') return gpu.numa || '';
  if (key === 'errors') return String(gpu.errors ?? 0);
  if (Object.hasOwn(HEALTH_FIELDS, key)) return comparisonHealthField(gpu, key)?.value ?? '';
  return '';
}

export function comparisonSourceLine(report, gpu, key) {
  if (!gpu) return null;
  const line = (item) => item?.evidence?.line;
  const refs = gpu.pciFields || {};
  switch (key) {
    case 'model': return line(gpu.fields?.model?.[0]) ?? line(refs.pci_model?.[0]);
    case 'pci': return gpu.pciEvidence?.line;
    case 'slot': return line(refs.slot?.[0]) ?? line(refs.slotDesignation?.[0]);
    case 'link': return line(refs.link?.[0]);
    case 'ecc': return line(gpu.metrics?.ecc_dram_volatile?.[0]);
    case 'errors': return report.events?.find((event) => event.gpu === gpu.id && event.line > 0)?.line;
    default: return Object.hasOwn(HEALTH_FIELDS, key) ? line(comparisonHealthField(gpu, key)) : null;
  }
}

const COMPARE_FIELDS = [
  ['model', '型号'],
  ['pci', 'PCI 地址'],
  ['slot', '槽位参考'],
  ['link', 'PCIe 链路'],
  ['ecc', '易失未纠 ECC'],
  ['aggEcc', '累计未纠 ECC'],
  ['remapPending', '行重映射待生效'],
  ['remapFailure', '行重映射失败'],
  ['errors', '错误记录数'],
];

function uniqueIdentityMap(gpus = []) {
  const snCounts = new Map();
  const uuidCounts = new Map();
  for (const g of gpus) {
    if (g.sn && g.sn !== '冲突') snCounts.set(g.sn, (snCounts.get(g.sn) || 0) + 1);
    if (g.uuid && g.uuid !== '冲突') {
      const uuid = g.uuid.toLowerCase();
      uuidCounts.set(uuid, (uuidCounts.get(uuid) || 0) + 1);
    }
  }
  return { snCounts, uuidCounts };
}

export function compareReports(baseReport, curReport) {
  if (!baseReport || !curReport) return { rows: [], serverDiffs: [] };
  const baseId = uniqueIdentityMap(baseReport.gpus);
  const curId = uniqueIdentityMap(curReport.gpus);
  const usedBase = new Set();
  const conflictingBase = new Set();
  const rows = [];

  for (const cur of curReport.gpus || []) {
    let matched = null;
    let matchBy = '';
    if (cur.sn && curId.snCounts.get(cur.sn) === 1 && baseId.snCounts.get(cur.sn) === 1) {
      matched = (baseReport.gpus || []).find((b) => b.sn === cur.sn && !usedBase.has(b.id));
      if (matched) matchBy = 'SN';
    }
    const uuid = cur.uuid?.toLowerCase();
    if (!matched && uuid && curId.uuidCounts.get(uuid) === 1 && baseId.uuidCounts.get(uuid) === 1) {
      matched = (baseReport.gpus || []).find((b) => b.uuid?.toLowerCase() === uuid && !usedBase.has(b.id));
      if (matched) matchBy = 'UUID';
    }
    const conflict = cur.sn === '冲突' || cur.uuid === '冲突' || (matched && (
      matched.sn === '冲突' || matched.uuid === '冲突' ||
      (cur.sn && matched.sn && cur.sn !== matched.sn) ||
      (uuid && matched.uuid && uuid !== matched.uuid.toLowerCase())
    ));
    if (conflict && matched) {
      conflictingBase.add(matched.id);
      matched = null;
    }
    if (matched) usedBase.add(matched.id);

    const fields = COMPARE_FIELDS.map(([key, label]) => {
      const a = singleField(matched, key);
      const b = singleField(cur, key);
      const changed = Boolean(matched && (a || b) && a !== b);
      return { key, label, before: a || '—', after: b || '—', changed };
    });
    const diffs = fields.filter((f) => f.changed);
    rows.push({
      id: `cur-${cur.id}`,
      label: cur.label,
      identity: cur.sn || shortUuid(cur.uuid) || cur.pci,
      matchBy: matched ? matchBy : conflict ? '身份冲突' : '仅当前报告',
      before: matched,
      after: cur,
      fields,
      diffs,
      changedCount: matched ? diffs.length : 1,
    });
  }

  for (const base of baseReport.gpus || []) {
    if (usedBase.has(base.id)) continue;
    const fields = COMPARE_FIELDS.map(([key, label]) => ({
      key,
      label,
      before: singleField(base, key) || '—',
      after: '—',
      changed: false,
    }));
    rows.push({
      id: `base-${base.id}`,
      label: base.label,
      identity: base.sn || shortUuid(base.uuid) || base.pci,
      matchBy: conflictingBase.has(base.id) || base.sn === '冲突' || base.uuid === '冲突' ? '身份冲突' : '仅基准报告',
      before: base,
      after: null,
      fields,
      diffs: [],
      changedCount: 1,
    });
  }

  const serverDiffs = [];
  for (const [k, label] of [['driver', '驱动版本'], ['sn', '服务器 SN'], ['model', '机型'], ['os', '系统']]) {
    const a = baseReport.server?.[k] || '';
    const b = curReport.server?.[k] || '';
    if ((a || b) && a !== b) serverDiffs.push({ key: k, label, before: a || '—', after: b || '—' });
  }
  return { rows, serverDiffs };
}

// ==================== TOPOLOGY HELPERS ====================
export const TOPO_RELATION_INFO = {
  X:    { short: '自身',       title: '设备自身' },
  PIX:  { short: '同 PCIe 桥', title: '经过至多一个 PCIe 桥' },
  PXB:  { short: '多级桥',     title: '经过多个 PCIe 桥（未过主桥）' },
  PHB:  { short: '同主桥',     title: '经过同一 PCIe 主桥' },
  NODE: { short: '同 NUMA',    title: '同一 NUMA 内跨 PCIe 主桥' },
  SYS:  { short: '跨 NUMA',    title: '跨 NUMA 节点（CPU 间总线）' },
};

export function describeRelation(code) {
  if (!code) return { short: '未确认', title: '日志信息不足，未确认连接关系' };
  if (TOPO_RELATION_INFO[code]) return TOPO_RELATION_INFO[code];
  if (/^NV\d+$/.test(code)) {
    const n = code.slice(2);
    return { short: `${n} 条 NVLink`, title: `${n} 条聚合 NVLink 直连` };
  }
  return { short: code, title: code };
}

export function formatTopoLabel(label) {
  return String(label || '').replace(/^(GPU|NIC)(\d+)$/, '$1 $2');
}

export function buildPathDiagram(rowA, rowB, rel, nodes = {}) {
  const nameA = formatTopoLabel(rowA?.label);
  const nameB = formatTopoLabel(rowB?.label);
  const addrA = rowA?.path?.at(-1) || rowA?.address || '';
  const addrB = rowB?.path?.at(-1) || rowB?.address || '';
  if (!rowA || !rowB || rel === 'X') return `${nameA}${addrA ? ` (${addrA})` : ''}`;
  if (/^NV\d+$/.test(rel)) {
    return `${nameA} (${addrA || '—'})\n  ↕  ${rel.slice(2)} 条聚合 NVLink\n${nameB} (${addrB || '—'})`;
  }
  const pathA = rowA.path || [];
  const pathB = rowB.path || [];
  const ancA = pathA.slice(0, -1);
  const ancB = pathB.slice(0, -1);
  let lcaIdx = -1;
  for (let i = 0; i < Math.min(ancA.length, ancB.length); i++) {
    if (ancA[i] === ancB[i]) lcaIdx = i;
    else break;
  }
  if (lcaIdx >= 0) {
    const lca = ancA[lcaIdx];
    const tailA = [...ancA.slice(lcaIdx + 1), addrA].filter(Boolean).join(' → ');
    const tailB = [...ancB.slice(lcaIdx + 1), addrB].filter(Boolean).join(' → ');
    const head = rowA.numa ? `NUMA ${rowA.numa} · ` : '';
    return `${head}PCIe 桥 ${lca}\n ├─ ${tailA} (${nameA})\n └─ ${tailB} (${nameB})`;
  }
  if (rel === 'PHB') {
    const rb = rowA.rootBus || 'Host Bridge';
    const head = rowA.numa ? `NUMA ${rowA.numa} · ` : '';
    const branchA = pathA.join(' → ') || addrA;
    const branchB = pathB.join(' → ') || addrB;
    return `${head}主桥 ${rb}\n ├─ ${branchA} (${nameA})\n └─ ${branchB} (${nameB})`;
  }
  if (rel === 'NODE') {
    const branchA = pathA.join(' → ') || addrA;
    const branchB = pathB.join(' → ') || addrB;
    return `NUMA ${rowA.numa || '—'}\n ├─ ${rowA.rootBus ? rowA.rootBus + ' → ' : ''}${branchA} (${nameA})\n └─ ${rowB.rootBus ? rowB.rootBus + ' → ' : ''}${branchB} (${nameB})`;
  }
  if (rel === 'SYS') {
    return `CPU 间跨 NUMA 总线\n ├─ NUMA ${rowA.numa || '—'} · ${addrA || nameA} (${nameA})\n └─ NUMA ${rowB.numa || '—'} · ${addrB || nameB} (${nameB})`;
  }
  const nA = nodes[addrA]?.address || addrA || nameA;
  const nB = nodes[addrB]?.address || addrB || nameB;
  return `${nameA} (${nA})\n${nameB} (${nB})`;
}

// ==================== EXPORTS ====================
const safeCell = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();

export function buildTsv(report) {
  const s = report.server || {};
  const header = ['服务器型号', '服务器 SN', 'GPU 编号', '型号', 'PCI 地址', 'GPU SN', 'GPU UUID', '槽位参考', 'PCIe 链路', '易失未纠 ECC', '错误记录'];
  const rows = (report.gpus || []).map((g) => [
    s.model, s.sn, g.index || g.label, g.model, g.pci, g.sn, g.uuid, g.slot, g.link, g.ecc, g.errors,
  ]);
  return [header, ...rows].map((r) => r.map(safeCell).join('\t')).join('\r\n');
}

export function buildSummaryText(report) {
  const s = report.server || {};
  const lines = [
    report.source && `日志：${report.source}`,
    report.complete === false && '状态：读取不完整',
    s.model && `机型：${s.model}`,
    s.sn && `服务器 SN：${s.sn}`,
    s.driver && `驱动版本：${s.driver}`,
    `GPU 数量：${(report.gpus || []).length}`,
  ].filter(Boolean);
  const groups = groupEvents(report.events || []);
  if (groups.length) {
    lines.push('', '错误记录：');
    for (const g of groups) {
      const dev = eventDeviceLabel(g.first, report.gpus);
      lines.push(`- ${dev}${g.first.address ? ' · ' + g.first.address : ''} · ${eventCodeLabel(g.first)} · ${g.first.title}（${g.count} 次）`);
    }
  } else {
    lines.push('', '错误记录：未见错误记录');
  }
  return lines.join('\n');
}
