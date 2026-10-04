import type {
  Calibration,
  FieldOfView,
  LogEntry,
  Objective,
  ScanBatch,
  StageOffset,
  StructureRecord,
  World,
} from "./types";
import {
  POS_DEV_LIMIT_UM,
  SIZE_DEV_PCT,
  batchProgress,
  currentSizeUm,
  deviationOf,
  expectedStructureCount,
  fovsOfBatch,
  getCal,
  getOffset,
  lateObservations,
  objectiveOf,
  primaryObservations,
  structuresOfSample,
} from "./engine";
import type { CheckResult } from "./selfcheck";

// ---------- 基础件 ----------
export function Badge({ tone, children }: { tone: "good" | "warn" | "danger" | "neutral" | "info"; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function stateTone(state: StructureRecord["measurement"]["state"]): "good" | "warn" | "danger" | "neutral" | "info" {
  switch (state) {
    case "已确认":
      return "good";
    case "待复核":
      return "warn";
    case "待核":
      return "danger";
    default:
      return "neutral";
  }
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------- 视野网格 ----------
export function FovGrid({ world, batch }: { world: World; batch: ScanBatch }) {
  const nextKey = batch.order.find((k) => !batch.importedKeys.includes(k));
  return (
    <div className="fov-grid" style={{ gridTemplateColumns: `repeat(${batch.cols}, 1fr)` }}>
      {Array.from({ length: batch.rows }).map((_, row) =>
        Array.from({ length: batch.cols }).map((__, col) => {
          const key = `${col}-${row}`;
          const done = batch.importedKeys.includes(key);
          const isNext = key === nextKey;
          return (
            <div key={key} className={`fov-cell ${done ? "done" : ""} ${isNext ? "next" : ""}`}>
              <strong>{key}</strong>
              <span>{done ? "已导入" : isNext ? "下一视野" : "待导入"}</span>
            </div>
          );
        }),
      )}
    </div>
  );
}

// ---------- 批次卡片 ----------
export function BatchCard({
  world,
  batch,
  selected,
  onSelect,
  onIngestNext,
  onInterrupt,
  onResume,
}: {
  world: World;
  batch: ScanBatch;
  selected: boolean;
  onSelect: () => void;
  onIngestNext: () => void;
  onInterrupt: () => void;
  onResume: () => void;
}) {
  const cal = getCal(world, batch.calId);
  const offset = getOffset(world, batch.offsetId);
  const sample = world.samples.find((s) => s.id === batch.sampleId);
  const progress = batchProgress(world, batch);
  const list = world.structures.filter((s) => s.batchId === batch.id);
  const merged = list.filter((s) => s.overlap).length;
  const newerCal = world.calibrations
    .filter((c) => c.objective === batch.objective)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const calStale = newerCal && newerCal.id !== batch.calId;
  const nextKey = batch.order.find((k) => !batch.importedKeys.includes(k));
  const fovs = fovsOfBatch(world, batch.id);
  void fovs;

  return (
    <article className={`batch-card ${selected ? "selected" : ""}`} onClick={onSelect}>
      <header>
        <div>
          <h3>{batch.code}</h3>
          <p>
            {sample?.name} · <Badge tone="info">{batch.objective}</Badge> · {batch.cols}×{batch.rows} 视野 · 重叠 {Math.round(batch.overlapPct * 100)}%
          </p>
        </div>
        <Badge tone={batch.status === "已完成" ? "good" : batch.status === "已中断" ? "danger" : "warn"}>{batch.status}</Badge>
      </header>
      <div className="bind-line">
        <span>
          绑定标定 <b>{cal?.label}</b>
        </span>
        {calStale && <Badge tone="warn">已有 {newerCal.label}：未确认测量已重算，确认件锁定原标定</Badge>}
        <span>
          偏移 <b>{offset?.label}</b>（{offset?.dxUm}, {offset?.dyUm}）μm
        </span>
      </div>
      <FovGrid world={world} batch={batch} />
      <div className="progress-row">
        <div className="progress-bar">
          <i style={{ width: `${progress.pct}%` }} />
        </div>
        <span>
          {progress.done}/{progress.total} 视野
        </span>
      </div>
      <div className="batch-stats">
        <span>
          结构 <b>{list.length}</b>/{expectedStructureCount(batch)}
        </span>
        <span>
          重叠合并 <b>{merged}</b>（同一编号）
        </span>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button disabled={!nextKey} onClick={onIngestNext}>
          导入下一视野{nextKey ? ` ${nextKey}` : ""}
        </button>
        {batch.status === "进行中" && (
          <button className="danger-btn" onClick={onInterrupt}>
            模拟导入中断
          </button>
        )}
        {batch.status === "已中断" && (
          <button className="primary-action" onClick={onResume}>
            从完整批次恢复（只补未完成）
          </button>
        )}
        {batch.status === "已完成" && (
          <button onClick={onResume}>重放导入（幂等，不新增结构）</button>
        )}
      </div>
    </article>
  );
}

// ---------- 测量复核表 ----------
export function StructureTable({
  world,
  structures,
  selectedId,
  onSelect,
}: {
  world: World;
  structures: StructureRecord[];
  selectedId?: string;
  onSelect: (s: StructureRecord) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="measure-table">
        <thead>
          <tr>
            <th>结构编号</th>
            <th>类型</th>
            <th>复核状态</th>
            <th>拼接来源</th>
            <th>观察员</th>
            <th>坐标偏差</th>
            <th>当前尺寸</th>
            <th>标定</th>
          </tr>
        </thead>
        <tbody>
          {structures.map((s) => {
            const dev = deviationOf(s);
            const p = primaryObservations(s);
            const cal = getCal(world, s.measurement.calId ?? undefined);
            const fovKeys = s.fovIds
              .map((id) => (world.fovs.find((f) => f.id === id) as FieldOfView | undefined)?.key)
              .filter(Boolean);
            return (
              <tr key={s.id} className={selectedId === s.id ? "active" : ""} onClick={() => onSelect(s)}>
                <td className="mono">{s.code}</td>
                <td>{s.kind}</td>
                <td>
                  <Badge tone={stateTone(s.measurement.state)}>{s.measurement.state}</Badge>
                </td>
                <td>
                  {s.legacy ? (
                    <span className="muted">旧记录 · {s.legacy.raw.slice(0, 10)}…</span>
                  ) : (
                    <span className="source-cell">
                      {fovKeys.join("、")}
                      {s.overlap && <Badge tone="info">重叠合并</Badge>}
                    </span>
                  )}
                </td>
                <td>{p.length ? p.map((o) => o.observer).join(" / ") : <span className="muted">—</span>}</td>
                <td>
                  {dev.distanceUm != null ? (
                    <span className={dev.overLimit ? "text-danger" : ""}>
                      {dev.distanceUm.toFixed(2)} μm
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="mono">
                  {currentSizeUm(world, s) != null ? `${currentSizeUm(world, s)!.toFixed(2)} μm` : "待核"}
                </td>
                <td>
                  {s.measurement.confirmed ? (
                    <span title="已确认件锁定原标定">
                      <Badge tone="good">{s.measurement.confirmed.calLabel} 锁定</Badge>
                      {s.measurement.currentCalId && (
                        <Badge tone="warn">新 {getCal(world, s.measurement.currentCalId)?.label}</Badge>
                      )}
                    </span>
                  ) : (
                    cal?.label ?? <span className="muted">缺</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- 结构详情 ----------
export function StructureDetail({
  world,
  structure,
  calibrations,
  offsets,
  observers,
  onSubmit,
  onConfirm,
  onVerifyLegacy,
}: {
  world: World;
  structure: StructureRecord;
  calibrations: Calibration[];
  offsets: StageOffset[];
  observers: string[];
  onSubmit: (observer: string, note: string) => void;
  onConfirm: () => void;
  onVerifyLegacy: (calId: string, offsetId: string) => void;
}) {
  const s = structure;
  const p = primaryObservations(s);
  const late = lateObservations(s);
  const dev = deviationOf(s);
  const batch = world.batches.find((b) => b.id === s.batchId);
  const obj = objectiveOf(world, s);
  const boundCal = batch ? getCal(world, batch.calId) : null;
  const boundOffset = batch ? getOffset(world, batch.offsetId) : null;
  const currentCal = getCal(world, s.measurement.calId ?? undefined);
  const newerCal = getCal(world, s.measurement.currentCalId ?? undefined);
  const fovKeys = s.fovIds
    .map((id) => world.fovs.find((f) => f.id === id)?.key)
    .filter(Boolean) as string[];

  return (
    <div className="detail-panel">
      <div className="detail-head">
        <div>
          <h3>
            <span className="mono">{s.code}</span> · {s.kind}
          </h3>
          <p>
            全局坐标 ({s.xUm.toFixed(1)}, {s.yUm.toFixed(1)}) μm · 像素径 {s.sizePx.toFixed(1)} px
          </p>
        </div>
        <Badge tone={stateTone(s.measurement.state)}>{s.measurement.state}</Badge>
      </div>

      <section className="detail-block">
        <h4>扫描绑定与拼接来源</h4>
        {batch ? (
          <>
            <p className="bind-line">
              批次 <b>{batch.code}</b> · 物镜 <b>{obj}</b> · 标定 <b>{boundCal?.label}</b>（{boundCal?.umPerPx} μm/px） · 偏移 <b>{boundOffset?.label}</b>
            </p>
            <div className="source-tags">
              {fovKeys.map((k) => (
                <Badge key={k} tone="neutral">
                  视野 {k}
                </Badge>
              ))}
              {s.overlap && <Badge tone="info">重叠区 {s.fovIds.length} 视野合并 · 仅一个编号</Badge>}
              {!s.overlap && <Badge tone="neutral">单视野检出</Badge>}
            </div>
          </>
        ) : (
          <div className="legacy-box">
            <Badge tone="danger">旧记录</Badge>
            <p>{s.legacy?.raw}</p>
            <p className="muted">
              缺标定版本：{s.legacy?.missingCal ? "是" : "否"} · 缺载物台偏移：{s.legacy?.missingOffset ? "是" : "否"}
              {s.offsetId && <> · 已补偏移 {getOffset(world, s.offsetId)?.label}</>}
            </p>
          </div>
        )}
      </section>

      <section className="detail-block">
        <h4>观察员坐标（两份正式坐标并列保留）</h4>
        {p.length === 0 && <p className="muted">尚无观察员提交。</p>}
        <div className="obs-list">
          {p.map((o, i) => (
            <div key={o.id} className="obs-card">
              <header>
                <b>
                  {i + 1}. {o.observer}
                </b>
                <Badge tone="neutral">正式坐标</Badge>
                <span className="muted">{fmtTime(o.at)}</span>
              </header>
              <p className="mono">
                ({o.xUm.toFixed(2)}, {o.yUm.toFixed(2)}) μm · 径 {o.sizeUm.toFixed(2)} μm
              </p>
              {o.note && <p className="muted">{o.note}</p>}
            </div>
          ))}
          {late.map((o) => (
            <div key={o.id} className="obs-card late">
              <header>
                <b>{o.observer}</b>
                <Badge tone="warn">确认后补交 · 仅备查不覆盖</Badge>
                <span className="muted">{fmtTime(o.at)}</span>
              </header>
              <p className="mono">
                ({o.xUm.toFixed(2)}, {o.yUm.toFixed(2)}) μm · 径 {o.sizeUm.toFixed(2)} μm
              </p>
            </div>
          ))}
        </div>
        {dev.distanceUm != null && (
          <div className={`deviation-box ${dev.overLimit ? "over" : ""}`}>
            <span>
              坐标偏差 <b>{dev.distanceUm.toFixed(2)}</b> μm（预警线 {POS_DEV_LIMIT_UM} μm）
            </span>
            <span>
              尺寸偏差 <b>{dev.dSizePct?.toFixed(1)}</b>%（预警线 {SIZE_DEV_PCT}%）
            </span>
            {dev.overLimit && <Badge tone="danger">超差，需复核</Badge>}
          </div>
        )}
      </section>

      <section className="detail-block">
        <h4>测量复核</h4>
        {s.measurement.state === "待核" ? (
          <LegacyVerifyForm calibrations={calibrations} offsets={offsets} onVerify={onVerifyLegacy} />
        ) : (
          <>
            <div className="measure-box">
              <div>
                <span className="muted">当前推算（依据 {currentCal?.label}）</span>
                <strong className="mono">{(s.sizePx * (currentCal?.umPerPx ?? 0)).toFixed(2)} μm</strong>
              </div>
              {s.measurement.confirmed && (
                <div className="locked-box">
                  <span className="muted">
                    已确认锁定 · {s.measurement.confirmed.by} · {fmtTime(s.measurement.confirmed.at)}
                  </span>
                  <strong className="mono">{s.measurement.confirmed.sizeUm.toFixed(2)} μm</strong>
                  <Badge tone="good">原标定 {s.measurement.confirmed.calLabel} 保留</Badge>
                  {newerCal && <Badge tone="warn">检测到 {newerCal.label}，锁定尺寸不随之变化</Badge>}
                </div>
              )}
            </div>
            {s.measurement.recalculatedFromCalId && (
              <p className="recalc-note">
                ⚠ {fmtTime(s.measurement.recalculatedAt!)} 标定 {getCal(world, s.measurement.recalculatedFromCalId)?.label} 失效，已按{" "}
                {currentCal?.label} 重算为 {(s.measurement.sizeUm ?? 0).toFixed(2)} μm（确认前有效）
              </p>
            )}
            <div className="action-row">
              <select id="observer-select" defaultValue={observers[0]}>
                {observers.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  const sel = document.getElementById("observer-select") as HTMLSelectElement;
                  const note = (document.getElementById("obs-note") as HTMLInputElement)?.value ?? "";
                  onSubmit(sel.value, note);
                }}
              >
                {s.measurement.state === "已确认" ? "补交坐标（备查，不覆盖）" : p.length < 2 ? `提交第 ${p.length + 1} 份坐标` : "再交一份（备查）"}
              </button>
              <input id="obs-note" placeholder="备注（可选）" className="note-input" />
              {s.measurement.state === "待复核" && (
                <button className="primary-action" onClick={onConfirm}>
                  确认测量并锁定尺寸
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <section className="detail-block">
        <h4>复核轨迹</h4>
        <ul className="history-list">
          {s.history.map((h, i) => (
            <li key={i} className={`hist hist-${h.kind}`}>
              <Badge tone={h.kind === "失效" || h.kind === "补交" ? "warn" : h.kind === "确认" || h.kind === "重算" || h.kind === "补录" ? "good" : "neutral"}>
                {h.kind}
              </Badge>
              <span>{h.text}</span>
              <span className="muted">{fmtTime(h.at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function LegacyVerifyForm({
  calibrations,
  offsets,
  onVerify,
}: {
  calibrations: Calibration[];
  offsets: StageOffset[];
  onVerify: (calId: string, offsetId: string) => void;
}) {
  return (
    <div className="verify-form">
      <p className="text-danger">旧记录缺标定版本/载物台偏移，先待核；补录后方可提交测量。</p>
      <div className="action-row">
        <select id="legacy-cal" defaultValue={calibrations[0]?.id}>
          {calibrations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}（{c.objective}，{c.umPerPx} μm/px）
            </option>
          ))}
        </select>
        <select id="legacy-offset" defaultValue={offsets[0]?.id}>
          {offsets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          className="primary-action"
          onClick={() => {
            const calId = (document.getElementById("legacy-cal") as HTMLSelectElement).value;
            const offsetId = (document.getElementById("legacy-offset") as HTMLSelectElement).value;
            onVerify(calId, offsetId);
          }}
        >
          补录并解除待核
        </button>
      </div>
    </div>
  );
}

// ---------- 标定/偏移面板 ----------
export function CalibrationPanel({
  world,
  onPublish,
}: {
  world: World;
  onPublish: (objective: Objective, label: string, umPerPx: number, note: string) => void;
}) {
  const objectives: Objective[] = ["4x", "10x", "40x", "100x"];
  return (
    <div className="cal-panel">
      <div className="cal-lists">
        <div>
          <h4>标定版本</h4>
          <ul className="version-list">
            {world.calibrations.map((c) => (
              <li key={c.id}>
                <Badge tone="info">{c.objective}</Badge>
                <b>{c.label}</b>
                <span className="mono">{c.umPerPx} μm/px</span>
                <span className="muted">生效 {c.effectiveFrom}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>载物台偏移</h4>
          <ul className="version-list">
            {world.offsets.map((o) => (
              <li key={o.id}>
                <b>{o.label}</b>
                <span className="mono">
                  ({o.dxUm}, {o.dyUm}) μm
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="publish-form">
        <h4>发布新标定版本（未确认测量立即失效重算，已确认保留原标定）</h4>
        <div className="action-row">
          <select id="new-cal-objective" defaultValue="40x">
            {objectives.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <input id="new-cal-label" placeholder="版本号 如 40x-v3" />
          <input id="new-cal-scale" type="number" step="0.001" placeholder="μm/px" />
          <input id="new-cal-note" placeholder="备注" className="note-input" />
          <button
            className="danger-btn"
            onClick={() => {
              const objective = (document.getElementById("new-cal-objective") as HTMLSelectElement).value as Objective;
              const label = (document.getElementById("new-cal-label") as HTMLInputElement).value.trim();
              const umPerPx = Number((document.getElementById("new-cal-scale") as HTMLInputElement).value);
              const note = (document.getElementById("new-cal-note") as HTMLInputElement).value.trim();
              if (label && umPerPx > 0) onPublish(objective, label, umPerPx, note);
            }}
          >
            发布并应用
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 自检面板 ----------
export function SelfCheckPanel({ results, onRun }: { results: CheckResult[] | null; onRun: () => void }) {
  const passed = results?.filter((r) => r.pass).length ?? 0;
  return (
    <section className="panel selfcheck">
      <div className="section-heading">
        <div>
          <p>规则引擎</p>
          <h2>业务规则自检</h2>
        </div>
        <button className="primary-action" onClick={onRun}>
          {results ? "重新运行自检" : "运行规则自检"}
        </button>
      </div>
      {results && (
        <>
          <p className="check-summary">
            {passed}/{results.length} 通过
          </p>
          <ul className="check-list">
            {results.map((r) => (
              <li key={r.name} className={r.pass ? "pass" : "fail"}>
                <span>{r.pass ? "✓" : "✗"}</span>
                <b>{r.name}</b>
                {!r.pass && <span className="muted">{r.detail}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---------- 日志 ----------
export function LogPanel({ logs, resolveScope }: { logs: LogEntry[]; resolveScope: (id: string) => string }) {
  return (
    <ul className="log-list">
      {logs.slice(0, 40).map((l, i) => (
        <li key={i} className={`log log-${l.tone}`}>
          <span className="muted">{fmtTime(l.at)}</span>
          <Badge tone={l.tone === "good" ? "good" : l.tone === "warn" ? "warn" : "neutral"}>{resolveScope(l.scope)}</Badge>
          <span>{l.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- 样本详情头 ----------
export function SampleSummary({ world, sampleId }: { world: World; sampleId: string }) {
  const sample = world.samples.find((x) => x.id === sampleId);
  if (!sample) return null;
  const list = structuresOfSample(world, sampleId);
  const counts = {
    total: list.length,
    overlap: list.filter((s) => s.overlap).length,
    pending: list.filter((s) => s.measurement.state === "待复核").length,
    confirmed: list.filter((s) => s.measurement.state === "已确认").length,
    legacy: list.filter((s) => s.measurement.state === "待核").length,
  };
  return (
    <div className="sample-summary">
      <div>
        <h3>
          {sample.code} · {sample.name}
        </h3>
        <p className="muted">
          {sample.category} · {sample.stain}
        </p>
      </div>
      <div className="summary-chips">
        <Badge tone="neutral">结构 {counts.total}</Badge>
        <Badge tone="info">重叠合并 {counts.overlap}</Badge>
        <Badge tone="warn">待复核 {counts.pending}</Badge>
        <Badge tone="good">已确认 {counts.confirmed}</Badge>
        <Badge tone="danger">待核旧记录 {counts.legacy}</Badge>
      </div>
    </div>
  );
}
