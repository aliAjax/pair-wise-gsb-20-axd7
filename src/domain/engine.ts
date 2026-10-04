import type {
  CalibrationVersion,
  FieldRecord,
  LabState,
  Measurement,
  ObjectiveMag,
  Pt,
  ScanBatch,
  StitchedStructure,
  StructureObservation,
} from "./types";

/** 视野尺寸与相邻视野步进（像素），步进小于视野尺寸即产生重叠区 */
export const FIELD_W_PX = 640;
export const FIELD_H_PX = 480;
export const STEP_X_PX = 512;
export const STEP_Y_PX = 384;
/** 重叠区内同一结构的合并容差（µm） */
export const MERGE_TOLERANCE_UM = 8;

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function uniq(list: string[]): string[] {
  return Array.from(new Set(list));
}

export function getCalibration(
  state: LabState,
  id: string | null,
): CalibrationVersion | undefined {
  return state.calibrations.find((c) => c.id === id);
}

/** 旧记录缺标定版本或载物台偏移 → 待核 */
export function batchPendingReasons(batch: ScanBatch): string[] {
  const reasons: string[] = [];
  if (!batch.calibrationVersionId) reasons.push("缺标定版本");
  if (!batch.stageOffset) reasons.push("缺载物台偏移");
  return reasons;
}

export function fieldOriginUm(
  batch: ScanBatch,
  field: FieldRecord,
  umPerPixel: number,
): Pt | null {
  if (!batch.stageOffset) return null;
  return {
    x: batch.stageOffset.x + field.gridX * STEP_X_PX * umPerPixel,
    y: batch.stageOffset.y + field.gridY * STEP_Y_PX * umPerPixel,
  };
}

export function observationStagePos(
  batch: ScanBatch,
  field: FieldRecord,
  obs: StructureObservation,
  umPerPixel: number,
): Pt | null {
  const origin = fieldOriginUm(batch, field, umPerPixel);
  if (!origin) return null;
  return {
    x: origin.x + obs.px.x * umPerPixel,
    y: origin.y + obs.px.y * umPerPixel,
  };
}

export interface IngestSummary {
  addedFields: number;
  skippedFields: number;
  newStructures: string[];
  mergedStructures: string[];
  batchCompleted: boolean;
}

/**
 * 导入/恢复扫描批次。
 * - 批次已存在时只补未完成的视野，已导入视野的观察记录直接跳过（重放不新增结构）；
 * - 重叠区内同标签、同倍率、坐标差在容差内的观察合并为同一结构编号。
 */
export function ingestBatch(
  state: LabState,
  batch: ScanBatch,
  fields: FieldRecord[],
  observations: StructureObservation[],
  time: string,
): { state: LabState; summary: IngestSummary } {
  const next: LabState = {
    ...state,
    batches: [...state.batches],
    fields: [...state.fields],
    observations: [...state.observations],
    structures: [...state.structures],
    log: [...state.log],
    counters: { ...state.counters },
  };
  const summary: IngestSummary = {
    addedFields: 0,
    skippedFields: 0,
    newStructures: [],
    mergedStructures: [],
    batchCompleted: false,
  };

  if (!next.batches.some((b) => b.id === batch.id)) {
    next.batches.push(batch);
    next.log.push({
      time,
      text: `批次 ${batch.id} 绑定样本 ${batch.sampleId} · ${batch.objective} · 标定 ${
        batch.calibrationVersionId ?? "待核"
      } · 偏移 ${
        batch.stageOffset
          ? `(${batch.stageOffset.x}, ${batch.stageOffset.y})µm`
          : "待核"
      }`,
    });
  }
  const batchRecord = next.batches.find((b) => b.id === batch.id)!;

  const knownFieldIds = new Set(next.fields.map((f) => f.id));
  const newFields = fields.filter((f) => !knownFieldIds.has(f.id));
  summary.addedFields = newFields.length;
  summary.skippedFields = fields.length - newFields.length;
  next.fields.push(...newFields);

  const calib = getCalibration(next, batchRecord.calibrationVersionId);
  const umPerPixel = calib ? calib.umPerPixel[batchRecord.objective] : null;

  const newFieldIds = new Set(newFields.map((f) => f.id));
  const knownObsIds = new Set(next.observations.map((o) => o.id));
  const incoming = observations.filter(
    (o) => newFieldIds.has(o.fieldId) && !knownObsIds.has(o.id),
  );
  next.observations.push(...incoming);

  for (const obs of incoming) {
    const field = newFields.find((f) => f.id === obs.fieldId)!;
    const pos =
      umPerPixel != null
        ? observationStagePos(batchRecord, field, obs, umPerPixel)
        : null;
    const candidate = pos
      ? next.structures.find(
          (s) =>
            s.sampleId === batchRecord.sampleId &&
            s.objective === batchRecord.objective &&
            s.label === obs.label &&
            s.stagePos !== null &&
            dist(s.stagePos, pos) <= MERGE_TOLERANCE_UM,
        )
      : undefined;

    if (candidate) {
      next.structures = next.structures.map((s) => {
        if (s.id !== candidate.id) return s;
        const n = s.observationIds.length;
        return {
          ...s,
          stagePos:
            s.stagePos && pos
              ? {
                  x: (s.stagePos.x * n + pos.x) / (n + 1),
                  y: (s.stagePos.y * n + pos.y) / (n + 1),
                }
              : s.stagePos,
          observationIds: [...s.observationIds, obs.id],
          sourceFieldIds: uniq([...s.sourceFieldIds, field.id]),
          sourceBatchIds: uniq([...s.sourceBatchIds, batch.id]),
        };
      });
      summary.mergedStructures.push(candidate.id);
      next.log.push({
        time,
        text: `重叠区合并：${obs.label}（${obs.id}）并入结构 ${candidate.id}，不新增编号`,
      });
    } else {
      const id = `ST-${String(next.counters.structure + 1).padStart(4, "0")}`;
      next.counters.structure += 1;
      next.structures.push({
        id,
        sampleId: batchRecord.sampleId,
        objective: batchRecord.objective,
        label: obs.label,
        stagePos: pos,
        observationIds: [obs.id],
        sourceFieldIds: [field.id],
        sourceBatchIds: [batch.id],
      });
      summary.newStructures.push(id);
    }
  }

  const fieldCount = next.fields.filter((f) => f.batchId === batch.id).length;
  if (fieldCount >= batchRecord.totalFields && batchRecord.status !== "complete") {
    next.batches = next.batches.map((b) =>
      b.id === batch.id ? { ...b, status: "complete" } : b,
    );
    summary.batchCompleted = true;
    next.log.push({
      time,
      text: `批次 ${batch.id} 视野补齐 ${fieldCount}/${batchRecord.totalFields}，从中断恢复为完成`,
    });
  }
  return { state: next, summary };
}

/** 提交测量：绑定结构来源批次的标定版本；已确认测量不被后到数据覆盖 */
export function submitMeasurement(
  state: LabState,
  input: { structureId: string; observer: string; points: [Pt, Pt] },
  time: string,
): { state: LabState; measurement: Measurement } {
  const structure = state.structures.find((s) => s.id === input.structureId);
  if (!structure) throw new Error(`结构 ${input.structureId} 不存在`);
  const srcBatch = state.batches.find((b) => b.id === structure.sourceBatchIds[0]);
  const pending =
    !srcBatch || batchPendingReasons(srcBatch).length > 0 || structure.stagePos === null;
  const calibId = pending ? null : srcBatch!.calibrationVersionId;
  const calib = getCalibration(state, calibId);
  const lengthUm =
    !pending && calib
      ? dist(input.points[0], input.points[1]) * calib.umPerPixel[structure.objective]
      : null;

  const id = `M-${String(state.counters.measurement + 1).padStart(4, "0")}`;
  const measurement: Measurement = {
    id,
    structureId: structure.id,
    observer: input.observer,
    points: input.points,
    calibrationVersionId: calibId,
    lengthUm,
    status: pending ? "pending-review" : "unconfirmed",
    submittedAt: time,
  };

  const confirmed = state.measurements.find(
    (m) => m.structureId === structure.id && m.status === "confirmed",
  );
  const next: LabState = {
    ...state,
    measurements: [...state.measurements, measurement],
    counters: { ...state.counters, measurement: state.counters.measurement + 1 },
    log: [
      ...state.log,
      {
        time,
        text: confirmed
          ? `测量 ${id}（${input.observer}）已保留为未确认，不覆盖已确认测量 ${confirmed.id}`
          : pending
            ? `测量 ${id}（${input.observer}）因来源批次待核而标记为待核`
            : `测量 ${id}（${input.observer}）已提交，待复核`,
      },
    ],
  };
  return { state: next, measurement };
}

export function confirmMeasurement(
  state: LabState,
  measurementId: string,
  time: string,
): { state: LabState; ok: boolean; reason?: string } {
  const m = state.measurements.find((x) => x.id === measurementId);
  if (!m) return { state, ok: false, reason: "测量不存在" };
  if (m.status === "pending-review")
    return { state, ok: false, reason: "缺标定版本或载物台偏移，待核记录不能确认" };
  if (m.status === "invalidated")
    return { state, ok: false, reason: "已失效测量不能确认，请使用重算结果" };
  if (m.status === "confirmed") return { state, ok: false, reason: "该测量已确认" };
  const next: LabState = {
    ...state,
    measurements: state.measurements.map((x) =>
      x.id === measurementId
        ? { ...x, status: "confirmed", note: `${time} 复核确认` }
        : x,
    ),
    log: [...state.log, { time, text: `测量 ${measurementId} 复核确认，尺寸与标定版本锁定` }],
  };
  return { state: next, ok: true };
}

/**
 * 发布新标定：未确认测量立即失效并按新标定重算；
 * 已确认测量保留原标定与尺寸；待核记录维持待核。
 */
export function publishCalibration(
  state: LabState,
  input: { version: string; umPerPixel: Record<ObjectiveMag, number>; note?: string },
  time: string,
): { state: LabState; invalidated: string[]; recomputed: string[] } {
  const id = `CAL-${state.calibrations.length + 1}`;
  const calib: CalibrationVersion = { id, issuedAt: time, ...input };
  const invalidated: string[] = [];
  const recomputed: string[] = [];
  const newMeasurements: Measurement[] = [];
  let counter = state.counters.measurement;

  const measurements = state.measurements.map((m) => {
    if (m.status !== "unconfirmed") return m;
    const structure = state.structures.find((s) => s.id === m.structureId)!;
    invalidated.push(m.id);
    counter += 1;
    const newId = `M-${String(counter).padStart(4, "0")}`;
    recomputed.push(newId);
    newMeasurements.push({
      ...m,
      id: newId,
      calibrationVersionId: id,
      lengthUm: dist(m.points[0], m.points[1]) * input.umPerPixel[structure.objective],
      status: "unconfirmed",
      submittedAt: time,
      note: `按 ${input.version} 重算`,
    });
    return {
      ...m,
      status: "invalidated" as const,
      note: `标定更新至 ${input.version}，原值失效`,
    };
  });

  const next: LabState = {
    ...state,
    calibrations: [...state.calibrations, calib],
    measurements: [...measurements, ...newMeasurements],
    counters: { ...state.counters, measurement: counter },
    log: [
      ...state.log,
      {
        time,
        text: `标定 ${input.version} 发布：${invalidated.length} 条未确认测量失效重算，已确认测量保留原标定与尺寸`,
      },
    ],
  };
  return { state: next, invalidated, recomputed };
}

/** 两名观察员对同一结构的测量偏差 */
export function measurementDeviation(
  a: Measurement,
  b: Measurement,
  umPerPixel: number,
): { lengthDiffUm: number | null; midpointOffsetUm: number } {
  const mid = (m: Measurement): Pt => ({
    x: (m.points[0].x + m.points[1].x) / 2,
    y: (m.points[0].y + m.points[1].y) / 2,
  });
  return {
    lengthDiffUm:
      a.lengthUm != null && b.lengthUm != null
        ? Math.abs(a.lengthUm - b.lengthUm)
        : null,
    midpointOffsetUm: dist(mid(a), mid(b)) * umPerPixel,
  };
}

export const STATUS_LABEL: Record<Measurement["status"], string> = {
  unconfirmed: "未确认",
  confirmed: "已确认",
  invalidated: "已失效",
  "pending-review": "待核",
};

/** 导出：样本详情 + 测量列表，含拼接来源与复核状态 */
export function exportReport(state: LabState, time: string): string {
  const lines: string[] = [
    "显微镜玻片观察 · 视野拼接与测量复核导出",
    `导出时间: ${time}`,
    "=".repeat(56),
  ];
  for (const sample of state.samples) {
    lines.push(
      "",
      `样本 ${sample.id} ${sample.name}（${sample.sampleType} · ${sample.stain}）`,
    );
    for (const batch of state.batches.filter((b) => b.sampleId === sample.id)) {
      const reasons = batchPendingReasons(batch);
      const calib = getCalibration(state, batch.calibrationVersionId);
      const fieldCount = state.fields.filter((f) => f.batchId === batch.id).length;
      lines.push(
        `  批次 ${batch.id} | ${batch.objective} | 标定 ${
          calib ? calib.version : "待核"
        } | 偏移 ${
          batch.stageOffset
            ? `(${batch.stageOffset.x}, ${batch.stageOffset.y})µm`
            : "待核"
        } | 视野 ${fieldCount}/${batch.totalFields} | ${
          batch.status === "complete" ? "完成" : "中断"
        }${reasons.length ? ` | 待核：${reasons.join("、")}` : ""}`,
      );
    }
    const structures = state.structures.filter((s) => s.sampleId === sample.id);
    if (structures.length) lines.push(`  ${"-".repeat(40)}`);
    for (const st of structures) {
      lines.push(
        `  ${st.id} ${st.label} @ ${
          st.stagePos
            ? `(${st.stagePos.x.toFixed(1)}, ${st.stagePos.y.toFixed(1)})µm`
            : "待核"
        } [${st.objective}]`,
      );
      lines.push(
        `    拼接来源: 视野 ${st.sourceFieldIds.join(", ")} / 批次 ${st.sourceBatchIds.join(
          ", ",
        )}（${st.observationIds.length} 条观察${
          st.observationIds.length > 1 ? "，重叠区已合并为单一编号" : ""
        }）`,
      );
      const ms = state.measurements.filter((m) => m.structureId === st.id);
      if (!ms.length) {
        lines.push("    测量: 无");
      }
      for (const m of ms) {
        const calib = getCalibration(state, m.calibrationVersionId);
        lines.push(
          `    ${m.id} ${m.observer} ${
            m.lengthUm != null ? `${m.lengthUm.toFixed(2)}µm` : "—"
          } [标定 ${calib ? calib.version : "待核"}] ${STATUS_LABEL[m.status]}${
            m.note ? `（${m.note}）` : ""
          }`,
        );
      }
    }
  }
  const pending = state.measurements.filter((m) => m.status === "pending-review");
  lines.push("", "=".repeat(56), `待核记录 ${pending.length} 条（缺标定版本或载物台偏移）`);
  for (const m of pending) {
    lines.push(`  ${m.id} → 结构 ${m.structureId} · ${m.observer}`);
  }
  return lines.join("\n");
}
