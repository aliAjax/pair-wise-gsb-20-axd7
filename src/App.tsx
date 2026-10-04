import { useMemo, useState } from "react";
import "./styles.css";
import {
  STATUS_LABEL,
  batchPendingReasons,
  confirmMeasurement,
  exportReport,
  getCalibration,
  ingestBatch,
  measurementDeviation,
  publishCalibration,
  submitMeasurement,
} from "./domain/engine";
import type { LabState, Measurement, Pt } from "./domain/types";
import { RESUME_PAYLOAD, buildSeedState } from "./data/seed";

const project = {
  id: "hxwl-06",
  port: 5106,
  title: "显微镜玻片观察 · 视野拼接与测量复核台",
  subtitle:
    "扫描批次绑定样本、物镜倍率、标定版本与载物台偏移；重叠区结构只保留一个编号，双人测量并列复核，标定更新未确认即失效重算。",
};

type TabKey = "samples" | "review" | "calibration" | "export";

const TABS: { key: TabKey; label: string }[] = [
  { key: "samples", label: "样本详情" },
  { key: "review", label: "测量复核" },
  { key: "calibration", label: "标定与导入" },
  { key: "export", label: "导出" },
];

function now() {
  return "2026-10-04 " + new Date().toTimeString().slice(0, 5);
}

function fmtPt(p: Pt | null) {
  return p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})µm` : "待核";
}

function StatusBadge({ status }: { status: Measurement["status"] }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

function App() {
  const [state, setState] = useState<LabState>(buildSeedState);
  const [tab, setTab] = useState<TabKey>("samples");
  const [sampleId, setSampleId] = useState("SMP-01");
  const [notice, setNotice] = useState<string>("");

  // 测量提交表单
  const [formStructure, setFormStructure] = useState("ST-0001");
  const [formObserver, setFormObserver] = useState("学生丙");
  const [formPoints, setFormPoints] = useState("[600,100],[662,101]");

  const sample = state.samples.find((s) => s.id === sampleId)!;
  const sampleBatches = state.batches.filter((b) => b.sampleId === sampleId);
  const sampleStructures = state.structures.filter((s) => s.sampleId === sampleId);

  const pendingCount = state.measurements.filter(
    (m) => m.status === "unconfirmed" || m.status === "pending-review",
  ).length;

  const metrics = [
    { label: "样本数", value: String(state.samples.length) },
    { label: "扫描批次", value: String(state.batches.length) },
    { label: "拼接结构", value: String(state.structures.length) },
    { label: "待复核/待核", value: String(pendingCount) },
  ];

  // 每个结构下 ≥2 条有效测量的偏差对
  const deviationPairs = useMemo(() => {
    const pairs: {
      structureId: string;
      a: Measurement;
      b: Measurement;
      lengthDiffUm: number | null;
      midpointOffsetUm: number;
    }[] = [];
    for (const st of state.structures) {
      const ms = state.measurements.filter(
        (m) =>
          m.structureId === st.id &&
          m.status !== "invalidated" &&
          m.status !== "pending-review",
      );
      const calib = getCalibration(state, ms[0]?.calibrationVersionId ?? null);
      const k = calib ? calib.umPerPixel[st.objective] : 0;
      for (let i = 0; i < ms.length; i++) {
        for (let j = i + 1; j < ms.length; j++) {
          const d = measurementDeviation(ms[i], ms[j], k);
          pairs.push({ structureId: st.id, a: ms[i], b: ms[j], ...d });
        }
      }
    }
    return pairs;
  }, [state]);

  function handleSubmitMeasurement() {
    const m = formPoints.match(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*,\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/);
    if (!m) {
      setNotice("坐标格式应为 [x1,y1],[x2,y2]");
      return;
    }
    const points: [Pt, Pt] = [
      { x: Number(m[1]), y: Number(m[2]) },
      { x: Number(m[3]), y: Number(m[4]) },
    ];
    try {
      const r = submitMeasurement(
        state,
        { structureId: formStructure, observer: formObserver || "未署名", points },
        now(),
      );
      setState(r.state);
      setNotice(
        `测量 ${r.measurement.id} 已提交（${STATUS_LABEL[r.measurement.status]}）` +
          (r.measurement.lengthUm != null ? `，长度 ${r.measurement.lengthUm.toFixed(2)}µm` : ""),
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  function handleConfirm(id: string) {
    const r = confirmMeasurement(state, id, now());
    setState(r.state);
    setNotice(r.ok ? `测量 ${id} 已确认，尺寸与标定版本锁定` : `无法确认 ${id}：${r.reason}`);
  }

  function handlePublishCalibration() {
    const r = publishCalibration(
      state,
      {
        version: "CAL-2026.10",
        umPerPixel: { "100x": 1.59, "200x": 0.795, "400x": 0.398, "1000x": 0.159 },
        note: "物镜复校后发布",
      },
      now(),
    );
    setState(r.state);
    setNotice(
      `标定 CAL-2026.10 已发布：${r.invalidated.length} 条未确认测量失效（${r.invalidated.join(", ") || "无"}），` +
        `重算生成 ${r.recomputed.join(", ") || "无"}；已确认测量保留原标定与尺寸`,
    );
  }

  function handleResume() {
    const r = ingestBatch(
      state,
      RESUME_PAYLOAD.batch,
      RESUME_PAYLOAD.fields,
      RESUME_PAYLOAD.observations,
      now(),
    );
    setState(r.state);
    setNotice(
      `批次 B-02 恢复导入：补录视野 ${r.summary.addedFields} 个，跳过重放视野 ${r.summary.skippedFields} 个；` +
        `新增结构 ${r.summary.newStructures.join(", ") || "无"}，重放未新增结构`,
    );
  }

  const report = useMemo(() => exportReport(state, now()), [state]);

  function downloadReport() {
    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "视野拼接与测量复核导出.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">{project.id} · port {project.port}</p>
          <h1>{project.title}</h1>
          <p className="subtitle">{project.subtitle}</p>
        </div>
        <div className="stack-card">
          <span>复核规则</span>
          <strong>重叠区单一编号 · 双人测量并列保留 · 后到数据不覆盖已确认 · 标定更新未确认即重算</strong>
        </div>
      </section>

      <section className="metrics-grid">
        {metrics.map((m, i) => (
          <article key={m.label} className="metric-card">
            <span>{m.label}</span>
            <strong>{m.value}</strong>
            <i className={["status-ok", "status-watch", "status-danger", "status-ok"][i % 4]} />
          </article>
        ))}
      </section>

      <nav className="tab-bar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "tab active" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {notice && <p className="notice">{notice}</p>}

      {tab === "samples" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p>样本详情</p>
              <h2>{sample.name}（{sample.sampleType} · {sample.stain}）</h2>
            </div>
            <div className="chips">
              {state.samples.map((s) => (
                <button
                  key={s.id}
                  className={s.id === sampleId ? "chip-active" : ""}
                  onClick={() => setSampleId(s.id)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          <h3 className="table-title">扫描批次（绑定倍率 / 标定版本 / 载物台偏移）</h3>
          <table>
            <thead>
              <tr>
                <th>批次</th><th>倍率</th><th>标定版本</th><th>载物台偏移</th><th>视野</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              {sampleBatches.map((b) => {
                const reasons = batchPendingReasons(b);
                const calib = getCalibration(state, b.calibrationVersionId);
                const fieldCount = state.fields.filter((f) => f.batchId === b.id).length;
                return (
                  <tr key={b.id}>
                    <td>{b.id}</td>
                    <td>{b.objective}</td>
                    <td>{calib ? calib.version : <span className="badge badge-pending-review">待核</span>}</td>
                    <td>{b.stageOffset ? `(${b.stageOffset.x}, ${b.stageOffset.y})µm` : <span className="badge badge-pending-review">待核</span>}</td>
                    <td>{fieldCount}/{b.totalFields}</td>
                    <td>
                      {b.status === "complete" ? "完成" : <span className="badge badge-unconfirmed">中断</span>}
                      {reasons.length > 0 && <span className="muted"> 待核：{reasons.join("、")}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h3 className="table-title">拼接结构（重叠区只生成一个编号）</h3>
          <table>
            <thead>
              <tr>
                <th>编号</th><th>结构</th><th>拼接坐标</th><th>来源视野</th><th>来源批次</th><th>观察数</th>
              </tr>
            </thead>
            <tbody>
              {sampleStructures.map((st) => (
                <tr key={st.id}>
                  <td><strong>{st.id}</strong></td>
                  <td>{st.label}</td>
                  <td>{fmtPt(st.stagePos)}</td>
                  <td>{st.sourceFieldIds.join(", ")}</td>
                  <td>{st.sourceBatchIds.join(", ")}</td>
                  <td>
                    {st.observationIds.length}
                    {st.observationIds.length > 1 && <span className="muted">（已合并）</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "review" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p>测量复核</p>
              <h2>测量列表（含复核状态与标定版本）</h2>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>编号</th><th>结构</th><th>观察员</th><th>长度</th><th>标定版本</th><th>状态</th><th>备注</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {state.measurements.map((m) => {
                const calib = getCalibration(state, m.calibrationVersionId);
                return (
                  <tr key={m.id}>
                    <td><strong>{m.id}</strong></td>
                    <td>{m.structureId}</td>
                    <td>{m.observer}</td>
                    <td>{m.lengthUm != null ? `${m.lengthUm.toFixed(2)}µm` : "—"}</td>
                    <td>{calib ? calib.version : "待核"}</td>
                    <td><StatusBadge status={m.status} /></td>
                    <td className="muted">{m.note ?? ""}</td>
                    <td>
                      {m.status === "unconfirmed" && (
                        <button onClick={() => handleConfirm(m.id)}>确认</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h3 className="table-title">双人测量偏差（两份坐标均保留）</h3>
          {deviationPairs.length === 0 && <p className="muted">暂无可比较的测量对</p>}
          <div className="record-list">
            {deviationPairs.map((p) => (
              <article key={`${p.a.id}-${p.b.id}`} className="record-card">
                <div className="record-index">{p.structureId.slice(3)}</div>
                <div>
                  <h3>
                    {p.a.id}（{p.a.observer}） vs {p.b.id}（{p.b.observer}）
                  </h3>
                  <p>
                    长度偏差 {p.lengthDiffUm != null ? `${p.lengthDiffUm.toFixed(2)}µm` : "—"}
                    {" · "}中心偏移 {p.midpointOffsetUm.toFixed(2)}µm
                    {" · "}{p.a.observer}：{p.a.lengthUm?.toFixed(2) ?? "—"}µm（{STATUS_LABEL[p.a.status]}）
                    {" · "}{p.b.observer}：{p.b.lengthUm?.toFixed(2) ?? "—"}µm（{STATUS_LABEL[p.b.status]}）
                  </p>
                </div>
              </article>
            ))}
          </div>

          <h3 className="table-title">提交测量（后到数据不覆盖已确认测量）</h3>
          <div className="field-grid">
            <label>
              <span>结构编号</span>
              <select value={formStructure} onChange={(e) => setFormStructure(e.target.value)}>
                {state.structures.map((s) => (
                  <option key={s.id} value={s.id}>{s.id} {s.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>观察员</span>
              <input value={formObserver} onChange={(e) => setFormObserver(e.target.value)} />
            </label>
            <label>
              <span>端点坐标（全景像素，格式 [x1,y1],[x2,y2]）</span>
              <input value={formPoints} onChange={(e) => setFormPoints(e.target.value)} />
            </label>
            <label>
              <span>&nbsp;</span>
              <button className="primary-action" onClick={handleSubmitMeasurement}>提交测量</button>
            </label>
          </div>
        </section>
      )}

      {tab === "calibration" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p>标定与导入</p>
              <h2>标定版本</h2>
            </div>
            <button className="primary-action" onClick={handlePublishCalibration}>
              发布新标定 CAL-2026.10
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>版本</th><th>发布时间</th><th>100x</th><th>200x</th><th>400x</th><th>1000x</th><th>备注</th>
              </tr>
            </thead>
            <tbody>
              {state.calibrations.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.version}</strong></td>
                  <td>{c.issuedAt}</td>
                  <td>{c.umPerPixel["100x"]}</td>
                  <td>{c.umPerPixel["200x"]}</td>
                  <td>{c.umPerPixel["400x"]}</td>
                  <td>{c.umPerPixel["1000x"]}</td>
                  <td className="muted">{c.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">单位 µm/px。发布后未确认测量立即失效并按新标定重算；已确认测量保留原标定与尺寸。</p>

          <h3 className="table-title">扫描批次导入 / 中断恢复</h3>
          <table>
            <thead>
              <tr>
                <th>批次</th><th>样本</th><th>倍率</th><th>视野进度</th><th>状态</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {state.batches.map((b) => {
                const fieldCount = state.fields.filter((f) => f.batchId === b.id).length;
                const reasons = batchPendingReasons(b);
                return (
                  <tr key={b.id}>
                    <td>{b.id}</td>
                    <td>{b.sampleId}</td>
                    <td>{b.objective}</td>
                    <td>{fieldCount}/{b.totalFields}</td>
                    <td>
                      {b.status === "complete" ? "完成" : <span className="badge badge-unconfirmed">中断</span>}
                      {reasons.length > 0 && <span className="badge badge-pending-review">待核</span>}
                    </td>
                    <td>
                      {b.id === "B-02" && b.status === "interrupted" && (
                        <button onClick={handleResume}>恢复导入（只补未完成视野）</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">
            恢复时从完整扫描批次接续，只补未完成视野；已导入视野的观察记录重放不新增结构。旧记录缺标定版本或载物台偏移时先标记待核。
          </p>
        </section>
      )}

      {tab === "export" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p>导出</p>
              <h2>样本详情 + 测量列表（含拼接来源与复核状态）</h2>
            </div>
            <button className="primary-action" onClick={downloadReport}>下载导出文件</button>
          </div>
          <pre className="export-view">{report}</pre>
        </section>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>操作日志</p>
            <h2>拼接与复核事件</h2>
          </div>
        </div>
        <div className="record-list">
          {[...state.log].reverse().slice(0, 12).map((entry, i) => (
            <article key={`${entry.time}-${i}`} className="record-card">
              <div className="record-index log-index">{entry.time.slice(5)}</div>
              <div><p>{entry.text}</p></div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
