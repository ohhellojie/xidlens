import React, { useId, useState } from 'react';
import { ModalFrame } from './Modals';

function Lines({ x, y, lines, lineHeight = 14, className = 'mf-text', subClassName = 'mf-subtext' }) {
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  return (
    <text x={x} textAnchor="middle" dominantBaseline="central" className={className}>
      {lines.map((line, idx) => {
        const text = typeof line === 'string' ? line : line.text;
        const isSub = typeof line === 'object' && line.sub;
        return (
          <tspan key={idx} x={x} y={startY + idx * lineHeight} className={isSub ? subClassName : undefined}>
            {text}
          </tspan>
        );
      })}
    </text>
  );
}

function NodeBox({ x, y, w, h, lines, variant = 'process', onClick, tooltip }) {
  const interactive = typeof onClick === 'function';
  const rx = variant === 'ok' ? Math.min(18, h / 2) : 6;
  const cx = x + w / 2;
  const cy = y + h / 2;

  function handleKeyDown(e) {
    if (!interactive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <g
      className={`mf-node mf-${variant} ${interactive ? 'is-link' : ''}`}
      onClick={interactive ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      onKeyDown={handleKeyDown}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive && tooltip ? tooltip : undefined}
    >
      {tooltip && <title>{tooltip}</title>}
      <rect x={x} y={y} width={w} height={h} rx={rx} ry={rx} className="mf-shape" />
      <Lines x={cx} y={cy} lines={lines} lineHeight={lines.length > 2 ? 13 : 14.5} />
      {interactive && (
        <path
          d={`M ${x + w - 11} ${y + 6} h 5 v 5 M ${x + w - 6} ${y + 6} l -5 5`}
          className="mf-link-mark"
        />
      )}
    </g>
  );
}

function Diamond({ cx, cy, hw, hh, lines }) {
  const pts = `${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}`;
  return (
    <g className="mf-node mf-decision">
      <polygon points={pts} className="mf-shape" />
      <Lines x={cx} y={cy} lines={lines} lineHeight={13.5} />
    </g>
  );
}

function Connector({ d, markerId, dashed = false, noArrow = false }) {
  return (
    <path
      d={d}
      className={`mf-edge ${dashed ? 'is-dashed' : ''}`}
      markerEnd={noArrow ? undefined : `url(#${markerId})`}
    />
  );
}

function EdgeTag({ x, y, text, tone = 'neutral' }) {
  const width = Math.max(26, Math.ceil(text.length * (/[a-zA-Z]/.test(text) ? 6.0 : 11.2)) + 12);
  const height = 16;
  return (
    <g className={`mf-tag mf-tag-${tone}`}>
      <rect x={x - width / 2} y={y - height / 2} width={width} height={height} rx={8} ry={8} />
      <text x={x} y={y} textAnchor="middle" dominantBaseline="central">{text}</text>
    </g>
  );
}

function Lane({ x, y, w, h, title }) {
  return (
    <g className="mf-lane">
      <rect x={x} y={y} width={w} height={h} rx={8} ry={8} className="mf-lane-bg" />
      <text x={x + 12} y={y + 15} className="mf-lane-title">{title}</text>
    </g>
  );
}

function TriageFigure1({ lang, onTopic, onFigure }) {
  const markerId = useId();
  const en = lang === 'en';
  const yes = en ? 'Yes' : '是';
  const no = en ? 'No' : '否';
  const resolved = en ? 'Resolved' : '已解决';
  const unresolved = en ? 'Unresolved' : '未解决';

  return (
    <svg
      viewBox="0 0 840 554"
      className="mf-svg"
      role="img"
      aria-label={en ? 'Figure 1: GPU Triage Flowchart' : '图 1：GPU 分流流程图'}
    >
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 1 1.5 L 9 5 L 1 8.5 z" className="mf-arrow" />
        </marker>
      </defs>

      {/* Lane 1: XID Messages */}
      <Lane
        x={6}
        y={8}
        w={828}
        h={214}
        title={en ? 'PATH 1 · XID MESSAGE REPORTED' : '路径 1 · 报告了 Xid 消息'}
      />

      <NodeBox
        x={20}
        y={92}
        w={116}
        h={50}
        variant="entry"
        lines={en ? ['XID Message', 'Reported'] : ['报告了 Xid 消息']}
      />

      {/* Bus from XID entry to 4 rows */}
      <Connector d="M 136 117 L 154 117" noArrow />
      <Connector d="M 154 50 L 154 192" noArrow />
      <Connector d="M 154 50 L 172 50" markerId={markerId} />
      <Connector d="M 154 94 L 172 94" markerId={markerId} />
      <Connector d="M 154 138 L 172 138" markerId={markerId} />
      <Connector d="M 154 192 L 172 192" markerId={markerId} />

      <NodeBox
        x={174}
        y={32}
        w={178}
        h={36}
        lines={en
          ? ['Application Error', { text: 'XID 13, 31', sub: true }]
          : ['应用程序错误', { text: 'Xid 13、31', sub: true }]}
      />
      <NodeBox
        x={174}
        y={76}
        w={178}
        h={36}
        lines={en
          ? ['ECC Memory Error', { text: 'XID 48, 63, 64, 92, 94, 95', sub: true }]
          : ['ECC 显存错误', { text: 'Xid 48、63、64、92、94、95', sub: true }]}
      />
      <NodeBox
        x={174}
        y={120}
        w={178}
        h={36}
        lines={en
          ? ['HW / System Error', { text: 'XID 74, 79', sub: true }]
          : ['硬件 / 系统错误', { text: 'Xid 74、79', sub: true }]}
      />
      <NodeBox
        x={174}
        y={174}
        w={178}
        h={36}
        lines={en ? ['Other XID?'] : ['其他 Xid？']}
      />

      {/* Merge first 3 rows into Table 1 */}
      <Connector d="M 352 50 L 370 50 L 370 138 L 352 138" noArrow />
      <Connector d="M 352 94 L 388 94" markerId={markerId} />

      <NodeBox
        x={390}
        y={64}
        w={124}
        h={60}
        variant="link"
        onClick={() => onTopic?.('triage-xid')}
        tooltip={en ? 'Open Table 1: Understanding XID Messages' : '跳转到「理解 Xid 消息（表 1）」'}
        lines={en
          ? ['See Table 1', { text: 'Understanding XID', sub: true }]
          : ['参阅表 1', { text: '理解 Xid 消息', sub: true }]}
      />

      {/* Merge Table 1 and Other XID into Resolved? */}
      <Connector d="M 514 94 L 528 94 L 528 192 L 352 192" noArrow />
      <Connector d="M 528 140 L 542 140" markerId={markerId} />

      <Diamond
        cx={594}
        cy={140}
        hw={50}
        hh={32}
        lines={en ? ['Resolved?'] : ['已解决？']}
      />

      <Connector d="M 594 108 L 594 74 L 696 74" markerId={markerId} />
      <EdgeTag x={644} y={74} text={yes} tone="ok" />
      <NodeBox
        x={698}
        y={56}
        w={120}
        h={36}
        variant="ok"
        lines={en ? ['End Triage'] : ['结束分流']}
      />

      <Connector d="M 594 172 L 594 188 L 696 188" markerId={markerId} />
      <EdgeTag x={644} y={188} text={no} tone="danger" />
      <NodeBox
        x={698}
        y={166}
        w={120}
        h={44}
        variant="escalate"
        onClick={() => onTopic?.('collect')}
        tooltip={en ? 'Open Reporting a GPU Issue' : '跳转到「报告 GPU 问题」'}
        lines={en ? ['Report a', 'GPU Issue'] : ['参阅「报告', 'GPU 问题」']}
      />

      {/* Lane 2: System Monitoring */}
      <Lane
        x={6}
        y={234}
        w={828}
        h={154}
        title={en ? 'PATH 2 · SYSTEM MONITORING' : '路径 2 · 系统监控发现问题'}
      />

      <NodeBox
        x={20}
        y={290}
        w={116}
        h={52}
        variant="entry"
        lines={en ? ['System', 'Monitoring'] : ['系统监控', '发现问题']}
      />
      <Connector d="M 136 316 L 164 316" markerId={markerId} />

      <NodeBox
        x={166}
        y={290}
        w={118}
        h={52}
        lines={en ? ['Inspect System', 'Logs'] : ['检查系统日志', '排查可疑记录']}
      />

      <Connector d="M 284 316 L 364 316" noArrow />
      <EdgeTag x={324} y={316} text={unresolved} />
      <Connector d="M 364 280 L 364 352" noArrow />
      <Connector d="M 364 280 L 378 280" markerId={markerId} />
      <Connector d="M 364 352 L 378 352" markerId={markerId} />

      <NodeBox
        x={380}
        y={256}
        w={134}
        h={48}
        variant="link"
        onClick={() => onTopic?.('network')}
        tooltip={en ? 'Open Testing Network' : '跳转到「网络测试」'}
        lines={en
          ? ['Network Issues', { text: 'Testing Network', sub: true }]
          : ['网络问题', { text: '参阅「网络测试」', sub: true }]}
      />
      <NodeBox
        x={380}
        y={328}
        w={134}
        h={48}
        variant="link"
        onClick={() => onTopic?.('diag')}
        tooltip={en ? 'Open Run DCGM Diagnostics' : '跳转到「运行 DCGM 诊断与现场诊断」'}
        lines={en
          ? ['Power / Thermal', { text: 'DCGM Diagnostics', sub: true }]
          : ['功耗 / 散热问题', { text: '运行 DCGM 诊断', sub: true }]}
      />

      <Connector d="M 514 280 L 528 280 L 528 352 L 514 352" noArrow />
      <Connector d="M 528 316 L 542 316" markerId={markerId} />

      <Diamond
        cx={594}
        cy={316}
        hw={50}
        hh={32}
        lines={en ? ['Resolved?'] : ['已解决？']}
      />

      <Connector d="M 594 284 L 594 274 L 696 274" markerId={markerId} />
      <EdgeTag x={644} y={274} text={yes} tone="ok" />
      <NodeBox
        x={698}
        y={256}
        w={120}
        h={36}
        variant="ok"
        lines={en ? ['End Triage'] : ['结束分流']}
      />

      <Connector d="M 594 348 L 594 356 L 696 356" markerId={markerId} />
      <EdgeTag x={644} y={356} text={no} tone="danger" />
      <NodeBox
        x={698}
        y={334}
        w={120}
        h={44}
        variant="escalate"
        onClick={() => onTopic?.('collect')}
        tooltip={en ? 'Open Reporting a GPU Issue' : '跳转到「报告 GPU 问题」'}
        lines={en ? ['Open Vendor', 'Ticket'] : ['向系统供应商', '提交工单']}
      />

      {/* Lane 3: System Issue */}
      <Lane
        x={6}
        y={400}
        w={828}
        h={146}
        title={en ? 'PATH 3 · SYSTEM ISSUE' : '路径 3 · 系统问题'}
      />

      <NodeBox
        x={20}
        y={442}
        w={154}
        h={56}
        variant="entry"
        lines={en
          ? ['System Issue', { text: 'Segfault / Crash / Reboot', sub: true }]
          : ['系统问题', { text: '段错误 / 崩溃 / 挂死 / 重启', sub: true }]}
      />
      <Connector d="M 174 470 L 204 470" markerId={markerId} />

      <Diamond
        cx={284}
        cy={470}
        hw={78}
        hh={38}
        lines={en ? ['Logs / traces show', 'GPU involved?'] : ['日志 / 调用栈 / 转储', '表明与 GPU 有关？']}
      />

      {/* Yes -> Fig 2 */}
      <Connector d="M 362 470 L 386 470 L 386 442 L 420 442" markerId={markerId} />
      <EdgeTag x={386} y={456} text={yes} tone="ok" />

      <NodeBox
        x={422}
        y={418}
        w={146}
        h={48}
        variant="link"
        onClick={() => onFigure?.('triage-fig2')}
        tooltip={en ? 'Jump to Figure 2: User Reported Error' : '定位到图 2：用户报告错误'}
        lines={en
          ? ['User Reported Error', { text: 'See Figure 2', sub: true }]
          : ['转入「用户报告错误」', { text: '参阅图 2', sub: true }]}
      />

      {/* Fig 2 resolved / unresolved */}
      <Connector d="M 568 434 L 696 434" markerId={markerId} />
      <EdgeTag x={632} y={434} text={resolved} tone="ok" />
      <NodeBox
        x={698}
        y={416}
        w={120}
        h={36}
        variant="ok"
        lines={en ? ['End Triage'] : ['结束分流']}
      />

      <Connector d="M 568 454 L 606 454 L 606 498 L 696 498" markerId={markerId} />
      <EdgeTag x={651} y={498} text={unresolved} tone="danger" />

      {/* No -> Vendor Ticket */}
      <Connector d="M 284 508 L 284 524 L 696 524" markerId={markerId} />
      <EdgeTag x={484} y={524} text={no} tone="danger" />

      <NodeBox
        x={698}
        y={488}
        w={120}
        h={44}
        variant="escalate"
        onClick={() => onTopic?.('collect')}
        tooltip={en ? 'Open Reporting a GPU Issue' : '跳转到「报告 GPU 问题」'}
        lines={en ? ['Open Vendor', 'Ticket'] : ['向系统供应商', '提交工单']}
      />
    </svg>
  );
}

function TriageFigure2({ lang, onTopic, onFigure }) {
  const markerId = useId();
  const en = lang === 'en';
  const yes = en ? 'Yes' : '是';
  const no = en ? 'No' : '否';
  const unresolved = en ? 'Unresolved' : '未解决';

  return (
    <svg
      viewBox="0 0 840 330"
      className="mf-svg"
      role="img"
      aria-label={en ? 'Figure 2: GPU Triage Flowchart (User Reported Error)' : '图 2：GPU 分流流程图（用户报告错误）'}
    >
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 1 1.5 L 9 5 L 1 8.5 z" className="mf-arrow" />
        </marker>
      </defs>

      {/* Row 2: Entry -> XID check -> DCGM -> Resolved? */}
      <NodeBox
        x={14}
        y={130}
        w={104}
        h={48}
        variant="entry"
        lines={en ? ['User Reported', 'Error'] : ['用户报告错误']}
      />
      <Connector d="M 118 154 L 140 154" markerId={markerId} />

      <Diamond
        cx={208}
        cy={154}
        hw={66}
        hh={38}
        lines={en ? ['XID or other', 'system issues?'] : ['存在 Xid 或', '其他系统问题？']}
      />

      {/* Row 1: Yes -> Follow Fig 1 -> Resolved? -> End Triage */}
      <Connector d="M 208 116 L 208 44 L 298 44" markerId={markerId} />
      <EdgeTag x={244} y={44} text={yes} tone="ok" />

      <NodeBox
        x={300}
        y={20}
        w={140}
        h={48}
        variant="link"
        onClick={() => onFigure?.('triage-fig1')}
        tooltip={en ? 'Jump to Figure 1: GPU Triage Flowchart' : '定位到图 1：Xid 与系统问题流程'}
        lines={en
          ? ['Follow Fig. 1 First', { text: 'Then return here', sub: true }]
          : ['按图 1 流程处理', { text: '完成后返回此处', sub: true }]}
      />
      <Connector d="M 440 44 L 462 44" markerId={markerId} />

      <Diamond
        cx={512}
        cy={44}
        hw={48}
        hh={28}
        lines={en ? ['Resolved?'] : ['已解决？']}
      />

      <Connector d="M 560 44 L 704 44" markerId={markerId} />
      <EdgeTag x={632} y={44} text={yes} tone="ok" />

      <NodeBox
        x={706}
        y={26}
        w={120}
        h={36}
        variant="ok"
        lines={en ? ['End Triage'] : ['结束分流']}
      />

      {/* Row 1 No -> down into DCGM */}
      <Connector d="M 512 72 L 512 96 L 382 96 L 382 128" markerId={markerId} />
      <EdgeTag x={448} y={96} text={no} tone="danger" />

      {/* Row 2 No -> DCGM */}
      <Connector d="M 274 154 L 318 154" markerId={markerId} />
      <EdgeTag x={296} y={154} text={no} />

      <NodeBox
        x={320}
        y={130}
        w={124}
        h={48}
        variant="link"
        onClick={() => onTopic?.('diag')}
        tooltip={en ? 'Open Run DCGM Diagnostics' : '跳转到「运行 DCGM 诊断与现场诊断」'}
        lines={en ? ['Run DCGM', 'Diagnostics'] : ['运行 DCGM 诊断']}
      />
      <Connector d="M 444 154 L 462 154" markerId={markerId} />

      <Diamond
        cx={512}
        cy={154}
        hw={48}
        hh={28}
        lines={en ? ['Resolved?'] : ['已解决？']}
      />

      {/* Row 2 Resolved Yes -> up to End Triage */}
      <Connector d="M 512 126 L 512 110 L 766 110 L 766 64" markerId={markerId} />
      <EdgeTag x={632} y={110} text={yes} tone="ok" />

      {/* Row 2 Resolved No -> Row 3 App Crash / Perf? */}
      <Connector d="M 512 182 L 512 204 L 360 204 L 360 218" markerId={markerId} />
      <EdgeTag x={436} y={204} text={no} tone="danger" />

      <Diamond
        cx={360}
        cy={256}
        hw={78}
        hh={36}
        lines={en ? ['App Crash or', 'Perf Issue?'] : ['应用崩溃或', '性能问题？']}
      />

      {/* Yes -> Debug Application (Fig 3) */}
      <Connector d="M 438 256 L 482 256" markerId={markerId} />
      <EdgeTag x={459} y={256} text={yes} tone="ok" />

      <NodeBox
        x={484}
        y={232}
        w={132}
        h={48}
        variant="link"
        onClick={() => onFigure?.('triage-fig3')}
        tooltip={en ? 'Jump to Figure 3: Debug Application' : '定位到图 3：调试应用程序'}
        lines={en
          ? ['Debug Application', { text: 'See Figure 3', sub: true }]
          : ['调试应用程序', { text: '参阅图 3', sub: true }]}
      />

      {/* Fig 3 -> Report GPU Issue */}
      <Connector d="M 616 256 L 704 256" markerId={markerId} />
      <EdgeTag x={660} y={256} text={unresolved} tone="danger" />

      {/* App Crash No -> Report GPU Issue */}
      <Connector d="M 360 292 L 360 312 L 766 312 L 766 282" markerId={markerId} />
      <EdgeTag x={560} y={312} text={no} tone="danger" />

      <NodeBox
        x={706}
        y={234}
        w={120}
        h={46}
        variant="escalate"
        onClick={() => onTopic?.('collect')}
        tooltip={en ? 'Open Reporting a GPU Issue' : '跳转到「报告 GPU 问题」'}
        lines={en ? ['Report a', 'GPU Issue'] : ['参阅「报告', 'GPU 问题」']}
      />
    </svg>
  );
}

function TriageFigure3({ lang, onTopic }) {
  const markerId = useId();
  const en = lang === 'en';
  const yes = en ? 'Yes' : '是';
  const no = en ? 'No' : '否';
  const resolved = en ? 'Resolved' : '已解决';
  const unresolved = en ? 'Unresolved' : '仍未解决';

  return (
    <svg
      viewBox="0 0 840 364"
      className="mf-svg"
      role="img"
      aria-label={en ? 'Figure 3: GPU Triage Flowchart (Debug Application)' : '图 3：GPU 分流流程图（调试应用程序）'}
    >
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 1 1.5 L 9 5 L 1 8.5 z" className="mf-arrow" />
        </marker>
      </defs>

      {/* Row 1: Entry -> Reproducible? -> NGC Stack? -> Collect logs -> Report GPU Issue */}
      <NodeBox
        x={14}
        y={26}
        w={104}
        h={48}
        variant="entry"
        lines={en ? ['Debug', 'Application'] : ['调试应用程序']}
      />
      <Connector d="M 118 50 L 140 50" markerId={markerId} />

      <Diamond
        cx={204}
        cy={50}
        hw={62}
        hh={34}
        lines={en ? ['Reproducible', 'reliably?'] : ['问题能否', '可靠复现？']}
      />

      <Connector d="M 266 50 L 316 50" markerId={markerId} />
      <EdgeTag x={291} y={50} text={yes} tone="ok" />

      <Diamond
        cx={402}
        cy={50}
        hw={84}
        hh={34}
        lines={en ? ['Standard NGC stack', 'runs OK?'] : ['标准软件栈 (NGC)', '能否正常运行？']}
      />

      <Connector d="M 486 50 L 536 50" markerId={markerId} />
      <EdgeTag x={511} y={50} text={no} tone="danger" />

      <NodeBox
        x={538}
        y={26}
        w={138}
        h={48}
        lines={en ? ['Collect debug logs,', 'traces & analysis'] : ['收集调试日志、', '跟踪及分析结果']}
      />
      <Connector d="M 676 50 L 704 50" markerId={markerId} />

      <NodeBox
        x={706}
        y={26}
        w={120}
        h={48}
        variant="escalate"
        onClick={() => onTopic?.('collect')}
        tooltip={en ? 'Open Reporting a GPU Issue' : '跳转到「报告 GPU 问题」'}
        lines={en ? ['Report a', 'GPU Issue'] : ['参阅「报告', 'GPU 问题」']}
      />

      {/* Reproducible No -> Instrument code */}
      <Connector d="M 204 84 L 204 114" markerId={markerId} />
      <EdgeTag x={204} y={98} text={no} tone="danger" />

      <NodeBox
        x={122}
        y={116}
        w={164}
        h={48}
        lines={en ? ['Instrument code to', 'capture fault'] : ['对代码进行插桩', '以便捕获故障现场']}
      />

      {/* Merge Instrument code and NGC Yes into All Nodes? */}
      <Connector d="M 204 164 L 204 228" markerId={markerId} />
      <Connector d="M 402 84 L 402 184 L 204 184" noArrow />
      <EdgeTag x={402} y={134} text={yes} tone="ok" />

      <Diamond
        cx={204}
        cy={266}
        hw={68}
        hh={36}
        lines={en ? ['Happens on', 'all nodes?'] : ['所有节点上', '均会发生？']}
      />

      {/* All nodes Yes / No */}
      <Connector d="M 272 266 L 298 266 L 298 224 L 324 224" markerId={markerId} />
      <EdgeTag x={298} y={242} text={yes} tone="ok" />

      <NodeBox
        x={326}
        y={198}
        w={156}
        h={52}
        lines={en
          ? ['Check recent app / SW', 'changes, revert & retest']
          : ['检查近期应用 / 系统变更', '回退变更后重新测试']}
      />

      <Connector d="M 272 266 L 298 266 L 298 308 L 324 308" markerId={markerId} />
      <EdgeTag x={298} y={288} text={no} tone="danger" />

      <NodeBox
        x={326}
        y={276}
        w={156}
        h={64}
        lines={en
          ? ['Diff node SW & logs;', 'check thermal throttle /', 'physical inspection']
          : ['比对节点软件与日志差异', '排查温度降频 / GPU 错误', '必要时进行物理检查']}
      />

      {/* Merge both branches */}
      <Connector d="M 482 224 L 496 224 L 496 308 L 482 308" noArrow />

      {/* Resolved -> End Triage */}
      <Connector d="M 496 224 L 496 184 L 704 184" markerId={markerId} />
      <EdgeTag x={600} y={184} text={resolved} tone="ok" />

      <NodeBox
        x={706}
        y={166}
        w={120}
        h={36}
        variant="ok"
        lines={en ? ['End Triage'] : ['结束分流']}
      />

      {/* No success -> Debugging Applications */}
      <Connector d="M 496 270 L 566 270" markerId={markerId} />
      <EdgeTag x={531} y={270} text={en ? 'Failed' : '未成功'} tone="danger" />

      <NodeBox
        x={568}
        y={244}
        w={108}
        h={52}
        variant="link"
        onClick={() => onTopic?.('13')}
        tooltip={en ? 'Open Debugging Applications' : '跳转到「调试应用程序与性能分析」'}
        lines={en ? ['Debugging', 'Applications'] : ['调试应用程序', '与性能分析']}
      />

      {/* Debugging Applications -> Resolved (subtle dashed) / Unresolved */}
      <Connector d="M 622 244 L 622 216 L 766 216 L 766 204" markerId={markerId} dashed />
      <Connector d="M 622 296 L 622 324 L 704 324" markerId={markerId} />
      <EdgeTag x={663} y={324} text={unresolved} tone="danger" />

      <NodeBox
        x={706}
        y={300}
        w={120}
        h={48}
        variant="escalate"
        onClick={() => onTopic?.('collect')}
        tooltip={en ? 'Open Reporting a GPU Issue' : '跳转到「报告 GPU 问题」'}
        lines={en ? ['Report a', 'GPU Issue'] : ['参阅「报告', 'GPU 问题」']}
      />
    </svg>
  );
}

export const MANUAL_FIGURES = {
  'triage-fig1': TriageFigure1,
  'triage-fig2': TriageFigure2,
  'triage-fig3': TriageFigure3,
};

export const FALLBACK_TOPIC_FIGURES = {
  triage: [
    { id: 'triage-fig1', step: 0 },
    { id: 'triage-fig2', step: 1 },
    { id: 'triage-fig3', step: 2 },
  ],
};

function DiagramLegend({ lang }) {
  const en = lang === 'en';
  return (
    <div className="mf-legend" aria-hidden="true">
      <span><i className="mf-swatch mf-swatch-entry" />{en ? 'Start / Trigger' : '入口 / 触发'}</span>
      <span><i className="mf-swatch mf-swatch-decision" />{en ? 'Decision' : '条件判断'}</span>
      <span><i className="mf-swatch mf-swatch-link" />{en ? 'Clickable Section' : '可点击跳转'}</span>
      <span><i className="mf-swatch mf-swatch-ok" />{en ? 'End Triage' : '结束分流'}</span>
      <span><i className="mf-swatch mf-swatch-escalate" />{en ? 'Report / Ticket' : '上报 / 提单'}</span>
    </div>
  );
}

export default function ManualFigure({ figure, lang = 'cn', compactHead = false, onTopic, onFigure }) {
  const [zoomed, setZoomed] = useState(false);
  const Diagram = MANUAL_FIGURES[figure?.id];
  if (!Diagram) return null;
  const en = lang === 'en';
  const caption = figure.caption || figure.id;
  const hint = en ? 'Click highlighted nodes to jump to related sections' : '点击带箭头节点可直接跳转对应章节';

  function handleTopic(id) {
    setZoomed(false);
    onTopic?.(id);
  }

  function handleFigure(figId) {
    setZoomed(false);
    onFigure?.(figId);
  }

  return (
    <>
      <figure className="manual-figure" id={`manual-fig-${figure.id}`}>
        <div className="manual-figure-head">
          {compactHead ? (
            <span className="manual-figure-hint">{hint}</span>
          ) : (
            <figcaption>{caption}</figcaption>
          )}
          <button
            type="button"
            className="link-btn"
            onClick={() => setZoomed(true)}
            aria-label={(en ? 'Zoom diagram: ' : '放大查看流程图：') + caption}
          >
            {en ? 'Zoom' : '放大查看'}
          </button>
        </div>
        <div className="manual-figure-canvas">
          <Diagram lang={lang} onTopic={handleTopic} onFigure={handleFigure} />
        </div>
        <DiagramLegend lang={lang} />
      </figure>

      {zoomed && (
        <ModalFrame title={caption} wide className="diagram-modal" onClose={() => setZoomed(false)}>
          <div className="manual-figure-modal">
            <Diagram lang={lang} onTopic={handleTopic} onFigure={handleFigure} />
            <DiagramLegend lang={lang} />
          </div>
        </ModalFrame>
      )}
    </>
  );
}
