export type ObjectiveMag = "100x" | "200x" | "400x" | "1000x";

export interface Pt {
  x: number;
  y: number;
}

/** 标定版本：各物镜倍率下的 µm/px */
export interface CalibrationVersion {
  id: string;
  version: string;
  umPerPixel: Record<ObjectiveMag, number>;
  issuedAt: string;
  note?: string;
}

export interface Sample {
  id: string;
  name: string;
  sampleType: string;
  stain: string;
}

/** 扫描批次：绑定样本、物镜倍率、标定版本、载物台偏移 */
export interface ScanBatch {
  id: string;
  sampleId: string;
  objective: ObjectiveMag;
  calibrationVersionId: string | null;
  stageOffset: Pt | null;
  totalFields: number;
  status: "complete" | "interrupted";
  importedAt: string;
}

export interface FieldRecord {
  id: string;
  batchId: string;
  index: number;
  gridX: number;
  gridY: number;
  status: "complete" | "pending";
}

/** 某视野内的一次结构标注（像素坐标） */
export interface StructureObservation {
  id: string;
  fieldId: string;
  label: string;
  px: Pt;
}

/** 拼接后的结构：重叠区只保留一个编号 */
export interface StitchedStructure {
  id: string;
  sampleId: string;
  objective: ObjectiveMag;
  label: string;
  stagePos: Pt | null;
  observationIds: string[];
  sourceFieldIds: string[];
  sourceBatchIds: string[];
}

export type MeasurementStatus =
  | "unconfirmed"
  | "confirmed"
  | "invalidated"
  | "pending-review";

export interface Measurement {
  id: string;
  structureId: string;
  observer: string;
  /** 全景图像素坐标，长度随标定版本换算 */
  points: [Pt, Pt];
  calibrationVersionId: string | null;
  lengthUm: number | null;
  status: MeasurementStatus;
  submittedAt: string;
  note?: string;
}

export interface LogEntry {
  time: string;
  text: string;
}

export interface LabState {
  samples: Sample[];
  calibrations: CalibrationVersion[];
  batches: ScanBatch[];
  fields: FieldRecord[];
  observations: StructureObservation[];
  structures: StitchedStructure[];
  measurements: Measurement[];
  log: LogEntry[];
  counters: { structure: number; measurement: number };
}
