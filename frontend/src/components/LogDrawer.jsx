import React, { useEffect, useRef, useState } from 'react';
import { apiRequest, copyToClipboard, waitForLog } from '../lib/api';
import { Icon } from '../lib/icons';

export default function LogDrawer({
  open,
  report,
  targetLine,
  onClose,
  onOpenFullReader,
  onNotify,
}) {
  const [meta, setMeta] = useState(null);
  const [startLine, setStartLine] = useState(1);
  const [lines, setLines] = useState([]);
  const [highlight, setHighlight] = useState(1);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef(null);

  const WINDOW_SIZE = 160;

  useEffect(() => {
    if (!open || !report?.id) return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    setError('');
    setMeta(null);
    setLines([]);
    setHighlight(Math.max(1, Number(targetLine) || 1));
    waitForLog(report.id, { signal })
      .then(async (m) => {
        const ln = Math.max(1, Math.min(Number(targetLine) || 1, m.lines || 1));
        const start = Math.max(1, ln - 40);
        const query = new URLSearchParams({ id: report.id, revision: m.revision, start, count: WINDOW_SIZE });
        const chunk = await apiRequest(`/api/log/lines?${query}`, { signal });
        if (signal.aborted) return;
        setMeta(m);
        setHighlight(ln);
        setStartLine(chunk.start);
        setLines(chunk.lines);
      })
      .catch((err) => {
        if (!signal.aborted) setError(err.message || '原日志读取失败');
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, report?.id, targetLine]);

  useEffect(() => {
    if (!open || !lines.length) return;
    const row = listRef.current?.querySelector(`[data-ln="${highlight}"]`);
    if (row) row.scrollIntoView({ block: 'center' });
  }, [open, lines, highlight]);

  async function jumpToLine(ln) {
    if (!meta || !report?.id) return;
    const clamped = Math.max(1, Math.min(ln, meta.lines || 1));
    setHighlight(clamped);
    if (clamped >= startLine && clamped < startLine + lines.length) return;
    setLoading(true);
    try {
      const start = Math.max(1, clamped - 40);
      const chunk = await apiRequest(`/api/log/lines?id=${encodeURIComponent(report.id)}&revision=${encodeURIComponent(meta.revision)}&start=${start}&count=${WINDOW_SIZE}`);
      setStartLine(chunk.start);
      setLines(chunk.lines || []);
    } catch (err) {
      onNotify(err.message || '读取失败');
    } finally {
      setLoading(false);
    }
  }

  async function searchNext() {
    if (!query.trim() || !meta || !report?.id) return;
    try {
      const hit = await apiRequest(`/api/log/match?id=${encodeURIComponent(report.id)}&revision=${encodeURIComponent(meta.revision)}&q=${encodeURIComponent(query.trim())}&selected=${highlight}&direction=next`);
      if (hit?.line) await jumpToLine(hit.line);
      else onNotify('无匹配结果');
    } catch (err) {
      onNotify(err.message || '搜索失败');
    }
  }

  function jumpNextAnomaly() {
    const errLines = (meta?.errors || []).map((e) => e.line).filter(Boolean).sort((a, b) => a - b);
    if (!errLines.length) { onNotify('未见异常行'); return; }
    const next = errLines.find((l) => l > highlight) || errLines[0];
    jumpToLine(next);
  }

  async function copyLine() {
    const idx = highlight - startLine;
    const text = lines[idx];
    if (text === undefined) return;
    const ok = await copyToClipboard(text);
    onNotify(ok ? '已复制原文' : '复制失败');
  }

  if (!open) return null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="log-drawer" role="dialog" aria-label="原始日志">
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span className="trunc" style={{ fontWeight: 500, fontSize: 13 }}>{report?.source || '原始日志'}</span>
            <span className="mono muted" style={{ fontSize: 12, flexShrink: 0 }}>第 {highlight} 行</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button className="btn sm" onClick={() => onOpenFullReader(highlight)}>完整日志</button>
            <button className="icon-btn" aria-label="关闭" title="关闭 (Esc)" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="drawer-tools">
          <input
            className="input"
            style={{ flex: 1 }}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') searchNext(); }}
            placeholder="搜索日志"
            aria-label="搜索日志"
          />
          <button className="btn sm" onClick={searchNext} disabled={!query.trim()}>查找</button>
          <button className="btn sm fault-text" onClick={jumpNextAnomaly}>下一处异常</button>
          <button className="btn sm" onClick={copyLine}>复制当前行</button>
        </div>

        <div className="drawer-lines" ref={listRef}>
          {error ? (
            <div className="empty-state">{error}</div>
          ) : loading && !lines.length ? (
            <div className="empty-state">加载原文…</div>
          ) : (
            <>
              {startLine > 1 && (
                <div style={{ padding: '4px 16px 8px' }}>
                  <button className="link-btn" onClick={() => jumpToLine(Math.max(1, startLine - 80))}>
                    加载上方行
                  </button>
                </div>
              )}
              {lines.map((text, idx) => {
                const ln = startLine + idx;
                const isHl = ln === highlight;
                return (
                  <div
                    key={ln}
                    data-ln={ln}
                    className={`drawer-line ${isHl ? 'is-hl' : ''}`}
                    onClick={() => setHighlight(ln)}
                  >
                    <span className="drawer-ln">{ln}</span>
                    <span className="drawer-text">{text || ' '}</span>
                  </div>
                );
              })}
              {meta && startLine + lines.length <= meta.lines && (
                <div style={{ padding: '8px 16px 4px' }}>
                  <button className="link-btn" onClick={() => jumpToLine(startLine + lines.length + 40)}>
                    加载下方行
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
