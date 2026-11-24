import React, { useCallback, useEffect, useRef, useState } from 'react';
import { APP_VERSION, apiRequest, postJson, saveTextFile } from './lib/api';
import { buildSummaryText, buildTsv } from './lib/analysis';
import { Icon } from './lib/icons';
import DevicesView from './views/DevicesView';
import ErrorsView from './views/ErrorsView';
import TopologyView from './views/TopologyView';
import CompareView from './views/CompareView';
import KnowledgeView from './views/KnowledgeView';
import FullReaderView from './views/FullReaderView';
import LogDrawer from './components/LogDrawer';
import { CompareSourceModal, ImportModal, ReportsModal, UpdateModal } from './components/Modals';

const NAV_ANALYSIS = [
  { id: 'devices', label: '设备状态', icon: 'devices' },
  { id: 'errors', label: '错误记录', icon: 'errors' },
  { id: 'topology', label: '机器拓扑', icon: 'topology' },
  { id: 'compare', label: '日志对比', icon: 'compare' },
];

const NAV_REF = [
  { id: 'reader', label: '完整日志', icon: 'log' },
  { id: 'xid', label: 'Xid 目录', icon: 'search', title: 'Xid 目录 (Ctrl+K)' },
  { id: 'manual', label: '排查手册', icon: 'book' },
];

const EXPORTS = {
  tsv: { name: 'GPU设备清单.tsv', label: '设备清单', mime: 'text/tab-separated-values;charset=utf-8', content: buildTsv },
  txt: { name: 'GPU日志摘要.txt', label: '排障摘要', mime: 'text/plain;charset=utf-8', content: buildSummaryText },
  json: { name: 'GPU日志证据.json', label: '完整记录', mime: 'application/json;charset=utf-8', content: (report) => JSON.stringify(report, null, 2) },
};

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('xidlens-theme') || 'light');
  const [sidebarPinned, setSidebarPinned] = useState(() => document.getElementById('root')?.dataset.sidebarPinned !== 'false');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [savingSidebar, setSavingSidebar] = useState(false);
  const sidebarRef = useRef(null);
  const sidebarToggleRef = useRef(null);
  const [page, setPage] = useState('devices');
  const [prevPage, setPrevPage] = useState('devices');
  const [cases, setCases] = useState([]);
  const [currentId, setCurrentId] = useState('');
  const [report, setReport] = useState(null);
  const [selectedGpuId, setSelectedGpuId] = useState(0);
  const [errorGpuFilter, setErrorGpuFilter] = useState('all');
  const [selectedTopoAddr, setSelectedTopoAddr] = useState('');
  const [knowledge, setKnowledge] = useState(null);
  const [knowledgeStatus, setKnowledgeStatus] = useState(null);
  const [online, setOnline] = useState(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [xidCode, setXidCode] = useState('79');
  const [manualTopic, setManualTopic] = useState('start');
  const [xidFocusSignal, setXidFocusSignal] = useState(0);

  // Drawer, Reader & Modals
  const [drawer, setDrawer] = useState({ open: false, line: 1 });
  const [readerLine, setReaderLine] = useState(0);
  const [modal, setModal] = useState(null); // 'import' | 'reports' | 'update' | null
  const [compareSource, setCompareSource] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  const notify = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  }, []);

  async function toggleSidebarPin() {
    if (savingSidebar) return;
    const pinned = !sidebarPinned;
    setSavingSidebar(true);
    try {
      await postJson(`/api/sidebar/${pinned ? 'pin' : 'unpin'}`);
      setSidebarPinned(pinned);
      setSidebarOpen(!pinned && Boolean(sidebarRef.current?.matches(':hover, :has(:focus-visible)')));
    } catch (err) {
      notify(err.message || '导航栏设置保存失败');
    } finally {
      setSavingSidebar(false);
    }
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('xidlens-theme', theme);
  }, [theme]);

  const loadCase = useCallback(async (id) => {
    if (!id) { setReport(null); setCurrentId(''); return; }
    try {
      const data = await apiRequest(`/api/case/${id}`);
      setCurrentId(id);
      setReport(data);
      const firstErrGpu = (data.gpus || []).find((g) => g.errors > 0);
      setSelectedGpuId(firstErrGpu ? firstErrGpu.id : (data.gpus?.[0]?.id ?? 0));
      setErrorGpuFilter('all');
      setSelectedTopoAddr('');
    } catch (err) {
      notify(err.message || '报告读取失败');
    }
  }, [notify]);

  const refreshCases = useCallback(async (preferId = '') => {
    try {
      const res = await apiRequest('/api/cases');
      const list = res.cases || [];
      setCases(list);
      const target = preferId && list.some((c) => c.id === preferId)
        ? preferId
        : (list.some((c) => c.id === currentId) ? currentId : (list.at(-1)?.id || ''));
      if (target && target !== currentId) {
        await loadCase(target);
      } else if (!target) {
        setCurrentId('');
        setReport(null);
      } else if (preferId && preferId === currentId) {
        await loadCase(target);
      }
    } catch {}
  }, [currentId, loadCase]);

  const refreshKnowledge = useCallback(async () => {
    try {
      const { packages, status } = await apiRequest('/api/knowledge/content');
      setKnowledge(packages);
      setKnowledgeStatus(status);
    } catch {}
  }, []);

  const refreshKnowledgeStatus = useCallback(async () => {
    try {
      setKnowledgeStatus(await apiRequest('/api/knowledge/status'));
    } catch {}
  }, []);

  const refreshOnline = useCallback(async () => {
    try {
      const snap = await apiRequest('/api/online');
      setOnline(snap);
    } catch {}
  }, []);

  useEffect(() => {
    refreshCases();
    refreshKnowledge();
    refreshOnline();
    const ready = () => window.pywebview?.api?.app_ready?.().catch((err) => notify(err.message || '启动确认失败'));
    if (window.pywebview?.api?.app_ready) ready();
    else window.addEventListener('pywebviewready', ready, { once: true });
    return () => window.removeEventListener('pywebviewready', ready);
  }, []);

  // Poll online/knowledge status when modal is open and working
  useEffect(() => {
    if (modal !== 'update') return;
    refreshOnline();
    refreshKnowledgeStatus();
    const id = setInterval(() => {
      refreshOnline();
      refreshKnowledgeStatus();
    }, 1000);
    return () => clearInterval(id);
  }, [modal, refreshOnline, refreshKnowledgeStatus]);

  useEffect(() => {
    if (knowledgeStatus && ['xid', 'manual'].some((kind) => knowledge?.[kind]?.version !== knowledgeStatus[kind]?.version)) {
      refreshKnowledge();
    }
  }, [knowledge, knowledgeStatus, refreshKnowledge]);

  // Global keyboard shortcuts: Ctrl+K -> Xid catalog, Esc -> close overlays
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (modal || compareSource) return;
        e.preventDefault();
        setPage('xid');
        setXidFocusSignal((n) => n + 1);
      } else if (e.key === 'Escape') {
        setExportOpen(false);
        if (!modal && !compareSource && drawer.open) setDrawer((d) => ({ ...d, open: false }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, drawer.open, compareSource]);

  useEffect(() => setExportOpen(false), [page, currentId, modal]);

  async function handleDeleteCases(ids) {
    const res = await postJson('/api/cases/delete', { ids });
    await refreshCases();
    notify(`已删除 ${res.deleted?.length || 0} 份报告`);
  }

  async function handleReparse(id) {
    const res = await postJson(`/api/reparse/start?id=${encodeURIComponent(id)}`);
    if (res.needsFile) {
      notify('原日志副本已缺失，请重新导入原文件');
      return;
    }
    while (true) {
      await new Promise((r) => setTimeout(r, 250));
      const job = await apiRequest(`/api/job/${res.job}`);
      if (job.state === 'done') {
        await refreshCases(id);
        notify('重新解析完成');
        return;
      }
      if (job.state === 'error' || job.state === 'cancelled') {
        notify(job.message || '重新解析失败');
        return;
      }
    }
  }

  async function handleExport(kind) {
    setExportOpen(false);
    if (!report) return;
    const { name, label, mime, content } = EXPORTS[kind];
    try {
      if (await saveTextFile(name, content(report), mime)) notify(`已导出${label}`);
    } catch (err) {
      notify(err.message || '导出失败');
    }
  }

  async function checkUpdates() {
    setCheckingUpdates(true);
    try {
      const paths = ['/api/online/check-rules', '/api/knowledge/xid/check', '/api/knowledge/manual/check'];
      if (online?.app?.state !== 'ready') paths.push('/api/online/check-app');
      const results = await Promise.allSettled(paths.map((path) => postJson(path)));
      await Promise.all([refreshOnline(), refreshKnowledgeStatus()]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) notify(failed.reason.message || '更新检查未能全部启动');
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function handleOnlineAction(action) {
    try {
      if (action === 'install-app') {
        const install = window.pywebview?.api?.install_update;
        if (!install) throw new Error('请在 Windows 桌面版中安装更新');
        await install();
      } else {
        setOnline(await postJson(`/api/online/${action}`));
      }
    } catch (err) {
      notify(err.message || '操作失败');
    }
  }

  async function handleKnowledgeAction(kind, action) {
    try {
      const status = await postJson(`/api/knowledge/${kind}/${action}`);
      setKnowledgeStatus(status);
    } catch (err) {
      notify(err.message || '资料更新操作失败');
    }
  }

  function openLineInDrawer(line) {
    if (!report) return;
    setDrawer({ open: true, line: Number(line) || 1 });
  }

  function openFullReaderAt(line) {
    setDrawer((d) => ({ ...d, open: false }));
    setPrevPage(page === 'reader' ? prevPage : page);
    setReaderLine(Number(line) || 0);
    setPage('reader');
  }

  function navigateKnowledge(targetPage, code, topicId) {
    if (code) setXidCode(String(code));
    if (topicId) setManualTopic(topicId);
    setPage(targetPage);
  }

  const totalEvents = (report?.events || []).reduce(
    (s, e) => s + (Number(e.occurrenceCount) > 0 ? Number(e.occurrenceCount) : 1),
    0
  );
  const hasAppUpdate = Boolean(online?.app?.notify || online?.app?.state === 'ready');

  const pageLabels = { devices: '设备状态', errors: '错误记录', topology: '机器拓扑', compare: '日志对比' };

  return (
    <div
      className={`shell${sidebarPinned ? '' : ' sidebar-unpinned'}`}
      onPointerDown={(event) => {
        if (sidebarOpen && !sidebarRef.current?.contains(event.target)) setSidebarOpen(false);
      }}
    >
      <aside
        ref={sidebarRef}
        className={`sidebar${sidebarOpen ? ' is-expanded' : ''}`}
        aria-label="主导航"
        onPointerEnter={(event) => {
          if (!sidebarPinned && event.pointerType !== 'touch') setSidebarOpen(true);
        }}
        onPointerLeave={(event) => {
          if (!sidebarPinned && event.pointerType !== 'touch' && !event.currentTarget.querySelector(':focus-visible')) {
            setSidebarOpen(false);
          }
        }}
        onFocus={(event) => {
          if (!sidebarPinned && event.target !== sidebarToggleRef.current && event.target.matches(':focus-visible')) {
            setSidebarOpen(true);
          }
        }}
        onBlur={(event) => {
          if (!sidebarPinned && !event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) {
            setSidebarOpen(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !sidebarPinned && sidebarOpen) {
            event.stopPropagation();
            setSidebarOpen(false);
            sidebarToggleRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        <div className="brand">
          {sidebarPinned ? <img src="/logo.png" alt="XidLens" /> : (
            <button
              className="sidebar-toggle"
              ref={sidebarToggleRef}
              aria-expanded={sidebarOpen}
              aria-controls="sidebar-nav"
              aria-label={sidebarOpen ? '收起导航栏' : '展开导航栏'}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <img src="/logo.png" alt="" />
            </button>
          )}
          <span className="brand-name">XidLens</span>
          <button
            className="icon-btn sidebar-pin"
            title={sidebarPinned ? '取消固定导航栏' : '固定导航栏'}
            aria-label="固定导航栏"
            aria-pressed={sidebarPinned}
            aria-disabled={savingSidebar}
            onClick={toggleSidebarPin}
          >
            <Icon name={sidebarPinned ? 'pin' : 'pinOff'} />
          </button>
        </div>

        <nav className="nav" id="sidebar-nav">
          <div className="nav-group">
            {NAV_ANALYSIS.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? 'is-active' : ''}`}
                title={item.label}
                onClick={() => setPage(item.id)}
              >
                <Icon name={item.icon} />
                <span className="nav-label">{item.label}</span>
                {item.id === 'errors' && totalEvents > 0 && (
                  <span className="nav-count">{totalEvents}</span>
                )}
              </button>
            ))}
          </div>

          <div className="nav-sep" />

          <div className="nav-group">
            {NAV_REF.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? 'is-active' : ''}`}
                title={item.title || item.label}
                onClick={() => {
                  if (item.id === 'reader') {
                    setPrevPage(page === 'reader' ? prevPage : page);
                    setReaderLine(0);
                  }
                  setPage(item.id);
                }}
              >
                <Icon name={item.icon} />
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="sidebar-foot">
          <button className="update-btn" title="软件更新" onClick={() => setModal('update')}>
            <span className="update-icon-wrap">
              <Icon name="refresh" size={14} />
              {hasAppUpdate && <span className="update-dot" />}
            </span>
            <span className="nav-label">软件更新</span>
          </button>
          <div className="version-text">v{APP_VERSION}</div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            {cases.length > 0 && (
              <select
                className="select-report"
                aria-label="切换报告"
                value={currentId}
                onChange={(e) => loadCase(e.target.value)}
              >
                {cases.slice().reverse().map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.source}{c.collected ? ` · ${c.collected}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="topbar-right">
            <button className="btn" onClick={() => setModal('reports')}>
              报告{cases.length ? ` (${cases.length})` : ''}
            </button>
            <button className="btn primary" onClick={() => setModal('import')}>导入日志</button>

            {report && <div className="dropdown-wrap">
              <button
                className="btn"
                onClick={() => setExportOpen((v) => !v)}
              >
                导出
              </button>
              {exportOpen && (
                <div className="dropdown-menu" role="menu">
                  <button onClick={() => handleExport('tsv')}><span>设备清单</span><span className="mono muted">TSV</span></button>
                  <button onClick={() => handleExport('txt')}><span>排障摘要</span><span className="mono muted">TXT</span></button>
                  <button onClick={() => handleExport('json')}><span>完整记录</span><span className="mono muted">JSON</span></button>
                </div>
              )}
            </div>}

            <button
              className="icon-btn"
              aria-label="切换外观"
              title={theme === 'dark' ? '切换浅色外观' : '切换深色外观'}
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
          </div>
        </header>

        <main className="main" onClick={() => { if (exportOpen) setExportOpen(false); }}>
          {page === 'devices' && (
            <DevicesView
              report={report}
              selectedGpuId={selectedGpuId}
              onSelectGpu={setSelectedGpuId}
              onOpenLine={openLineInDrawer}
              onJumpGpuErrors={(id) => { setErrorGpuFilter(String(id)); setPage('errors'); }}
              onNotify={notify}
            />
          )}
          {page === 'errors' && (
            <ErrorsView
              report={report}
              knowledge={knowledge}
              gpuFilter={errorGpuFilter}
              onGpuFilterChange={setErrorGpuFilter}
              onOpenLine={openLineInDrawer}
              onOpenDevice={(id) => { setSelectedGpuId(id); setPage('devices'); }}
              onOpenXid={(code) => navigateKnowledge('xid', code)}
              onOpenManual={(topicId) => navigateKnowledge('manual', undefined, topicId)}
              onOpenTopology={(addr) => { setSelectedTopoAddr(addr); setPage('topology'); }}
            />
          )}
          {page === 'topology' && (
            <TopologyView
              report={report}
              selectedAddress={selectedTopoAddr}
              onSelectAddress={setSelectedTopoAddr}
              onOpenLine={openLineInDrawer}
              onOpenDevice={(id) => { setSelectedGpuId(id); setPage('devices'); }}
            />
          )}
          {page === 'compare' && (
            <CompareView
              cases={cases}
              currentReport={report}
              onOpenCompareSource={setCompareSource}
            />
          )}
          {page === 'reader' && (
            <FullReaderView
              key={report?.id}
              report={report}
              initialLine={readerLine}
              backLabel={pageLabels[prevPage] || ''}
              onBack={() => setPage(prevPage || 'devices')}
            />
          )}
          {(page === 'xid' || page === 'manual') && (
            <KnowledgeView
              mode={page}
              knowledge={knowledge}
              selectedCode={xidCode}
              onSelectCode={setXidCode}
              selectedTopic={manualTopic}
              onSelectTopic={setManualTopic}
              onNavigate={navigateKnowledge}
              onNotify={notify}
              focusSignal={xidFocusSignal}
            />
          )}
        </main>

      </div>

      <LogDrawer
        open={drawer.open}
        report={report}
        targetLine={drawer.line}
        onClose={() => setDrawer((d) => ({ ...d, open: false }))}
        onOpenFullReader={openFullReaderAt}
        onNotify={notify}
      />

      {modal === 'import' && (
        <ImportModal
          onClose={() => setModal(null)}
          onImported={(id) => { refreshCases(id); notify('日志导入完成'); }}
          onInterrupted={refreshCases}
          onNotify={notify}
        />
      )}

      {modal === 'reports' && (
        <ReportsModal
          cases={cases}
          currentId={currentId}
          onSelect={loadCase}
          onDelete={handleDeleteCases}
          onReparse={handleReparse}
          onClose={() => setModal(null)}
        />
      )}

      {modal === 'update' && (
        <UpdateModal
          appVersion={APP_VERSION}
          online={online}
          knowledgeStatus={knowledgeStatus}
          checking={checkingUpdates}
          onCheck={checkUpdates}
          onOnlineAction={handleOnlineAction}
          onKnowledgeAction={handleKnowledgeAction}
          onClose={() => setModal(null)}
        />
      )}

      {compareSource && (
        <CompareSourceModal data={compareSource} onClose={() => setCompareSource(null)} />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
