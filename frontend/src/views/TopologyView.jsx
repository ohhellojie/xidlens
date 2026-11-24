import React, { useMemo, useState } from 'react';
import {
  buildPathDiagram,
  describeRelation,
  formatLink,
  formatTopoLabel,
} from '../lib/analysis';

const PCIE_SCALE = ['PIX', 'PXB', 'PHB', 'NODE', 'SYS'];

export default function TopologyView({
  report,
  selectedAddress,
  onSelectAddress,
  onOpenLine,
  onOpenDevice,
}) {
  const diag = report?.diagnostics;
  const smiMatrices = diag?.matrices || [];
  const derivedMatrix = diag?.derivedMatrix || null;
  const hasAnyMatrix = smiMatrices.length > 0 || Boolean(derivedMatrix);

  const [viewMode, setViewMode] = useState(hasAnyMatrix ? 'matrix' : 'tree');
  const [sourceChoice, setSourceChoice] = useState(() => (smiMatrices.length ? 'smi' : 'lspci'));
  const [scope, setScope] = useState('gpu');
  const [cell, setCell] = useState(['', '']);

  const nodes = report?.nodes || {};
  const gpus = report?.gpus || [];
  const edges = diag?.topology || [];

  const activeSource = sourceChoice === 'smi' && smiMatrices.length
    ? 'smi'
    : (derivedMatrix ? 'lspci' : (smiMatrices.length ? 'smi' : 'none'));

  const activeMatrix = activeSource === 'smi' ? smiMatrices[0] : derivedMatrix;

  // Build tree structure from diagnostics.topology
  const treeData = useMemo(() => {
    const parentMap = new Map(edges.map((e) => [e.address, e.parent]));
    const addresses = [...new Set([...edges.map((e) => e.address), ...Object.keys(nodes), ...gpus.map((g) => g.pci)])].filter(Boolean).sort();
    const addrSet = new Set(addresses);
    const children = new Map();
    for (const a of addresses) {
      const p = parentMap.get(a);
      if (p && addrSet.has(p) && p !== a) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(a);
      }
    }
    const roots = addresses.filter((a) => !addrSet.has(parentMap.get(a)) || parentMap.get(a) === a);
    return { addresses, parentMap, children, roots };
  }, [edges, nodes, gpus]);

  if (!report) {
    return <div className="empty-state">请先导入日志</div>;
  }

  const gpuByPci = new Map(gpus.map((g) => [g.pci, g]));
  const nicCount = Object.values(nodes).filter((n) => n.kind === 'nic' && !n.physicalFunction).length;

  // Matrix labels & lookup
  const matrixLabels = activeMatrix?.labels || [];
  const gpuLabels = matrixLabels.filter((l) => l.startsWith('GPU'));
  const nicLabels = matrixLabels.filter((l) => l.startsWith('NIC'));
  const effectiveScope = scope === 'nic' && nicLabels.length ? 'nic' : 'gpu';
  const rowLabels = gpuLabels.length ? gpuLabels : matrixLabels;
  const colLabels = effectiveScope === 'nic' ? nicLabels : rowLabels;
  const rowMap = new Map((activeMatrix?.rows || []).map((row) => [row.label, row]));
  const colIndex = new Map(matrixLabels.map((l, i) => [l, i]));

  let [selA, selB] = cell;
  if (!rowLabels.includes(selA)) selA = rowLabels[0] || '';
  if (!colLabels.includes(selB)) selB = colLabels.find((l) => l !== selA) || colLabels[0] || '';

  const cellVal = (a, b) => {
    const row = rowMap.get(a);
    const idx = colIndex.get(b);
    return row && idx !== undefined ? (row.cells[idx] || '') : '';
  };

  const activeRel = selA && selB ? cellVal(selA, selB) : '';
  const relInfo = describeRelation(activeRel);
  const derivedRowMap = new Map((derivedMatrix?.rows || []).map((row) => [row.label, row]));

  const nicDisplay = (label) => {
    const names = activeMatrix?.nicNames?.[label];
    if (names?.length) return names[0].name;
    return formatTopoLabel(label);
  };

  const presentCodes = useMemo(() => {
    if (!activeMatrix) return [];
    const set = new Set();
    for (const a of rowLabels) {
      for (const b of colLabels) {
        const v = cellVal(a, b);
        if (v && v !== 'X') set.add(v);
      }
    }
    return [...set];
  }, [activeMatrix, rowLabels, colLabels]);

  // Tree selected node
  const treeNodeAddr = selectedAddress && (nodes[selectedAddress] || gpuByPci.get(selectedAddress))
    ? selectedAddress
    : (gpus[0]?.pci || treeData.roots[0] || '');
  const treeNode = nodes[treeNodeAddr];
  const treeGpu = gpuByPci.get(treeNodeAddr);
  const treeEdge = edges.find((e) => e.address === treeNodeAddr);

  function renderTreeBranch(addr, depth = 0, seen = new Set()) {
    if (seen.has(addr)) return null;
    seen.add(addr);
    const n = nodes[addr];
    const g = gpuByPci.get(addr);
    const kids = (treeData.children.get(addr) || []).filter((c) => !seen.has(c));
    const kind = g ? g.label : ({ bridge: 'PCIe 桥', nic: '网卡', nvme: 'NVMe', vf: 'VF' }[n?.kind] || '设备');
    const link = g?.link || n?.fields?.link?.[0]?.value || '';
    const hasErr = (diag?.checks || []).some((c) => c.address === addr && c.status !== 'ok');

    return (
      <li key={addr}>
        <div
          className={`tree-row ${treeNodeAddr === addr ? 'is-selected' : ''}`}
          onClick={() => onSelectAddress(addr)}
        >
          <span className="tree-kind">{kind}</span>
          <span className="mono" style={{ fontWeight: 500 }}>{addr}</span>
          <span className="muted trunc" style={{ flex: 1 }}>{g?.model || n?.description || ''}</span>
          {link && <span className={`mono ${hasErr ? 'fault-text' : 'muted'}`}>{formatLink(link)}</span>}
        </div>
        {kids.length > 0 && (
          <ul>{kids.map((c) => renderTreeBranch(c, depth + 1, seen))}</ul>
        )}
      </li>
    );
  }

  function renderEndpointCard(label) {
    const addr = activeMatrix?.mapping?.[label] || derivedMatrix?.mapping?.[label] || '';
    const gpu = addr ? gpuByPci.get(addr) : null;
    const node = addr ? nodes[addr] : null;
    const dRow = derivedRowMap.get(label);
    const numa = dRow?.numa || gpu?.numa || node?.fields?.numa?.[0]?.value || '';
    const bridge = dRow?.path?.length > 1 ? dRow.path[dRow.path.length - 2] : (gpu?.parent || '');
    const link = gpu?.link || node?.fields?.link?.[0]?.value || '';
    const line = gpu?.pciEvidence?.line || node?.evidence?.line || 0;

    return (
      <div key={label} style={{ paddingBottom: 12, borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 500 }}>{label.startsWith('NIC') ? nicDisplay(label) : formatTopoLabel(label)}</span>
          {line > 0 && <button className="link-btn" onClick={() => onOpenLine(line)}>第 {line} 行</button>}
        </div>
        <div className="mono muted">
          {addr || '—'}{link ? ` · ${formatLink(link)}` : ''}
        </div>
        <div className="muted">
          {[numa !== '' ? `NUMA ${numa}` : '', bridge ? `上游桥 ${bridge}` : ''].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>
    );
  }

  return (
    <div className="page-pad">
      <div className="split">
        <section className="split-main">
          <div className="toolbar">
            <div className="toolbar-group">
              <button
                className="btn"
                style={viewMode === 'tree' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                onClick={() => setViewMode('tree')}
              >
                PCIe 连接树
              </button>
              <button
                className="btn"
                style={viewMode === 'matrix' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                onClick={() => setViewMode('matrix')}
              >
                互联矩阵
              </button>
              {viewMode === 'matrix' && activeMatrix && nicLabels.length > 0 && (
                <div className="segmented">
                  <button className={effectiveScope === 'gpu' ? 'is-active' : ''} onClick={() => setScope('gpu')}>GPU ↔ GPU</button>
                  <button className={effectiveScope === 'nic' ? 'is-active' : ''} onClick={() => setScope('nic')}>GPU ↔ 网卡</button>
                </div>
              )}
            </div>

            {viewMode === 'matrix' && activeMatrix ? (
              <div className="toolbar-group">
                <select
                  className="select"
                  aria-label="拓扑来源"
                  value={activeSource}
                  onChange={(e) => setSourceChoice(e.target.value)}
                >
                  {derivedMatrix && <option value="lspci">lspci · PCIe 拓扑</option>}
                  {smiMatrices.length > 0 && <option value="smi">nvidia-smi topo -m</option>}
                </select>
                <span
                  className="info-badge"
                  title={activeSource === 'lspci' ? '由 lspci 桥结构与 NUMA 节点推导（仅 PCIe 路径，不含 NVLink）' : '来自日志中的 nvidia-smi topo -m 实测输出（含 NVLink）'}
                >
                  i
                </span>
              </div>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>
                {gpus.length} 块 GPU{nicCount ? ` · ${nicCount} 张网卡` : ''}
              </span>
            )}
          </div>

          <div className="topo-panel">
            {viewMode === 'matrix' ? (
              activeMatrix ? (
                <>
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    <table className="matrix-table">
                      <thead>
                        <tr>
                          <th>设备</th>
                          {colLabels.map((c) => (
                            <th key={c} style={c === selB ? { color: 'var(--accent)' } : undefined} title={activeMatrix.mapping?.[c] || c}>
                              {c.startsWith('NIC') ? nicDisplay(c) : formatTopoLabel(c)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rowLabels.map((rLabel) => {
                          const dRow = derivedRowMap.get(rLabel);
                          const numa = dRow?.numa || rowMap.get(rLabel)?.affinityValues?.['NUMA Affinity'] || '';
                          return (
                            <tr key={rLabel}>
                              <td style={rLabel === selA ? { color: 'var(--accent)', fontWeight: 600 } : undefined}>
                                {formatTopoLabel(rLabel)}
                                {numa !== '' && <span className="muted" style={{ marginLeft: 4 }}>N{numa}</span>}
                              </td>
                              {colLabels.map((cLabel) => {
                                const v = cellVal(rLabel, cLabel);
                                const isSelf = v === 'X';
                                const isSel = rLabel === selA && cLabel === selB;
                                const isCross = rLabel === selA || cLabel === selB;
                                const isBest = v === 'PIX' || /^NV\d+$/.test(v);
                                const info = describeRelation(v);
                                return (
                                  <td
                                    key={cLabel}
                                    onClick={() => setCell([rLabel, cLabel])}
                                    title={`${formatTopoLabel(rLabel)} ↔ ${formatTopoLabel(cLabel)} · ${info.title}`}
                                    className={`matrix-cell ${isSel ? 'is-active' : (isCross ? 'is-cross' : '')} ${isSelf || !v ? 'muted' : ''}`}
                                    style={isBest ? { fontWeight: 600 } : undefined}
                                  >
                                    {isSelf || !v ? '—' : v}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="matrix-legend">
                    {presentCodes.map((c) => (
                      <span key={c} title={describeRelation(c).title}>
                        <strong className="mono" style={{ color: 'var(--text)' }}>{c}</strong> {describeRelation(c).short}
                      </span>
                    ))}
                    <span><strong className="mono" style={{ color: 'var(--text)' }}>—</strong> 自身 / 未确认</span>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <h2>未生成互联矩阵</h2>
                  <div style={{ fontSize: 12 }}>日志缺少 lspci 拓扑树、NUMA 或 nvidia-smi topo 输出</div>
                </div>
              )
            ) : treeData.addresses.length ? (
              <ul className="tree-list">
                {treeData.roots.map((root) => renderTreeBranch(root, 0, new Set()))}
              </ul>
            ) : (
              <div className="empty-state">当前日志未包含 PCIe 拓扑信息</div>
            )}
          </div>
        </section>

        {(viewMode === 'matrix' ? Boolean(activeMatrix) : treeData.addresses.length > 0) && (
          <aside className="inspector" aria-label="拓扑详情">
          {viewMode === 'matrix' && activeMatrix && selA && selB ? (
            <>
              <div className="inspector-head">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <h2>
                    {formatTopoLabel(selA)} ↔ {selB.startsWith('NIC') ? nicDisplay(selB) : formatTopoLabel(selB)}
                  </h2>
                  <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                    {activeRel === 'X' || !activeRel ? '—' : activeRel}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{relInfo.title}</div>
              </div>

              <div className="inspector-body">
                {PCIE_SCALE.includes(activeRel) && (
                  <div className="scale-grid">
                    {PCIE_SCALE.map((code) => (
                      <div
                        key={code}
                        title={describeRelation(code).title}
                        className={`scale-item ${code === activeRel ? 'is-active' : ''}`}
                      >
                        {code}
                      </div>
                    ))}
                  </div>
                )}

                <div>
                  <div className="section-title" style={{ marginBottom: 6 }}>路径</div>
                  <pre className="code-box">
                    {buildPathDiagram(
                      derivedRowMap.get(selA) || { label: selA, address: activeMatrix.mapping?.[selA], path: [activeMatrix.mapping?.[selA]].filter(Boolean) },
                      derivedRowMap.get(selB) || { label: selB, address: activeMatrix.mapping?.[selB], path: [activeMatrix.mapping?.[selB]].filter(Boolean) },
                      activeRel,
                      nodes
                    )}
                  </pre>
                </div>

                <div className="section-block">
                  {renderEndpointCard(selA)}
                  {selB !== selA && renderEndpointCard(selB)}
                </div>
              </div>
            </>
          ) : viewMode === 'tree' && (treeNode || treeGpu) ? (
            <>
              <div className="inspector-head">
                <h2>{treeGpu?.label || treeNode?.kind || 'PCIe 设备'}</h2>
                <div className="mono muted" style={{ fontSize: 12, marginTop: 3 }}>{treeNodeAddr}</div>
              </div>
              <div className="inspector-body">
                <div className="kv-list">
                  <div className="kv-row"><span>设备名称</span><span>{treeGpu?.model || treeNode?.description || '—'}</span></div>
                  <div className="kv-row"><span>上游节点</span><span className="mono">{treeEdge?.ambiguous ? '有歧义' : (treeEdge?.parent || '—')}</span></div>
                  <div className="kv-row"><span>NUMA</span><span className="mono">{treeGpu?.numa || treeNode?.fields?.numa?.[0]?.value || '—'}</span></div>
                  <div className="kv-row"><span>当前链路</span><span className="mono">{formatLink(treeGpu?.link || treeNode?.fields?.link?.[0]?.value)}</span></div>
                  <div className="kv-row"><span>驱动绑定</span><span className="mono">{treeNode?.fields?.driver?.[0]?.value || '—'}</span></div>
                </div>
                <div style={{ display: 'flex', gap: 14 }}>
                  {treeGpu && (
                    <button className="link-btn" onClick={() => onOpenDevice(treeGpu.id)}>设备详情</button>
                  )}
                  {(treeNode?.evidence?.line || treeGpu?.pciEvidence?.line) > 0 && (
                    <button className="link-btn" onClick={() => onOpenLine(treeNode?.evidence?.line || treeGpu?.pciEvidence?.line)}>
                      第 {treeNode?.evidence?.line || treeGpu?.pciEvidence?.line} 行
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">选择节点或单元格查看路径</div>
          )}
          </aside>
        )}
      </div>
    </div>
  );
}
