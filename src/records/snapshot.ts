/**
 * 完整文本快照的组装。
 *
 * 快照保存在记录里供网页对照查看；它只是"某一时刻的内容副本"，不参与脱敏判断。
 */
import type { MaskingProviderPayload, MaskingSnapshot } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 图片等二进制载荷不落盘：只保留占位标记。 */
const OMITTED = "[binary omitted]";

/**
 * 深拷贝并去掉二进制载荷。
 *
 * 消息里可能带图片 data（base64），体积大且不是核对对象；这里替换成占位标记。
 *
 * `seen` 只记录当前递归路径上的节点（退出时移除），否则两个字段引用同一个对象
 * 这种合法共享会被误判成循环，快照就会静默少一块内容。
 */
export function sanitizeForSnapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out = value.map((item) => sanitizeForSnapshot(item, seen));
    seen.delete(value);
    return out;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    if (seen.has(source)) return "[circular]";
    seen.add(source);
    // 用 null 原型：普通 {} 上写 `out["__proto__"] = ...` 会走原型 setter，
    // 既丢字段又改掉副本的原型链，快照就不再是"实际收到的内容"。
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(source)) {
      // 图片二进制：消息块 `data`、Anthropic 的 base64 源、Gemini inlineData（无 type，靠
      // mimeType 识别），以及 Responses 把 `image_url` 直接写成 data URL 的形态。
      const inlineImage =
        source["type"] === "image" ||
        source["type"] === "base64" ||
        source["mimeType"] !== undefined ||
        source["mime_type"] !== undefined;
      if (key === "data" && inlineImage) {
        out[key] = OMITTED;
        continue;
      }
      const dataUrl = typeof item === "string" && item.startsWith("data:");
      if (dataUrl && (key === "url" || key === "image_url")) {
        out[key] = OMITTED;
        continue;
      }
      out[key] = sanitizeForSnapshot(item, seen);
    }
    seen.delete(source);
    return out;
  }
  return value;
}

/** 把消息树序列化成快照文本；不可序列化时返回 undefined，不影响脱敏主流程。 */
export function serializeSnapshot(value: unknown): string | undefined {
  try {
    return JSON.stringify(sanitizeForSnapshot(value));
  } catch {
    return undefined;
  }
}

/** 按 UTF-8 字节截断，避免中文等多字节内容突破单条记录预算。 */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return {
    text: `${decoder.decode(bytes.slice(0, Math.max(0, maxBytes)))}…[truncated]`,
    truncated: true,
  };
}

/**
 * 组装前后快照。
 *
 * 两侧共用一份预算，超限时各自截断并标记；调用方据此在页面上说明内容不完整。
 */
export function buildSnapshot(
  before: string | undefined,
  after: string | undefined,
  maxBytes: number,
): MaskingSnapshot | undefined {
  if (before === undefined || after === undefined) return undefined;
  const half = Math.max(1, Math.floor(maxBytes / 2));
  const left = truncateToBytes(before, half);
  const right = truncateToBytes(after, half);
  const truncated = left.truncated || right.truncated;
  return {
    before: left.text,
    after: right.text,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** 组装供应商请求体快照；预算与前后快照一致，超限显式标记。 */
export function buildProviderPayload(
  body: string | undefined,
  maxBytes: number,
): MaskingProviderPayload | undefined {
  if (body === undefined) return undefined;
  const result = truncateToBytes(body, maxBytes);
  return { body: result.text, ...(result.truncated ? { truncated: true } : {}) };
}
