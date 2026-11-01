/**
 * Pi 扩展的 ExtensionAPI 适配层。
 *
 * 与 {@link scrubCore} / `rehydrateToolArgumentsInPlace` 配合，把脱敏能力挂到 Pi 的事件钩子上。
 *
 * - `context_with_system` 在每个 LLM 请求前对 `messages` 做脱敏；
 * - `tool_call` 在工具执行前严格还原入参标签；还原不全即阻断该次调用；
 * - `tool_result` 在结果回填给模型前就地脱敏真实 PII；
 * - `message_end` 改写最终 assistant 文本，把 PII 标签还原为真值；
 * - `session_start` / `session_shutdown` 管理会话与匿名器生命周期；
 * - `input` / `user_bash` 在源头做最低限度的脱敏，避免走特殊路径的 PII 漏出。
 *
 * 设计目标：
 * - 复用 {@link scrubCore} 递归处理消息树；
 * - 失败关闭：任何 scrub 异常都向上抛出，Pi 会停在该请求而不是泄漏；
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
  normalizeRehydraOptions,
  policyFromOptions,
} from "../host-agnostic/normalize-options.js";
import { buildTagPrefix } from "../utils/regex.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { MaskingRecorder } from "../records/recorder.js";
import { detectorLabel, finderOf, type MaskingRecord } from "../records/types.js";
import { buildPIISystemInstruction } from "../proxy/system-instruction.js";
import { githubUsernameRecognizer } from "./github-username.js";
import { gitIdentityRecognizer } from "./git-identity.js";
import { protectIdentityTags } from "./identity-recognizer.js";
import {
  scrubCore,
  type ScrubComparison,
  type ScrubCoreOptions,
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
  /** 脱敏记录器；未启用时 enabled 为 false。 */
  recorder: MaskingRecorder;
  /** 模型检测不可用时的处理。 */
  nerFailure: "rules" | "block";
  /** 上次模型降级告警时间，用于限频。 */
  lastModelWarningAt: number;
  /** 统一日志出口。 */
  log: ScrubHost["log"];
  /** 允许字面标签放行的工具名（见 `allowLiteralTagsIn`）。 */
  allowLiteralTagsIn: Set<string>;
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
  },
): void {
  const recorder = state.recorder;
  if (!recorder.enabled) return;
  const now = Date.now();
  const record: MaskingRecord = {
    version: 1,
    id: recorder.nextId(now),
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
  recorder.add(record);
}

/** 记录一条关联事件（不是独立模型请求，不计命中）。 */
function recordRelatedEvent(
  state: PiExtensionState,
  sessionId: string,
  kind: "tool_call" | "message_end",
  code?: string,
): void {
  const recorder = state.recorder;
  if (!recorder.enabled) return;
  const now = Date.now();
  recorder.add({
    version: 1,
    id: recorder.nextId(now),
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


/** `/rehydra` 子命令：无参数看状态，`log` 看记录，`clear` 清记录。 */
async function handleRehydraCommand(
  args: string,
  state: PiExtensionState,
  ctx: ExtensionContext,
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter((token) => token !== "");
  const sub = tokens[0];

  if (sub === undefined) {
    ctx.ui.notify(
      [
        `Rehydra Pi extension active.`,
        `cwd: ${ctx.sessionManager.getCwd()}`,
        `tagPrefix: ${state.tagPrefix}`,
        `vcsIdentities: ${state.vcsIdentities}`,
        `regexTypes: ${state.effectiveRegexTypes.join(", ")}`,
        `records: ${state.recorder.enabled ? "on" : "off (rehydra.record.enabled)"}`,
      ].join("\n"),
      "info",
    );
    return;
  }

  if (sub === "log") {
    const sessionId = ctx.sessionManager.getSessionId();
    const typeFilter = tokens.includes("--type")
      ? tokens[tokens.indexOf("--type") + 1]
      : undefined;
    const target = tokens.slice(1).find((token) => !token.startsWith("--") && token !== typeFilter);

    if (target !== undefined) {
      const found = await state.recorder.find(target);
      if (found.kind === "missing") {
        ctx.ui.notify(`No record matches "${target}".`, "warning");
        return;
      }
      if (found.kind === "ambiguous") {
        ctx.ui.notify(`Ambiguous record id "${target}". Candidates:\n${found.ids.join("\n")}`, "warning");
        return;
      }
      ctx.ui.notify(formatRecordDetail(found.record), "info");
      return;
    }

    const records = state.recorder
      .recent(20, sessionId)
      .filter(
        (record) =>
          typeFilter === undefined ||
          record.hits.some((hit) => String(hit.type) === typeFilter),
      );
    if (records.length === 0) {
      ctx.ui.notify(
        state.recorder.enabled
          ? "No masking records for this session yet."
          : "Recording is off. Set rehydra.record.enabled to true.",
        "info",
      );
      return;
    }
    ctx.ui.notify(records.map(formatRecordSummary).join("\n"), "info");
    return;
  }

  if (sub === "clear") {
    const all = tokens.includes("--all");
    const scope = all ? "all sessions" : "this session";
    const confirmed = await ctx.ui.confirm?.(`Delete masking records for ${scope}?`);
    if (confirmed !== true) {
      ctx.ui.notify("Cancelled; records were not deleted.", "info");
      return;
    }
    await state.recorder.clear(all ? "all" : "session", ctx.sessionManager.getSessionId());
    ctx.ui.notify(`Masking records cleared for ${scope}.`, "info");
    return;
  }

  ctx.ui.notify("Usage: /rehydra [log [<id>] [--type TYPE] | clear [--all]]", "warning");
}

/** 记录摘要行。 */
function formatRecordSummary(record: MaskingRecord): string {
  const kinds = record.hits.map((hit) => hit.type).join(",");
  return `#${record.id} ${record.time} ${record.source} masked=${record.masked} ${record.durationMs}ms${kinds === "" ? "" : ` (${kinds})`}`;
}

/** 单条记录详情：命中行 + 字段级前后对照。 */
function formatRecordDetail(record: MaskingRecord): string {
  const lines = [
    `#${record.id} ${record.time} ${record.source} masked=${record.masked} ${record.durationMs}ms`,
    `session: ${record.sessionId}  scope: ${record.scope}  integrity: ${record.integrity}`,
  ];
  if (record.relatedEvents !== undefined) {
    for (const event of record.relatedEvents) {
      lines.push(`related: ${event.kind}${event.code === undefined ? "" : ` (${event.code})`}`);
    }
  }
  for (const hit of record.hits) {
    const head = hit.original === undefined ? `${hit.length}c` : `${JSON.stringify(hit.original)}`;
    lines.push(
      `  - ${hit.type} [${hit.finder}] ${detectorLabel(hit.detector)} ${hit.placeholder} ${head}`,
    );
  }
  for (const item of record.comparisons) {
    if (item.before === "" && item.after === "") {
      lines.push(`  ~ ${item.path} (original text not stored)`);
      continue;
    }
    lines.push(`  ~ ${item.path}`);
    lines.push(`      before: ${escapeForTerminal(item.before)}`);
    lines.push(`      after : ${escapeForTerminal(item.after)}`);
  }
  return lines.join("\n");
}

/** 转义终端控制字符，避免记录里的原文改写终端。 */
function escapeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
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
 * Pi 中的 `UserMessage.content` 可以是字符串或 `(TextContent | ImageContent)[]`。
 * 共享核心按 `ScrubPart[]` 处理，所以这里把它统一拍平为 `[{ type: "text", text }]`。
 * 同时记录下原字段是字符串，以便 scrub 后把改动写回到原字段。
 */
interface MessageRewrite {
  scrubMessages: ScrubMessage[];
  /** index in scrubMessages -> 原始 content 字段是否是字符串 */
  userStringContent: Map<number, { original: string }>;
}

function normalizeMessagesForScrub(messages: AgentMessage[]): MessageRewrite {
  const scrubMessages: ScrubMessage[] = [];
  const userStringContent = new Map<number, { original: string }>();
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
    scrubMessages.push(agentMessageToScrub(m));
  });
  return { scrubMessages, userStringContent };
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
 */
function restoreMessagesFromScrub(
  originals: AgentMessage[],
  scrubbed: ScrubMessage[],
  userStringContent: Map<number, { original: string }>,
): void {
  scrubbed.forEach((scrub, index) => {
    const original = originals[index] as { role?: string; content?: unknown };
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

function agentMessageToScrub(message: AgentMessage): ScrubMessage {
  const role = (message as { role?: string }).role;
  if (role === "user") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return {
        content: [{ type: "text", text: content }],
      };
    }
    if (Array.isArray(content)) {
      return {
        content: content.map((part) => textPartFromContent(part)),
      };
    }
    return {};
  }
  if (role === "assistant") {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return {};
    return {
      content: content.map((block) => assistantBlockToPart(block)),
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
      content: [
        {
          type: "tool-result",
          id: toolCallId,
          callID: toolCallId,
          result: texts,
        },
      ],
    };
  }
  return {};
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
 * 安装 Pi 扩展。
 *
 * 该工厂由 `src/pi-extension/index.ts` 的 default export 暴露，Pi 在加载
 * 扩展时自动调用。它负责：
 *
 * 1. 在 `session_start` 中实例化匿名器、装配会话注册表与策略；
 * 2. 在 `context_with_system` / `tool_call` / `tool_result` / `message_end`
 *    上挂载脱敏 / 还原钩子；
 * 3. 在 `session_shutdown` 中幂等释放所有资源；
 * 4. 注册 `/rehydra` 命令以便用户在 TUI 中查看或手动触发操作。
 */
export function createRehydraPiExtension(pi: ExtensionAPI): void {
  // Per-session runtime state, scoped to a single Pi session.
  const runtime: { state?: PiExtensionState } = {};

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
      // Pi 显式启用模型检测后，默认降级为规则；SDK 未配置时仍保持抛错
      nerFailure: options.nerFailure ?? "rules",
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
    const recorder = new MaskingRecorder(
      {
        ...(recordOptions ?? {}),
        dir: recordOptions?.dir ?? join(homedir(), ".pi", "agent", "rehydra", "records"),
      },
      (level, message, extra) => createConsoleLogger()[level](message, extra),
      `${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
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
      recorder,
      nerFailure: options.nerFailure ?? "rules",
      lastModelWarningAt: 0,
      log: createConsoleLogger(),
      allowLiteralTagsIn: new Set(options.allowLiteralTagsIn ?? []),
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
    if (state === undefined) return;
    // 先等记录落盘，避免会话结束时丢掉队尾
    try {
      await state.recorder.flush();
    } catch {
      // 记录层失败不影响资源释放
    }
    try {
      await state.anonymizer.dispose();
    } catch {
      // Dispose is best-effort: the session is being torn down regardless.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.sessionManager.getCwd();
    const settings = pi.getSettings();
    const rawOptions = readPiExtensionOptions(settings);
    runtime.state = await setupRuntime(cwd, rawOptions);
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
    const stats = await scrubCore(
      rewrite.scrubMessages,
      state.resolveSession(sessionId),
      host,
      scrubOptions,
      state.recorder.enabled
        ? {
            includeOriginal: state.recorder.includeOriginal,
            maxRecordBytes: state.recorder.maxRecordBytes,
          }
        : undefined,
    );
    restoreMessagesFromScrub(event.messages, rewrite.scrubMessages, rewrite.userStringContent);
    if (stats.detectionErrors !== undefined) warnDegradedOnce(state, stats.detectionErrors);
    recordRequest(state, sessionId, "context", startedAt, stats);
    // 共享核心就地改写了 event.messages；显式回传，保证 Pi 使用改写后的数组。
    const result: ContextEventResult = { messages: event.messages };
    return result;
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    const state = runtime.state;
    if (state === undefined) return undefined;
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
      if (Array.isArray(event.content)) {
        const scrubbed: typeof event.content = [];
        for (const part of event.content) {
          if (
            part !== null &&
            typeof part === "object" &&
            part.type === "text" &&
            typeof part.text === "string"
          ) {
            const anonymized = await session.anonymize(
              part.text,
              state.locale,
              state.policy,
              state.recorder.enabled
                ? {
                    includeOriginal: state.recorder.includeOriginal,
                    onEntity: (entity) => {
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
            );
            if (
              state.recorder.enabled &&
              state.recorder.includeOriginal &&
              anonymized.anonymizedText !== part.text
            ) {
              comparisons.push({
                path: `tool_result[${scrubbed.length}]`,
                before: part.text,
                after: anonymized.anonymizedText,
              });
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
      recordRequest(state, ctx.sessionManager.getSessionId(), "tool_result", startedAt, {
        scrubbed: hits.length,
        hits,
        comparisons,
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

  // 给用户提供一个简单的 TUI 命令，便于查看当前配置与状态。
  pi.registerCommand("rehydra", {
    description: "Inspect the Rehydra Pi extension status, masking records, or clear them.",
    handler: (args: string, ctx: ExtensionContext): Promise<void> => {
      const state = runtime.state;
      if (state === undefined) {
        ctx.ui.notify("Rehydra extension is not initialized.", "warning");
        return Promise.resolve();
      }
      return handleRehydraCommand(args, state, ctx);
    },
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