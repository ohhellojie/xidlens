import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../lib/icons';
import { comparisonSourceLine, formatBytes } from '../lib/analysis';
import { apiRequest, postJson, uploadWithProgress, waitForLog } from '../lib/api';

export function ModalFrame({ title, wide = false, className = '', onClose, closeLabel = '关闭', closeOnBackdrop = true, children }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose(); }}>
      <div className={`modal-box ${wide ? 'wide' : ''} ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="icon-btn" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ImportModal({ onClose, onImported, onInterrupted, onNotify }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [percent, setPercent] = useState(null);
  const [error, setError] = useState('');
  const activeJob = useRef(null);

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || activeJob.current) return;
    const operation = new AbortController();
    const { signal } = operation;
    activeJob.current = operation;
    setBusy(true);
    setError('');
    let lastId = '';
    let jobId = '';
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = files.length > 1 ? `${file.name}（${i + 1}/${files.length}）` : file.name;
        setStatusText(`${name} · 正在读取文件`);
        setPercent(0);
        ({ job: jobId } = await postJson('/api/import/start'));
        signal.throwIfAborted();
        await uploadWithProgress(
          `/api/import?${new URLSearchParams({ name: file.name, job: jobId })}`,
          file,
          (loaded, total) => setPercent(Math.floor(loaded / total * 100)),
          signal,
        );
        setPercent(null);
        setStatusText(`${name} · 正在解析`);
        while (true) {
          await new Promise((r) => setTimeout(r, 250));
          const job = await apiRequest(`/api/job/${jobId}`, { signal });
          if (job.state === 'done') {
            lastId = job.ids?.at(-1) || lastId;
            jobId = '';
            break;
          }
          if (job.state === 'error' || job.state === 'cancelled') {
            jobId = '';
            throw new Error(job.message || (job.state === 'cancelled' ? '已取消' : '解析失败'));
          }
          const stage = job.phase === 'organizing' ? '正在整理报告' : '正在解析';
          setStatusText(`${name} · ${stage}${job.lines > 0 ? `（${job.lines.toLocaleString()} 行）` : ''}`);
        }
      }
      signal.throwIfAborted();
      onImported(lastId);
      onClose();
    } catch (err) {
      if (jobId) {
        try {
          const job = await postJson(`/api/job/${jobId}/cancel`);
          lastId = job.ids?.at(-1) || lastId;
        } catch (cancelError) {
          if (signal.aborted) onNotify(cancelError.message || '取消导入失败');
        }
      }
      if (lastId || signal.aborted) onInterrupted(lastId);
      if (!signal.aborted) setError(err.message || '导入失败');
    } finally {
      if (!signal.aborted) setBusy(false);
      activeJob.current = null;
    }
  }

  function close() {
    activeJob.current?.abort();
    onClose();
  }

  return (
    <ModalFrame title="导入日志" onClose={close} closeLabel={busy ? '取消导入' : '关闭'} closeOnBackdrop={!busy}>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          importFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {busy ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 0' }}>
          <div role="status" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
            <span className="trunc">{statusText}</span>
            {percent !== null && <span className="mono muted">{percent}%</span>}
          </div>
          <progress className="import-progress" aria-label="导入进度" value={percent ?? undefined} max={100} />
        </div>
      ) : (
        <>
          <button
            type="button"
            className={`dropzone ${dragging ? 'is-drag' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); importFiles(e.dataTransfer.files); }}
          >
            <Icon name="upload" size={22} className="muted" />
            <strong style={{ color: 'var(--accent)', fontSize: 13 }}>选择文件或拖放至此</strong>
            <span className="mono muted" style={{ fontSize: 12 }}>
              nvidia-bug-report · dmesg · nvidia-smi · lspci · .gz / .zip / .tar
            </span>
          </button>
          {error && <div className="fault-text" role="alert" style={{ fontSize: 12 }}>{error}</div>}
        </>
      )}
    </ModalFrame>
  );
}

export function ReportsModal({ cases, currentId, onSelect, onDelete, onReparse, onClose }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const filtered = (cases || []).filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const ids = (c.identities || []).map((x) => `${x.sn} ${x.uuid}`).join(' ');
    return `${c.source} ${c.server?.sn || ''} ${c.server?.model || ''} ${ids}`.toLowerCase().includes(q);
  }).slice().reverse();

  function toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function handleDelete() {
    if (!selected.size) return;
    setBusy(true);
    try {
      await onDelete([...selected]);
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  }

  async function handleReparse(id) {
    setBusy(true);
    try {
      await onReparse(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalFrame title="报告管理" wide onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <input
          className="input"
          style={{ width: 280 }}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索文件名、服务器 SN、GPU SN 或 UUID"
        />
        <div className="toolbar-group">
          {selected.size > 0 && (
            <button className="btn danger sm" disabled={busy} onClick={handleDelete}>
              删除所选 ({selected.size})
            </button>
          )}
        </div>
      </div>

      <div className="table-box" style={{ maxHeight: 420 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}></th>
              <th>文件名</th>
              <th>服务器 SN</th>
              <th className="num-col">GPU</th>
              <th className="num-col">错误</th>
              <th className="num-col">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? filtered.map((c) => (
              <tr key={c.id} className={c.id === currentId ? 'is-selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                </td>
                <td>
                  <div style={{ fontWeight: 500 }}>{c.source}</div>
                  <span className="cell-sub mono">
                    {[c.collected, formatBytes(c.bytes)].filter((x) => x && x !== '—').join(' · ')}
                  </span>
                </td>
                <td className="mono muted">{c.server?.sn || '—'}</td>
                <td className="num-col mono">{c.gpus}</td>
                <td className={`num-col mono ${c.events > 0 ? 'fault-text' : 'muted'}`}>{c.events}</td>
                <td className="num-col">
                  <div style={{ display: 'inline-flex', gap: 8 }}>
                    {c.id === currentId ? <span className="muted current-report">当前</span> : (
                      <button className="btn sm" onClick={() => { onSelect(c.id); onClose(); }}>打开</button>
                    )}
                    <button className="btn sm" disabled={busy} onClick={() => handleReparse(c.id)}>
                      重解析
                    </button>
                  </div>
                </td>
              </tr>
            )) : (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 30 }} className="muted">暂无报告</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </ModalFrame>
  );
}

function UpdateRow({ name, version, status, children }) {
  const details = [version, status].filter(Boolean).join(' · ');
  return (
    <div className="update-row">
      <div>
        <div>{name}</div>
        {details && <div className="muted">{details}</div>}
      </div>
      {children}
    </div>
  );
}

export function UpdateModal({ appVersion, online, knowledgeStatus, checking, onCheck, onOnlineAction, onKnowledgeAction, onClose }) {
  const app = online?.app;
  const rules = online?.rules;
  const automatic = online?.settings?.automatic;
  const busy = [app, rules, knowledgeStatus?.xid?.state, knowledgeStatus?.manual?.state]
    .some((item) => item?.state === 'working');
  const appStatus = app?.state === 'available' ? `可更新至 v${app.release.version}` : app?.message;
  const downloading = app?.state === 'working' && app.action === 'download-app';

  return (
    <ModalFrame title="软件与资料更新" onClose={onClose}>
      <div className="update-actions">
        <button className="btn primary" disabled={checking || busy || !online || !knowledgeStatus} onClick={onCheck}>
          {checking ? '正在启动检查…' : '检查更新'}
        </button>
        <label className="update-automatic">
          <input
            type="checkbox"
            checked={automatic === true}
            disabled={automatic === undefined}
            onChange={(event) => onOnlineAction(event.target.checked ? 'enable' : 'disable')}
          />
          自动检查软件更新
        </label>
      </div>
      <div className="update-list">
        <UpdateRow name="XidLens" version={`v${appVersion}`} status={appStatus}>
          {app?.state === 'available' && (
            <button className="btn sm" onClick={() => onOnlineAction('download-app')}>下载更新</button>
          )}
          {downloading && <button className="btn sm" onClick={() => onOnlineAction('cancel')}>取消下载</button>}
          {app?.state === 'ready' && (
            <button className="btn primary sm" onClick={() => onOnlineAction('install-app')}>重启并安装</button>
          )}
        </UpdateRow>
        {app?.state === 'available' && app.release.notes && (
          <pre className="code-box update-notes">{app.release.notes}</pre>
        )}
        <UpdateRow name="NVIDIA Xid 解析规则" status={rules?.message}>
          {rules?.state === 'available' && (
            <button className="btn sm" onClick={() => onOnlineAction('apply-rules')}>应用规则</button>
          )}
        </UpdateRow>
        {[['xid', 'Xid 目录中文资料'], ['manual', 'GPU 排查手册']].map(([kind, name]) => {
          const item = knowledgeStatus?.[kind];
          return (
            <UpdateRow
              key={kind}
              name={name}
              version={item?.version && `v${item.version}`}
              status={item?.state?.message}
            >
              {item?.candidate && item.state.state !== 'working' && (
                <button className="btn sm" onClick={() => onKnowledgeAction(kind, 'apply')}>
                  更新至 v{item.candidate.version}
                </button>
              )}
            </UpdateRow>
          );
        })}
      </div>
    </ModalFrame>
  );
}

export function CompareSourceModal({ data, onClose }) {
  const [fieldKey, setFieldKey] = useState(data.row.diffs[0].key);
  const [snippets, setSnippets] = useState(null);
  const { baseReport, currentReport, row } = data;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function loadSide(report, gpu) {
      if (!report?.id || !gpu) return '该报告无此设备';
      const line = comparisonSourceLine(report, gpu, fieldKey);
      if (!Number.isInteger(line) || line < 1) return '该字段未记录原文行号';
      try {
        const meta = await waitForLog(report.id, { signal });
        if (line > meta.lines) return '该字段行号超出可读范围';
        const start = Math.max(1, line - 3);
        const query = new URLSearchParams({ id: report.id, revision: meta.revision, start, count: 7 });
        const chunk = await apiRequest(`/api/log/lines?${query}`, { signal });
        if (chunk.start + chunk.lines.length <= line) return '该行超出本次可读范围';
        return chunk.lines.map((text, index) => `${chunk.start + index}: ${text}`).join('\n');
      } catch (error) {
        return error.message || '原文读取失败';
      }
    }
    Promise.all([
      loadSide(baseReport, row.before),
      loadSide(currentReport, row.after),
    ]).then(([base, cur]) => {
      if (!signal.aborted) setSnippets({ fieldKey, base, cur });
    });
    return () => controller.abort();
  }, [baseReport, currentReport, row, fieldKey]);

  return (
    <ModalFrame title={`${row.label} 原文对照`} wide onClose={onClose}>
      {row.diffs.length > 1 && (
        <select className="select" aria-label="选择原文对照字段" value={fieldKey} onChange={(event) => setFieldKey(event.target.value)}>
          {row.diffs.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
        </select>
      )}
      {snippets?.fieldKey !== fieldKey ? (
        <div className="empty-state" role="status">读取原文…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>基准 · {baseReport.source}</div>
            <pre className="code-box" style={{ maxHeight: 360 }}>{snippets.base}</pre>
          </div>
          <div>
            <div className="fault-text" style={{ fontSize: 12, marginBottom: 6 }}>当前 · {currentReport.source}</div>
            <pre className="code-box" style={{ maxHeight: 360 }}>{snippets.cur}</pre>
          </div>
        </div>
      )}
    </ModalFrame>
  );
}
