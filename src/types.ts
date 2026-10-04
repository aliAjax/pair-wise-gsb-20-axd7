// 视野拼接与测量复核台 —— 领域模型

export type Objective = "4x" | "10x" | "40x" | "100x";

export type ObjectiveCalState =
  | "待核" // 旧记录缺标定版本 / 载物台偏移，尚未补录
  | "待测量" // 结构已拼接，尚无观察员提交
  | "待复核" // 已有观察员坐标，等待教师复核确认
  | "已确认"; // 测量已锁定，后到数据不得覆盖

export interface Calibration {
  id: string;
  objective: Objective;
  label: string; // 例如 40x-v2
  umPerPx: number; // 微米 / 像素
  effectiveFrom: string; // 生效日期 ISO
  note?: string;
}

export interface StageOffset {
  id: string;
  label: string; // 例如 载物台偏移-A
  dxUm: number;
  dyUm: number;
}

export interface Sample {
  id: string;
  code: string; // S01
  name: string;
  category: string;
  stain: string;
  createdAt: string;
}

export interface PlannedDetection {
  kind: string;
  sizePx: number;
  xUm: number; // 玻片全局坐标（μm），创建批次时按绑定标定与偏移换算
  yUm: number;
  point: string; // 逻辑点位编号，保证重放稳定
}

export type BatchStatus = "进行中" | "已中断" | "已完成";

export interface ScanBatch {
  id: string;
  code: string; // B-20261004-01
  sampleId: string;
  objective: Objective;
  calId: string; // 每次扫描绑定的标定版本
  offsetId: string; // 每次扫描绑定的载物台偏移
  cols: number;
  rows: number;
  fovWidthPx: number;
  fovHeightPx: number;
  overlapPct: number;
  status: BatchStatus;
  plan: Record<string, PlannedDetection[]>; // key: `${col}-${row}`
  order: string[]; // 视野导入顺序
  importedKeys: string[]; // 已完整导入的视野
  createdAt: string;
  finishedAt?: string;
}

export interface FieldOfView {
  id: string;
  batchId: string;
  col: number;
  row: number;
  key: string;
  originXUm: number;
  originYUm: number;
  widthUm: number;
  heightUm: number;
  importedAt: string;
}

export interface RawDetection {
  id: string;
  batchId: string;
  fovId: string;
  xUm: number;
  yUm: number;
  sizePx: number;
  kind: string;
}

export interface Observation {
  id: string;
  observer: string;
  at: string;
  xUm: number;
  yUm: number;
  sizeUm: number;
  primary: boolean; // 前两份为正式坐标；第三份起留作备查
  afterLock: boolean; // 确认之后补交：只登记，不覆盖
  note?: string;
}

export interface HistoryEvent {
  at: string;
  kind: "创建" | "提交" | "确认" | "失效" | "重算" | "补交" | "补录" | "合并";
  text: string;
}

export interface ConfirmedSnapshot {
  at: string;
  by: string;
  calId: string; // 原标定版本
  calLabel: string;
  umPerPx: number;
  sizeUm: number; // 已确认尺寸，锁定沿用
  observationIds: string[];
}

export interface MeasurementState {
  state: ObjectiveCalState;
  calId: string | null; // 当前测量所依据的标定
  sizeUm: number | null; // 依据当前标定推算的尺寸
  recalculatedFromCalId?: string; // 上一版标定（已被失效重算）
  recalculatedAt?: string;
  confirmed?: ConfirmedSnapshot; // 已确认测量快照
  currentCalId?: string; // 锁定后又发布的新标定（仅提示，不改变锁定尺寸）
}

export interface StructureRecord {
  id: string;
  code: string; // S01-0003
  sampleId: string;
  batchId: string | null; // 旧记录无批次
  kind: string;
  xUm: number;
  yUm: number;
  sizePx: number;
  detectionIds: string[];
  fovIds: string[]; // 拼接来源视野
  overlap: boolean; // 是否由重叠区多视野合并
  offsetId?: string; // 旧记录补录后记录
  legacy?: {
    missingCal: boolean;
    missingOffset: boolean;
    raw: string;
  };
  observations: Observation[];
  measurement: MeasurementState;
  history: HistoryEvent[];
  createdAt: string;
}

export interface LogEntry {
  at: string;
  scope: string; // global 或 batch id
  text: string;
  tone: "info" | "good" | "warn";
}

export interface World {
  samples: Sample[];
  calibrations: Calibration[];
  offsets: StageOffset[];
  batches: ScanBatch[];
  fovs: FieldOfView[];
  detections: RawDetection[];
  structures: StructureRecord[];
  logs: LogEntry[];
  seq: Record<string, number>;
}
