import type {
  Calibration,
  ConfirmedSnapshot,
  FieldOfView,
  HistoryEvent,
  LogEntry,
  MeasurementState,
  Objective,
  Observation,
  PlannedDetection,
  RawDetection,
  Sample,
  ScanBatch,
  StageOffset,
  StructureRecord,
  World,
} from "./types";

// ---------- 规则常量 ----------
export const MERGE_RADIUS_UM = 4; // 重叠区同一结构判定半径（μm）
export const POS_DEV_LIMIT_UM = 2.5; // 双观察员坐标偏差预警（μm）
export const SIZE_DEV_PCT = 8; // 尺寸偏差预警百分比

export const OBSERVERS = ["王老师", "李同学", "张助教"];

export function nowIso(): string {
  return new Date().toISOString();
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function uid(world: World, prefix: string): string {
  world.seq[prefix] = (world.seq[prefix] ?? 0) + 1;
  return `${prefix}-${world.seq[prefix]}`;
}

export function pushLog(
  world: World,
  scope: string,
  text: string,
  tone: LogEntry["tone"] = "info",
): void {
  world.logs.unshift({ at: nowIso(), scope, text, tone });
  if (world.logs.length > 300) world.logs.length = 300;
}

export function addHistory(s: StructureRecord, kind: HistoryEvent["kind"], text: string): void {
  s.history.unshift({ at: nowIso(), kind, text });
}

// 确定性伪随机：同一批次/点位在任意时刻重放结果一致，重放不新增结构
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------- 查询选择器 ----------
export function getCal(world: World, calId: string | null | undefined): Calibration | undefined {
  return world.calibrations.find((c) => c.id === calId);
}

export function getOffset(world: World, id: string | null | undefined): StageOffset | undefined {
  return world.offsets.find((o) => o.id === id);
}

export function getBatch(world: World, id: string | null | undefined): ScanBatch | undefined {
  return world.batches.find((b) => b.id === id);
}

export function objectiveOf(world: World, s: StructureRecord): Objective | null {
  const b = getBatch(world, s.batchId);
  if (b) return b.objective;
  const c = getCal(world, s.measurement.calId);
  return c ? c.objective : null;
}

export function fovGeometry(batch: ScanBatch, cal: Calibration, offset: StageOffset) {
  const widthUm = batch.fovWidthPx * cal.umPerPx;
  const heightUm = batch.fovHeightPx * cal.umPerPx;
  const pitchX = widthUm * (1 - batch.overlapPct);
  const pitchY = heightUm * (1 - batch.overlapPct);
  const origin = (col: number, row: number) => ({
    x: offset.dxUm + col * pitchX,
    y: offset.dyUm + row * pitchY,
  });
  return { widthUm, heightUm, pitchX, pitchY, origin };
}

export function expectedStructureCount(batch: ScanBatch): number {
  return batch.cols * batch.rows + (batch.cols - 1) * batch.rows + batch.cols * (batch.rows - 1);
}

export function batchProgress(world: World, batch: ScanBatch) {
  const total = batch.order.length;
  const done = batch.importedKeys.length;
  return { total, done, pct: Math.round((done / total) * 100) };
}

export function fovsOfBatch(world: World, batchId: string): FieldOfView[] {
  return world.fovs.filter((f) => f.batchId === batchId);
}

export function structuresOfSample(world: World, sampleId: string): StructureRecord[] {
  return world.structures.filter((s) => s.sampleId === sampleId);
}

export function primaryObservations(s: StructureRecord): Observation[] {
  return s.observations.filter((o) => o.primary && !o.afterLock);
}

export function lateObservations(s: StructureRecord): Observation[] {
  return s.observations.filter((o) => o.afterLock);
}

export interface DeviationInfo {
  distanceUm: number | null;
  dSizeUm: number | null;
  dSizePct: number | null;
  overLimit: boolean;
}

export function deviationOf(s: StructureRecord): DeviationInfo {
  const p = primaryObservations(s);
  if (p.length < 2) {
    return { distanceUm: null, dSizeUm: null, dSizePct: null, overLimit: false };
  }
  const distanceUm = Math.hypot(p[0].xUm - p[1].xUm, p[0].yUm - p[1].yUm);
  const dSizeUm = Math.abs(p[0].sizeUm - p[1].sizeUm);
  const base = Math.max(p[0].sizeUm, p[1].sizeUm, 1e-6);
  const dSizePct = (dSizeUm / base) * 100;
  return {
    distanceUm,
    dSizeUm,
    dSizePct,
    overLimit: distanceUm > POS_DEV_LIMIT_UM || dSizePct > SIZE_DEV_PCT,
  };
}

// 未确认测量：按当前标定重算；已确认：沿用锁定尺寸
export function currentSizeUm(world: World, s: StructureRecord): number | null {
  const m = s.measurement;
  if (m.state === "已确认" && m.confirmed) return m.confirmed.sizeUm;
  const cal = getCal(world, m.calId);
  if (!cal) return null;
  return s.sizePx * cal.umPerPx;
}

export function statusBadge(state: MeasurementState["state"]): string {
  return state;
}

// ---------- 基础建档 ----------
export function addSample(
  world: World,
  input: { name: string; category: string; stain: string },
): Sample {
  const n = world.samples.length + 1;
  const sample: Sample = {
    id: uid(world, "sample"),
    code: `S${String(n).padStart(2, "0")}`,
    name: input.name,
    category: input.category,
    stain: input.stain,
    createdAt: nowIso(),
  };
  world.samples.push(sample);
  pushLog(world, "global", `新建样本 ${sample.code} ${sample.name}`, "good");
  return sample;
}

export function addCalibration(
  world: World,
  input: {
    objective: Objective;
    label: string;
    umPerPx: number;
    effectiveFrom: string;
    note?: string;
  },
  apply = false,
): Calibration {
  const cal: Calibration = { id: uid(world, "cal"), ...input };
  world.calibrations.push(cal);
  pushLog(world, "global", `登记标定 ${cal.label}（${cal.objective}，${cal.umPerPx} μm/px）`);
  if (apply) applyCalibration(world, cal);
  return cal;
}

export function addOffset(
  world: World,
  input: { label: string; dxUm: number; dyUm: number },
): StageOffset {
  const offset: StageOffset = { id: uid(world, "off"), ...input };
  world.offsets.push(offset);
  pushLog(world, "global", `登记载物台偏移 ${offset.label}（${offset.dxUm}, ${offset.dyUm}）μm`);
  return offset;
}

// ---------- 扫描批次与视野规划 ----------
export interface CreateBatchInput {
  sampleId: string;
  objective: Objective;
  calId: string;
  offsetId: string;
  cols: number;
  rows: number;
  fovWidthPx?: number;
  fovHeightPx?: number;
  overlapPct?: number;
}

export function createBatch(world: World, input: CreateBatchInput): ScanBatch {
  const cal = getCal(world, input.calId);
  const offset = getOffset(world, input.offsetId);
  if (!cal) throw new Error("标定版本不存在");
  if (!offset) throw new Error("载物台偏移不存在");
  if (cal.objective !== input.objective) throw new Error("标定版本与物镜倍率不匹配");

  const n = world.batches.length + 1;
  const day = nowIso().slice(0, 10).replace(/-/g, "");
  const batch: ScanBatch = {
    id: uid(world, "batch"),
    code: `B-${day}-${String(n).padStart(2, "0")}`,
    sampleId: input.sampleId,
    objective: input.objective,
    calId: input.calId,
    offsetId: input.offsetId,
    cols: input.cols,
    rows: input.rows,
    fovWidthPx: input.fovWidthPx ?? 800,
    fovHeightPx: input.fovHeightPx ?? 600,
    overlapPct: input.overlapPct ?? 0.2,
    status: "进行中",
    plan: {},
    order: [],
    importedKeys: [],
    createdAt: nowIso(),
  };

  const geo = fovGeometry(batch, cal, offset);
  const rng = mulberry32(hashSeed(batch.id));
  for (let row = 0; row < batch.rows; row++) {
    for (let col = 0; col < batch.cols; col++) {
      const key = `${col}-${row}`;
      const o = geo.origin(col, row);
      const points: PlannedDetection[] = [];

      // 视野自有结构（落在非重叠中部区域）
      points.push({
        point: `c${col}x${row}`,
        kind: pickKind(hashSeed(batch.id + key)),
        sizePx: Math.round(22 + rng() * 26),
        xUm: o.x + geo.widthUm * (0.3 + 0.4 * rng()),
        yUm: o.y + geo.heightUm * (0.3 + 0.4 * rng()),
      });

      // 与右侧视野的纵向重叠区：只由左侧视野生成点位，两侧视野各检出一次
      if (col < batch.cols - 1) {
        points.push({
          point: `sV-${col}-${row}`,
          kind: pickKind(hashSeed(batch.id + "V" + key)),
          sizePx: Math.round(22 + mulberry32(hashSeed(batch.id + "V" + key))() * 26),
          xUm: o.x + geo.widthUm * (1 - batch.overlapPct / 2),
          yUm: o.y + geo.heightUm * (0.32 + 0.36 * rng()),
        });
      }

      // 与下侧视野的横向重叠区
      if (row < batch.rows - 1) {
        points.push({
          point: `sH-${col}-${row}`,
          kind: pickKind(hashSeed(batch.id + "H" + key)),
          sizePx: Math.round(22 + mulberry32(hashSeed(batch.id + "H" + key))() * 26),
          xUm: o.x + geo.widthUm * (0.32 + 0.36 * rng()),
          yUm: o.y + geo.heightUm * (1 - batch.overlapPct / 2),
        });
      }

      batch.plan[key] = points;
      batch.order.push(key);
    }
  }

  world.batches.push(batch);
  pushLog(
    world,
    batch.id,
    `创建扫描 ${batch.code}：${input.objective} · ${cal.label} · ${offset.label} · ${batch.cols}×${batch.rows} 视野，规划 ${expectedStructureCount(batch)} 个结构`,
    "good",
  );
  return batch;
}

function pickKind(seed: number): string {
  const kinds = ["细胞核", "导管", "气孔", "液泡", "纤毛环"];
  return kinds[seed % kinds.length];
}

// ---------- 视野导入 + 重叠区拼接（幂等） ----------
export interface IngestResult {
  ingested: number;
  skipped: number;
  created: number;
  merged: number;
  completed: boolean;
}

export function ingestFov(world: World, batchId: string, key: string): IngestResult {
  const result: IngestResult = { ingested: 0, skipped: 0, created: 0, merged: 0, completed: false };
  const batch = getBatch(world, batchId);
  if (!batch) throw new Error("批次不存在");
  if (batch.importedKeys.includes(key)) {
    result.skipped = 1;
    return result;
  }
  const planned = batch.plan[key];
  if (!planned) throw new Error("视野不在批次规划中");
  if (batch.status === "已完成") {
    result.skipped = 1;
    return result;
  }

  const cal = getCal(world, batch.calId)!;
  const offset = getOffset(world, batch.offsetId)!;
  const geo = fovGeometry(batch, cal, offset);
  const [col, row] = key.split("-").map(Number);
  const origin = geo.origin(col, row);

  // 本视野检出 = 自有规划点 + 左侧/上侧视野在重叠区里的共有结构
  const sharedPoints: PlannedDetection[] = [];
  if (col > 0) {
    sharedPoints.push(...(batch.plan[`${col - 1}-${row}`] ?? []).filter((p) => p.point.startsWith("sV-")));
  }
  if (row > 0) {
    sharedPoints.push(...(batch.plan[`${col}-${row - 1}`] ?? []).filter((p) => p.point.startsWith("sH-")));
  }
  const detected = [...planned, ...sharedPoints];

  const fov: FieldOfView = {
    id: uid(world, "fov"),
    batchId: batch.id,
    col,
    row,
    key,
    originXUm: origin.x,
    originYUm: origin.y,
    widthUm: geo.widthUm,
    heightUm: geo.heightUm,
    importedAt: nowIso(),
  };
  world.fovs.push(fov);

  for (const p of detected) {
    // 同一结构在不同视野检出时坐标有亚微米级抖动，但落在合并半径内
    const jitter = mulberry32(hashSeed(batch.id + p.point + key));
    const det: RawDetection = {
      id: uid(world, "det"),
      batchId: batch.id,
      fovId: fov.id,
      xUm: p.xUm + (jitter() - 0.5) * 0.8,
      yUm: p.yUm + (jitter() - 0.5) * 0.8,
      sizePx: p.sizePx,
      kind: p.kind,
    };
    world.detections.push(det);
    const mergeTo = findMergeTarget(world, batch.id, det.xUm, det.yUm);
    if (mergeTo) {
      mergeDetection(world, mergeTo, det, fov);
      result.merged += 1;
    } else {
      createStructure(world, batch, fov, det);
      result.created += 1;
    }
  }

  batch.importedKeys.push(key);
  result.ingested = 1;
  if (batch.importedKeys.length === batch.order.length) {
    batch.status = "已完成";
    batch.finishedAt = nowIso();
    result.completed = true;
    pushLog(world, batch.id, `扫描 ${batch.code} 全部 ${batch.order.length} 个视野导入完成`, "good");
  }
  return result;
}

export function interruptBatch(world: World, batchId: string): void {
  const batch = getBatch(world, batchId);
  if (!batch || batch.status === "已完成") return;
  batch.status = "已中断";
  pushLog(
    world,
    batch.id,
    `扫描 ${batch.code} 导入中断：已完成 ${batch.importedKeys.length}/${batch.order.length} 视野，批次保留待恢复`,
    "warn",
  );
}

// 从完整扫描批次恢复：只补未完成视野，重放不新增结构
export function resumeBatch(world: World, batchId: string): IngestResult {
  const batch = getBatch(world, batchId);
  if (!batch) throw new Error("批次不存在");
  const totals: IngestResult = { ingested: 0, skipped: 0, created: 0, merged: 0, completed: false };
  if (batch.status === "已完成") {
    totals.skipped = batch.order.length;
    pushLog(world, batch.id, `扫描 ${batch.code} 已完成，重放 ${totals.skipped} 个视野全部跳过，结构不变`, "info");
    return totals;
  }
  const before = world.structures.filter((s) => s.batchId === batch.id).length;
  for (const key of batch.order) {
    const r = ingestFov(world, batch.id, key);
    totals.ingested += r.ingested;
    totals.skipped += r.skipped;
    totals.created += r.created;
    totals.merged += r.merged;
  }
  totals.completed = getBatch(world, batchId)!.status === "已完成";
  const after = world.structures.filter((s) => s.batchId === batch.id).length;
  pushLog(
    world,
    batch.id,
    `恢复扫描 ${batch.code}：补导 ${totals.ingested} 个视野，跳过已完成 ${totals.skipped} 个；结构 ${before}→${after}（重放不新增重复结构）`,
    "good",
  );
  return totals;
}

function findMergeTarget(
  world: World,
  batchId: string,
  x: number,
  y: number,
): StructureRecord | null {
  let best: StructureRecord | null = null;
  let bestD = MERGE_RADIUS_UM;
  for (const s of world.structures) {
    if (s.batchId !== batchId) continue;
    const d = Math.hypot(s.xUm - x, s.yUm - y);
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

function createStructure(
  world: World,
  batch: ScanBatch,
  fov: FieldOfView,
  det: RawDetection,
): StructureRecord {
  const sample = world.samples.find((x) => x.id === batch.sampleId);
  const n = world.structures.filter((s) => s.sampleId === batch.sampleId).length + 1;
  const s: StructureRecord = {
    id: uid(world, "st"),
    code: `${sample?.code ?? "S?"}-${String(n).padStart(4, "0")}`,
    sampleId: batch.sampleId,
    batchId: batch.id,
    kind: det.kind,
    xUm: det.xUm,
    yUm: det.yUm,
    sizePx: det.sizePx,
    detectionIds: [det.id],
    fovIds: [fov.id],
    overlap: false,
    observations: [],
    measurement: { state: "待测量", calId: batch.calId, sizeUm: det.sizePx * getCal(world, batch.calId)!.umPerPx },
    history: [{ at: nowIso(), kind: "创建", text: `视野 ${fov.key} 首次检出，生成结构编号` }],
    createdAt: nowIso(),
  };
  world.structures.push(s);
  return s;
}

function mergeDetection(
  world: World,
  s: StructureRecord,
  det: RawDetection,
  fov: FieldOfView,
): void {
  const wasSingle = s.fovIds.length === 1;
  s.detectionIds.push(det.id);
  if (!s.fovIds.includes(fov.id)) s.fovIds.push(fov.id);
  const dets = world.detections.filter((d) => s.detectionIds.includes(d.id));
  s.xUm = dets.reduce((sum, d) => sum + d.xUm, 0) / dets.length;
  s.yUm = dets.reduce((sum, d) => sum + d.yUm, 0) / dets.length;
  s.sizePx = dets.reduce((sum, d) => sum + d.sizePx, 0) / dets.length;
  s.overlap = s.fovIds.length > 1;
  if (wasSingle && s.overlap) {
    addHistory(s, "合并", `重叠区与视野 ${fov.key} 检出合并，沿用同一编号 ${s.code}`);
    pushLog(world, s.batchId ?? "global", `结构 ${s.code} 在重叠区合并视野 ${fov.key}，不另发编号`, "good");
  }
}

// ---------- 观察员提交（双坐标 + 偏差） ----------
export interface SubmitInput {
  observer: string;
  xUm?: number;
  yUm?: number;
  sizeUm?: number;
  note?: string;
}

export function submitObservation(
  world: World,
  structureId: string,
  input: SubmitInput,
): Observation {
  const s = world.structures.find((x) => x.id === structureId);
  if (!s) throw new Error("结构不存在");
  if (s.measurement.state === "待核") throw new Error("旧记录待核，补录标定与偏移后才能提交测量");

  const locked = s.measurement.state === "已确认";
  const primaryCount = s.observations.filter((o) => !o.afterLock).length;
  const jitter = mulberry32(hashSeed(s.id + input.observer + primaryCount));
  const xUm = input.xUm ?? s.xUm + (jitter() - 0.5) * 3;
  const yUm = input.yUm ?? s.yUm + (jitter() - 0.5) * 3;

  // 未确认测量按当前标定；确认后的补交仅登记坐标，尺寸不参与
  const cal = getCal(world, s.measurement.currentCalId ?? s.measurement.calId);
  const scaleSalt = mulberry32(hashSeed(s.id + input.observer + "size" + primaryCount));
  const sizeUm = input.sizeUm ?? s.sizePx * (cal?.umPerPx ?? 0) * (0.96 + scaleSalt() * 0.1);

  const obs: Observation = {
    id: uid(world, "obs"),
    observer: input.observer,
    at: nowIso(),
    xUm,
    yUm,
    sizeUm,
    primary: primaryCount < 2,
    afterLock: locked,
    note: input.note,
  };
  s.observations.push(obs);

  if (locked) {
    addHistory(s, "补交", `${input.observer} 在确认后补交坐标（第 ${s.observations.length} 份），已登记备查，确认尺寸不变`);
    pushLog(world, s.batchId ?? "global", `结构 ${s.code} 已确认，${input.observer} 后到数据仅登记，不覆盖`, "warn");
  } else {
    s.measurement.state = "待复核";
    addHistory(s, "提交", `${input.observer} 提交坐标（第 ${primaryCount + 1} 份${obs.primary ? "正式" : "备查"}）`);
    const dev = deviationOf(s);
    pushLog(
      world,
      s.batchId ?? "global",
      `结构 ${s.code} 收到 ${input.observer} 坐标` +
        (dev.distanceUm != null
          ? `；双观察员偏差 ${dev.distanceUm.toFixed(2)} μm / ${dev.dSizePct?.toFixed(1)}%${dev.overLimit ? "，超出预警，需复核" : ""}`
          : "，等待第二名观察员"),
      dev.overLimit ? "warn" : "info",
    );
  }
  return obs;
}

export function confirmStructure(world: World, structureId: string, by: string): ConfirmedSnapshot {
  const s = world.structures.find((x) => x.id === structureId);
  if (!s) throw new Error("结构不存在");
  if (s.measurement.state !== "待复核") throw new Error("仅待复核测量可以确认");
  const p = primaryObservations(s);
  if (p.length === 0) throw new Error("缺少观察员坐标");
  const cal = getCal(world, s.measurement.calId);
  const snap: ConfirmedSnapshot = {
    at: nowIso(),
    by,
    calId: cal!.id,
    calLabel: cal!.label,
    umPerPx: cal!.umPerPx,
    sizeUm: p.reduce((sum, o) => sum + o.sizeUm, 0) / p.length,
    observationIds: p.map((o) => o.id),
  };
  s.measurement.state = "已确认";
  s.measurement.sizeUm = snap.sizeUm;
  s.measurement.confirmed = snap;
  s.measurement.recalculatedFromCalId = undefined;
  s.measurement.recalculatedAt = undefined;
  addHistory(s, "确认", `${by} 确认测量 ${snap.sizeUm.toFixed(2)} μm（标定 ${snap.calLabel}），尺寸锁定`);
  pushLog(world, s.batchId ?? "global", `结构 ${s.code} 确认 ${snap.sizeUm.toFixed(2)} μm @${snap.calLabel}，后到数据不得覆盖`, "good");
  return snap;
}

// ---------- 标定版本发布：未确认立即失效重算，已确认锁定原标定 ----------
export function applyCalibration(world: World, next: Calibration): void {
  let recalced = 0;
  let locked = 0;
  let pending = 0;
  for (const s of world.structures) {
    const obj = objectiveOf(world, s);
    if (obj !== next.objective) continue;

    if (s.measurement.state === "待核") {
      pending += 1;
      continue;
    }
    if (s.measurement.state === "已确认") {
      s.measurement.currentCalId = next.id;
      locked += 1;
      addHistory(
        s,
        "失效",
        `标定 ${next.label} 已发布；确认测量保留原标定 ${s.measurement.confirmed?.calLabel} 与原尺寸，新标定仅提示`,
      );
      continue;
    }
    const prev = getCal(world, s.measurement.calId);
    s.measurement.recalculatedFromCalId = s.measurement.calId ?? undefined;
    s.measurement.recalculatedAt = nowIso();
    s.measurement.calId = next.id;
    s.measurement.sizeUm = s.sizePx * next.umPerPx;
    recalced += 1;
    addHistory(
      s,
      "重算",
      `标定 ${prev?.label ?? "?"} → ${next.label}：未确认测量立即失效，尺寸重算为 ${s.measurement.sizeUm.toFixed(2)} μm`,
    );
  }
  pushLog(
    world,
    "global",
    `发布标定 ${next.label}（${next.objective}）：未确认重算 ${recalced} 个；已确认保留原标定 ${locked} 个；待核旧记录挂起 ${pending} 个`,
    "warn",
  );
}

// ---------- 旧记录（缺标定版本 / 偏移） ----------
export interface LegacyInput {
  sampleId: string;
  kind: string;
  raw: string;
  xUm: number;
  yUm: number;
  sizePx: number;
  missingCal?: boolean;
  missingOffset?: boolean;
}

export function createLegacyStructure(world: World, input: LegacyInput): StructureRecord {
  const sample = world.samples.find((x) => x.id === input.sampleId);
  const n = world.structures.filter((s) => s.sampleId === input.sampleId).length + 1;
  const s: StructureRecord = {
    id: uid(world, "st"),
    code: `${sample?.code ?? "S?"}-L${String(n).padStart(3, "0")}`,
    sampleId: input.sampleId,
    batchId: null,
    kind: input.kind,
    xUm: input.xUm,
    yUm: input.yUm,
    sizePx: input.sizePx,
    detectionIds: [],
    fovIds: [],
    overlap: false,
    observations: [],
    measurement: { state: "待核", calId: null, sizeUm: null },
    history: [
      {
        at: nowIso(),
        kind: "创建",
        text: `导入旧记录“${input.raw}”：缺${input.missingCal === false ? "" : "标定版本"}${input.missingOffset === false ? "" : "载物台偏移"}，置为待核`,
      },
    ],
    legacy: {
      missingCal: input.missingCal !== false,
      missingOffset: input.missingOffset !== false,
      raw: input.raw,
    },
    createdAt: nowIso(),
  };
  world.structures.push(s);
  pushLog(world, "global", `旧记录 ${s.code}（${input.raw}）缺标定/偏移信息，待核`, "warn");
  return s;
}

export function verifyLegacy(
  world: World,
  structureId: string,
  calId: string,
  offsetId: string,
): void {
  const s = world.structures.find((x) => x.id === structureId);
  if (!s || !s.legacy) throw new Error("待核旧记录不存在");
  const cal = getCal(world, calId);
  const offset = getOffset(world, offsetId);
  if (!cal) throw new Error("标定版本不存在");
  if (!offset) throw new Error("载物台偏移不存在");
  s.offsetId = offsetId;
  s.legacy.missingCal = false;
  s.legacy.missingOffset = false;
  s.measurement = {
    state: "待测量",
    calId,
    sizeUm: s.sizePx * cal.umPerPx,
  };
  addHistory(s, "补录", `补录标定 ${cal.label} 与 ${offset.label}，待核解除，进入待测量`);
  pushLog(world, "global", `旧记录 ${s.code} 补录 ${cal.label} / ${offset.label}，待核解除`, "good");
}

// ---------- 导出 ----------
export function exportCsv(world: World): string {
  const header = [
    "结构编号",
    "样本",
    "结构类型",
    "扫描批次",
    "物镜",
    "复核状态",
    "拼接来源视野",
    "重叠合并",
    "X(μm)",
    "Y(μm)",
    "当前尺寸(μm)",
    "当前标定",
    "确认尺寸(μm)",
    "确认标定",
    "观察员",
    "坐标偏差(μm)",
    "尺寸偏差(%)",
    "新标定提示",
    "旧记录来源",
  ];
  const lines = [header.join(",")];
  for (const s of world.structures) {
    const sample = world.samples.find((x) => x.id === s.sampleId);
    const batch = getBatch(world, s.batchId);
    const obj = objectiveOf(world, s);
    const dev = deviationOf(s);
    const p = primaryObservations(s);
    const currentCal = getCal(world, s.measurement.calId);
    const newer = getCal(world, s.measurement.currentCalId);
    const fovKeys = s.fovIds
      .map((id) => world.fovs.find((f) => f.id === id)?.key)
      .filter(Boolean)
      .join("|");
    lines.push(
      [
        s.code,
        sample?.name ?? "",
        s.kind,
        batch?.code ?? (s.legacy ? "旧记录" : ""),
        obj ?? "-",
        s.measurement.state,
        fovKeys || (s.legacy ? "无扫描批次" : ""),
        s.overlap ? "是" : "否",
        s.xUm.toFixed(2),
        s.yUm.toFixed(2),
        (currentSizeUm(world, s) ?? 0).toFixed(2),
        currentCal?.label ?? "-",
        s.measurement.confirmed?.sizeUm.toFixed(2) ?? "",
        s.measurement.confirmed?.calLabel ?? "",
        p.map((o) => o.observer).join("|"),
        dev.distanceUm?.toFixed(2) ?? "",
        dev.dSizePct?.toFixed(1) ?? "",
        newer?.label ?? "",
        s.legacy?.raw ?? "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
  }
  return "﻿" + lines.join("\n");
}
