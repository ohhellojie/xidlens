import React, { useMemo, useState } from 'react';
import {
  buildTsv,
  formatLink,
  formatTemp,
  gpuHealthSummary,
  shortUuid,
} from '../lib/analysis';
import { copyToClipboard } from '../lib/api';

export default function DevicesView({
  report,
  selectedGpuId,
  onSelectGpu,
  onOpenLine,
  onJumpGpuErrors,
  onNotify,
}) {
  const [onlyAbnormal, setOnlyAbnormal] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('info');

  const gpus = report?.gpus || [];
  const checks = report?.diagnostics?.checks || [];
  const events = report?.events || [];

  const summaries = useMemo(() => {
    const map = new Map();
    for (const g of gpus) map.set(g.id, gpuHealthSummary(g, checks));
    return map;
  }, [gpus, checks]);

  const abnormalCount = useMemo(
    () => gpus.filter((g) => summaries.get(g.id)?.abnormal).length,
    [gpus, summaries]
  );

  const visibleGpus = useMemo(() => {
    const q = search.trim().toLowerCase();
    return gpus.filter((g) => {
      if (onlyAbnormal && !summaries.get(g.id)?.abnormal) return false;
      if (!q) return true;
      return `${g.label} ${g.model} ${g.pci} ${g.sn} ${g.uuid} ${g.slot}`.toLowerCase().includes(q);
    });
  }, [gpus, onlyAbnormal, search, summaries]);

  if (!report) {
    return (
      <div className="empty-state">
        <h2>导入日志后查看设备状态</h2>
      </div>
    );
  }

  const sel = visibleGpus.find((g) => g.id === selectedGpuId) || visibleGpus[0];
  const selHealth = sel ? summaries.get(sel.id) : null;
  const selEvents = sel ? events.filter((e) => e.gpu === sel.id) : [];
  const selLine = sel?.pciEvidence?.line || sel?.fields?.uuid?.[0]?.evidence?.line || sel?.fields?.model?.[0]?.evidence?.line || 0;

  async function copyVal(text, label) {
    if (!text) return;
    const ok = await copyToClipboard(text);
    onNotify(ok ? `已复制${label}` : '复制失败');
  }

  async function copyExcel() {
    const ok = await copyToClipboard(buildTsv(report));
    onNotify(ok ? '已复制 GPU 清单，可直接粘贴到 Excel' : '复制失败');
  }

  const s = report.server || {};

  return (
    <div className="page-pad">
      <div className="server-strip">
        <div className="server-grid">
          <div>
            <div className="field-k">服务器 SN</div>
            <div className="field-v mono">
              {s.sn ? (
                <button className="mono" onClick={() => copyVal(s.sn, '服务器 SN')} title="点击复制">
                  {s.sn}
                </button>
              ) : '—'}
            </div>
          </div>
          <div>
            <div className="field-k">型号</div>
            <div className="field-v" title={s.model || ''}>{s.model || '—'}</div>
          </div>
          <div>
            <div className="field-k">驱动版本</div>
            <div className="field-v mono" title={s.driver || ''}>{s.driver || '—'}</div>
          </div>
          <div>
            <div className="field-k">采集时间</div>
            <div className="field-v mono muted" title={s.time || ''}>{s.time || '—'}</div>
          </div>
        </div>

        {abnormalCount > 0 ? (
          <div className="segmented" role="group" aria-label="设备筛选">
            <button className={!onlyAbnormal ? 'is-active' : ''} onClick={() => setOnlyAbnormal(false)}>
              全部 ({gpus.length})
            </button>
            <button
              className={onlyAbnormal ? 'is-active fault-text' : ''}
              onClick={() => setOnlyAbnormal(true)}
            >
              仅异常 ({abnormalCount})
            </button>
          </div>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>已检项未见异常</span>
        )}
      </div>

      <div className="split split-responsive">
        <section className="split-main">
          <div className="toolbar">
            <div className="toolbar-group">
              <strong style={{ fontSize: 14 }}>GPU 清单</strong>
              {visibleGpus.length < gpus.length && <span className="muted mono" style={{ fontSize: 12 }}>{visibleGpus.length} / {gpus.length}</span>}
            </div>
            <div className="toolbar-group gpu-tools">
              <input
                className="input"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索 SN、UUID、PCI 地址"
                aria-label="搜索 GPU"
              />
              <button className="btn" onClick={copyExcel} disabled={!gpus.length}>复制到 Excel</button>
            </div>
          </div>

          <div className="table-box">
            <table className="data-table">
              <thead>
                <tr>
                  <th>GPU</th>
                  <th>PCI 地址 / 槽位</th>
                  <th>SN / UUID</th>
                  <th>PCIe 链路</th>
                  <th>未纠 ECC</th>
                  <th className="num-col">错误</th>
                </tr>
              </thead>
              <tbody>
                {visibleGpus.length ? visibleGpus.map((g) => {
                  const h = summaries.get(g.id);
                  const active = sel?.id === g.id;
                  return (
                    <tr
                      key={g.id}
                      className={active ? 'is-selected' : ''}
                      onClick={() => onSelectGpu(g.id)}
                    >
                      <td>
                        <div style={{ fontWeight: 500 }}>{g.label}</div>
                        <span className="cell-sub">{g.model || '—'}</span>
                      </td>
                      <td className="mono">
                        <div>{g.pci || '—'}</div>
                        <span className="cell-sub" style={{ fontFamily: 'var(--font)' }}>{g.slot || '—'}</span>
                      </td>
                      <td className="mono">
                        <div>{g.sn || '—'}</div>
                        <span className="cell-sub">{shortUuid(g.uuid)}</span>
                      </td>
                      <td className={`mono ${h.linkBad ? 'fault-text' : 'muted'}`}>
                        {formatLink(g.link)}
                      </td>
                      <td>
                        {h.volNum > 0 || h.aggNum > 0 || h.pendingYes || h.failureYes ? (
                          <div>
                            <div className={`mono ${h.volNum > 0 ? 'fault-text' : 'muted'}`}>
                              {h.volEcc || '0'}{h.aggEcc ? `（累计 ${h.aggEcc}）` : ''}
                            </div>
                            {(h.pendingYes || h.failureYes) && (
                              <span className="cell-sub fault-text">
                                {h.failureYes ? '重映射失败' : '待重映射'}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="mono muted">{h.volEcc !== '' ? h.volEcc : '—'}</span>
                        )}
                      </td>
                      <td className="num-col mono">
                        {g.errors > 0 ? (
                          <button
                            className="fault-pill"
                            onClick={(e) => { e.stopPropagation(); onJumpGpuErrors(g.id); }}
                            title={`查看 ${g.label} 的错误记录`}
                          >
                            {g.errors}
                          </button>
                        ) : (
                          <span className="muted">0</span>
                        )}
                      </td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: 36 }} className="muted">
                      {gpus.length ? (
                        <>
                          未找到匹配的 GPU
                          <button
                            className="link-btn"
                            style={{ marginLeft: 8 }}
                            onClick={() => { setSearch(''); setOnlyAbnormal(false); }}
                          >
                            清除筛选
                          </button>
                        </>
                      ) : '当前日志未解析到 GPU 设备'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {sel && (
          <aside className="inspector" aria-label="设备详情">
              <div className="inspector-head">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <h2>{sel.label}</h2>
                  {selLine > 0 && (
                    <button className="link-btn" onClick={() => onOpenLine(selLine)}>
                      第 {selLine} 行
                    </button>
                  )}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{sel.model || '—'}</div>
                <div className="inspector-tabs">
                  <button className={tab === 'info' ? 'is-active' : ''} onClick={() => setTab('info')}>
                    设备信息
                  </button>
                  <button className={tab === 'checks' ? 'is-active' : ''} onClick={() => setTab('checks')}>
                    <span>状态检查</span>
                    {selHealth?.abnormal && <span className="fault-dot" title="存在异常检查项" />}
                  </button>
                </div>
              </div>

              <div className="inspector-body">
                {tab === 'info' ? (
                  <>
                    <div className="kv-list">
                      {[
                        ['GPU SN', sel.sn, true],
                        ['PCI 地址', sel.pci, true],
                        ['槽位参考', [sel.slot, sel.numa !== '' ? `NUMA ${sel.numa}` : ''].filter(Boolean).join(' · '), false],
                        ['UUID', sel.uuid, true],
                      ].map(([k, v, cp]) => (
                        <div className="kv-row" key={k}>
                          <span>{k}</span>
                          <div className="kv-val mono">
                            <span>{v || '—'}</span>
                            {cp && v && v !== '冲突' && (
                              <button className="link-btn muted-link" onClick={() => copyVal(v, k)}>复制</button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="section-block">
                      <div className="section-title">采集值</div>
                      <div className="kv-list">
                        {[
                          ['温度', formatTemp(sel.temp), false],
                          ['功耗', sel.power || '—', false],
                          ['显存占用', sel.memory || '—', false],
                          ['当前链路', sel.link ? `${formatLink(sel.link)}${selHealth.linkBad && sel.linkMax ? `（上限 ${formatLink(sel.linkMax)}）` : ''}` : '—', selHealth.linkBad],
                        ].map(([k, v, bad]) => (
                          <div className="kv-row" key={k}>
                            <span>{k}</span>
                            <span className={`mono ${bad ? 'fault-text' : ''}`}>{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {selEvents.length > 0 && (
                      <div className="section-block">
                        <div className="section-title">
                          <span>关联错误</span>
                          <button className="link-btn" onClick={() => onJumpGpuErrors(sel.id)}>查看全部</button>
                        </div>
                        {selEvents.slice(0, 6).map((e) => (
                          <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <span className="fault-text trunc">{e.kind === 'xid' ? `Xid ${e.code}` : e.title}</span>
                            {e.line > 0 && (
                              <button className="link-btn" onClick={() => onOpenLine(e.line)}>第 {e.line} 行</button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {[
                      ['PCIe 链路', sel.link ? `${formatLink(sel.link)}${selHealth.linkBad && sel.linkMax ? `（上限 ${formatLink(sel.linkMax)}）` : ''}` : '未采集', selHealth.linkBad, sel.pciFields?.link?.[0]?.evidence?.line],
                      ['易失未纠 ECC', selHealth.volEcc !== '' ? selHealth.volEcc : '未采集', selHealth.volNum > 0, sel.metrics?.ecc_dram_volatile?.[0]?.evidence?.line],
                      ['累计未纠 ECC', selHealth.aggEcc !== '' ? selHealth.aggEcc : '未采集', selHealth.aggNum > 0, 0],
                      ['行重映射待生效', selHealth.remapPending ? (selHealth.pendingYes ? '是' : '否') : '未采集', selHealth.pendingYes, 0],
                      ['行重映射失败', selHealth.remapFailure ? (selHealth.failureYes ? '是' : '否') : '未采集', selHealth.failureYes, 0],
                    ].map(([name, val, bad, ln]) => (
                      <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--line)', gap: 8 }}>
                        <div>
                          <div>{name}</div>
                          <div className={`mono ${bad ? 'fault-text' : 'muted'}`} style={{ marginTop: 2 }}>{val}</div>
                        </div>
                        {ln > 0 && (
                          <button className="link-btn muted-link" onClick={() => onOpenLine(ln)}>第 {ln} 行</button>
                        )}
                      </div>
                    ))}
                    {selHealth.gpuChecks.filter((c) => c.status !== 'ok').map((c) => (
                      <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--line)', gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <div className="fault-text">{c.title}</div>
                          <div className="mono muted trunc" style={{ marginTop: 2 }} title={c.observation}>{c.observation}</div>
                        </div>
                        {c.evidence?.[0]?.line > 0 && (
                          <button className="link-btn muted-link" onClick={() => onOpenLine(c.evidence[0].line)}>
                            第 {c.evidence[0].line} 行
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
          </aside>
        )}
      </div>
    </div>
  );
}
