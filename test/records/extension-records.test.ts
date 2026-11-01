/**
 * 扩展层记录与 `/rehydra` 子命令的集成测试。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRehydraPiExtension } from "../../src/pi-extension/extension.js";
import { createMockPiContext } from "../pi-extension/pi-test-helpers.js";
import type { ContextWithSystemEvent, ToolCallEvent } from "../../src/pi-extension/host-types.js";

const EMAIL = ["alice", "@", "example.com"].join("");
// 拼出一个无法还原的字面标签，避免源码里出现标签字面量
const UNRESOLVED = `<${"PII"} type="PERSON" id="${String(999999)}"/>`;

describe("rehydra records", () => {
  let dir: string;
  let mock: ReturnType<typeof createMockPiContext>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rehydra-ext-rec-"));
  });

  afterEach(async () => {
    const shutdown = mock?.handlers.find((h) => h.name === "session_shutdown");
    if (shutdown !== undefined) await shutdown.handler({}, mock.ctx);
    await rm(dir, { recursive: true, force: true });
  });

  async function start(options: Parameters<typeof createMockPiContext>[0]): Promise<void> {
    mock = createMockPiContext(options);
    createRehydraPiExtension(mock.api);
    const startHandler = mock.handlers.find((h) => h.name === "session_start");
    await startHandler!.handler({}, mock.ctx);
  }

  async function runCommand(args: string): Promise<string> {
    const command = mock.commandHandlers.get("rehydra");
    expect(command).toBeDefined();
    await command!(args, mock.ctx);
    return mock.notifications.join("\n");
  }

  async function scrubContext(text: string): Promise<void> {
    const handler = mock.handlers.find((h) => h.name === "context_with_system");
    const event: ContextWithSystemEvent = {
      messages: [{ role: "user", content: text }],
    } as ContextWithSystemEvent;
    await handler!.handler(event, mock.ctx);
  }

  it("records hits and comparisons for a context request", async () => {
    await start({ record: { enabled: true, includeOriginal: true, dir } });
    await scrubContext(`mail ${EMAIL} now`);

    const output = await runCommand("log");
    expect(output).toContain("context");
    expect(output).toContain("EMAIL");
  });

  it("shows before/after for a record detail", async () => {
    await start({ record: { enabled: true, includeOriginal: true, dir } });
    await scrubContext(`mail ${EMAIL} now`);

    const id = /#(\d+-\d+)/.exec(await runCommand("log"))?.[1];
    expect(id).toBeDefined();

    const detail = await runCommand(`log ${id}`);
    expect(detail).toContain("before:");
    expect(detail).toContain("after");
  });

  it("omits original text when includeOriginal is off", async () => {
    await start({ record: { enabled: true, includeOriginal: false, dir } });
    await scrubContext(`mail ${EMAIL} now`);

    const id = /#(\d+-\d+)/.exec(await runCommand("log"))?.[1];
    const detail = await runCommand(`log ${id}`);
    expect(detail).toContain("original text not stored");
  });

  it("records a blocked tool call as a related event", async () => {
    await start({ record: { enabled: true, dir } });
    const toolCall = mock.handlers.find((h) => h.name === "tool_call");
    await toolCall!.handler(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: `echo ${UNRESOLVED}` },
      } as ToolCallEvent,
      mock.ctx,
    );

    expect(await runCommand("log")).toContain("tool_call");
  });

  it("reports nothing when recording is off", async () => {
    await start({ record: { enabled: false, dir } });
    expect(await runCommand("log")).toContain("Recording is off");
  });

  it("requires confirmation before clearing", async () => {
    await start({ record: { enabled: true, dir }, confirmAnswer: false });
    await scrubContext(`mail ${EMAIL} now`);

    expect(await runCommand("clear")).toContain("Cancelled");
    expect(mock.confirmations.length).toBe(1);
  });

  it("clears records when confirmed", async () => {
    await start({ record: { enabled: true, dir }, confirmAnswer: true });
    await scrubContext(`mail ${EMAIL} now`);

    await runCommand("clear --all");
    expect(await runCommand("log")).toContain("No masking records");
  });

  it("keeps the plain status output", async () => {
    await start({});
    const output = await runCommand("");
    expect(output).toContain("Rehydra Pi extension active.");
    expect(output).toContain("regexTypes:");
  });

  it("prints usage for an unknown subcommand", async () => {
    await start({});
    expect(await runCommand("nope")).toContain("Usage:");
  });
});
