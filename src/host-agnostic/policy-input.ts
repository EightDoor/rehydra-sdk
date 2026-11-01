/**
 * 脱敏策略配置的规范化。
 *
 * 配置来自 JSON：集合类字段是数组，阈值是对象；而代码里用的是 Set / Map。
 * 这里把两种形态统一成运行时形态，无法解析的项报出字段名，不静默丢弃。
 */
import { PIIType, type AnonymizationPolicy, type CustomIdPattern } from "../types/index.js";

/** 规范化结果：成功时带策略，失败时带出错字段。 */
export type PolicyInputResult =
  | { ok: true; policy: Partial<AnonymizationPolicy> }
  | { ok: false; field: string; message: string };
/**
 * 用户可写的策略形态：JSON 配置里集合是数组、阈值是普通对象，
 * 程序化调用也可以直接用 Set / Map。
 */
export interface PolicyInputShape {
  enabledTypes?: string[] | Set<string>;
  regexEnabledTypes?: string[] | Set<string>;
  nerEnabledTypes?: string[] | Set<string>;
  typePriority?: string[] | Set<string>;
  allowlistTerms?: string[] | Set<string>;
  excludeLocationScopes?: string[] | Set<string>;
  confidenceThresholds?: Record<string, number> | Map<string, number>;
  denylistPatterns?: string[] | RegExp[];
  customIdPatterns?: unknown[];
  reuseIdsForRepeatedPII?: boolean;
  enableLeakScan?: boolean;
  enableSemanticMasking?: boolean;
}

type ThresholdMap = AnonymizationPolicy["confidenceThresholds"];
type TypeSet = AnonymizationPolicy["enabledTypes"];
type ScopeSet = AnonymizationPolicy["excludeLocationScopes"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 把数组或 Set 转成字符串集合；其他形态报错。 */
function toStringSet(value: unknown, field: string): Set<string> | { error: string } {
  if (value instanceof Set) {
    return new Set([...value].map((item) => String(item)));
  }
  if (Array.isArray(value)) {
    return new Set(value.map((item) => String(item)));
  }
  return { error: `${field} must be an array or a Set` };
}

/** 把数组转成 PII 类型列表，忽略未知类型名。 */
function toPIITypeList(value: unknown): PIIType[] {
  const known = new Set<string>(Object.values(PIIType));
  const items = value instanceof Set ? [...value] : (value as unknown[]);
  return items
    .map((item) => String(item))
    .filter((item): item is PIIType => known.has(item));
}

/** 把对象或 Map 转成阈值映射。 */
function toThresholdMap(value: unknown): ThresholdMap | { error: string } {
  const source: Array<[string, unknown]> =
    value instanceof Map
      ? ([...value.entries()].map(([key, item]) => [
          String(key),
          item,
        ]) as Array<[string, unknown]>)
      : Object.entries(value as Record<string, unknown>);

  const known = new Set<string>(Object.values(PIIType));
  const out: ThresholdMap = new Map();
  for (const [key, item] of source) {
    if (!known.has(key)) continue;
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1) {
      return { error: `confidenceThresholds.${key} must be a number between 0 and 1` };
    }
    out.set(key as PIIType, item);
  }
  return out;
}

/** 自定义 ID 模式：支持字符串或 { name, pattern, type } 形态。 */
function toCustomIdPatterns(value: unknown): CustomIdPattern[] {
  if (!Array.isArray(value)) return [];
  const out: CustomIdPattern[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({
        name: item,
        pattern: new RegExp(item, "g"),
        type: PIIType.CUSTOMER_ID,
      });
      continue;
    }
    if (isRecord(item) && typeof item.pattern === "string") {
      const type =
        typeof item.type === "string" ? (item.type as PIIType) : PIIType.CUSTOMER_ID;
      out.push({
        name: typeof item.name === "string" ? item.name : item.pattern,
        pattern: new RegExp(item.pattern, "g"),
        type,
      });
    }
  }
  return out;
}

/**
 * 把 JSON 形态的策略规范化为运行时形态。
 *
 * 只处理集合类与阈值类字段；布尔与数值字段由调用方按原样传递。
 */
export function normalizePolicyInput(raw: unknown): PolicyInputResult {
  if (raw === undefined || raw === null) {
    return { ok: true, policy: {} };
  }
  if (!isRecord(raw)) {
    return { ok: false, field: "policy", message: "policy must be an object" };
  }

  const policy: Partial<AnonymizationPolicy> = {};

  if (raw.enabledTypes !== undefined) {
    policy.enabledTypes = new Set(toPIITypeList(raw.enabledTypes)) as unknown as TypeSet;
  }
  if (raw.regexEnabledTypes !== undefined) {
    policy.regexEnabledTypes = new Set(
      toPIITypeList(raw.regexEnabledTypes),
    ) as unknown as TypeSet;
  }
  if (raw.nerEnabledTypes !== undefined) {
    policy.nerEnabledTypes = new Set(
      toPIITypeList(raw.nerEnabledTypes),
    ) as unknown as TypeSet;
  }
  if (raw.typePriority !== undefined) {
    policy.typePriority = toPIITypeList(raw.typePriority);
  }
  if (raw.allowlistTerms !== undefined) {
    const set = toStringSet(raw.allowlistTerms, "policy.allowlistTerms");
    if ("error" in set) {
      return { ok: false, field: "policy.allowlistTerms", message: set.error };
    }
    policy.allowlistTerms = set;
  }
  if (raw.excludeLocationScopes !== undefined) {
    const set = toStringSet(
      raw.excludeLocationScopes,
      "policy.excludeLocationScopes",
    );
    if ("error" in set) {
      return {
        ok: false,
        field: "policy.excludeLocationScopes",
        message: set.error,
      };
    }
    const scopes = ["city", "country", "region", "macro-region"];
    policy.excludeLocationScopes = new Set(
      [...set].filter((item) => scopes.includes(item)),
    ) as unknown as ScopeSet;
  }
  if (raw.confidenceThresholds !== undefined) {
    const map = toThresholdMap(raw.confidenceThresholds);
    if ("error" in map) {
      return {
        ok: false,
        field: "policy.confidenceThresholds",
        message: map.error,
      };
    }
    policy.confidenceThresholds = map;
  }
  if (raw.denylistPatterns !== undefined) {
    // 运行时用 RegExp；配置里给字符串更安全，也避免 JSON 无法表达正则。
    const items =
      raw.denylistPatterns instanceof Set
        ? [...raw.denylistPatterns]
        : raw.denylistPatterns;
    if (!Array.isArray(items)) {
      return {
        ok: false,
        field: "policy.denylistPatterns",
        message: "policy.denylistPatterns must be an array",
      };
    }
    const patterns: RegExp[] = [];
    for (const item of items) {
      if (item instanceof RegExp) {
        patterns.push(item);
        continue;
      }
      if (typeof item !== "string") {
        return {
          ok: false,
          field: "policy.denylistPatterns",
          message: "policy.denylistPatterns must contain strings",
        };
      }
      try {
        patterns.push(new RegExp(item, "g"));
      } catch {
        return {
          ok: false,
          field: "policy.denylistPatterns",
          message: `policy.denylistPatterns has an invalid pattern: ${item}`,
        };
      }
    }
    policy.denylistPatterns = patterns;
  }
  if (raw.customIdPatterns !== undefined) {
    policy.customIdPatterns = toCustomIdPatterns(raw.customIdPatterns);
  }

  return { ok: true, policy };
}
