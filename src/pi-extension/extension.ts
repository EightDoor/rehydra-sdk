/**
 * Pi 扩展的 ExtensionAPI 适配层。
 *
 * 与 {@link scrubCore} / `rehydrateToolArgumentsInPlace` 配合，把脱敏能力挂到 Pi 的事件钩子上。
 *
 * - `context_with_system` 在每个 LLM 请求前对 `messages` 做脱敏；
 * - `tool_call` 在工具执行前严格还原入参标签；还原不全即阻断该次调用；
 * - `tool_result` 在结果回填给模型前就地脱敏真实 PII；
 * - `message_end` 改写最终 assistant 文本，把 PII 标签还原为真值；
 * - `session_start` / `session_shutdown` 管理会话与匿名器生命周期。
 *
 * 设计目标：
 * - 复用 {@link scrubCore} 递归处理消息树；
 * - 覆盖宿主会转成模型输入的全部消息角色（user / assistant / toolResult /
 *   system / bashExecution / custom / 两类摘要）；
 * - 失败语义：宿主会吞掉处理器异常并继续用未脱敏内容发请求，因此脱敏异常
 *   在扩展内自行捕获并告警；工具执行路径则失败关闭（阻断该次调用）；
 * - 资源释放：`session_shutdown` 幂等释放 session 注册表与匿名器；
 * - 暴露 `/rehydra` 命令，便于用户在交互模式快速查看当前配置。
 */
import type {
  AgentMessage,
  ContextEventResult,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from "./host-types.js";

import {
  PIIType,
  createDefaultPolicy,
  SECRET_PII_TYPES,
} from "../types/index.js";
import type {
  AnonymizationPolicy,
  TagFormat,
} from "../types/index.js";
import type { AnonymizerConfig } from "../core/anonymizer.js";
import { Anonymizer, createAnonymizer } from "../index.js";
import type { AnonymizerSessionImpl } from "../storage/session-base.js";
import { InMemoryKeyProvider } from "../crypto/index.js";
import { InMemoryPIIStorageProvider } from "../storage/in-memory.js";
import {
  anonymizerConfigFromOptions,
  DEFAULT_RECORD_OPTIONS,
  normalizeRehydraOptions,
  policyFromOptions,
} from "../host-agnostic/normalize-options.js";
import { buildTagPrefix } from "../utils/regex.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { MaskingRecordStore } from "../records/sqlite-store.js";
import { finderOf, type MaskingRecord, type MaskingSnapshot } from "../records/types.js";
import { buildSnapshot, serializeSnapshot } from "../records/snapshot.js";
import { startViewer, type ViewerHandle } from "../records/viewer/server.js";
import { buildPIISystemInstruction } from "../proxy/system-instruction.js";
import { githubUsernameRecognizer } from "./github-username.js";
import { gitIdentityRecognizer } from "./git-identity.js";
import { protectIdentityTags } from "./identity-recognizer.js";
import {
  scrubCore,
  type ScrubComparison,
  type ScrubCoreOptions,
  type ScrubCoreStats,
  type ScrubHit,
  type ScrubHost,
  type ScrubMessage,
  type ScrubPart,
} from "../host-agnostic/scrub.js";
import {
  ToolArgumentRehydrateError,
  rehydrateToolArgumentsInPlace,
} from "../utils/tool-arguments.js";

/** Pi 扩展运行时状态：跨多个事件共享。 */
interface PiExtensionState {
  anonymizer: Anonymizer;
  policy: Partial<AnonymizationPolicy>;
  locale?: string;
  tagFormat: TagFormat;
  tagPrefix: string;
  rehydraInstruction: string;
  vcsIdentities: boolean;
  /** 当前生效的正则识别类型。 */
  effectiveRegexTypes: string[];
  /** 脱敏记录存储（SQLite）。 */
  store: MaskingRecordStore;
  /** 模型检测不可用时的处理。 */
  nerFailure: "rules" | "block";
  /** 是否启用模型检测。 */
  nerEnabled: boolean;
  /** 上次模型降级告警时间，用于限频。 */
  lastModelWarningAt: number;
  /** 统一日志出口。 */
  log: ScrubHost["log"];
  /** 允许字面标签放行的工具名（见 `allowLiteralTagsIn`）。 */
  allowLiteralTagsIn: Set<string>;
  /** 是否启动本机查看页面。 */
  dashboardEnabled: boolean;
  resolveSession: (sessionId: string) => AnonymizerSessionImpl;
}

/** 构造脱敏策略：对启用 `vcsIdentities` 的命令叠加 GITHUB_USERNAME / PERSON。 */
function buildIdentityPolicyBuilder(state: PiExtensionState) {
  return (types: PIIType[]): Partial<AnonymizationPolicy> => {
    const base = state.policy;
    const defaults = createDefaultPolicy();
    const enabledTypes = new Set(base.enabledTypes ?? defaults.enabledTypes);
    const regexEnabledTypes = new Set(
      base.regexEnabledTypes ?? defaults.regexEnabledTypes,
    );
    for (const secretType of SECRET_PII_TYPES) {
      enabledTypes.add(secretType);
      regexEnabledTypes.add(secretType);
    }
    for (const type of types) {
      enabledTypes.add(type);
      regexEnabledTypes.add(type);
    }
    return {
      ...base,
      enabledTypes,
      regexEnabledTypes,
      reuseIdsForRepeatedPII: true,
    };
  };
}

/** 命令抽取：从 Pi 的 `tool-call` input 中识别 `bash` / `powershell` 等命令。 */
function extractCommandFromInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const candidate = (input as Record<string, unknown>).command;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * 构建 {@link ScrubHost}：从 AgentMessage 的 `toolCall` / `toolResult` parts
 * 中抽取 shell 命令，并启用 VCS 身份策略。
 */
function buildScrubHost(state: PiExtensionState): ScrubHost {
  const commandByCallID = new Map<string, string>();
  const identityBuilder = buildIdentityPolicyBuilder(state);

  return {
    sessionID: "",
    log: createConsoleLogger(),
    extractCommand(input: unknown): string | undefined {
      return extractCommandFromInput(input);
    },
    commandForPart(callID: string | undefined): string | undefined {
      if (callID === undefined) return undefined;
      return commandByCallID.get(callID);
    },
    recordCommand(callID: string | undefined, command: string | undefined): void {
      if (callID === undefined || command === undefined) return;
      commandByCallID.set(callID, command);
    },
    applyIdentityPolicy(
      base: Partial<AnonymizationPolicy> | undefined,
      command: string | undefined,
    ): Partial<AnonymizationPolicy> {
      if (command === undefined) return base ?? state.policy;
      const types: PIIType[] = [];
      // 简化启发式：命令中出现 git / gh 即视为 VCS 上下文。
      if (/^(?:.*\s)?(?:git|gh)\b/.test(command)) {
        // git 走 PERSON；gh 走 GITHUB_USERNAME。两个都启用即可，由 recognizer
        // 各自按结构化字段匹配，不会冲突。
        types.push(PIIType.GITHUB_USERNAME, PIIType.PERSON);
      }
      if (types.length === 0) return base ?? state.policy;
      return identityBuilder(types);
    },
  };
}


/** 单次宿主事件允许花在模型检测上的时间上限。 */
const MODEL_BUDGET_MS = 5000;

/**
 * system 消息里存放工具声明的提示分段名。
 *
 * 该段是工具描述文本，替换成占位符会改变模型看到的工具语义，因此不参与脱敏。
 */
const SYSTEM_TOOLS_SECTION = "tools";

/** 注入占位符说明用的提示分段名。 */
const REHYDRA_SECTION = "rehydra";

/**
 * 把脱敏异常折算成稳定的原因码。
 *
 * 异常 message 可能夹带原文（例如宿主用 `AbortSignal.abort(new Error(用户内容))`），
 * 所以记录里只存码；排查细节仍由同一条告警日志承载。
 */
function maskingFailureCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "masking-aborted";
  if (error instanceof Error && error.name === "TimeoutError") return "masking-timeout";
  return "masking-failed";
}

/** 降级告警按服务地址每分钟至多一条（记录在 state 上）。 */
function warnDegradedOnce(state: PiExtensionState, errors: Array<{ code: string }>): void {
  const now = Date.now();
  if (now - state.lastModelWarningAt < 60_000) return;
  state.lastModelWarningAt = now;
  state.log.warn("model detection unavailable, fell back to rules", {
    code: errors[0]?.code ?? "model-failed",
  });
}

/** 把一次宿主事件的采集结果组装成请求记录。 */
function recordRequest(
  state: PiExtensionState,
  sessionId: string,
  source: MaskingRecord["source"],
  startedAt: number,
  stats: {
    scrubbed: number;
    hits?: ScrubHit[];
    comparisons?: ScrubComparison[];
    truncated?: boolean;
    integrity?: "complete" | "rules-only";
    detectionErrors?: Array<{ finder: "model"; code: string }>;
    /** 完整文本快照（钩子收到的内容与扩展输出的内容）。 */
    snapshot?: MaskingSnapshot;
    /** 脱敏失败但按现有策略放行时的原因码。 */
    failure?: string;
  },
): void {
  const store = state.store;
  if (!store.enabled) return;
  const now = Date.now();
  const record: MaskingRecord = {
    version: 1,
    id: store.nextId(now),
    sessionId,
    scope: "model-input",
    source,
    time: new Date(now).toISOString(),
    durationMs: now - startedAt,
    masked: stats.scrubbed,
    blocked: false,
    integrity: stats.integrity ?? "complete",
    hits: (stats.hits ?? []).map((hit) => ({
      type: hit.type as PIIType,
      finder: finderOf(hit.detector, hit.detector.startsWith("ner:") ? "ner" : "regex"),
      detector: hit.detector,
      placeholder: hit.placeholder,
      length: hit.length,
      start: hit.start,
      end: hit.end,
      ...(hit.original === undefined ? {} : { original: hit.original }),
    })),
    comparisons: stats.comparisons ?? [],
    ...(stats.snapshot === undefined ? {} : { snapshot: stats.snapshot }),
    ...(stats.failure === undefined ? {} : { failure: stats.failure }),
  };
  if (stats.truncated === true) {
    record.comparisons = record.comparisons.map((item) => ({ ...item, truncated: true }));
  }
  if (stats.detectionErrors !== undefined && stats.detectionErrors.length > 0) {
    record.errors = stats.detectionErrors.map((entry) => ({
      finder: entry.finder,
      code: entry.code,
    }));
  }
  store.add(record);
}

/** 记录一条关联事件（不是独立模型请求，不计命中）。 */
function recordRelatedEvent(
  state: PiExtensionState,
  sessionId: string,
  kind: "tool_call" | "message_end",
  code?: string,
): void {
  const store = state.store;
  if (!store.enabled) return;
  const now = Date.now();
  store.add({
    version: 1,
    id: store.nextId(now),
    sessionId,
    scope: "model-input",
    source: kind,
    time: new Date(now).toISOString(),
    durationMs: 0,
    masked: 0,
    blocked: code !== undefined,
    integrity: "complete",
    hits: [],
    comparisons: [],
    relatedEvents: [{ kind, ...(code === undefined ? {} : { code }) }],
  });
}



/** Pi 扩展运行时不暴露 logger 通道，统一走 console.warn 兜底。 */
function createConsoleLogger(): ScrubHost["log"] {
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    const suffix = extra === undefined ? "" : ` extra=${JSON.stringify(extra)}`;
    const line = `service=pi-rehydra level=${level} message=${message}${suffix}`;
    if (level === "error") {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.warn(line);
    }
  };
  return {
    debug: (message, extra) => emit("debug", message, extra),
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
  };
}

/**
 * 一条消息里被投影出来的文本块，各自从哪里取、scrub 后写回哪里。
 *
 * 只有把整条消息正文投影成独立文本块的角色需要它：system 的提示分段、
 * bashExecution 的命令与输出、custom 的字符串正文、两类摘要的正文。
 * 其余角色（user / assistant / toolResult）沿用按块索引回写。
 */
type FieldWriteTarget =
  | { kind: "field"; field: string }
  | { kind: "section"; key: string };

/**
 * Pi 中的 `UserMessage.content` 可以是字符串或 `(TextContent | ImageContent)[]`。
 * 共享核心按 `ScrubPart[]` 处理，所以这里把它统一拍平为 `[{ type: "text", text }]`。
 * 同时记录下原字段是字符串，以便 scrub 后把改动写回到原字段。
 */
interface MessageRewrite {
  scrubMessages: ScrubMessage[];
  /** index in scrubMessages -> 原始 content 字段是否是字符串 */
  userStringContent: Map<number, { original: string }>;
  /** index in scrubMessages -> 投影文本块各自的写回位置 */
  fieldWrites: Map<number, FieldWriteTarget[]>;
}
function normalizeMessagesForScrub(messages: AgentMessage[]): MessageRewrite {
  const scrubMessages: ScrubMessage[] = [];
  const userStringContent = new Map<number, { original: string }>();
  const fieldWrites = new Map<number, FieldWriteTarget[]>();
  messages.forEach((m, index) => {
    const role = (m as { role?: string }).role;
    if (role === "user") {
      const content = (m as { content?: unknown }).content;
      if (typeof content === "string") {
        userStringContent.set(index, { original: content });
        scrubMessages.push({
          content: [{ type: "text", text: content }],
        });
        return;
      }
    }
    const projected = projectMessage(m);
    scrubMessages.push(projected.scrub);
    if (projected.writes.length > 0) {
      fieldWrites.set(index, projected.writes);
    }
  });
  return { scrubMessages, userStringContent, fieldWrites };
}

/**
 * scrub 后把 parts 改动写回到 AgentMessage，保持 Pi 原始 content 结构。
 *
 * - user string content：取 scrub 后第一段 text 还原回字符串；
 * - toolResult：scrub 侧逐 text 块收集为文本数组，这里按块索引逐块写回
 *   （多轮往返稳定，不合并、不压平）；**不能**拿 scrub 侧结构覆盖 Pi 的
 *   content，那会让 toolResult 变成 scrub 侧结构、模型看不到任何工具输出；
 * - 其余（user / assistant 数组 content）：parts 与原始 content 元素一一对应，
 *   按块类型回写 text / thinking / toolCall.arguments。
 * - 有字段写回计划的消息（system / bashExecution / custom / 摘要）：
 *   按计划把投影出的文本块写回对应字段或提示分段，跳过按块索引回写。
 */
function restoreMessagesFromScrub(
  originals: AgentMessage[],
  scrubbed: ScrubMessage[],
  userStringContent: Map<number, { original: string }>,
fieldWrites: Map<number, FieldWriteTarget[]>,
): void {
  scrubbed.forEach((scrub, index) => {
    const original = originals[index] as { role?: string; content?: unknown };
    const writes = fieldWrites.get(index);
    if (writes !== undefined) {
      restoreProjectedFields(original, scrub, writes);
      return;
    }
    if (userStringContent.has(index)) {
      const firstPart = scrub.content?.[0];
      if (
        firstPart !== undefined &&
        firstPart !== null &&
        typeof firstPart.text === "string"
      ) {
        original.content = firstPart.text;
      }
      return;
    }

    const parts = scrub.content;
    if (!Array.isArray(parts)) return;
    const originalContent = original.content;
    if (!Array.isArray(originalContent)) return;

    if (original.role === "toolResult") {
      const restored = parts.find((part) => part.type === "tool-result")?.result;
      if (!Array.isArray(restored)) return;
      const textBlocks = originalContent.filter(
        (block): block is Record<string, unknown> =>
          block !== null &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text",
      );
      // result 与 text 块逐块对应（scrub 侧逐块收集），按索引写回保证往返稳定。
      restored.forEach((value, i) => {
        const block = textBlocks[i];
        if (block !== undefined && typeof value === "string") {
          block["text"] = value;
        }
      });
      return;
    }

    originalContent.forEach((block, i) => {
      const part = parts[i];
      if (part === undefined || block === null || typeof block !== "object") return;
      writeScrubbedBlock(block as Record<string, unknown>, part);
    });
  });
}

/** 把单个 scrub part 的结果写回对应的 Pi content 块，不改变块结构。 */
function writeScrubbedBlock(block: Record<string, unknown>, part: ScrubPart): void {
  if (block["type"] === "text" && typeof part.text === "string") {
    block["text"] = part.text;
  } else if (block["type"] === "thinking" && typeof part.text === "string") {
    block["thinking"] = part.text;
  } else if (block["type"] === "toolCall" && part.type === "tool-call") {
    block["arguments"] = part.input;
  }
}

/**
 * 一条消息的投影结果：可脱敏的文本块 + 各自的写回位置。
 */
interface MessageProjection {
  /** 交给共享核心扫描的结构。 */
  scrub: ScrubMessage;
  /** 与 `scrub.content` 下标一一对应的写回位置；为空表示沿用按块索引回写。 */
  writes: FieldWriteTarget[];
}

/**
 * 把一条 Pi 消息投影成共享核心可扫描的结构。
 *
 * 覆盖宿主会转成模型输入的全部角色：user / assistant / toolResult 沿用
 * 按块索引回写；system / bashExecution / custom / 两类摘要把正文投影成
 * 独立文本块，并记录各自的写回位置。
 */
function projectMessage(message: AgentMessage): MessageProjection {
  const role = (message as { role?: string }).role;
  if (role === "user") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return {
        scrub: { content: [{ type: "text", text: content }] },
        writes: [],
      };
    }
    if (Array.isArray(content)) {
      return {
        scrub: { content: content.map((part) => textPartFromContent(part)) },
        writes: [],
      };
    }
    return { scrub: {}, writes: [] };
  }
  if (role === "assistant") {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return { scrub: {}, writes: [] };
    return {
      scrub: { content: content.map((block) => assistantBlockToPart(block)) },
      writes: [],
    };
  }
  if (role === "toolResult") {
    const toolCallId = (message as { toolCallId?: string }).toolCallId;
    const content = (message as { content?: unknown }).content;
    // 逐 text 块收集为文本数组：scrub 侧会递归逐串脱敏，回写时按块索引还原，
    // 多轮往返保持不动点（不 join、不压平）。
    const texts: string[] = [];
    if (Array.isArray(content)) {
      for (const c of content) {
        const part = textPartFromContent(c);
        if (typeof part.text === "string") texts.push(part.text);
      }
    }
    return {
      scrub: {
        content: [
          {
            type: "tool-result",
            id: toolCallId,
            callID: toolCallId,
            result: texts,
          },
        ],
      },
      writes: [],
    };
  }
  if (role === "system") {
    return projectSystemMessage(message);
  }
  if (role === "bashExecution") {
    return projectBashExecutionMessage(message);
  }
  if (role === "custom") {
    return projectCustomMessage(message);
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    return projectSummaryMessage(message);
  }
  return { scrub: {}, writes: [] };
}

/**
 * system 消息：提示正文在 `content` 与 `sections` 各段里，两者都会进 provider 的
 * system prompt。`sections.tools` 是工具声明，替换会改变工具语义，跳过。
 */
function projectSystemMessage(message: AgentMessage): MessageProjection {
  const content = (message as { content?: unknown }).content;
  const sections = (message as { sections?: unknown }).sections;
  const parts: ScrubPart[] = [];
  const writes: FieldWriteTarget[] = [];

  if (typeof content === "string" && content.length > 0) {
    parts.push({ type: "text", text: content });
    writes.push({ kind: "field", field: "content" });
  }

  if (sections !== null && typeof sections === "object") {
    for (const [key, value] of Object.entries(sections as Record<string, unknown>)) {
      // null 表示该段被移除，没有正文可脱敏。
      if (typeof value !== "string") continue;
      if (key === SYSTEM_TOOLS_SECTION) continue;
      parts.push({ type: "text", text: value });
      writes.push({ kind: "section", key });
    }
  }

  return { scrub: { content: parts }, writes };
}

/**
 * bashExecution 消息：命令与输出都会被转成 user 文本发给模型，两处都要脱敏。
 */
function projectBashExecutionMessage(message: AgentMessage): MessageProjection {
  const parts: ScrubPart[] = [];
  const writes: FieldWriteTarget[] = [];
  const command = (message as { command?: unknown }).command;
  const output = (message as { output?: unknown }).output;
  if (typeof command === "string") {
    parts.push({ type: "text", text: command });
    writes.push({ kind: "field", field: "command" });
  }
  if (typeof output === "string") {
    parts.push({ type: "text", text: output });
    writes.push({ kind: "field", field: "output" });
  }
  return { scrub: { content: parts }, writes };
}

/**
 * custom 消息：`content` 为字符串时整体投影；为内容块数组时沿用按块索引回写。
 */
function projectCustomMessage(message: AgentMessage): MessageProjection {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return {
      scrub: { content: [{ type: "text", text: content }] },
      writes: [{ kind: "field", field: "content" }],
    };
  }
  if (Array.isArray(content)) {
    return {
      scrub: { content: content.map((part) => textPartFromContent(part)) },
      writes: [],
    };
  }
  return { scrub: {}, writes: [] };
}

/**
 * branchSummary / compactionSummary 消息：摘要正文会被转成 user 文本发给模型。
 */
function projectSummaryMessage(message: AgentMessage): MessageProjection {
  const summary = (message as { summary?: unknown }).summary;
  if (typeof summary !== "string") return { scrub: {}, writes: [] };
  return {
    scrub: { content: [{ type: "text", text: summary }] },
    writes: [{ kind: "field", field: "summary" }],
  };
}

/**
 * 按写回计划把投影出的文本块写回原消息的字段或提示分段。
 */
function restoreProjectedFields(
  original: { role?: string; content?: unknown },
  scrub: ScrubMessage,
  writes: FieldWriteTarget[],
): void {
  const parts = scrub.content;
  if (!Array.isArray(parts)) return;
  writes.forEach((target, index) => {
    const part = parts[index];
    if (part === undefined || typeof part.text !== "string") return;
    if (target.kind === "field") {
      (original as Record<string, unknown>)[target.field] = part.text;
      return;
    }
    const sections = (original as { sections?: unknown }).sections;
    if (sections === null || typeof sections !== "object") return;
    (sections as Record<string, unknown>)[target.key] = part.text;
  });
}

/**
 * 把占位符说明注入首条 system 消息的提示分段。
 *
 * 用独立 section 而不是拼进既有分段：宿主会把同名 section 覆盖合并，独立键
 * 不会与 Pi 自己的提示段互相覆盖。
 */
function injectRehydraInstruction(messages: AgentMessage[], instruction: string): void {
  for (const message of messages) {
    if ((message as { role?: string }).role !== "system") continue;
    const target = message as { sections?: Record<string, string | null> };
    // 旧式 system 消息可能只有 content、没有 sections；补建一个空对象即可，
    // 宿主会把 content 与各 section 一起拼进提示。
    if (target.sections === undefined || target.sections === null) {
      target.sections = {};
    }
    target.sections[REHYDRA_SECTION] = instruction;
    return;
  }
}
function textPartFromContent(part: unknown): ScrubPart {
  if (part === null || typeof part !== "object") return {};
  const obj = part as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") {
    return { type: "text", text: obj.text };
  }
  if (obj.type === "image") return {};
  return {};
}

function assistantBlockToPart(block: unknown): ScrubPart {
  if (block === null || typeof block !== "object") return {};
  const obj = block as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") {
    return { type: "text", text: obj.text };
  }
  if (obj.type === "thinking") {
    const thinking = obj.thinking;
    if (typeof thinking === "string") {
      return { type: "text", text: thinking };
    }
  }
  if (obj.type === "toolCall") {
    return {
      type: "tool-call",
      id: typeof obj.id === "string" ? obj.id : undefined,
      input: obj.arguments,
    };
  }
  return {};
}


/** 暴露给 Pi 的脱敏 / 还原入口。 */
export interface RehydraPiHandle {
  /** 强制脱敏一组文本（对外命令使用）。 */
  anonymize(text: string): Promise<string>;
  /** 强制还原一组文本（对外命令使用）。 */
  rehydrate(text: string): Promise<string>;
}

/**
 * 启动本机查看页面并展示访问地址。
 *
 * 只监听 127.0.0.1 的随机端口；页面失败不影响脱敏主流程，只留一条告警。
 */
async function startViewerService(
  state: PiExtensionState,
  ctx: ExtensionContext,
): Promise<ViewerHandle | undefined> {
  if (!state.dashboardEnabled) return undefined;
  try {
    const viewer = await startViewer({
      store: state.store,
      status: () => ({
        recordsDir: state.store.path,
        recordsEnabled: state.store.enabled,
        includeOriginal: state.store.includeOriginal,
        regexTypes: state.effectiveRegexTypes,
        nerEnabled: state.nerEnabled,
        nerFailure: state.nerFailure,
        dropped: state.store.droppedCount,
      }),
    });
    const message = `Rehydra 脱敏记录页面：${viewer.url}（仅本机访问）`;
    if (ctx.hasUI) {
      ctx.ui.notify(message, "info");
    } else {
      // 无 UI 的运行方式下 stdout 可能是协议通道，地址写 stderr。
      // eslint-disable-next-line no-console
      console.error(message);
    }
    return viewer;
  } catch (error) {
    state.log.warn("failed to start the local masking viewer", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * 安装 Pi 扩展。
 *
 * 该工厂由 `src/pi-extension/index.ts` 的 default export 暴露，Pi 在加载
 * 扩展时自动调用。它负责：
 *
 * 1. 在 `session_start` 中实例化匿名器、装配会话注册表与策略；
 * 2. 在 `context_with_system` / `tool_call` / `tool_result` / `message_end`
 *    上挂载脱敏 / 还原钩子；
 * 3. 在 `session_shutdown` 中幂等释放所有资源；
 * 4. 启动本机查看页面，并把访问地址告知用户。
 */
export function createRehydraPiExtension(pi: ExtensionAPI): void {
  // Per-session runtime state, scoped to a single Pi session.
  const runtime: { state?: PiExtensionState; viewer?: ViewerHandle } = {};

  const setupRuntime = async (
    cwd: string,
    rawOptions: unknown,
  ): Promise<PiExtensionState> => {
    const options = normalizeRehydraOptions(rawOptions);
    const policy = policyFromOptions(options) ?? {};
    const effectiveRegexTypes = [
      ...(policy.regexEnabledTypes ?? createDefaultPolicy().regexEnabledTypes),
    ].sort();
    const anonymizerConfig: AnonymizerConfig = anonymizerConfigFromOptions(
      options,
      cwd,
    );
    const keyProvider = new InMemoryKeyProvider();
    const piiStorage = new InMemoryPIIStorageProvider();
    const anonymizer = createAnonymizer({
      ...anonymizerConfig,
      keyProvider,
      piiStorageProvider: piiStorage,
      // 优先级：完整匿名器配置 > 顶层快捷配置 > Pi 默认（降级为规则）
      nerFailure: anonymizerConfig.nerFailure ?? options.nerFailure ?? "rules",
    });
    const tagFormat =
      anonymizerConfig.tagFormat ??
      options.tagFormat ?? { open: "<", close: "/>", keyword: "PII" };
    if (options.vcsIdentities === true) {
      anonymizer
        .getRegistry()
        .register(protectIdentityTags(githubUsernameRecognizer, tagFormat));
      anonymizer
        .getRegistry()
        .register(protectIdentityTags(gitIdentityRecognizer, tagFormat));
    }
    await anonymizer.initialize();

    const tagPrefix = buildTagPrefix(tagFormat);
    const rehydraInstruction = `<rehydra>\n${buildPIISystemInstruction(tagFormat)}\n</rehydra>`;

    const recordOptions = options.record;
    const store = new MaskingRecordStore(
      {
        ...DEFAULT_RECORD_OPTIONS,
        ...(recordOptions ?? {}),
        dir: recordOptions?.dir ?? join(homedir(), ".pi", "agent", "rehydra", "records"),
      },
      (level, message, extra) => createConsoleLogger()[level](message, extra),
    );

    const sessionMap = new Map<string, AnonymizerSessionImpl>();
    const state: PiExtensionState = {
      anonymizer,
      policy,
      locale: options.locale,
      tagFormat,
      tagPrefix,
      rehydraInstruction,
      vcsIdentities: options.vcsIdentities === true,
      effectiveRegexTypes,
      store,
      nerFailure: options.nerFailure ?? "rules",
      nerEnabled: (anonymizerConfig.ner?.mode ?? "disabled") !== "disabled",
      lastModelWarningAt: 0,
      log: createConsoleLogger(),
      allowLiteralTagsIn: new Set(options.allowLiteralTagsIn ?? []),
      dashboardEnabled: options.dashboard?.enabled ?? true,
      resolveSession(sessionId: string): AnonymizerSessionImpl {
        let session = sessionMap.get(sessionId);
        if (session === undefined) {
          session = anonymizer.session(sessionId) as unknown as AnonymizerSessionImpl;
          sessionMap.set(sessionId, session);
        }
        return session;
      },
    };
    void sessionMap;

    return state;
  };

  const disposeRuntime = async (state?: PiExtensionState): Promise<void> => {
    // 先关页面服务，再释放匿名器，避免页面在会话结束后继续读记录。
    // 页面在 state 已丢失时也要关掉，否则端口会一直挂着。
    if (runtime.viewer !== undefined) {
      try {
        await runtime.viewer.close();
      } catch {
        // 关闭失败不影响会话释放
      }
      runtime.viewer = undefined;
    }
    if (state === undefined) return;
    try {
      await state.anonymizer.dispose();
    } catch {
      // Dispose is best-effort: the session is being torn down regardless.
    }
    try {
      state.store.close();
    } catch {
      // 关闭数据库失败不影响会话释放
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.sessionManager.getCwd();
    const settings = pi.getSettings();
    const rawOptions = readPiExtensionOptions(settings);
    // 重载会再次触发 session_start：先完整释放上一轮（页面、匿名器、数据库），
    // 否则旧连接只能等 GC，句柄与 WAL 生命周期不可控。
    await disposeRuntime(runtime.state);
    runtime.state = undefined;
    runtime.state = await setupRuntime(cwd, rawOptions);
    if (runtime.state !== undefined) {
      runtime.viewer = await startViewerService(runtime.state, ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    await disposeRuntime(runtime.state);
    runtime.state = undefined;
  });

  pi.on("context_with_system", async (event, ctx) => {
    const state = runtime.state;
    if (state === undefined) return {};
    const host = buildScrubHost(state);
    const sessionId = ctx.sessionManager.getSessionId();
    (host as { sessionID: string }).sessionID = sessionId;
    const scrubOptions: ScrubCoreOptions = {
      locale: state.locale,
      policy: state.policy,
      // 一次宿主事件共用 5s 模型预算；取消直接结束，不降级
      deadlineMs: MODEL_BUDGET_MS,
      ...(ctx.signal instanceof AbortSignal ? { signal: ctx.signal } : {}),
    };
    // 把 user string content 拍平为 parts 数组便于共享核心处理；返回还原
    // 映射，以便在 scrub 后把改动写回到原始消息的 `content` 字段。
    const rewrite = normalizeMessagesForScrub(event.messages);
    const startedAt = Date.now();
    // 快照保存钩子实际收到的内容；scrub 会就地改写 messages，所以必须先取。
    const beforeSnapshot = state.store.includeOriginal
      ? serializeSnapshot(event.messages)
      : undefined;
    let stats: ScrubCoreStats;
    try {
      stats = await scrubCore(
        rewrite.scrubMessages,
        state.resolveSession(sessionId),
        host,
        scrubOptions,
        state.store.enabled
          ? {
              includeOriginal: state.store.includeOriginal,
              maxRecordBytes: state.store.maxRecordBytes,
            }
          : undefined,
      );
    } catch (error) {
      // 宿主会吞掉处理器异常并继续用未脱敏内容发请求，所以在这里自己兜住：
      // 内容保持原样，本次请求照常发出，但要留下可定位的告警。
      const reason = error instanceof Error ? error.message : String(error);
      state.log.warn("masking failed; request may contain unmasked content", {
        event: "context_with_system",
        sessionId,
        reason,
      });
      // 失败也记录：页面要能看出这次请求的内容没有被脱敏。
      // 记录里只写原因码：异常 message 可能夹带原文，不能绕过关掉原文保存的配置。
      recordRequest(state, sessionId, "context", startedAt, {
        scrubbed: 0,
        failure: maskingFailureCode(error),
        snapshot: buildSnapshot(
          beforeSnapshot,
          serializeSnapshot(event.messages),
          state.store.maxRecordBytes,
        ),
      });
      return { messages: event.messages };
    }
    restoreMessagesFromScrub(
      event.messages,
      rewrite.scrubMessages,
      rewrite.userStringContent,
      rewrite.fieldWrites,
    );
    if (stats.scrubbed > 0) {
      injectRehydraInstruction(event.messages, state.rehydraInstruction);
    }
    if (stats.detectionErrors !== undefined) warnDegradedOnce(state, stats.detectionErrors);
    recordRequest(state, sessionId, "context", startedAt, {
      ...stats,
      snapshot: buildSnapshot(
        beforeSnapshot,
        state.store.includeOriginal ? serializeSnapshot(event.messages) : undefined,
        state.store.maxRecordBytes,
      ),
    });
    // 共享核心就地改写了 event.messages；显式回传，保证 Pi 使用改写后的数组。
    const result: ContextEventResult = { messages: event.messages };
    return result;
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    const state = runtime.state;
    if (state === undefined) {
      // 扩展尚未初始化（初始化失败或尚未完成）：没有脱敏映射，工具可能拿到
      // 未还原的占位符参数，直接阻止执行。
      return {
        block: true,
        reason: "Rehydra 扩展未初始化，已阻止工具执行。",
      };
    }
    const session = state.resolveSession(ctx.sessionManager.getSessionId());
    // 严格还原：还原不全就阻断，绝不把 `<PII .../>` 当真实值交给工具执行。
    // 宿主契约（已核对 pi 运行时）：`{block: true}` 会直接产出 error 工具结果、不执行工具。
    // 放行是显式配置的豁免，必须留痕；logger 复用扩展统一的 output 格式。
    const log = createConsoleLogger();
    try {
      await rehydrateToolArgumentsInPlace(event.input, session, {
        tagFormat: state.tagFormat,
        allowUnresolved: state.allowLiteralTagsIn.has(event.toolName),
        onUnresolvedTag: (path) => {
          // 只记工具名与参数路径，不记正文。
          log.warn("allowed literal tag in tool args", {
            tool: event.toolName,
            path,
          });
        },
      });
    } catch (error) {
      const code =
        error instanceof ToolArgumentRehydrateError ? error.code : "rehydrate-failed";
      // reason 只带原因码，不回显命令或参数正文。
      recordRelatedEvent(state, ctx.sessionManager.getSessionId(), "tool_call", code);
      return {
        block: true,
        reason:
          `工具参数包含无法还原的 PII 占位符（${code}），已阻止执行。` +
          `请改用真实值，或检查本次会话的脱敏映射是否仍然可用。`,
      };
    }
    return undefined;
  });

  pi.on(
    "tool_result",
    async (event: ToolResultEvent, ctx): Promise<ToolResultEventResult | undefined> => {
      const state = runtime.state;
      if (state === undefined) return undefined;
      const session = state.resolveSession(ctx.sessionManager.getSessionId());
      // 把结果先脱敏再返回模型；content 是 (TextContent|ImageContent)[]，
      // 仅处理 TextContent 的 text 字段；image 维持原样。
      const result: ToolResultEventResult = {};
      const startedAt = Date.now();
      const hits: ScrubHit[] = [];
      const comparisons: ScrubComparison[] = [];
      // 工具原文快照：工具结果进入下一轮请求时已被脱敏，这里先留一份原文。
      const beforeSnapshot = state.store.includeOriginal
        ? serializeSnapshot(event.content)
        : undefined;
      let failure: string | undefined;
      // 与 context 路径一致：整次事件共享模型预算，宿主取消直接结束
      const run = {
        deadline: Date.now() + MODEL_BUDGET_MS,
        ...(ctx.signal instanceof AbortSignal ? { signal: ctx.signal } : {}),
      };
      let compareBytes = 0;
      let comparisonsTruncated = false;
      let integrity: "complete" | "rules-only" | undefined;
      const detectionErrors: Array<{ finder: "model"; code: string }> = [];
      if (Array.isArray(event.content)) {
        const scrubbed: typeof event.content = [];
        for (const part of event.content) {
          if (
            part !== null &&
            typeof part === "object" &&
            part.type === "text" &&
            typeof part.text === "string"
          ) {
            let anonymized;
            try {
              anonymized = await session.anonymize(
                part.text,
                state.locale,
                state.policy,
                state.store.enabled
                  ? {
                      includeOriginal: state.store.includeOriginal,
                      onEntity: (entity): void => {
                        hits.push({
                          type: entity.type,
                          detector: entity.recognizer ?? "unknown",
                          placeholder: entity.replaced,
                          length: entity.end - entity.start,
                          start: entity.start,
                          end: entity.end,
                          ...(entity.original === undefined
                            ? {}
                            : { original: entity.original }),
                        });
                      },
                    }
                  : undefined,
                run,
              );
            } catch (error) {
              // 宿主会吞掉处理器异常并把原始内容交给模型，所以在这里兜住：
              // 该块保持原样，但要留下可定位的告警。
              const reason = error instanceof Error ? error.message : String(error);
              state.log.warn("masking failed; tool result may reach the model unmasked", {
                event: "tool_result",
                tool: event.toolName,
                reason,
              });
              failure = failure ?? maskingFailureCode(error);
              scrubbed.push(part);
              continue;
            }
            if (anonymized.integrity !== undefined) integrity = anonymized.integrity;
            for (const entry of anonymized.detectionErrors ?? []) {
              if (!detectionErrors.some((item) => item.code === entry.code)) {
                detectionErrors.push(entry);
              }
            }
            if (
              state.store.enabled &&
              state.store.includeOriginal &&
              anonymized.anonymizedText !== part.text
            ) {
              // 按字节计费，避免中文等多字节内容突破单条记录上限
              const size =
                new TextEncoder().encode(part.text).length +
                new TextEncoder().encode(anonymized.anonymizedText).length;
              if (compareBytes + size > state.store.maxRecordBytes) {
                comparisonsTruncated = true;
              } else {
                compareBytes += size;
                comparisons.push({
                  path: `tool_result[${scrubbed.length}]`,
                  before: part.text,
                  after: anonymized.anonymizedText,
                });
              }
            }
            scrubbed.push({ type: "text", text: anonymized.anonymizedText });
          } else {
            scrubbed.push(part);
          }
        }
        result.content = scrubbed;
      }
      // 在源头对 details / structuredContent 做递归脱敏（递归 deep-rehydrate）。
      // 留空，避免破坏 TUI 渲染细节。structuredContent 不在 LLM 上下文中。
      if (detectionErrors.length > 0) warnDegradedOnce(state, detectionErrors);
      recordRequest(state, ctx.sessionManager.getSessionId(), "tool_result", startedAt, {
        scrubbed: hits.length,
        hits,
        comparisons,
        truncated: comparisonsTruncated,
        ...(integrity === undefined ? {} : { integrity }),
        ...(detectionErrors.length === 0 ? {} : { detectionErrors }),
        ...(failure === undefined ? {} : { failure }),
        snapshot: buildSnapshot(
          beforeSnapshot,
          state.store.includeOriginal ? serializeSnapshot(result.content) : undefined,
          state.store.maxRecordBytes,
        ),
      });
      return result;
    },
  );

  pi.on("message_end", async (event: MessageEndEvent, ctx): Promise<MessageEndEventResult | undefined> => {
    const state = runtime.state;
    if (state === undefined) return undefined;
    const message = event.message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
    const session = state.resolveSession(ctx.sessionManager.getSessionId());
    const newContent: unknown[] = [];
    for (const block of message.content) {
      if (block === null || typeof block !== "object") {
        newContent.push(block);
        continue;
      }
      const obj = block as Record<string, unknown>;
      if (obj.type === "text" && typeof obj.text === "string") {
        const restored = await session.rehydrate(obj.text);
        newContent.push({ ...obj, text: restored });
      } else if (obj.type === "thinking" && typeof obj.thinking === "string") {
        // 思考块是面向模型的；按原 plugin 的行为保留 PII 标签，避免泄漏。
        newContent.push(block);
      } else {
        newContent.push(block);
      }
    }
    const updated: AgentMessage = { ...message, content: newContent };
    recordRelatedEvent(state, ctx.sessionManager.getSessionId(), "message_end");
    return { message: updated };
  });

  // 兼容 try 块中可能抛错的初始化失败：通过 warn 输出而非 fail-closed。
}

function readPiExtensionOptions(settings: unknown): unknown {
  // Pi 的内置 `Settings` 不携带插件配置，扩展通过约定键 `settings.rehydra`
  // 读取配置。安装文档建议用户在 `~/.pi/agent/settings.json` 中：
  //
  // ```json
  // { "rehydra": { "redactValues": ["..."], "envFiles": ["..."] } }
  // ```
  if (settings === null || typeof settings !== "object") return undefined;
  const obj = settings as { rehydra?: unknown };
  return obj.rehydra;
}

/** 兜底避免 lint 抱怨未使用的 DEFAULT_DISABLE_TYPES。 */
void 0;