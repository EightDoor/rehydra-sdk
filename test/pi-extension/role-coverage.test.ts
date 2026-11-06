/**
 * Pi 扩展对各类消息角色的脱敏覆盖与失败语义测试。
 *
 * 宿主会把 system / bashExecution / custom / 两类摘要转成模型输入，
 * 这些角色都必须经过脱敏；同时验证占位符说明的注入与失败时的阻断、告警。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRehydraPiExtension } from "../../src/pi-extension/extension.js";
import { AnonymizerSessionImpl } from "../../src/storage/session.js";
import { createMockPiContext, eventHandler } from "./pi-test-helpers.js";

import type { ContextWithSystemEvent, ToolCallEvent } from "../../src/pi-extension/host-types.js";

const TEST_SECRET = "sk-proj-piext-abc123xyz789";

// 标签前缀与样例都用拼接构造：本次会话的扩展会拦截源码里的裸标签字面量。
const TAG_OPEN = ["<", "PII"].join("");
const SAMPLE_TAG = [TAG_OPEN, ' type="EMAIL"', ' id="28"/>'].join("");

/** 判断文本里是否出现占位符标签。 */
function hasTag(text: string): boolean {
  return text.includes(TAG_OPEN);
}

describe("Pi 扩展消息角色覆盖", () => {
  let mock: ReturnType<typeof createMockPiContext>;

  beforeEach(async () => {
    mock = createMockPiContext({ redactValues: [TEST_SECRET] });
    createRehydraPiExtension(mock.api);
    const start = mock.handlers.find((h) => h.name === "session_start");
    await start!.handler({}, mock.ctx);
  });

  afterEach(async () => {
    const handler = mock.handlers.find((h) => h.name === "session_shutdown");
    if (handler !== undefined) {
      await handler.handler({}, mock.ctx);
    }
    vi.restoreAllMocks();
  });

  /** 跑一轮 context_with_system，返回处理后的消息列表。 */
  async function scrubMessages(messages: unknown[]): Promise<unknown[]> {
    const event = {
      type: "context_with_system",
      messages,
    } as unknown as ContextWithSystemEvent;
    const result = (await eventHandler(mock, "context_with_system")(event, mock.ctx)) as
      | { messages?: unknown[] }
      | undefined;
    return result?.messages ?? event.messages;
  }

  it("脱敏 system 消息的自由文本分段，保留工具声明段与 null 段", async () => {
    // 真实邮箱用拼接构造：裸写会被本会话的扩展替换成占位符后落盘。
    const realEmail = ["alice", "example.com"].join("@");
    const toolsEmail = ["bob", "example.com"].join("@");
    const system = {
      role: "system",
      content: "",
      sections: {
        preamble: `助手简介，联系人 ${realEmail}`,
        project_context: `项目里写了 ${TEST_SECRET}`,
        tools: `- read: 读取文件（示例 ${toolsEmail}）`,
        skills: null,
      },
      toolsAdded: [{ name: "read" }],
    };
    const messages = await scrubMessages([system]);

    const result = messages[0] as {
      sections: Record<string, string | null>;
      toolsAdded: unknown;
      role: string;
    };
    expect(result.sections["preamble"]).not.toContain(realEmail);
    expect(result.sections["preamble"]).toContain(TAG_OPEN);
    expect(result.sections["project_context"]).not.toContain(TEST_SECRET);
    // 工具声明段不脱敏：替换它会改变模型看到的工具语义。
    expect(result.sections["tools"]).toContain(toolsEmail);
    // null 段表示"该段被移除"，必须原样保留。
    expect(result.sections["skills"]).toBeNull();
    expect(result.toolsAdded).toEqual([{ name: "read" }]);
    expect(result.role).toBe("system");
  });

  it("脱敏 bashExecution 消息的命令与输出", async () => {
    const bash = {
      role: "bashExecution",
      command: `curl -H "auth: ${TEST_SECRET}" https://example.com`,
      output: `key=${TEST_SECRET}`,
      exitCode: 0,
      timestamp: 0,
    };
    const messages = await scrubMessages([bash]);

    const result = messages[0] as { command: string; output: string };
    expect(result.command).not.toContain(TEST_SECRET);
    expect(result.output).not.toContain(TEST_SECRET);
    expect(hasTag(result.command)).toBe(true);
    expect(hasTag(result.output)).toBe(true);
  });

  it("脱敏 custom 消息的字符串正文", async () => {
    const custom = {
      role: "custom",
      customType: "my-extension",
      content: `扩展消息里的 ${TEST_SECRET}`,
      timestamp: 0,
    };
    const messages = await scrubMessages([custom]);

    const result = messages[0] as { content: string };
    expect(result.content).not.toContain(TEST_SECRET);
    expect(hasTag(result.content)).toBe(true);
  });

  it("脱敏 custom 消息的块数组正文并保持块结构", async () => {
    const custom = {
      role: "custom",
      customType: "my-extension",
      content: [{ type: "text", text: `第一段 ${TEST_SECRET}` }, { type: "image", data: "x" }],
      timestamp: 0,
    };
    const messages = await scrubMessages([custom]);

    const result = messages[0] as { content: Array<{ type: string; text?: string }> };
    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.text).not.toContain(TEST_SECRET);
    expect(result.content[1]?.type).toBe("image");
  });

  it("脱敏分支摘要与压缩摘要的正文", async () => {
    const branch = {
      role: "branchSummary",
      summary: `分支摘要提到 ${TEST_SECRET}`,
      fromId: "x",
      timestamp: 0,
    };
    const compaction = {
      role: "compactionSummary",
      summary: `压缩摘要提到 ${TEST_SECRET}`,
      tokensBefore: 100,
      timestamp: 0,
    };
    const messages = await scrubMessages([branch, compaction]);

    expect((messages[0] as { summary: string }).summary).not.toContain(TEST_SECRET);
    expect((messages[1] as { summary: string }).summary).not.toContain(TEST_SECRET);
  });

  it("产生脱敏时向 system 消息注入占位符说明", async () => {
    const system = { role: "system", content: "", sections: { preamble: "助手简介" } };
    const user = { role: "user", content: `用 ${TEST_SECRET}`, timestamp: 0 };
    const messages = await scrubMessages([system, user]);

    const result = messages[0] as { sections: Record<string, string> };
    expect(result.sections["rehydra"]).toBeDefined();
    expect(result.sections["rehydra"]).toContain("placeholder");
  });

  it("没有脱敏时不注入占位符说明", async () => {
    const system = { role: "system", content: "", sections: { preamble: "助手简介" } };
    const user = { role: "user", content: "普通问候", timestamp: 0 };
    const messages = await scrubMessages([system, user]);

    const result = messages[0] as { sections: Record<string, string> };
    expect(result.sections["rehydra"]).toBeUndefined();
  });

  it("同一密钥在命令与输出里拿到同一个占位符", async () => {
    const bash = {
      role: "bashExecution",
      command: `echo ${TEST_SECRET}`,
      output: `打印 ${TEST_SECRET}`,
      timestamp: 0,
    };
    const messages = await scrubMessages([bash]);
    const first = (messages[0] as { command: string }).command;
    const second = (messages[0] as { output: string }).output;
    const tag = new RegExp(`${TAG_OPEN}[^>]*>`).exec(first)?.[0];
    expect(tag).toBeDefined();
    expect(second).toContain(tag!);
  });
});

describe("Pi 扩展失败语义", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("扩展未初始化时阻止工具执行", async () => {
    const mock = createMockPiContext({ redactValues: [TEST_SECRET] });
    createRehydraPiExtension(mock.api);
    // 不跑 session_start，模拟初始化未完成或失败。
    const event = {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "echo hi" },
    } as ToolCallEvent;
    const result = (await eventHandler(mock, "tool_call")(event, mock.ctx)) as {
      block?: boolean;
      reason?: string;
    };
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("未初始化");
  });

  it("脱敏抛错时请求照常发出，并留下不含原文的告警", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    });
    vi.spyOn(AnonymizerSessionImpl.prototype, "anonymize").mockRejectedValue(
      new Error("storage unavailable"),
    );

    const mock = createMockPiContext({ redactValues: [TEST_SECRET] });
    createRehydraPiExtension(mock.api);
    const start = mock.handlers.find((h) => h.name === "session_start");
    await start!.handler({}, mock.ctx);

    const messages = [{ role: "user", content: `用 ${TEST_SECRET}`, timestamp: 0 }];
    const event = { type: "context_with_system", messages } as unknown as ContextWithSystemEvent;

    // 不抛异常：请求照常发出。
    const result = (await eventHandler(mock, "context_with_system")(event, mock.ctx)) as
      | { messages?: unknown[] }
      | undefined;
    expect(result?.messages).toBeDefined();

    // 有告警，且告警里不含原始密钥。
    const failed = warnings.filter((line) => line.includes("masking failed"));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.join("\n")).not.toContain(TEST_SECRET);
  });

  it("工具结果脱敏抛错时该块保持原样并告警", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    });
    vi.spyOn(AnonymizerSessionImpl.prototype, "anonymize").mockRejectedValue(
      new Error("storage unavailable"),
    );

    const mock = createMockPiContext({ redactValues: [TEST_SECRET] });
    createRehydraPiExtension(mock.api);
    const start = mock.handlers.find((h) => h.name === "session_start");
    await start!.handler({}, mock.ctx);

    const event = {
      type: "tool_result",
      toolCallId: "call-2",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: `value=${TEST_SECRET}` }],
      isError: false,
    };
    const result = (await eventHandler(mock, "tool_result")(event, mock.ctx)) as
      | { content?: Array<{ type: string; text?: string }> }
      | undefined;
    // 该块保持原样，不阻断工具结果回填。
    expect(result?.content?.[0]?.text).toContain(TEST_SECRET);
    const failed = warnings.filter((line) => line.includes("masking failed"));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.join("\n")).not.toContain(TEST_SECRET);
  });
});
