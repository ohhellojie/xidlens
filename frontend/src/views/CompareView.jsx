import React, { useEffect, useMemo, useState } from 'react';
import { compareReports } from '../lib/analysis';
import { apiRequest } from '../lib/api';

export default function CompareView({
  cases,
  currentReport,
  onOpenCompareSource,
}) {
  const otherCases = useMemo(
    () => (cases || []).filter((c) => c.id !== currentReport?.id),
    [cases, currentReport]
  );
  const [baseId, setBaseId] = useState('');
  const [baseReport, setBaseReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [selectedRowId, setSelectedRowId] = useState('');

  useEffect(() => {
    if (!otherCases.length) {
      setBaseId('');
      setBaseReport(null);
      return;
    }
    if (!baseId || !otherCases.some((c) => c.id === baseId)) {
      setBaseId(otherCases[otherCases.length - 1].id);
    }
  }, [otherCases, baseId]);

  useEffect(() => {
    if (!baseId) { setBaseReport(null); return; }
    let cancelled = false;
    setLoading(true);
    setBaseReport(null);
    setError('');
    apiRequest(`/api/case/${baseId}`)
      .then((data) => { if (!cancelled) setBaseReport(data); })
      .catch((err) => { if (!cancelled) setError(err.message || '基准报告读取失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [baseId]);

  const result = useMemo(
    () => compareReports(baseReport, currentReport),
    [baseReport, currentReport]
  );

  if (!currentReport || otherCases.length === 0) {
    return (
      <div className="empty-state">
        <h2>需要至少两份报告</h2>
        <div style={{ fontSize: 12 }}>导入另一份日志后可对比设备参数与错误变化</div>
      </div>
    );
  }

  const visibleRows = onlyDiff ? result.rows.filter((r) => r.changedCount > 0) : result.rows;
  const sel = visibleRows.find((r) => r.id === selectedRowId) || visibleRows[0] || null;

  return (
    <div className="page-pad">
      <div className="server-strip">
        <div className="toolbar-group" style={{ flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>基准</span>
          <select
            className="select"
            aria-label="选择基准报告"
            value={baseId}
            onChange={(e) => setBaseId(e.target.value)}
            style={{ maxWidth: 260 }}
          >
            {otherCases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.source}{c.collected ? ` · ${c.collected}` : ''}
              </option>
            ))}
          </select>
          <span className="muted">→</span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>{currentReport.source}</span>
          {result.serverDiffs.map((d) => (
            <span key={d.key} style={{ fontSize: 12, marginLeft: 8 }} className="muted">
              {d.label} <span className="mono">{d.before} → <span className="fault-text">{d.after}</span></span>
            </span>
          ))}
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 }}>
          <input
            type="checkbox"
            checked={onlyDiff}
            onChange={(e) => setOnlyDiff(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          仅显示变化项
        </label>
      </div>

      {error ? (
        <div className="empty-state" role="alert">{error}</div>
      ) : loading ? (
        <div className="empty-state">加载基准报告…</div>
      ) : (
        <div className="split">
          <section className="split-main">
            <div className="table-box">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>GPU / 标识</th>
                    <th>匹配</th>
                    <th>变化字段</th>
                    <th className="num-col">变化数</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length ? visibleRows.map((row) => (
                    <tr
                      key={row.id}
                      className={sel?.id === row.id ? 'is-selected' : ''}
                      onClick={() => setSelectedRowId(row.id)}
                    >
                      <td>
                        <div style={{ fontWeight: 500 }}>{row.label}</div>
                        <span className="cell-sub mono">{row.identity}</span>
                      </td>
                      <td className="muted">{row.matchBy}</td>
                      <td className="muted">
                        {row.diffs.length ? row.diffs.map((d) => d.label).join('、') : (row.before && row.after ? '无变化' : row.matchBy)}
                      </td>
                      <td className={`num-col mono ${row.changedCount > 0 ? 'fault-text' : 'muted'}`}>
                        {row.changedCount}
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', padding: 36 }} className="muted">
                        已采集字段无变化
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {sel && (
            <aside className="inspector" aria-label="对比明细">
                <div className="inspector-head">
                  <h2>{sel.label}</h2>
                  <div className="mono muted" style={{ fontSize: 12, marginTop: 3 }}>
                    {sel.identity} · {sel.matchBy}
                  </div>
                </div>
                <div className="inspector-body">
                  {sel.diffs.length > 0 ? (
                    <>
                      <div style={{ fontSize: 12 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr 1fr', gap: 8, paddingBottom: 8, borderBottom: '1px solid var(--line)' }} className="muted">
                          <span>字段</span><span>基准</span><span>当前</span>
                        </div>
                        {sel.diffs.map((d) => (
                          <div key={d.key} style={{ display: 'grid', gridTemplateColumns: '92px 1fr 1fr', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                            <span>{d.label}</span>
                            <span className="mono muted">{d.before}</span>
                            <span className="mono fault-text">{d.after}</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <button
                          className="link-btn"
                          onClick={() => onOpenCompareSource({ baseReport, currentReport, row: sel })}
                        >
                          对比两侧原文
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {sel.before && sel.after ? '已采集字段无变化' : sel.matchBy}
                    </div>
                  )}
                </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
