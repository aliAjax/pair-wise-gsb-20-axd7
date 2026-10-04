import {
  addCalibration,
  addOffset,
  addSample,
  applyCalibration,
  confirmStructure,
  createBatch,
  createLegacyStructure,
  ingestFov,
  interruptBatch,
  resumeBatch,
  submitObservation,
  verifyLegacy,
} from "./engine";
import type { World } from "./types";

export function createEmptyWorld(): World {
  return {
    samples: [],
    calibrations: [],
    offsets: [],
    batches: [],
    fovs: [],
    detections: [],
    structures: [],
    logs: [],
    seq: {},
  };
}

// 预置演示数据，覆盖全部规则场景
export function buildDemoWorld(): World {
  const world = createEmptyWorld();

  const onion = addSample(world, { name: "洋葱表皮装片", category: "植物组织", stain: "碘液染色" });
  const blood = addSample(world, { name: "人血涂片", category: "血液涂片", stain: "瑞氏染色" });

  const cal40v1 = addCalibration(world, {
    objective: "40x",
    label: "40x-v1",
    umPerPx: 0.25,
    effectiveFrom: "2026-09-20",
    note: "学期初台尺标定",
  });
  addCalibration(world, {
    objective: "100x",
    label: "100x-v1",
    umPerPx: 0.1,
    effectiveFrom: "2026-09-20",
    note: "油镜台尺标定",
  });
  // 标定更新：40x 新版，未确认测量将立即失效重算
  addCalibration(world, {
    objective: "40x",
    label: "40x-v2",
    umPerPx: 0.27,
    effectiveFrom: "2026-10-04",
    note: "复测发现 v1 偏小 8%",
  });

  const offA = addOffset(world, { label: "载物台偏移-A", dxUm: 0, dyUm: 0 });
  addOffset(world, { label: "载物台偏移-B", dxUm: 12, dyUm: -8 });

  // 批次1：2×2 扫描，经历 导入→中断→从完整批次恢复
  const b1 = createBatch(world, {
    sampleId: onion.id,
    objective: "40x",
    calId: cal40v1.id,
    offsetId: offA.id,
    cols: 2,
    rows: 2,
    overlapPct: 0.2,
  });
  ingestFov(world, b1.id, "0-0");
  ingestFov(world, b1.id, "1-0");
  interruptBatch(world, b1.id);
  resumeBatch(world, b1.id); // 只补 0-1、1-1，重放不新增结构

  const b1Structures = world.structures.filter((s) => s.batchId === b1.id);
  const locked = b1Structures[0];
  submitObservation(world, locked.id, { observer: "王老师" });
  submitObservation(world, locked.id, { observer: "李同学" });
  confirmStructure(world, locked.id, "实验管理员");

  const review = b1Structures[1];
  submitObservation(world, review.id, { observer: "王老师" });
  submitObservation(world, review.id, { observer: "李同学" });

  const pending = b1Structures[2];
  submitObservation(world, pending.id, { observer: "王老师" });

  // 已确认结构：第三人补交坐标，只登记备查，不覆盖
  submitObservation(world, locked.id, { observer: "张助教", note: "课后补测" });

  // 发布 40x-v2：已确认锁定 v1 与原尺寸；其余未确认立即重算
  applyCalibration(world, world.calibrations.find((c) => c.label === "40x-v2")!);

  // 批次2：100x 血涂片，导入中断待恢复（v2 不影响 100x）
  const cal100 = world.calibrations.find((c) => c.label === "100x-v1")!;
  const b2 = createBatch(world, {
    sampleId: blood.id,
    objective: "100x",
    calId: cal100.id,
    offsetId: offA.id,
    cols: 2,
    rows: 1,
    overlapPct: 0.2,
  });
  ingestFov(world, b2.id, "0-0");
  interruptBatch(world, b2.id);

  // 旧记录：一条缺标定版本，一条标定与偏移都缺 → 待核；一条已补录进入流程
  const legacyCalOnly = createLegacyStructure(world, {
    sampleId: onion.id,
    kind: "细胞核",
    raw: "2025 实验课手抄：40x 视野 12，核径约 13.2 μm",
    xUm: 312,
    yUm: 188,
    sizePx: 50,
    missingCal: true,
    missingOffset: false,
  });
  const legacyBoth = createLegacyStructure(world, {
    sampleId: onion.id,
    kind: "气孔",
    raw: "纸质登记本 P37：洋葱下表皮气孔，放大倍数与台位置未记",
    xUm: 96,
    yUm: 240,
    sizePx: 84,
  });
  const legacyFixed = createLegacyStructure(world, {
    sampleId: onion.id,
    kind: "液泡",
    raw: "旧库导出 CSV：未携带 cal_version / stage_offset",
    xUm: 205,
    yUm: 150,
    sizePx: 64,
  });
  const calV2 = world.calibrations.find((c) => c.label === "40x-v2")!;
  const offB = world.offsets.find((o) => o.label === "载物台偏移-B")!;
  // 两条旧记录保持待核供演示；一条补录标定与偏移后进入流程
  void legacyCalOnly;
  void legacyBoth;
  verifyLegacy(world, legacyFixed.id, calV2.id, offB.id);

  return world;
}
