import React, { useEffect, useMemo, useRef, useState } from 'react';
import ManualContent from '../ManualContent';
import { manualMatches } from '../manuals';
import { ModalFrame } from '../components/Modals';
import { FALLBACK_TOPIC_FIGURES } from '../components/ManualFigures';
import { displayXidActions } from '../lib/analysis';

const OFFICIAL_XID_URL = 'https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html';
const LEGACY_XID_URL = 'https://docs.nvidia.com/deploy/xid-errors/archive/index.html';

export default function KnowledgeView({
  mode, // 'xid' | 'manual'
  knowledge,
  selectedCode,
  onSelectCode,
  selectedTopic,
  onSelectTopic,
  onNavigate,
  onNotify,
  focusSignal,
}) {
  const [xidQuery, setXidQuery] = useState('');
  const [xidFilter, setXidFilter] = useState('active');
  const [lang, setLang] = useState('cn');
  const [decodeOpen, setDecodeOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [manualQuery, setManualQuery] = useState('');
  const searchRef = useRef(null);
  const sessionState = useRef({});

  useEffect(() => {
    if (mode === 'xid' && focusSignal > 0) {
      setTimeout(() => searchRef.current?.focus(), 20);
    }
  }, [mode, focusSignal]);

  const xidPkg = knowledge?.xid;
  const manualPkg = knowledge?.manual;
  const xidData = xidPkg?.content;
  const cnTopics = manualPkg?.content?.topics || [];
  const enTopics = manualPkg?.content?.en || [];
  const activeTopics = lang === 'en' && enTopics.length ? enTopics : cnTopics;
  const peerTopics = lang === 'en' && enTopics.length ? cnTopics : enTopics;
  const sources = manualPkg?.content?.sources || {};
  const codes = useMemo(() => Object.keys(xidData?.cn?.codes || {}), [xidData]);
  const unused = useMemo(() => new Set(xidData?.unused || []), [xidData]);

  const xidMatches = useMemo(() => {
    if (!xidData) return [];
    const q = xidQuery.trim().toLowerCase().replace(/^xid\s*/, '');
    return codes.filter((k) => {
      if (!q) {
        if (xidFilter === 'active' && unused.has(k)) return false;
        if (xidFilter === 'unused' && !unused.has(k)) return false;
        return true;
      }
      if (/^\d+$/.test(q)) return k === String(Number(q));
      return JSON.stringify([xidData.cn.codes[k], xidData.en?.codes?.[k]]).toLowerCase().includes(q);
    });
  }, [xidData, codes, unused, xidQuery, xidFilter]);

  const manualMatchesList = useMemo(() => {
    if (!xidData) return activeTopics;
    return activeTopics.filter((t, idx) => !manualQuery.trim() || manualMatches(t, manualQuery, xidData, peerTopics[idx]));
  }, [activeTopics, peerTopics, manualQuery, xidData]);

  if (!xidData || !manualPkg) {
    return <div className="empty-state">加载资料中…</div>;
  }

  if (mode === 'xid') {
    const activeCode = xidMatches.includes(selectedCode) ? selectedCode : (xidMatches[0] || '');
    const item = activeCode ? (xidData[lang]?.codes?.[activeCode] || xidData.cn.codes[activeCode]) : null;
    const actions = item ? displayXidActions(item, lang) : [];
    const relatedTopics = activeCode ? cnTopics.filter((t) => (t.related || []).includes(activeCode) && t.id !== 'reset') : [];
    const decodeRows = activeCode && Number(activeCode) >= 144 && Number(activeCode) <= 150
      ? (xidData.extra?.['Xid 144-150 Decode'] || []).slice(1).filter((r) => String(r[0]) === activeCode)
      : [];
    const guideRows = (xidData.extra?.['Customer User Guide'] || []).slice(1);

    return (
      <div className="doc-shell">
        <section className="doc-index" aria-label="Xid 列表">
          <div className="doc-index-head">
            <input
              ref={searchRef}
              className="input"
              type="search"
              value={xidQuery}
              onChange={(e) => setXidQuery(e.target.value)}
              placeholder="搜索 Xid 编号、符号或说明"
              aria-label="搜索 Xid"
            />
            <div className="segmented" style={{ width: '100%', justifyContent: 'space-between' }}>
              {[['active', '已定义'], ['all', '全部'], ['unused', '未使用']].map(([k, label]) => (
                <button
                  key={k}
                  style={{ flex: 1 }}
                  className={xidFilter === k ? 'is-active' : ''}
                  onClick={() => { setXidFilter(k); setXidQuery(''); }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="doc-index-list">
            {xidMatches.map((k) => (
              <button
                key={k}
                className={`doc-row ${activeCode === k ? 'is-active' : ''}`}
                onClick={() => onSelectCode(k)}
              >
                <span className="mono" style={{ fontWeight: 600 }}>Xid {k}</span>
                <span className="muted trunc">{xidData.cn.codes[k]?.title || '—'}</span>
              </button>
            ))}
          </div>

          {xidMatches.length > 0 && <div className="doc-index-foot">{xidMatches.length} 条</div>}
        </section>

        <article className="doc-reader" aria-label="Xid 详情">
          {item ? (
            <div className="doc-article">
              <div style={{ paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
                <div className="xid-title-row">
                  <h1>Xid {activeCode} · {item.title}</h1>
                  <div className="segmented" role="group" aria-label="Xid 目录语言">
                    <button className={lang === 'cn' ? 'is-active' : ''} aria-pressed={lang === 'cn'} onClick={() => setLang('cn')}>中文</button>
                    <button className={lang === 'en' ? 'is-active' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>English</button>
                  </div>
                </div>
                {item.symbol && <div className="mono muted" style={{ fontSize: 12, marginTop: 4 }}>{item.symbol}</div>}
              </div>

              {unused.has(activeCode) && (
                <div className="note">
                  当前目录标记为未使用。<a href={LEGACY_XID_URL} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>旧版目录</a>
                </div>
              )}

              {item.description && (
                <section>
                  <h2 className="muted" style={{ fontWeight: 500, marginBottom: 6 }}>说明</h2>
                  <p className="prose">{item.description}</p>
                </section>
              )}

              {actions.length > 0 && (
                <section style={{ paddingTop: 16, borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <h2 className="muted" style={{ fontWeight: 500 }}>处理建议</h2>
                  {actions.map((a, i) => (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="muted" style={{ fontSize: 12 }}>{a.stage}</span>
                      {a.label && <strong>{a.label}</strong>}
                      {a.text && <p className="prose muted">{a.text}</p>}
                    </div>
                  ))}
                </section>
              )}

              {decodeRows.length > 0 && (
                <section style={{ paddingTop: 16, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <strong>NVLink 子代码与寄存器</strong>
                    <div className="muted" style={{ fontSize: 12 }}>IntrInfo / ErrorStatus</div>
                  </div>
                  <button className="btn" onClick={() => setDecodeOpen(true)}>查看解码表</button>
                </section>
              )}

              <section style={{ paddingTop: 16, borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h2 className="muted" style={{ fontWeight: 500 }}>适用架构</h2>
                <div className="arch-grid">
                  {Object.entries(item.architectures || {}).map(([arch, val]) => (
                    <div className="arch-cell" key={arch}>
                      <span className="muted">{arch}</span>
                      <span>{val}</span>
                    </div>
                  ))}
                </div>
                {item.association154 && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    关联 Xid 154：<span className="mono" style={{ color: 'var(--text)' }}>{item.association154}</span>
                    <button className="link-btn" style={{ marginLeft: 10 }} onClick={() => onSelectCode('154')}>查看 Xid 154</button>
                  </div>
                )}
                {relatedTopics.length > 0 && (
                  <div className="chip-row" style={{ alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 12 }}>相关排查：</span>
                    {relatedTopics.map((t) => (
                      <button key={t.id} className="chip-btn" onClick={() => onNavigate('manual', undefined, t.id)}>
                        {t.title}
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, gap: 12 }} className="muted">
                  <span>NVIDIA Xid Catalog · v{xidPkg.version}</span>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
                    {guideRows.length > 0 && (
                      <button className="link-btn" onClick={() => setGuideOpen(true)}>字段说明</button>
                    )}
                    <a href={xidPkg.sources?.[0]?.url || OFFICIAL_XID_URL} target="_blank" rel="noreferrer">官方来源</a>
                  </div>
                </div>
              </section>
            </div>
          ) : (
            <div className="empty-state" role="status">
              <h2>未找到匹配条目</h2>
              <a href={OFFICIAL_XID_URL} target="_blank" rel="noreferrer">查看官方 Xid 目录</a>
            </div>
          )}
        </article>

        {decodeOpen && decodeRows.length > 0 && (
          <ModalFrame title={`Xid ${activeCode} · 解码表`} wide onClose={() => setDecodeOpen(false)}>
            {decodeRows.map((row, idx) => (
              <details key={idx} className="manual-extract">
                <summary className="mono">{row[1]} · {row[4]} · {row[10]}</summary>
                <div className="kv-list" style={{ marginTop: 10 }}>
                  {['Xid', '子代码', 'IntrInfo (R575 前)', 'IntrInfo (R575 起)', 'ErrorStatus', '恢复操作', '操作 2 (R575 前)', '操作 2 (R575 起)', '操作 2', '调查操作', '严重程度', '硬件／软件', '本地／远端'].map((label, j) => (
                    j > 1 && row[j] ? (
                      <div className="kv-row" key={j}><span>{label}</span><span className="mono">{row[j]}</span></div>
                    ) : null
                  ))}
                </div>
              </details>
            ))}
          </ModalFrame>
        )}

        {guideOpen && guideRows.length > 0 && (
          <ModalFrame title="目录字段说明" wide onClose={() => setGuideOpen(false)}>
            <table className="manual-table">
              <thead>
                <tr>
                  <th style={{ width: 136 }}>工作表</th>
                  <th style={{ width: 168 }}>列名称</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {guideRows.map(([sheet, col, desc], idx) => (
                  <tr key={idx}>
                    <td className="muted" style={{ verticalAlign: 'top', fontWeight: sheet ? 600 : 400 }}>{sheet || ''}</td>
                    <th scope="row" style={{ verticalAlign: 'top' }}>{col}</th>
                    <td className="prose" style={{ verticalAlign: 'top' }}>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ModalFrame>
        )}
      </div>
    );
  }

  // Manual view
  const groups = [...new Set(activeTopics.map((t) => t.group))];
  const currentTopic = manualMatchesList.find((t) => t.id === selectedTopic) || manualMatchesList[0];

  return (
    <div className="doc-shell">
      <section className="doc-index" aria-label="排查手册目录">
        <div className="doc-index-head">
          <input
            className="input"
            type="search"
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
            placeholder="搜索现象、Xid 或工具"
            aria-label="搜索排查手册"
          />
        </div>
        <div className="doc-index-list">
          {groups.map((grp) => {
            const grpItems = manualMatchesList.filter((t) => t.group === grp);
            if (!grpItems.length) return null;
            return (
              <div key={grp}>
                <div className="doc-group-title">{grp}</div>
                {grpItems.map((t) => (
                  <button
                    key={t.id}
                    className={`doc-row ${currentTopic?.id === t.id ? 'is-active' : ''}`}
                    onClick={() => onSelectTopic(t.id)}
                  >
                    <span style={{ fontWeight: 500 }}>{t.title}</span>
                    <span className="muted trunc">{t.sub}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </section>

      <article className="doc-reader" aria-label="排查手册正文">
        {currentTopic ? (
          <div className={`doc-article ${(currentTopic.figures?.length || FALLBACK_TOPIC_FIGURES[currentTopic.id]?.length) ? 'has-figures' : ''}`}>
            <div style={{ paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <h1>{currentTopic.title}</h1>
                {enTopics.length > 0 && (
                  <div className="segmented">
                    <button className={lang === 'cn' ? 'is-active' : ''} onClick={() => setLang('cn')}>中文</button>
                    <button className={lang === 'en' ? 'is-active' : ''} onClick={() => setLang('en')}>English</button>
                  </div>
                )}
              </div>
            </div>
            <ManualContent
              key={currentTopic.id + manualPkg.version + lang}
              current={currentTopic}
              lang={lang}
              topics={activeTopics}
              sources={sources}
              data={xidData}
              xidMeta={xidPkg}
              onTopic={(id) => { setManualQuery(''); onSelectTopic(id); }}
              onXid={(code) => onNavigate('xid', code)}
              onNotice={onNotify}
              sessionState={sessionState.current}
            />
          </div>
        ) : (
          <div className="empty-state" role="status">未找到相关章节</div>
        )}
      </article>
    </div>
  );
}
