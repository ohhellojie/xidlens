import assert from 'node:assert/strict';
import fs from 'node:fs';
import { manualMatches } from '../frontend/src/manuals.js';
import {
  buildPathDiagram,
  buildSummaryText,
  buildTsv,
  compareReports,
  comparisonSourceLine,
  displayXidActions,
  describeRelation,
  eventCodeLabel,
  gpuHealthSummary,
  groupEvents,
  sortEventsChronologically,
} from '../frontend/src/lib/analysis.js';

// 1. Event grouping and chronological sorting
{
  const events = [
    { id: 'e2', gpu: 2, address: '0000:5e:00.0', kind: 'xid', code: '79', line: 425, time: '14:15:41', timeInfo: { utc: '2026-10-29T06:15:41Z' }, title: 'GPU 已从总线掉线' },
    { id: 'e1', gpu: 2, address: '0000:5e:00.0', kind: 'aer', code: '', line: 412, time: '14:15:02', timeInfo: { utc: '2026-10-29T06:15:02Z' }, title: 'PCIe AER' },
    { id: 'e3', gpu: 2, address: '0000:5e:00.0', kind: 'xid', code: '79', line: 426, time: '14:15:42', timeInfo: { utc: '2026-10-29T06:15:42Z' }, title: 'GPU 已从总线掉线' },
  ];
  const groups = groupEvents(events);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(eventCodeLabel(groups[0].first), 'Xid 79');

  const ordered = sortEventsChronologically(events);
  assert.deepEqual(ordered.map((e) => e.id), ['e1', 'e2', 'e3']);

  const mixed = [
    { line: 1, timeInfo: { kind: 'calendar', raw: '2026-11-02T08:00:10Z' } },
    { line: 2, timeInfo: { kind: 'uptime_seconds', raw: '8.25', boot: 'boot-a' } },
    { line: 3, timeInfo: { kind: 'calendar', raw: '2026-11-02 16:00:02.000000002+0800' } },
    { line: 4, timeInfo: { kind: 'uptime_seconds', raw: '100', boot: 'boot-b' } },
    { line: 5, timeInfo: { kind: 'calendar', raw: '2026-11-02T08:00:02.000000001Z' } },
    { line: 6, timeInfo: { kind: 'uptime_seconds', raw: '2.5', boot: 'boot-a' } },
    { line: 7, timeInfo: { kind: 'calendar', raw: '2026-11-02T08:00:00' } },
  ];
  assert.deepEqual(sortEventsChronologically(mixed).map((e) => e.line), [5, 6, 3, 4, 1, 2, 7]);
}

// 2. GPU health summary
{
  const gpu = {
    id: 2,
    pci: '0000:5e:00.0',
    link: '8GT/s · x8',
    linkMax: '32GT/s · x16',
    ecc: '4',
    errors: 2,
    healthFields: {
      'ECC Errors/Aggregate/DRAM Uncorrectable': [{ value: '19' }],
      'Remapped Rows/Pending': [{ value: 'Yes' }],
    },
  };
  const summary = gpuHealthSummary(gpu, []);
  assert.equal(summary.abnormal, true);
  assert.equal(summary.linkBad, true);
  assert.equal(summary.volNum, 4);
  assert.equal(summary.aggNum, 19);
  assert.equal(summary.pendingYes, true);
}

// 3. Report comparison by unique SN
{
  const base = {
    source: 'base.log',
    server: { driver: '550.54.15', sn: 'SRV-1' },
    gpus: [{ id: 0, label: 'GPU 0', sn: 'SN-A', uuid: 'U-A', pci: '0000:41:00.0', link: '32GT/s · x16', ecc: '0', errors: 0 }],
  };
  const cur = {
    source: 'cur.log',
    server: { driver: '550.90.07', sn: 'SRV-1' },
    gpus: [{ id: 0, label: 'GPU 0', sn: 'SN-A', uuid: 'U-A', pci: '0000:41:00.0', link: '8GT/s · x8', ecc: '4', errors: 2 }],
  };
  const res = compareReports(base, cur);
  assert.equal(res.serverDiffs.length, 1);
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].matchBy, 'SN');
  assert.equal(res.rows[0].diffs.length, 3);

  const changedGpu = { ...cur.gpus[0], uuid: 'U-B' };
  const conflicting = compareReports(base, { ...cur, gpus: [changedGpu] });
  assert.deepEqual(conflicting.rows.map((r) => r.matchBy), ['身份冲突', '身份冲突']);
  assert.ok(conflicting.rows.every((r) => r.diffs.length === 0));
  assert.equal(compareReports(base, { ...cur, gpus: [{ ...cur.gpus[0], sn: 'SN-B' }] }).rows[0].matchBy, '身份冲突');

  const sourcedGpu = {
    ...changedGpu,
    pciEvidence: { line: 13 },
    healthFields: { 'ECC Errors/Aggregate/DRAM Uncorrectable': [{ value: '12', evidence: { line: 38 } }] },
  };
  assert.equal(comparisonSourceLine(cur, sourcedGpu, 'aggEcc'), 38);
  assert.equal(comparisonSourceLine(cur, sourcedGpu, 'pci'), 13);
  assert.equal(comparisonSourceLine(cur, sourcedGpu, 'link'), undefined);
}

// 4. Topology path diagram and relation descriptions
{
  assert.equal(describeRelation('PIX').short, '同 PCIe 桥');
  assert.equal(describeRelation('NV18').short, '18 条 NVLink');
  const diagram = buildPathDiagram(
    { label: 'GPU0', numa: '0', path: ['0000:18:00.0', '0000:1a:00.0'] },
    { label: 'GPU1', numa: '0', path: ['0000:18:00.0', '0000:1b:00.0'] },
    'PIX'
  );
  assert.match(diagram, /0000:18:00\.0/);
  assert.match(diagram, /GPU 0/);
  assert.match(diagram, /GPU 1/);
}

// 5. TSV and summary export
{
  const report = {
    source: 'demo.log',
    server: { model: 'Demo', sn: 'SRV-1', driver: '550.90.07' },
    gpus: [{ id: 0, index: '0', label: 'GPU 0', model: 'H100', pci: '0000:41:00.0', sn: 'SN-1', uuid: 'U-1', slot: 'S1', link: 'Gen5 x16', ecc: '0', errors: 0 }],
    events: [],
  };
  assert.match(buildTsv(report), /SRV-1\t0\tH100/);
  assert.match(buildSummaryText(report), /未见错误记录/);
}

// Identical guidance keeps both action stages without repeating the body.
{
  const action = { label: 'WORKFLOW_NVLINK5_ERR', text: 'Read the decode table.' };
  assert.deepEqual(displayXidActions({ actions: [action, { ...action, text: 'Read the  decode table.' }] }), [
    { label: action.label, text: action.text, stage: '即时与调查操作' },
  ]);
  assert.deepEqual(displayXidActions({ description: 'Read the decode table.', actions: [
    action, { label: 'CONTACT_SUPPORT', text: 'Attach the original log.' },
  ] }, 'en'), [
    { label: action.label, text: '', stage: 'Immediate action' },
    { label: 'CONTACT_SUPPORT', text: 'Attach the original log.', stage: 'Investigative action' },
  ]);
}

// 6. Manual search covers CN/EN official chapters, Xid numbers, and tools
{
  const xidData = JSON.parse(fs.readFileSync(new URL('../app/knowledge/xid.json', import.meta.url), 'utf8')).content;
  const manual = JSON.parse(fs.readFileSync(new URL('../app/knowledge/manual.json', import.meta.url), 'utf8')).content;
  const findIds = (q) => manual.topics.filter((t, idx) => manualMatches(t, q, xidData, manual.en[idx])).map((t) => t.id);
  assert.ok(findIds('Xid 95').includes('48'));
  assert.ok(findIds('Xid 140').includes('48'));
  assert.ok(findIds('Xid 119').includes('xid-working'));
  assert.ok(findIds('SXid').includes('xid-intro'));
  assert.ok(findIds('Row Remapping').includes('48'));
  assert.ok(findIds('CUDA-GDB').includes('13'));
}

console.log('Frontend analysis tests passed');
