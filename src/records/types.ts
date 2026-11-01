/**
 * 脱敏记录的对外结构。
 *
 * 一条请求（一次宿主事件）对应一条记录；记录只声称"本扩展处理后的模型输入"，
 * 不包含宿主未提供的供应商或发送结果。
 */
import type { PIIType } from "../types/index.js";

/** 发现者类别：规则、已知值、模型。 */
export type MaskingFinder = "rule" | "known" | "model" | "unknown";

/** 一条命中。 */
export interface MaskingHit {
  type: PIIType;
  finder: MaskingFinder;
  /** 稳定检测器标识；未知时为 `unknown`。 */
  detector: string;
  /** 模型看到的占位符。 */
  placeholder: string;
  /** 原值字符长度。 */
  length: number;
  /** 命中原文中的起始偏移。 */
  start: number;
  /** 命中原文中的结束偏移。 */
  end: number;
  /** 原值：仅在开启原文保存时存在。 */
  original?: string;
}

/** 字段级对照。 */
export interface MaskingComparison {
  /** 字段在消息中的路径，如 `messages[2].content[0].text`。 */
  path: string;
  /** 原始文本。 */
  before: string;
  /** 本扩展输出文本。 */
  after: string;
  /** 该对照是否被截断。 */
  truncated?: boolean;
}

/** 关联事件：不是独立模型请求。 */
export interface MaskingRelatedEvent {
  kind: "tool_call" | "message_end";
  /** 安全错误码，如 `unresolved-tag`；成功时缺省。 */
  code?: string;
}

/** 一条请求记录。 */
export interface MaskingRecord {
  /** 记录格式版本。 */
  version: 1;
  /** 记录标识：`<unix-ms>-<序号>`。 */
  id: string;
  /** 所属会话。 */
  sessionId: string;
  /** 记录范围：始终为本扩展处理后的模型输入。 */
  scope: "model-input";
  /** 来源事件。 */
  source: "context" | "tool_call" | "tool_result" | "message_end";
  /** 发生时间（ISO 8601）。 */
  time: string;
  /** 处理耗时（毫秒）。 */
  durationMs: number;
  /** 命中数。 */
  masked: number;
  /** 是否阻断。 */
  blocked: boolean;
  /** 检测完整性：规则降级时为 `rules-only`。 */
  integrity: "complete" | "rules-only";
  hits: MaskingHit[];
  comparisons: MaskingComparison[];
  /** 关联事件（非请求本身）。 */
  relatedEvents?: MaskingRelatedEvent[];
  /** 记录层错误，如模型不可用。 */
  errors?: Array<{ finder: MaskingFinder; code: string }>;
}

/** 已知值检测器的标识前缀。 */
const KNOWN_DETECTOR_PREFIX = "known-value";

/** 检测器标识→显示名；未登记的标识原样显示，保证旧记录仍可读。 */
const DETECTOR_LABELS: Record<string, string> = {
  [KNOWN_DETECTOR_PREFIX]: "known value",
};

/** 取检测器的显示名：只影响展示，落盘始终写稳定标识。 */
export function detectorLabel(detector: string): string {
  const exact = DETECTOR_LABELS[detector];
  if (exact !== undefined) return exact;
  if (detector.startsWith(`${KNOWN_DETECTOR_PREFIX}:`)) {
    return `known value (${detector.slice(KNOWN_DETECTOR_PREFIX.length + 1)})`;
  }
  if (detector.startsWith("case-id:")) {
    return `case id (${detector.slice("case-id:".length)})`;
  }
  if (detector.startsWith("ner:")) {
    return `model (${detector.slice("ner:".length)})`;
  }
  return detector;
}

/** 由检测器标识派生发现者类别。 */
export function finderOf(detector: string | undefined, source: "regex" | "ner"): MaskingFinder {
  if (detector === undefined || detector === "") return "unknown";
  if (source === "ner" || detector.startsWith("ner:")) return "model";
  if (detector.startsWith(KNOWN_DETECTOR_PREFIX)) return "known";
  return "rule";
}
