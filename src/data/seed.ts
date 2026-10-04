import {
  confirmMeasurement,
  ingestBatch,
  submitMeasurement,
} from "../domain/engine";
import type {
  CalibrationVersion,
  FieldRecord,
  LabState,
  ScanBatch,
  StructureObservation,
} from "../domain/types";

const calA: CalibrationVersion = {
  id: "CAL-1",
  version: "CAL-2026.08",
  umPerPixel: { "100x": 1.6, "200x": 0.8, "400x": 0.4, "1000x": 0.16 },
  issuedAt: "2026-08-20 09:00",
  note: "学期初统一标定",
};

/** 中断批次 B-02 的恢复负载：含已导入视野的重放数据 + 未完成视野 */
export const RESUME_PAYLOAD = {
  batch: {
    id: "B-02",
    sampleId: "SMP-01",
    objective: "400x",
    calibrationVersionId: "CAL-1",
    stageOffset: { x: 1200, y: 0 },
    totalFields: 4,
    status: "interrupted",
    importedAt: "2026-09-30 10:40",
  } as ScanBatch,
  fields: [
    { id: "F-B02-1", batchId: "B-02", index: 1, gridX: 0, gridY: 0, status: "complete" },
    { id: "F-B02-2", batchId: "B-02", index: 2, gridX: 1, gridY: 0, status: "complete" },
    { id: "F-B02-3", batchId: "B-02", index: 3, gridX: 0, gridY: 1, status: "complete" },
    { id: "F-B02-4", batchId: "B-02", index: 4, gridX: 1, gridY: 1, status: "complete" },
  ] as FieldRecord[],
  observations: [
    // 重放：已导入视野的观察，不应新增结构
    { id: "O-B02-1", fieldId: "F-B02-1", label: "细胞核", px: { x: 100, y: 100 } },
    { id: "O-B02-2", fieldId: "F-B02-2", label: "细胞核", px: { x: 120, y: 96 } },
    // 新视野的观察
    { id: "O-B02-3", fieldId: "F-B02-3", label: "液泡", px: { x: 300, y: 300 } },
    { id: "O-B02-4", fieldId: "F-B02-4", label: "细胞核", px: { x: 400, y: 150 } },
  ] as StructureObservation[],
};

export function buildSeedState(): LabState {
  let state: LabState = {
    samples: [
      { id: "SMP-01", name: "洋葱表皮", sampleType: "植物组织", stain: "碘液" },
      { id: "SMP-02", name: "人血涂片", sampleType: "血液涂片", stain: "瑞氏染色" },
    ],
    calibrations: [calA],
    batches: [],
    fields: [],
    observations: [],
    structures: [],
    measurements: [],
    log: [],
    counters: { structure: 0, measurement: 0 },
  };

  // B-01：完整批次，2x2 视野，相邻视野重叠区内“细胞核”被重复标号 → 合并为单一结构
  const b01: ScanBatch = {
    id: "B-01",
    sampleId: "SMP-01",
    objective: "400x",
    calibrationVersionId: "CAL-1",
    stageOffset: { x: 0, y: 0 },
    totalFields: 4,
    status: "complete",
    importedAt: "2026-09-28 09:30",
  };
  const b01Fields: FieldRecord[] = [
    { id: "F-B01-1", batchId: "B-01", index: 1, gridX: 0, gridY: 0, status: "complete" },
    { id: "F-B01-2", batchId: "B-01", index: 2, gridX: 1, gridY: 0, status: "complete" },
    { id: "F-B01-3", batchId: "B-01", index: 3, gridX: 0, gridY: 1, status: "complete" },
    { id: "F-B01-4", batchId: "B-01", index: 4, gridX: 1, gridY: 1, status: "complete" },
  ];
  const b01Obs: StructureObservation[] = [
    // 重叠区：同一细胞核在相邻两个视野各标一次
    { id: "O-B01-1", fieldId: "F-B01-1", label: "细胞核", px: { x: 600, y: 100 } },
    { id: "O-B01-2", fieldId: "F-B01-2", label: "细胞核", px: { x: 90, y: 105 } },
    { id: "O-B01-3", fieldId: "F-B01-3", label: "液泡", px: { x: 200, y: 200 } },
    { id: "O-B01-4", fieldId: "F-B01-4", label: "细胞壁", px: { x: 320, y: 240 } },
  ];
  state = ingestBatch(state, b01, b01Fields, b01Obs, "2026-09-28 09:30").state;

  // B-02：导入中断，只完成 2/4 视野（恢复负载见 RESUME_PAYLOAD）
  const b02Fields = RESUME_PAYLOAD.fields.slice(0, 2);
  const b02Obs = RESUME_PAYLOAD.observations.slice(0, 2);
  state = ingestBatch(
    state,
    RESUME_PAYLOAD.batch,
    b02Fields,
    b02Obs,
    "2026-09-30 10:40",
  ).state;

  // B-03：旧记录，缺标定版本与载物台偏移 → 待核
  const b03: ScanBatch = {
    id: "B-03",
    sampleId: "SMP-02",
    objective: "1000x",
    calibrationVersionId: null,
    stageOffset: null,
    totalFields: 2,
    status: "complete",
    importedAt: "2026-06-15 14:20",
  };
  const b03Fields: FieldRecord[] = [
    { id: "F-B03-1", batchId: "B-03", index: 1, gridX: 0, gridY: 0, status: "complete" },
    { id: "F-B03-2", batchId: "B-03", index: 2, gridX: 1, gridY: 0, status: "complete" },
  ];
  const b03Obs: StructureObservation[] = [
    { id: "O-B03-1", fieldId: "F-B03-1", label: "红细胞", px: { x: 320, y: 240 } },
  ];
  state = ingestBatch(state, b03, b03Fields, b03Obs, "2026-06-15 14:20").state;

  // 两名观察员同时测量同一结构 ST-0001：两份坐标都保留
  const r1 = submitMeasurement(
    state,
    {
      structureId: "ST-0001",
      observer: "学生甲",
      points: [
        { x: 600, y: 100 },
        { x: 660, y: 100 },
      ],
    },
    "2026-09-28 10:05",
  );
  state = r1.state;
  const r2 = submitMeasurement(
    state,
    {
      structureId: "ST-0001",
      observer: "学生乙",
      points: [
        { x: 598, y: 102 },
        { x: 655, y: 104 },
      ],
    },
    "2026-09-28 10:06",
  );
  state = r2.state;
  // 学生甲的测量先确认；学生乙的后到数据保留为未确认，不覆盖
  state = confirmMeasurement(state, r1.measurement.id, "2026-09-28 11:00").state;

  // 一条未确认测量：演示标定更新后失效重算（ST-0002 液泡，全景坐标约 (200, 584)px）
  const r3 = submitMeasurement(
    state,
    {
      structureId: "ST-0002",
      observer: "学生甲",
      points: [
        { x: 200, y: 584 },
        { x: 250, y: 644 },
      ],
    },
    "2026-09-29 15:40",
  );
  state = r3.state;

  // 旧批次（待核）上的测量 → 待核（ST-0006 红细胞，来自缺标定/偏移的 B-03）
  const r4 = submitMeasurement(
    state,
    {
      structureId: "ST-0006",
      observer: "学生丙",
      points: [
        { x: 320, y: 240 },
        { x: 360, y: 240 },
      ],
    },
    "2026-06-15 15:00",
  );
  state = r4.state;

  return state;
}
