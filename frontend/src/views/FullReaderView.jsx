import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Reader } from '../reader/Reader';
import readerCss from '../reader/reader.css?inline';
import { apiRequest, postJson, waitForLog } from '../lib/api';

function ReaderHost({ children }) {
  const host = useRef(null);
  const [shadow, setShadow] = useState(null);
  useLayoutEffect(() => {
    setShadow(host.current.shadowRoot || host.current.attachShadow({ mode: 'open' }));
  }, []);

  return (
    <div ref={host} style={{ flex: 1, minHeight: 0, height: '100%' }}>
      {shadow && createPortal(<><style>{readerCss}</style><div className="reader-mount">{children}</div></>, shadow)}
    </div>
  );
}

export default function FullReaderView({ report, initialLine, backLabel, onBack }) {
  const reportId = report?.id;
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const saveTimer = useRef(null);

  useEffect(() => {
    if (!reportId) return;
    const controller = new AbortController();
    const { signal } = controller;
    setError('');
    setMeta(null);
    waitForLog(reportId, { signal, retry: reloadTick > 0 })
      .then((data) => { if (!signal.aborted) setMeta(data); })
      .catch((err) => { if (!signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [reportId, reloadTick]);

  const revision = meta?.revision;
  useEffect(() => () => clearTimeout(saveTimer.current), [reportId, revision]);

  const savePosition = useCallback((view, immediate = false) => {
    clearTimeout(saveTimer.current);
    const save = () => {
      const query = new URLSearchParams({ id: reportId, revision });
      const { top, offset, selected, wrap, query: search } = view;
      postJson(`/api/log/position?${query}`, { top, offset, selected, wrap, query: search }).catch(() => {});
    };
    if (immediate) save();
    else saveTimer.current = setTimeout(save, 400);
  }, [reportId, revision]);

  if (!report) return <div className="empty-state">请先导入日志</div>;
  if (error) {
    return (
      <div className="empty-state">
        <h2>{error}</h2>
        <button className="btn" onClick={() => setReloadTick((n) => n + 1)}>重试</button>
      </div>
    );
  }
  if (!meta) return <div className="empty-state" role="status">正在建立原文索引…</div>;

  const initial = initialLine ? {
    ...meta.position, top: Math.max(1, initialLine - 8), selected: initialLine, offset: 0,
  } : (meta.position || {});

  return (
    <ReaderHost>
      <Reader
        key={`${reportId}:${revision}:${initialLine}`}
        meta={meta}
        initial={initial}
        options={{
          caseId: reportId,
          source: report.source || '',
          backLabel,
          onBack,
          onFocus: () => {},
          onReload: () => setReloadTick((n) => n + 1),
          request: apiRequest,
        }}
        onSave={savePosition}
      />
    </ReaderHost>
  );
}
