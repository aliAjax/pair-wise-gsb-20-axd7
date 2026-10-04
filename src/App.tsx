import { useMemo, useState } from "react";
import "./styles.css";
import {
  addCalibration,
  addSample,
  batchProgress,
  confirmStructure,
  createBatch,
  expectedStructureCount,
  exportCsv,
  getBatch,
  ingestFov,
  interruptBatch,
  resumeBatch,
  structuresOfSample,
  submitObservation,
  verifyLegacy,
} from "./engine";
import { buildDemoWorld } from "./seed";
import { runSelfChecks, type CheckResult } from "./selfcheck";
import type { Objective, StructureRecord, World } from "./types";
import {
  BatchCard,
  CalibrationPanel,
  LogPanel,
  SampleSummary,
  SelfCheckPanel,
  StructureDetail,
  StructureTable,
} from "./components";

const SAMPLE_PRESETS = [
  { name: "草履虫涂片", category: "微生物", stain: "活体观察" },
  { name: "蚕豆叶下表皮", category: "植物组织", stain: "番红染色" },
  { name: "口腔上皮涂片", category: "动物组织", stain: "亚甲蓝" },
];

function App() {
  const [world, setWorld] = useState<World>(() => buildDemoWorld());
  const [selectedSampleId, setSelectedSampleId] = useState<string>(() => world.samples[0]?.id ?? "");
  const [selectedBatchId, setSelectedBatchId] = useState<string>(() => world.batches[0]?.id ?? "");
  const [selectedStructureId, setSelectedStructureId] = useState<string | undefined>(undefined);
  const [stateFilter, setStateFilter] = useState<string>("全部");
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [, force] = useState(0);

  const commit = (mutate: (w: World) => void) => {
    const draft = structuredClone(world) as World;
    mutate(draft);
    setWorld(draft);
    force((n) => n + 1);
  };

  const selectedStructure = world.structures.find((s) => s.id === selectedStructureId);
  const sampleStructures = useMemo(
    () => structuresOfSample(world, selectedSampleId),
    [world, selectedSampleId],
  );
  const filteredStructures =
    stateFilter === "全部"
      ? sampleStructures
      : sampleStructures.filter((s) => s.measurement.state === stateFilter);

  const metrics = [
    { label: "扫描批次", value: world.batches.length, tone: "进行中 " + world.batches.filter((b) => b.status !== "已完成").length },
    { label: "拼接结构", value: world.structures.length, tone: "重叠合并 " + world.structures.filter((s) => s.overlap).length },
    { label: "已确认测量", value: world.structures.filter((s) => s.measurement.state === "已确认").length, tone: "后到不覆盖" },
    { label: "待核旧记录", value: world.structures.filter((s) => s.measurement.state === "待核").length, tone: "补录后恢复" },
  ];

  const downloadCsv = () => {
    const csv = exportCsv(world);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `视野拼接测量复核_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const createScan = () => {
    const sampleId = (document.getElementById("scan-sample") as HTMLSelectElement).value;
    const objective = (document.getElementById("scan-objective") as HTMLSelectElement).value as Objective;
    const calId = (document.getElementById("scan-cal") as HTMLSelectElement).value;
    const offsetId = (document.getElementById("scan-offset") as HTMLSelectElement).value;
    const cols = Number((document.getElementById("scan-cols") as HTMLInputElement).value) || 2;
    const rows = Number((document.getElementById("scan-rows") as HTMLInputElement).value) || 2;
    commit((w) => {
      const b = createBatch(w, { sampleId, objective, calId, offsetId, cols, rows, overlapPct: 0.2 });
      setSelectedSampleId(sampleId);
      setSelectedBatchId(b.id);
    });
  };

  const addPresetSample = () => {
    const preset = SAMPLE_PRESETS[world.samples.length % SAMPLE_PRESETS.length];
    commit((w) => addSample(w, preset));
  };

  const selectStructure = (s: StructureRecord) => setSelectedStructureId(s.id);

  const scopeName = (scope: string) => {
    if (scope === "global") return "全局";
    const b = getBatch(world, scope);
    return b?.code ?? scope;
  };

  const eligibleCals = world.calibrations.filter((c) => {
    const obj = (document.getElementById("scan-objective") as HTMLSelectElement | null)?.value as Objective | undefined;
    return !obj || c.objective === obj;
  });

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-06 · 实验课多倍率玻片扫描</p>
          <h1>视野拼接与测量复核台</h1>
          <p className="subtitle">
            每次扫描绑定样本、物镜倍率、标定版本与载物台偏移；重叠区只发一个结构编号。两名观察员双坐标并列留痕、列出偏差；
            标定一更新，未确认测量立即失效重算，已确认测量锁定原标定与尺寸；导入中断后从完整批次恢复，只补未完成视野。
          </p>
        </div>
        <div className="stack-card">
          <span>规则基线</span>
          <strong>重叠单一编号 · 双坐标复核 · 确认不可覆盖 · 标定版本化 · 断点幂等恢复 · 旧记录先待核</strong>
        </div>
      </section>

      <section className="metrics-grid">
        {metrics.map((m) => (
          <article key={m.label} className="metric-card">
            <span>{m.label}</span>
            <strong>{m.value}</strong>
            <i className="metric-note">{m.tone}</i>
          </article>
        ))}
      </section>

      <section className="panel control-panel">
        <div className="section-heading">
          <div>
            <p>扫描作业</p>
            <h2>新建扫描批次</h2>
          </div>
          <div className="heading-actions">
            <button onClick={addPresetSample}>新增示例样本</button>
            <button className="primary-action" onClick={downloadCsv}>
              导出复核 CSV（含拼接来源/状态）
            </button>
            <button onClick={() => setWorld(buildDemoWorld())}>重置演示数据</button>
          </div>
        </div>
        <div className="scan-form">
          <label>
            <span>样本</span>
            <select id="scan-sample" defaultValue={selectedSampleId}>
              {world.samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>物镜倍率</span>
            <select id="scan-objective" defaultValue="40x" onChange={() => force((n) => n + 1)}>
              {["4x", "10x", "40x", "100x"].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
          <label>
            <span>标定版本</span>
            <select id="scan-cal">
              {eligibleCals.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} · {c.umPerPx} μm/px
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>载物台偏移</span>
            <select id="scan-offset">
              {world.offsets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} ({o.dxUm},{o.dyUm})
                </option>
              ))}
            </select>
          </label>
          <label className="mini">
            <span>列</span>
            <input id="scan-cols" type="number" min={1} max={6} defaultValue={2} />
          </label>
          <label className="mini">
            <span>行</span>
            <input id="scan-rows" type="number" min={1} max={6} defaultValue={2} />
          </label>
          <button className="primary-action form-submit" onClick={createScan}>
            创建扫描（绑定标定+偏移）
          </button>
        </div>
      </section>

      <section className="workspace two-col">
        <div className="panel batches-panel">
          <div className="section-heading">
            <div>
              <p>导入与恢复</p>
              <h2>扫描批次</h2>
            </div>
          </div>
          <div className="batch-list">
            {world.batches.map((b) => (
              <BatchCard
                key={b.id}
                world={world}
                batch={b}
                selected={b.id === selectedBatchId}
                onSelect={() => {
                  setSelectedBatchId(b.id);
                  setSelectedSampleId(b.sampleId);
                }}
                onIngestNext={() =>
                  commit((w) => {
                    const key = getBatch(w, b.id)!.order.find((k) => !getBatch(w, b.id)!.importedKeys.includes(k));
                    if (key) ingestFov(w, b.id, key);
                  })
                }
                onInterrupt={() => commit((w) => interruptBatch(w, b.id))}
                onResume={() => commit((w) => resumeBatch(w, b.id))}
              />
            ))}
          </div>

          <CalibrationPanel
            world={world}
            onPublish={(objective, label, umPerPx, note) =>
              commit((w) =>
                addCalibration(
                  w,
                  { objective, label, umPerPx, effectiveFrom: new Date().toISOString().slice(0, 10), note },
                  true,
                ),
              )
            }
          />
        </div>

        <div className="panel review-panel">
          <div className="sample-tabs">
            {world.samples.map((s) => (
              <button key={s.id} className={s.id === selectedSampleId ? "active" : ""} onClick={() => setSelectedSampleId(s.id)}>
                {s.code} {s.name}
              </button>
            ))}
          </div>
          <SampleSummary world={world} sampleId={selectedSampleId} />

          <div className="filter-bar">
            {["全部", "待测量", "待复核", "已确认", "待核"].map((f) => (
              <button key={f} className={stateFilter === f ? "active" : ""} onClick={() => setStateFilter(f)}>
                {f}
              </button>
            ))}
            <span className="muted">
              批次恢复进度：
              {(() => {
                const b = getBatch(world, selectedBatchId);
                if (!b) return "—";
                const p = batchProgress(world, b);
                return `${b.code} ${p.done}/${p.total}（规划结构 ${expectedStructureCount(b)}）`;
              })()}
            </span>
          </div>

          <StructureTable world={world} structures={filteredStructures} selectedId={selectedStructureId} onSelect={selectStructure} />

          {selectedStructure && (
            <StructureDetail
              key={selectedStructure.id}
              world={world}
              structure={selectedStructure}
              calibrations={world.calibrations}
              offsets={world.offsets}
              observers={["王老师", "李同学", "张助教"]}
              onSubmit={(observer, note) =>
                commit((w) => submitObservation(w, selectedStructure.id, { observer, note: note || undefined }))
              }
              onConfirm={() => commit((w) => confirmStructure(w, selectedStructure.id, "实验管理员"))}
              onVerifyLegacy={(calId, offsetId) =>
                commit((w) => verifyLegacy(w, selectedStructure.id, calId, offsetId))
              }
            />
          )}
        </div>
      </section>

      <SelfCheckPanel results={checks} onRun={() => setChecks(runSelfChecks())} />

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>审计轨迹</p>
            <h2>操作与规则日志</h2>
          </div>
        </div>
        <LogPanel logs={world.logs} resolveScope={scopeName} />
      </section>

      <footer className="footnote">
        规则要点：① 重叠区检出合并到同一结构编号；② 两名观察员两份坐标均保留并算偏差；③ 确认后补交只登记备查；④
        标定更新只重算未确认件；⑤ 批次恢复按规划顺序补导，幂等不新增结构；⑥ 旧记录缺标定版本或偏移先待核。
      </footer>
    </main>
  );
}

export default App;
