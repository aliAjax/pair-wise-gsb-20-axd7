import {
  addCalibration,
  addOffset,
  addSample,
  applyCalibration,
  batchProgress,
  confirmStructure,
  createBatch,
  createLegacyStructure,
  deviationOf,
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
import { createEmptyWorld } from "./seed";
import type { World } from "./types";

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

function assert(cond: boolean, name: string, detail: string): CheckResult {
  return { name, pass: cond, detail: cond ? "OK" : detail };
}

// 规则1：扫描绑定样本/倍率/标定版本/偏移；重叠区只生成一个结构编号
function checkStitch(): CheckResult {
  const w = createEmptyWorld();
  const s = addSample(w, { name: "T", category: "植物组织", stain: "无" });
  const cal = addCalibration(w, { objective: "40x", label: "40x-a", umPerPx: 0.25, effectiveFrom: "2026-10-01" });
  const off = addOffset(w, { label: "O", dxUm: 3, dyUm: 5 });
  const b = createBatch(w, { sampleId: s.id, objective: "40x", calId: cal.id, offsetId: off.id, cols: 3, rows: 2 });
  for (const key of b.order) ingestFov(w, b.id, key);

  const list = structuresOfSample(w, s.id);
  const overlaps = list.filter((x) => x.overlap);
  const detectionCount = w.detections.filter((d) => d.batchId === b.id).length;
  const bound =
    getBatch(w, b.id)!.sampleId === s.id &&
    getBatch(w, b.id)!.objective === "40x" &&
    getBatch(w, b.id)!.calId === cal.id &&
    getBatch(w, b.id)!.offsetId === off.id;

  return assert(
    bound &&
      list.length === expectedStructureCount(b) &&
      overlaps.length === (b.cols - 1) * b.rows + b.cols * (b.rows - 1) &&
      detectionCount > list.length &&
      overlaps.every((o) => o.fovIds.length >= 2),
    "重叠区只生成一个结构编号",
    `结构 ${list.length}/${expectedStructureCount(b)}，重叠 ${overlaps.length}，检出 ${detectionCount}`,
  );
}

// 规则2：两名观察员保留两份坐标并列出偏差
function checkDualObservation(): CheckResult {
  const w = tinyWorld();
  const st = firstStructure(w);
  submitObservation(w, st.id, { observer: "王老师", xUm: 10, yUm: 10, sizeUm: 12 });
  submitObservation(w, st.id, { observer: "李同学", xUm: 12, yUm: 10, sizeUm: 12.6 });
  const dev = deviationOf(st);
  const obs = st.observations;
  return assert(
    obs.length === 2 &&
      obs[0].primary &&
      obs[1].primary &&
      Math.abs((dev.distanceUm ?? 0) - 2) < 1e-9 &&
      Math.abs((dev.dSizePct ?? 0) - (0.6 / 12.6) * 100) < 1e-6 &&
      st.measurement.state === "待复核",
    "双观察员保留两份坐标并列出偏差",
    `坐标数 ${obs.length}，偏差 ${dev.distanceUm}μm / ${dev.dSizePct}%`,
  );
}

// 规则3：确认后后到数据不覆盖
function checkLateCannotOverride(): CheckResult {
  const w = tinyWorld();
  const st = firstStructure(w);
  submitObservation(w, st.id, { observer: "王老师", xUm: 0, yUm: 0, sizeUm: 10 });
  submitObservation(w, st.id, { observer: "李同学", xUm: 0, yUm: 0, sizeUm: 12 });
  const snap = confirmStructure(w, st.id, "教师");
  const lockedSize = snap.sizeUm; // 11
  submitObservation(w, st.id, { observer: "张助教", xUm: 999, yUm: 999, sizeUm: 50, note: "补交" });
  const fresh = w.structures.find((x) => x.id === st.id)!;
  const late = fresh.observations.filter((o) => o.afterLock);
  return assert(
    fresh.measurement.state === "已确认" &&
      fresh.measurement.confirmed!.sizeUm === lockedSize &&
      late.length === 1 &&
      !late[0].primary &&
      fresh.measurement.confirmed!.calId === fresh.measurement.confirmed!.calId,
    "后到数据不能覆盖已确认测量",
    `锁定尺寸 ${fresh.measurement.confirmed!.sizeUm}，补交备查 ${late.length} 份`,
  );
}

// 规则4：标定更新——未确认立即重算，已确认保留原标定与尺寸
function checkCalibrationInvalidation(): CheckResult {
  const w = tinyWorld(2);
  const sts = w.structures.filter((s) => s.batchId);
  const a = sts[0];
  const b = sts[1];
  submitObservation(w, a.id, { observer: "王老师", xUm: 0, yUm: 0, sizeUm: a.sizePx * 0.25 });
  submitObservation(w, a.id, { observer: "李同学", xUm: 0, yUm: 0, sizeUm: a.sizePx * 0.25 });
  confirmStructure(w, a.id, "教师");
  const oldConfirmedSize = a.measurement.confirmed!.sizeUm;
  const oldCalId = a.measurement.confirmed!.calId;

  submitObservation(w, b.id, { observer: "王老师", xUm: 0, yUm: 0, sizeUm: b.sizePx * 0.25 });
  const oldBSize = b.measurement.sizeUm;

  const v2 = addCalibration(w, { objective: "40x", label: "40x-b", umPerPx: 0.5, effectiveFrom: "2026-10-02" }, true);
  const a2 = w.structures.find((x) => x.id === a.id)!;
  const b2 = w.structures.find((x) => x.id === b.id)!;

  return assert(
    a2.measurement.confirmed!.calId === oldCalId &&
      a2.measurement.confirmed!.sizeUm === oldConfirmedSize &&
      a2.measurement.currentCalId === v2.id &&
      b2.measurement.calId === v2.id &&
      Math.abs((b2.measurement.sizeUm ?? 0) - b.sizePx * 0.5) < 1e-9 &&
      b2.measurement.sizeUm !== oldBSize &&
      b2.measurement.recalculatedFromCalId === oldCalId,
    "标定更新：未确认重算 / 已确认锁定原标定",
    `A 锁定 ${oldCalId}@${oldConfirmedSize}；B 重算 ${b2.measurement.sizeUm}`,
  );
}

// 规则5：中断恢复——只补未完成视野，重放不新增结构，且结果与一次性导入一致
function checkResume(): CheckResult {
  const direct = tinyWorld(3, 3);
  const w = createEmptyWorld();
  const s = addSample(w, { name: "R", category: "植物组织", stain: "无" });
  const cal = addCalibration(w, { objective: "40x", label: "cal", umPerPx: 0.25, effectiveFrom: "2026-10-01" });
  const off = addOffset(w, { label: "off", dxUm: 0, dyUm: 0 });
  const b = createBatch(w, { sampleId: s.id, objective: "40x", calId: cal.id, offsetId: off.id, cols: 3, rows: 3 });
  ingestFov(w, b.id, "0-0");
  ingestFov(w, b.id, "1-0");
  interruptBatch(w, b.id);
  const countsBefore = {
    structures: w.structures.length,
    fovs: w.fovs.length,
    detections: w.detections.length,
  };
  const progress = batchProgress(w, b);
  const r = resumeBatch(w, b.id);
  const after = getBatch(w, b.id)!;
  const structureCount = w.structures.length;

  // 再次重放：全部跳过，结构不新增
  const replay = resumeBatch(w, b.id);
  const replayStable = w.structures.length === structureCount;

  const directCount = direct.structures.length;
  const sameAsDirect = structureCount === directCount;

  return assert(
    after.status === "已完成" &&
      progress.done === 2 &&
      progress.total === 9 &&
      r.ingested === 7 &&
      r.skipped === 2 &&
      r.created + countsBefore.structures === structureCount &&
      r.merged === 11 &&
      replay.skipped === 9 &&
      replay.ingested === 0 &&
      replayStable &&
      sameAsDirect,
    "中断恢复：只补未完成，重放不新增结构",
    `补导 ${r.ingested}，再重放跳过 ${replay.skipped}，结构 ${structureCount}/${directCount}`,
  );
}

// 规则6：旧记录缺标定/偏移 → 待核；补录后可测量；新标定不改变待核记录
function checkLegacy(): CheckResult {
  const w = createEmptyWorld();
  const s = addSample(w, { name: "L", category: "植物组织", stain: "无" });
  const old = createLegacyStructure(w, {
    sampleId: s.id,
    kind: "核",
    raw: "手抄本",
    xUm: 1,
    yUm: 1,
    sizePx: 40,
  });
  let blocked = false;
  try {
    submitObservation(w, old.id, { observer: "王老师" });
  } catch {
    blocked = true;
  }
  const cal1 = addCalibration(w, { objective: "40x", label: "v1", umPerPx: 0.25, effectiveFrom: "2026-09-01" });
  const off = addOffset(w, { label: "o", dxUm: 0, dyUm: 0 });
  // 待核期间标定更新不影响它
  addCalibration(w, { objective: "40x", label: "v2", umPerPx: 0.3, effectiveFrom: "2026-10-01" }, true);
  const stillPending = w.structures.find((x) => x.id === old.id)!.measurement.state === "待核";
  verifyLegacy(w, old.id, cal1.id, off.id);
  const fixed = w.structures.find((x) => x.id === old.id)!;

  return assert(
    blocked &&
      stillPending &&
      fixed.measurement.state === "待测量" &&
      fixed.measurement.calId === cal1.id &&
      Math.abs((fixed.measurement.sizeUm ?? 0) - 10) < 1e-9 &&
      !fixed.legacy!.missingCal &&
      !fixed.legacy!.missingOffset,
    "旧记录缺标定/偏移先待核，补录后恢复",
    `阻塞提交 ${blocked}，补录后尺寸 ${fixed.measurement.sizeUm}`,
  );
}

// 规则7：导出含拼接来源与复核状态
function checkExport(): CheckResult {
  const w = tinyWorld(2);
  const st = w.structures[0];
  submitObservation(w, st.id, { observer: "王老师" });
  submitObservation(w, st.id, { observer: "李同学" });
  confirmStructure(w, st.id, "教师");
  const csv = exportCsv(w);
  const overlap = w.structures.find((x) => x.overlap)!;
  return assert(
    csv.includes("复核状态") &&
      csv.includes("拼接来源视野") &&
      csv.includes("已确认") &&
      csv.includes(overlap.code) &&
      csv.includes('"是"'),
    "导出显示拼接来源与复核状态",
    "CSV 表头/状态/重叠标记缺失",
  );
}

// 规则8：标定版本必须与物镜匹配
function checkCalObjectiveMismatch(): CheckResult {
  const w = createEmptyWorld();
  const s = addSample(w, { name: "M", category: "微生物", stain: "无" });
  const cal = addCalibration(w, { objective: "100x", label: "100", umPerPx: 0.1, effectiveFrom: "2026-10-01" });
  const off = addOffset(w, { label: "o", dxUm: 0, dyUm: 0 });
  let blocked = false;
  try {
    createBatch(w, { sampleId: s.id, objective: "40x", calId: cal.id, offsetId: off.id, cols: 1, rows: 1 });
  } catch {
    blocked = true;
  }
  return assert(blocked, "倍率与标定绑定校验", "不匹配的标定被接受");
}

// ---- helpers ----
function tinyWorld(cols = 1, rows = 1): World {
  const w = createEmptyWorld();
  const s = addSample(w, { name: "t", category: "植物组织", stain: "无" });
  const cal = addCalibration(w, { objective: "40x", label: "40x-a", umPerPx: 0.25, effectiveFrom: "2026-10-01" });
  const off = addOffset(w, { label: "o", dxUm: 0, dyUm: 0 });
  const b = createBatch(w, { sampleId: s.id, objective: "40x", calId: cal.id, offsetId: off.id, cols, rows, overlapPct: 0.2 });
  for (const key of b.order) ingestFov(w, b.id, key);
  return w;
}

function firstStructure(w: World) {
  const st = w.structures[0];
  if (!st) throw new Error("no structure");
  return st;
}

export function runSelfChecks(): CheckResult[] {
  return [
    checkStitch(),
    checkDualObservation(),
    checkLateCannotOverride(),
    checkCalibrationInvalidation(),
    checkResume(),
    checkLegacy(),
    checkExport(),
    checkCalObjectiveMismatch(),
  ];
}
