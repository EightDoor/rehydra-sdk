/**
 * 快照序列化的测试：二进制剔除、共享引用与真实循环。
 */
import { describe, it, expect } from "vitest";
import { buildSnapshot, serializeSnapshot } from "../../src/records/snapshot.js";

describe("serializeSnapshot", () => {
  it("replaces image payloads with a marker", () => {
    const snapshot = serializeSnapshot([
      { type: "image", data: "BASE64PAYLOAD", mimeType: "image/png" },
    ]);
    expect(snapshot).not.toContain("BASE64PAYLOAD");
    expect(snapshot).toContain("binary omitted");
  });

  it("keeps shared references instead of treating them as cycles", () => {
    const shared = { type: "text", text: "same block" };
    const snapshot = serializeSnapshot([shared, shared]);
    expect(snapshot).not.toContain("circular");
    expect(JSON.parse(snapshot!) as unknown[]).toHaveLength(2);
  });

  it("keeps an own __proto__ field instead of writing through the prototype setter", () => {
    // JSON.parse 会造出自有的 __proto__ 数据属性；写进 {} 会走原型 setter 并丢字段。
    const parsed = JSON.parse(
      '{"arguments":{"__proto__":{"text":"keep-this-field"},"ok":1}}',
    ) as unknown;
    const snapshot = serializeSnapshot(parsed);
    expect(snapshot).toContain("keep-this-field");
    expect(snapshot).toContain('"ok"');
    // 副本原型不被改写：序列化结果里 __proto__ 是普通键，不是继承来的。
    const round = JSON.parse(snapshot!) as Record<string, Record<string, unknown>>;
    expect(Object.keys(round["arguments"] ?? {}).sort()).toEqual(["__proto__", "ok"]);
  });

  it("still guards against real cycles", () => {
    const node: Record<string, unknown> = { role: "user" };
    node["self"] = node;
    expect(serializeSnapshot(node)).toContain("circular");
  });
});

describe("buildSnapshot", () => {
  it("returns undefined when either side is missing", () => {
    expect(buildSnapshot(undefined, "after", 1024)).toBeUndefined();
    expect(buildSnapshot("before", undefined, 1024)).toBeUndefined();
  });

  it("marks truncated snapshots", () => {
    const snapshot = buildSnapshot("a".repeat(500), "b".repeat(500), 100);
    expect(snapshot?.truncated).toBe(true);
  });

  it("keeps small snapshots intact", () => {
    const snapshot = buildSnapshot("before", "after", 1024);
    expect(snapshot).toEqual({ before: "before", after: "after" });
  });
});
