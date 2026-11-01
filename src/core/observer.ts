/**
 * 脱敏诊断观察者。
 *
 * 记录能力通过这个可选回调取得"哪条命中被哪段文本替换"，默认不注册时零开销；
 * 原值只在观察者显式声明需要时填充，避免明文扩散到普通调用方。
 */
import type { PIIType } from "../types/index.js";

/** 一条被替换的命中。 */
export interface ObservedEntity {
  type: PIIType;
  /** 稳定检测器标识；缺失表示来源未知。 */
  recognizer?: string;
  /** 原文中的起止偏移（已从规范化文本折回）。 */
  start: number;
  end: number;
  /** 实际写入的占位符。 */
  replaced: string;
  /** 原值：只有观察者声明需要时才填充。 */
  original?: string;
}

/** 单次调用的预算与取消。 */
export interface AnonymizeRun {
  /** 绝对时间戳：超过后不再调用模型，按 nerFailure 处理。 */
  deadline?: number;
  /** 宿主取消信号：取消直接结束，不降级。 */
  signal?: AbortSignal;
}

/** 诊断观察者。 */
export interface PiiObserver {
  readonly includeOriginal?: boolean;
  onEntity(entity: ObservedEntity): void;
}
