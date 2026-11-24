import React, { useMemo, useState } from 'react';
import {
  displayXidActions,
  eventCodeLabel,
  eventDeviceLabel,
  groupEvents,
  sortEventsChronologically,
} from '../lib/analysis';

export default function ErrorsView({
  report,
  knowledge,
  gpuFilter,
  onGpuFilterChange,
  onOpenLine,
  onOpenDevice,
  onOpenXid,
  onOpenManual,
  onOpenTopology,
}) {
  const [mode, setMode] = useState('grouped');
  const [selectedKey, setSelectedKey] = useState('');
  const [lang, setLang] = useState('cn');

  const events = report?.events || [];
  const gpus = report?.gpus || [];
  const filtered = useMemo(
    () => events.filter((e) => gpuFilter === 'all' || String(e.gpu) === String(gpuFilter)),
    [events, gpuFilter]
  );
  const groups = useMemo(() => groupEvents(filtered), [filtered]);
  const chrono = useMemo(() => sortEventsChronologically(filtered), [filtered]);

  if (!report) {
    return <div className="empty-state">请先导入日志</div>;
  }
  if (!events.length) return <div className="empty-state">当前日志未见错误记录</div>;

  const activeGroup = groups.find((g) => g.key === selectedKey) || groups[0] || null;
  const activeEvent = mode === 'grouped'
    ? activeGroup?.first || null
    : (chrono.find((e) => e.id === selectedKey) || chrono[0] || null);

  const xidCatalog = knowledge?.xid?.content;
  const xidCode = activeEvent?.kind === 'xid' ? String(activeEvent.code || '') : '';
  const xidEntry = xidCode && xidCatalog?.[lang]?.codes?.[xidCode]
    ? xidCatalog[lang].codes[xidCode]
    : (xidCode && xidCatalog?.cn?.codes?.[xidCode] ? xidCatalog.cn.codes[xidCode] : null);
  const actions = xidEntry ? displayXidActions(xidEntry, lang) : [];

  const manualTopics = knowledge?.manual?.content?.topics || [];
  const relatedTopic = useMemo(() => {
    if (!activeEvent || !manualTopics.length) return null;
    const byId = (id) => manualTopics.find((t) => t.id === id) || null;
    if (xidCode) {
      if (['48', '63', '64', '92', '94', '95', '140'].includes(xidCode)) return byId('48') || byId('triage-xid');
      if (['8', '11', '13', '25', '31', '32', '43', '68', '69', '80', '137'].includes(xidCode)) return byId('13');
      if (['45', '61', '62', '74', '79', '123'].includes(xidCode)) return byId('triage-xid');
      return (
        manualTopics.find((t) => !['triage', 'reset'].includes(t.id) && (t.related || []).includes(xidCode)) ||
        manualTopics.find((t) => (t.related || []).includes(xidCode)) ||
        byId('xid-catalog')
      );
    }
    if (activeEvent.kind === 'sxid') return byId('xid-intro');
    if (activeEvent.kind === 'aer' || activeEvent.kind === 'fallen') return byId('triage-xid');
    if (activeEvent.kind === 'init' || activeEvent.kind === 'channel' || activeEvent.kind === 'lockup') return byId('triage');
    return null;
  }, [activeEvent, manualTopics, xidCode]);

  const aerPort = activeEvent?.kind === 'aer'
    ? (activeEvent.raw?.match(/pcieport\s+((?:[\da-f]{4}:)?[\da-f]{2}:[\da-f]{2}\.[0-7])/i)?.[1] || '')
    : '';
  const aerSeverity = activeEvent?.kind === 'aer'
    ? (activeEvent.raw?.match(/severity=([^,]+)|(Corrected|Uncorrected)/i)?.[1] || activeEvent.raw?.match(/(Corrected|Uncorrected)/i)?.[1] || '')
    : '';

  const totalCount = filtered.reduce((sum, e) => sum + (Number(e.occurrenceCount) > 0 ? Number(e.occurrenceCount) : 1), 0);

  return (
    <div className="page-pad">
      <div className="split split-responsive">
        <section className="split-main">
          <div className="toolbar">
            <div className="toolbar-group error-tools">
              <div className="segmented" role="group" aria-label="排序方式">
                <button className={mode === 'grouped' ? 'is-active' : ''} onClick={() => setMode('grouped')}>
                  按类型聚合
                </button>
                <button className={mode === 'timeline' ? 'is-active' : ''} onClick={() => setMode('timeline')}>
                  按时间顺序
                </button>
              </div>
              <select
                className="select"
                aria-label="按设备筛选"
                value={gpuFilter}
                onChange={(e) => onGpuFilterChange(e.target.value)}
              >
                <option value="all">全部设备</option>
                {gpus.filter((g) => g.errors > 0).map((g) => (
                  <option key={g.id} value={String(g.id)}>{g.label}</option>
                ))}
              </select>
            </div>
            {gpuFilter !== 'all' && <span className="muted mono" style={{ fontSize: 12 }}>{totalCount} 条记录</span>}
          </div>

          <div className="table-box">
            {!filtered.length ? (
              <div className="empty-state">没有符合筛选的错误记录</div>
            ) : mode === 'grouped' ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 96 }}>类型</th>
                    <th style={{ width: 136 }}>设备</th>
                    <th>描述</th>
                    <th className="num-col" style={{ width: 64 }}>次数</th>
                    <th className="num-col" style={{ width: 112 }}>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const e = g.first;
                    const active = activeGroup?.key === g.key;
                    return (
                      <tr key={g.key} className={active ? 'is-selected' : ''} onClick={() => setSelectedKey(g.key)}>
                        <td className="fault-text">{eventCodeLabel(e)}</td>
                        <td>
                          <div>{eventDeviceLabel(e, gpus)}</div>
                          {e.address && <span className="cell-sub mono">{e.address}</span>}
                        </td>
                        <td>{e.title || '—'}</td>
                        <td className="num-col mono">{g.count}</td>
                        <td className="num-col mono muted">{e.time || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>时间</th>
                    <th style={{ width: 92 }}>类型</th>
                    <th style={{ width: 110 }}>设备</th>
                    <th>描述</th>
                    <th className="num-col" style={{ width: 84 }}>行号</th>
                  </tr>
                </thead>
                <tbody>
                  {chrono.slice(0, 500).map((e) => {
                    const active = activeEvent?.id === e.id;
                    return (
                      <tr key={e.id} className={active ? 'is-selected' : ''} onClick={() => setSelectedKey(e.id)}>
                        <td className="mono muted">{e.time || '—'}</td>
                        <td className="fault-text">{eventCodeLabel(e)}</td>
                        <td>{eventDeviceLabel(e, gpus)}</td>
                        <td>{e.title || '—'}</td>
                        <td className="num-col muted">{e.line > 0 ? `第 ${e.line} 行` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {activeEvent && (
          <aside className="inspector wide" aria-label="错误详情">
              <div className="inspector-head">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <h2 className="fault-text">{eventCodeLabel(activeEvent)}</h2>
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    {eventDeviceLabel(activeEvent, gpus)} · {activeEvent.time || '—'}
                  </span>
                </div>
                <div style={{ marginTop: 4, fontWeight: 500 }}>
                  {xidEntry?.title || activeEvent.title || '—'}
                </div>
                {xidEntry?.symbol && (
                  <div className="mono muted" style={{ fontSize: 11, marginTop: 3, wordBreak: 'break-all' }}>
                    {xidEntry.symbol}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
                  {activeEvent.gpu !== null && activeEvent.gpu !== undefined && (
                    <button className="link-btn muted-link" onClick={() => onOpenDevice(activeEvent.gpu)}>
                      设备详情
                    </button>
                  )}
                  {relatedTopic && (
                    <button className="link-btn" onClick={() => onOpenManual(relatedTopic.id)}>
                      查看排查手册
                    </button>
                  )}
                </div>
              </div>

              <div className="inspector-body">
                <div>
                  <div className="section-title" style={{ marginBottom: 6 }}>
                    <span>原始记录</span>
                    {activeEvent.line > 0 && (
                      <button className="link-btn" onClick={() => onOpenLine(activeEvent.line)}>第 {activeEvent.line} 行</button>
                    )}
                  </div>
                  <pre className="code-box">{activeEvent.raw}</pre>
                </div>

                {xidEntry ? (
                  <>
                    <div className="section-block">
                      <div className="section-title">
                        <span>官方说明</span>
                        <div className="segmented">
                          <button className={lang === 'cn' ? 'is-active' : ''} onClick={() => setLang('cn')}>中文</button>
                          <button className={lang === 'en' ? 'is-active' : ''} onClick={() => setLang('en')}>English</button>
                        </div>
                      </div>
                      <p className="prose">{xidEntry.description || '—'}</p>
                    </div>

                    {actions.length > 0 && (
                      <div className="section-block">
                        {actions.map((a, i) => (
                          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <span className="muted">{a.stage}</span>
                            {a.label && <div style={{ fontWeight: 500 }}>{a.label}</div>}
                            {a.text && <p className="prose muted">{a.text}</p>}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="section-block" style={{ alignItems: 'flex-start' }}>
                      <button className="link-btn" onClick={() => onOpenXid(xidCode)}>在 Xid 目录中查看</button>
                    </div>
                  </>
                ) : activeEvent.kind === 'aer' ? (
                  <div className="section-block">
                    <div className="kv-list">
                      <div className="kv-row"><span>类型</span><span>PCIe AER{aerSeverity ? ` · ${aerSeverity}` : ''}</span></div>
                      {aerPort && <div className="kv-row"><span>上报端口</span><span className="mono">{aerPort}</span></div>}
                      {activeEvent.address && <div className="kv-row"><span>目标设备</span><span className="mono">{activeEvent.address}</span></div>}
                    </div>
                    {activeEvent.address && (
                      <div>
                        <button className="link-btn" onClick={() => onOpenTopology(activeEvent.address)}>
                          在拓扑中定位
                        </button>
                      </div>
                    )}
                  </div>
                ) : (activeEvent.description || activeEvent.actions?.length > 0) ? (
                  <div className="section-block">
                    {activeEvent.description && <p className="prose">{activeEvent.description}</p>}
                  </div>
                ) : null}
              </div>
          </aside>
        )}
      </div>
    </div>
  );
}
