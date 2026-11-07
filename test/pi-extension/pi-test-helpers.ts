/**
 * 模拟 Pi 的 ExtensionAPI 形态，便于在 vitest 里直接调用扩展钩子。
 *
 * 实际上是把 ExtensionAPI 上每个 `on(name, handler)` 调用记录到 handlers 列表，
 * 并把 `registerCommand` / `getSettings` 的常见调用桩起来。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "../../src/pi-extension/host-types.js";

type AnyHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface RecordedHandler {
  name: string;
  handler: AnyHandler;
}

export interface MockPiContext {
  ctx: ExtensionContext;
  api: ExtensionAPI;
  handlers: RecordedHandler[];
  sessionId: string;
  cwd: string;
  /** 已注册的命令名。 */
  commands: string[];
  /** UI 收到的通知文本。 */
  notifications: string[];
  /** UI 收到的确认请求。 */
  confirmations: string[];
  /** 已注册命令的 handler。 */
  commandHandlers: Map<
    string,
    (args: string, ctx: ExtensionContext) => unknown
  >;
}

export interface MockPiOptions {
  sessionId?: string;
  cwd?: string;
  redactValues?: string[];
  envFiles?: string[];
  vcsIdentities?: boolean;
  allowLiteralTagsIn?: string[];
  record?: {
    enabled?: boolean;
    includeOriginal?: boolean;
    dir?: string;
  };
  /** 本机查看页面：测试默认关闭，避免每个用例都起一个 HTTP 服务。 */
  dashboard?: {
    enabled?: boolean;
  };
  /** ui.confirm 的桩返回值。 */
  confirmAnswer?: boolean;
}

/**
 * 构造一个最小的 ExtensionAPI + ExtensionContext，捕获所有事件钩子。
 */
export function createMockPiContext(options: MockPiOptions = {}): MockPiContext {
  const sessionId = options.sessionId ?? "ses-pi";
  const cwd = options.cwd ?? "C:/tmp/pi-mock";
  const handlers: RecordedHandler[] = [];
  const commands: string[] = [];
  const notifications: string[] = [];
  const confirmations: string[] = [];
  const commandHandlers = new Map<
    string,
    (args: string, ctx: ExtensionContext) => unknown
  >();

  // 简化版的 SessionManager 桩：仅暴露 getSessionId / getCwd。
  const sessionManager = {
    getSessionId: () => sessionId,
    getCwd: () => cwd,
  };

  // 简化版的 UI 桩：notify / select / custom 都是 noop。
  const ui = {
    notify: (message: string) => {
      notifications.push(message);
    },
    confirm: async (message: string) => {
      confirmations.push(message);
      return options.confirmAnswer ?? false;
    },
    select: async () => undefined,
    custom: async () => undefined,
  };

  const ctx = {
    ui,
    mode: "tui" as const,
    hasUI: true,
    cwd,
    sessionManager,
    model: undefined,
    scopedModels: [],
    thinkingLevel: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;

  const api = {
    on(name: string, handler: AnyHandler) {
      handlers.push({ name, handler });
      return () => {
        const idx = handlers.findIndex((h) => h.name === name && h.handler === handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => unknown },
    ) => {
      commands.push(name);
      commandHandlers.set(name, command.handler);
    },
    getSettings: () => {
      // 测试默认关掉记录与页面：既不写真实用户目录，也不占用端口。
      const settings: Record<string, unknown> = {
        rehydra: {
          ...(options.redactValues !== undefined
            ? { redactValues: options.redactValues }
            : {}),
          ...(options.envFiles !== undefined ? { envFiles: options.envFiles } : {}),
          ...(options.allowLiteralTagsIn !== undefined
            ? { allowLiteralTagsIn: options.allowLiteralTagsIn }
            : {}),
          ...(options.vcsIdentities !== undefined
            ? { vcsIdentities: options.vcsIdentities }
            : {}),
          record: { enabled: false, ...(options.record ?? {}) },
          dashboard: { enabled: false, ...(options.dashboard ?? {}) },
        },
      };
      return settings as unknown;
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => undefined,
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    events: { on: () => () => undefined, emit: () => undefined },
  } as unknown as ExtensionAPI;

  void api;

  return {
    ctx,
    handlers,
    sessionId,
    cwd,
    api,
    commands,
    notifications,
    confirmations,
    commandHandlers,
  };
}

/** 取出某个事件类型的已注册 handler；不存在则抛错。 */
export function eventHandler(
  mock: MockPiContext,
  name: string,
): AnyHandler {
  const entry = mock.handlers.find((h) => h.name === name);
  if (entry === undefined) {
    throw new Error(`event handler not registered: ${name}`);
  }
  return entry.handler;
}