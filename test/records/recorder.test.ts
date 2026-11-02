/**
 * 记录器行为测试：落盘、权限、裁剪、查找、清理与失败兜底。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaskingRecorder } from "../../src/records/recorder.js";
import type { MaskingRecord } from "../../src/records/types.js";

function record(id: string, sessionId = "s1"): MaskingRecord {
  return {
    version: 1,
    id,
    sessionId,
    scope: "model-input",
    source: "context",
    time: new Date().toISOString(),
    durationMs: 1,
    masked: 1,
    blocked: false,
    integrity: "complete",
    hits: [],
    comparisons: [],
  };
}

const logs: string[] = [];
const log = (level: "warn" | "error", message: string): void => {
  logs.push(`${level}:${message}`);
};

describe("MaskingRecorder", () => {
  let dir: string;

  beforeEach(async () => {
    logs.length = 0;
    dir = await mkdtemp(join(tmpdir(), "rehydra-rec-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does nothing when disabled", async () => {
    const recorder = new MaskingRecorder({ enabled: false, dir }, log, "i1");
    recorder.add(record("1-1"));
    await recorder.flush();

    expect(recorder.recent(10)).toHaveLength(0);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it("keeps records in memory and appends them to a day file", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("1-1"));
    recorder.add(record("1-2"));
    await recorder.flush();

    expect(recorder.recent(10).map((r) => r.id)).toEqual(["1-2", "1-1"]);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const content = await readFile(join(dir, files[0]!), "utf-8");
    expect(content.trim().split("\n")).toHaveLength(2);
  });

  it("writes files with owner-only permissions", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("1-1"));
    await recorder.flush();

    const files = await readdir(dir);
    const info = await stat(join(dir, files[0]!));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("trims memory to keepInMemory", () => {
    const recorder = new MaskingRecorder({ enabled: true, dir, keepInMemory: 2 }, log, "i1");
    recorder.add(record("1-1"));
    recorder.add(record("1-2"));
    recorder.add(record("1-3"));

    expect(recorder.recent(10).map((r) => r.id)).toEqual(["1-3", "1-2"]);
  });

  it("filters memory by session", () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("1-1", "a"));
    recorder.add(record("1-2", "b"));

    expect(recorder.recent(10, "a").map((r) => r.id)).toEqual(["1-1"]);
  });

  it("finds by exact id and by unique prefix, and rejects ambiguous prefixes", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("100-1"));
    recorder.add(record("100-2"));
    recorder.add(record("200-1"));

    await expect(recorder.find("200-1")).resolves.toMatchObject({ kind: "found" });
    await expect(recorder.find("200")).resolves.toMatchObject({ kind: "found" });
    await expect(recorder.find("100")).resolves.toMatchObject({ kind: "ambiguous" });
    await expect(recorder.find("999")).resolves.toMatchObject({ kind: "missing" });
  });

  it("reads records back from disk after a restart", async () => {
    const writer = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    writer.add(record("300-1"));
    await writer.flush();

    // 新实例：内存为空，只能从磁盘读
    const reader = new MaskingRecorder({ enabled: true, dir }, log, "i2");
    await expect(reader.find("300-1")).resolves.toMatchObject({ kind: "found" });
  });

  it("skips corrupt lines without failing", async () => {
    const writer = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    writer.add(record("400-1"));
    await writer.flush();

    const files = await readdir(dir);
    const path = join(dir, files[0]!);
    const original = await readFile(path, "utf-8");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, `${original}{"broken":`, "utf-8");

    const reader = new MaskingRecorder({ enabled: true, dir }, log, "i2");
    await expect(reader.find("400-1")).resolves.toMatchObject({ kind: "found" });
    expect(logs.some((entry) => entry.includes("corrupt"))).toBe(true);
  });

  it("does not throw when the directory cannot be written", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir, keepInMemory: 5 }, log, "i1");
    // 用一个不存在的深层路径模拟不可写
    const broken = new MaskingRecorder(
      { enabled: true, dir: join(dir, "missing-parent", "\u0000bad") },
      log,
      "i2",
    );
    broken.add(record("500-1"));
    await expect(broken.flush()).resolves.toBeUndefined();
    recorder.add(record("500-2"));
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("refuses a symlinked records directory", async () => {
    const real = await mkdtemp(join(tmpdir(), "rehydra-real-"));
    const link = join(dir, "link");
    await symlink(real, link, "dir");

    const recorder = new MaskingRecorder({ enabled: true, dir: link }, log, "i1");
    recorder.add(record("600-1"));
    await recorder.flush();

    expect(await readdir(real)).toHaveLength(0);
    expect(logs.some((entry) => entry.includes("not a real directory"))).toBe(true);
    await rm(real, { recursive: true, force: true });
  });

  it("clears all files and memory", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("700-1"));
    await recorder.flush();

    await recorder.clear("all");
    expect(recorder.recent(10)).toHaveLength(0);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it("clears only the current session from memory", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("800-1", "a"));
    recorder.add(record("800-2", "b"));

    await recorder.clear("session", "a");
    expect(recorder.recent(10).map((r) => r.id)).toEqual(["800-2"]);
  });

  it("drops records beyond the queue limit and warns once", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    for (let i = 0; i < 400; i += 1) recorder.add(record(`900-${i}`));
    await recorder.flush();

    expect(logs.filter((entry) => entry.includes("queue is full"))).toHaveLength(1);
  });
});

describe("MaskingRecorder disk safety", () => {
  let dir: string;

  beforeEach(async () => {
    logs.length = 0;
    dir = await mkdtemp(join(tmpdir(), "rehydra-safe-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to append through a symlinked day file", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("1-1"));
    await recorder.flush();

    const files = await readdir(dir);
    const dayFile = join(dir, files[0]!);
    const target = join(dir, "target.txt");
    const { writeFile: wf, rename: rn } = await import("node:fs/promises");
    await wf(target, "", "utf-8");
    await rn(dayFile, join(dir, "moved.jsonl"));
    await symlink(target, dayFile, "file");

    const before = await readFile(target, "utf-8");
    recorder.add(record("1-2"));
    await recorder.flush();

    expect(await readFile(target, "utf-8")).toBe(before);
    expect(logs.some((entry) => entry.includes("not a regular file"))).toBe(true);
  });

  it("tightens permissions of an existing loose file", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("2-1"));
    await recorder.flush();

    const files = await readdir(dir);
    const path = join(dir, files[0]!);
    const { chmod: ch } = await import("node:fs/promises");
    await ch(path, 0o666);

    recorder.add(record("2-2"));
    await recorder.flush();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("deletes the session's records from disk, keeping others", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("3-1", "a"));
    recorder.add(record("3-2", "b"));
    await recorder.flush();

    await recorder.clear("session", "a");

    const files = await readdir(dir);
    const content = await readFile(join(dir, files[0]!), "utf-8");
    expect(content).not.toContain("3-1");
    expect(content).toContain("3-2");
    // 清理后不能再从磁盘查回
    await expect(recorder.find("3-1")).resolves.toMatchObject({ kind: "missing" });
  });

  it("does not resurrect records when clearing while writes are queued", async () => {
    const recorder = new MaskingRecorder({ enabled: true, dir }, log, "i1");
    recorder.add(record("4-1"));
    // 不等待队列，直接清理
    await recorder.clear("all");
    await recorder.flush();

    const files = await readdir(dir);
    expect(files).toHaveLength(0);
  });

  it("prunes on every write instead of once an hour", async () => {
    const recorder = new MaskingRecorder(
      { enabled: true, dir, keepBytes: 600 },
      log,
      "i1",
    );
    const padded = { ...record("5-1"), comparisons: [{ path: "p", before: "x".repeat(200), after: "y".repeat(200) }] };
    // 同一天写多批，超过 keepBytes 后旧文件被删掉
    for (let i = 0; i < 6; i += 1) {
      recorder.add({ ...padded, id: `5-${i}` });
      await recorder.flush();
    }

    const files = await readdir(dir);
    let total = 0;
    for (const file of files) total += (await stat(join(dir, file))).size;
    expect(total).toBeLessThanOrEqual(600);
  });

  it("reports ambiguity across memory and disk", async () => {
    const writer = new MaskingRecorder({ enabled: true, dir, keepInMemory: 1 }, log, "i1");
    writer.add(record("100-1"));
    writer.add(record("100-2"));
    await writer.flush();

    // 内存只留最后一条，磁盘仍有两条 → 前缀仍然有歧义
    const reader = new MaskingRecorder({ enabled: true, dir, keepInMemory: 1 }, log, "i2");
    reader.add(record("100-2"));
    await expect(reader.find("100")).resolves.toMatchObject({ kind: "ambiguous" });
  });
});

describe("MaskingRecorder clear safety", () => {
  it("refuses to delete through a symlinked directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "rehydra-clear-"));
    const target = await mkdtemp(join(tmpdir(), "rehydra-target-"));
    logs.length = 0;
    const { writeFile: wf } = await import("node:fs/promises");
    // 目标目录里放一个"看起来像记录"的文件，清理不应碰它
    const victim = join(target, "2026-01-01.other.jsonl");
    await wf(victim, "{}\n", "utf-8");
    const link = join(base, "records");
    await symlink(target, link, "dir");

    const recorder = new MaskingRecorder({ enabled: true, dir: link }, log, "i1");
    await recorder.clear("all");

    expect(await readdir(target)).toHaveLength(1);
    await rm(base, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });
});
