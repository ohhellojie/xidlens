import React, { useState } from 'react';
import { displayXidActions } from './lib/analysis';
import ManualFigure, { FALLBACK_TOPIC_FIGURES } from './components/ManualFigures';

function Extract({ code, data, xidMeta, lang = 'cn' }) {
  const en = lang === 'en';
  const item = data[lang]?.codes?.[code] || data.cn.codes[code];
  if (!item) return <p className="note">{en ? `Xid ${code} is not in the catalog.` : `资料未包含 Xid ${code}。`}</p>;
  const actions = displayXidActions(item, lang);
  return (
    <details className="manual-extract">
      <summary>Xid {code} · {item.title || (en ? 'Catalog Entry' : '目录说明')}</summary>
      <div className="extract-body">
        {item.description && <p className="prose">{item.description}</p>}
        {actions.map((a, i) => (
          <section key={i}>
            <div className="muted" style={{ fontSize: 11 }}>{a.stage}</div>
            {a.label && <h4>{a.label}</h4>}
            {a.text && <p className="prose muted">{a.text}</p>}
          </section>
        ))}
        <p className="extract-source muted">
          {en ? `NVIDIA Xid Catalog v${xidMeta.version}` : `中文 Xid 资料 v${xidMeta.version}`}
        </p>
      </div>
    </details>
  );
}

export default function ManualContent({ current, lang = 'cn', onTopic, onXid, onNotice, topics, sources, data, xidMeta, sessionState = {} }) {
  const en = lang === 'en';
  const [branch, setBranch] = useState(() => Math.min(sessionState.branches?.[current.id] || 0, Math.max(0, (current.branches?.length || 1) - 1)));
  function chooseBranch(i) {
    sessionState.branches ??= {};
    sessionState.branches[current.id] = i;
    setBranch(i);
  }
  const selected = current.branches?.[branch];
  const tables = [...(current.table ? [current.table] : []), ...(current.tables || [])];
  const rawFigures = current.figures?.length ? current.figures : (FALLBACK_TOPIC_FIGURES[current.id] || []);
  const figuresByStep = new Map();
  for (const fig of rawFigures) {
    const list = figuresByStep.get(fig.step) || [];
    list.push(fig);
    figuresByStep.set(fig.step, list);
  }

  function jumpToFigure(figId) {
    const el = document.getElementById(`manual-fig-${figId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function copy(code) {
    try {
      await navigator.clipboard.writeText(code);
      onNotice('已复制命令');
    } catch {
      onNotice('复制失败，请选中命令复制');
    }
  }

  return (
    <div className="manual-content">
      {current.scope && <p className="manual-scope">{current.scope}</p>}

      <ol className="steps">
        {current.steps.map(([title, text], idx) => {
          const stepFigures = figuresByStep.get(idx) || [];
          const hasFigures = stepFigures.length > 0;
          const isLongText = hasFigures && text && text.includes('\n');
          return (
            <li key={title}>
              <h3>{title}</h3>
              {text && !isLongText && <p className="prose">{text}</p>}
              {stepFigures.map((fig) => (
                <ManualFigure
                  key={fig.id}
                  figure={{ ...fig, caption: fig.caption || title }}
                  lang={lang}
                  compactHead
                  onTopic={onTopic}
                  onFigure={jumpToFigure}
                />
              ))}
              {isLongText && (
                <details className="manual-extract">
                  <summary>{en ? 'Text walkthrough' : '展开文字版步骤'}</summary>
                  <p className="prose" style={{ marginTop: 8 }}>{text}</p>
                </details>
              )}
            </li>
          );
        })}
      </ol>

      {selected && (
        <section className="manual-section">
          <h3>{en ? 'By Error Combination' : '按错误组合排查'}</h3>
          <div className="branch-tabs" role="group" aria-label={current.title}>
            {current.branches.map((b, i) => (
              <button key={b.label} aria-pressed={i === branch} onClick={() => chooseBranch(i)}>
                Xid {b.label}
              </button>
            ))}
          </div>
          <div className="branch-content">
            <h3>{selected.title}</h3>
            <p className="prose">{selected.text}</p>
            {selected.extra && (
              <div className="note">
                <span>{selected.extra}</span>
                {sources.triage && (
                  <>
                    {' '}
                    <a href={sources.triage[1]} target="_blank" rel="noreferrer">{en ? 'Source' : '平台表原文'}</a>
                  </>
                )}
              </div>
            )}
            <Extract key={selected.code + lang} code={selected.code} data={data} xidMeta={xidMeta} lang={lang} />
          </div>
        </section>
      )}

      {tables.map((tb) => (
        <section className="manual-section" key={tb.title}>
          <h3>{tb.title}</h3>
          <div className="manual-table-wrap">
            <table className="manual-table">
              <thead>
                <tr>{tb.head.map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {tb.rows.map((row, ri) => (
                  <tr key={ri}>
                    <th scope="row" className="prose">{row[0]}</th>
                    {row.slice(1).map((cell, ci) => (
                      <td key={ci} className="prose">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {current.note && <div className="note prose">{current.note}</div>}

      {current.commands?.map((c) => (
        <section className="command-block" key={c.code}>
          <div>
            <h3>{c.title}</h3>
            <button className="link-btn" aria-label={(en ? 'Copy command: ' : '复制命令：') + c.title} onClick={() => copy(c.code)}>
              {en ? 'Copy' : '复制'}
            </button>
          </div>
          <pre><code>{c.code}</code></pre>
          {c.note && <p>{c.note}</p>}
        </section>
      ))}

      {current.extracts?.length > 0 && (
        <section className="manual-section">
          <h3>{en ? 'Details' : '详细说明'}</h3>
          {current.extracts.map((code) => (
            <Extract key={code + lang} code={code} data={data} xidMeta={xidMeta} lang={lang} />
          ))}
        </section>
      )}

      {current.next.length > 0 && (
        <section className="manual-section">
          <h3>{en ? 'Next Steps' : '后续排查'}</h3>
          <div className="chip-row">
            {current.next.map((id) => {
              const target = topics.find((t) => t.id === id);
              return target ? (
                <button key={id} className="btn" onClick={() => onTopic(id)}>
                  {target.title}
                </button>
              ) : null;
            })}
          </div>
        </section>
      )}

      {current.related.length > 0 && (
        <section className="manual-section">
          <h3>{en ? 'Related Xid' : '相关 Xid'}</h3>
          <div className="chip-row">
            {current.related.map((k) => (
              <button className="chip-btn" key={k} onClick={() => onXid(k)}>
                Xid {k}
              </button>
            ))}
          </div>
        </section>
      )}

      {current.refs.length > 0 && (
        <div className="manual-sources">
          <span>{en ? 'References' : '参考文档'}</span>
          {current.refs.map((k) => (
            sources[k] ? (
              <a key={k} href={sources[k][1]} target="_blank" rel="noreferrer">{sources[k][0]}</a>
            ) : null
          ))}
        </div>
      )}
    </div>
  );
}
