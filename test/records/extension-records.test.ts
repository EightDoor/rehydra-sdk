/**
 * 扩展层记录与本机查看页面的集成测试。
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

  async function scrubContext(text: string): Promise<void> {
    const handler = mock.handlers.find((h) => h.name === "context_with_system");
    const event: ContextWithSystemEvent = {
      messages: [{ role: "user", content: text }],
    } as ContextWithSystemEvent;
    await handler!.handler(event, mock.ctx);
  }

  it("stores hits and the full before/after snapshot", async () => {
    await start({ record: { enabled: true, includeOriginal: true, dir } });
    await scrubContext(`mail ${EMAIL} now`);

    const { MaskingRecordStore } = await import("../../src/records/sqlite-store.js");
    const store = new MaskingRecordStore(
      { enabled: true, includeOriginal: true, keepDays: 7, keepBytes: 1 << 20, maxRecordBytes: 1 << 20, dir },
      () => undefined,
    );
    const listed = store.query({});
    expect(listed.total).toBeGreaterThan(0);

    const record = store.get(listed.records[0]!.id);
    expect(record?.hits.some((hit) => hit.type === "EMAIL")).toBe(true);
    // 快照保存钩子收到的内容与扩展输出的内容：未命中字段也在。
    expect(record?.snapshot?.before).toContain(EMAIL);
    expect(record?.snapshot?.after).not.toContain(EMAIL);
    expect(record?.snapshot?.after).toContain("now");
    store.close();
  });

  it("omits the snapshot when original capture is off", async () => {
    await start({ record: { enabled: true, includeOriginal: false, dir } });
    await scrubContext(`mail ${EMAIL} now`);

    const { MaskingRecordStore } = await import("../../src/records/sqlite-store.js");
    const store = new MaskingRecordStore(
      { enabled: true, includeOriginal: false, keepDays: 7, keepBytes: 1 << 20, maxRecordBytes: 1 << 20, dir },
      () => undefined,
    );
    const listed = store.query({});
    const record = store.get(listed.records[0]!.id);
    expect(record?.snapshot).toBeUndefined();
    expect(record?.hits.length).toBeGreaterThan(0);
    store.close();
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

    const { MaskingRecordStore } = await import("../../src/records/sqlite-store.js");
    const store = new MaskingRecordStore(
      { enabled: true, includeOriginal: true, keepDays: 7, keepBytes: 1 << 20, maxRecordBytes: 1 << 20, dir },
      () => undefined,
    );
    const listed = store.query({});
    expect(listed.records.some((row) => row.source === "tool_call")).toBe(true);
    expect(listed.records.some((row) => row.status === "blocked")).toBe(true);
    store.close();
  });

  it("writes nothing when recording is off", async () => {
    await start({ record: { enabled: false, dir } });
    await scrubContext(`mail ${EMAIL} now`);

    const { MaskingRecordStore } = await import("../../src/records/sqlite-store.js");
    const store = new MaskingRecordStore(
      { enabled: true, includeOriginal: true, keepDays: 7, keepBytes: 1 << 20, maxRecordBytes: 1 << 20, dir },
      () => undefined,
    );
    expect(store.query({}).total).toBe(0);
    store.close();
  });

  it("records the actual content when masking fails and the request passes through", async () => {
    const { vi } = await import("vitest");
    const { AnonymizerSessionImpl } = await import("../../src/storage/session.js");
    vi.spyOn(AnonymizerSessionImpl.prototype, "anonymize").mockRejectedValue(
      new Error("storage unavailable"),
    );
    try {
      await start({ record: { enabled: true, includeOriginal: true, dir } });
      await scrubContext(`mail ${EMAIL} now`);

      const { MaskingRecordStore } = await import("../../src/records/sqlite-store.js");
      const store = new MaskingRecordStore(
        {
          enabled: true,
          includeOriginal: true,
          keepDays: 7,
          keepBytes: 1 << 20,
          maxRecordBytes: 1 << 20,
          dir,
        },
        () => undefined,
      );
      const listed = store.query({});
      const record = store.get(listed.records[0]!.id);
      // 失败也要留下记录，并且明确标出这次请求没有被脱敏。
      expect(record?.failure).toContain("masking-failed");
      expect(record?.snapshot?.before).toContain(EMAIL);
      expect(listed.records[0]?.status).toBe("failed");
      store.close();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("stores only a failure code when masking fails with a message carrying content", async () => {
    const { vi } = await import("vitest");
    const { AnonymizerSessionImpl } = await import("../../src/storage/session.js");
    // 异常 message 里夹带原文：关闭原文保存时，这句话不能出现在记录里。
    const leaked = ["secret", "payload", "in-message"].join("-");
    vi.spyOn(AnonymizerSessionImpl.prototype, "anonymize").mockRejectedValue(
      new Error(`upstream rejected ${leaked}`),
    );
    try {
      await start({ record: { enabled: true, includeOriginal: false, dir } });
      await scrubContext(`mail ${EMAIL} now`);

      const { MaskingRecordStore } = await import("../../src/records/sqlite-store.js");
      const store = new MaskingRecordStore(
        {
          enabled: true,
          includeOriginal: true,
          keepDays: 7,
          keepBytes: 1 << 20,
          maxRecordBytes: 1 << 20,
          dir,
        },
        () => undefined,
      );
      const listed = store.query({});
      const record = store.get(listed.records[0]!.id);
      expect(record?.failure).toBe("masking-failed");
      expect(JSON.stringify(record)).not.toContain(leaked);
      expect(listed.records[0]?.failure).toBe("masking-failed");
      store.close();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps the tool result original text next to the masked output", async () => {
    await start({ record: { enabled: true, includeOriginal: true, dir } });
    const toolResult = mock.handlers.find((h) => h.name === "tool_result");
    await toolResult!.handler(
      {
        type: "tool_result",
        toolCallId: "c2",
        toolName: "bash",
        input: {},
        content: [{ type: "text", text: `value=${EMAIL}` }],
        isError: false,
      },
      mock.ctx,
    );

    const { MaskingRecordStore } = await import("../../src/records/sqlite-store.js");
    const store = new MaskingRecordStore(
      { enabled: true, includeOriginal: true, keepDays: 7, keepBytes: 1 << 20, maxRecordBytes: 1 << 20, dir },
      () => undefined,
    );
    const listed = store.query({ source: "tool_result" });
    const record = store.get(listed.records[0]!.id);
    expect(record?.snapshot?.before).toContain(EMAIL);
    expect(record?.snapshot?.after).not.toContain(EMAIL);
    store.close();
  });
});
