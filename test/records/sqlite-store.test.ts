/**
 * 记录 SQLite 存储的测试：落盘、查询、筛选、清理与保留裁剪。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { MaskingRecordStore, statusOf } from "../../src/records/sqlite-store.js";
import type { MaskingRecord } from "../../src/records/types.js";

const EMAIL = ["alice", "@", "example.com"].join("");

// Windows 的 chmod 只映射只读位，模式位断言不成立；创建文件符号链接还需要
// SeCreateSymbolicLinkPrivilege（管理员或开发者模式），普通用户会 EPERM。
const POSIX = process.platform !== "win32";

/** 目录下所有文件的实际占用（库 + wal + shm）。 */
async function diskUsage(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir)) {
    total += (await stat(join(dir, name))).size;
  }
  return total;
}
const TAG = `<${"PII"} type="EMAIL" id="1"/>`;

function record(id: string, overrides: Partial<MaskingRecord> = {}): MaskingRecord {
  return {
    version: 1,
    id,
    sessionId: "s1",
    scope: "model-input",
    source: "context",
    time: new Date().toISOString(),
    durationMs: 1,
    masked: 1,
    blocked: false,
    integrity: "complete",
    hits: [],
    comparisons: [],
    ...overrides,
  };
}

describe("MaskingRecordStore", () => {
  let dir: string;
  let store: MaskingRecordStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rehydra-store-"));
    store = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: 1024 * 1024,
        maxRecordBytes: 1024 * 1024,
        dir,
      },
      () => undefined,
    );
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes nothing when disabled", () => {
    const off = new MaskingRecordStore(
      {
        enabled: false,
        includeOriginal: false,
        keepDays: 7,
        keepBytes: 1024,
        maxRecordBytes: 1024,
        dir,
      },
      () => undefined,
    );
    off.add(record("1-1"));
    expect(off.query({}).total).toBe(0);
    off.close();
  });

  it("persists a record and reads it back", () => {
    store.add(record("1-1"));
    const listed = store.query({});
    expect(listed.total).toBe(1);
    expect(listed.records[0]?.id).toBe("1-1");
    expect(store.get("1-1")?.sessionId).toBe("s1");
  });

  it("keeps hits and the snapshot in the stored payload", () => {
    store.add(
      record("2-1", {
        hits: [
          {
            type: "EMAIL" as never,
            finder: "rule",
            detector: "email",
            placeholder: TAG,
            length: EMAIL.length,
            start: 0,
            end: EMAIL.length,
            original: EMAIL,
          },
        ],
        snapshot: { before: EMAIL, after: "masked" },
      }),
    );
    const stored = store.get("2-1");
    expect(stored?.hits[0]?.original).toBe(EMAIL);
    expect(stored?.snapshot?.before).toBe(EMAIL);
  });

  it("filters by session, source, status and type", () => {
    store.add(record("3-1", { sessionId: "a" }));
    store.add(record("3-2", { sessionId: "b", source: "tool_result" }));
    store.add(record("3-3", { sessionId: "b", blocked: true }));
    store.add(
      record("3-4", {
        sessionId: "b",
        hits: [
          {
            type: "EMAIL" as never,
            finder: "rule",
            detector: "email",
            placeholder: TAG,
            length: 1,
            start: 0,
            end: 1,
          },
        ],
      }),
    );

    expect(store.query({ sessionId: "a" }).total).toBe(1);
    expect(store.query({ source: "tool_result" }).total).toBe(1);
    expect(store.query({ status: "blocked" }).total).toBe(1);
    expect(store.query({ type: "EMAIL" }).total).toBe(1);
    expect(store.query({ type: "PERSON" }).total).toBe(0);
  });

  it("pages results", () => {
    for (let i = 0; i < 5; i += 1) store.add(record(`4-${i}`));
    const first = store.query({ limit: 2, offset: 0 });
    const second = store.query({ limit: 2, offset: 2 });
    expect(first.records).toHaveLength(2);
    expect(second.records).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.records.map((row) => row.id)).not.toEqual(second.records.map((row) => row.id));
  });

  it("lists sessions", () => {
    store.add(record("5-1", { sessionId: "a" }));
    store.add(record("5-2", { sessionId: "a" }));
    store.add(record("5-3", { sessionId: "b" }));
    const sessions = store.sessions();
    expect(sessions.find((item) => item.sessionId === "a")?.records).toBe(2);
  });

  it("clears one session or everything", () => {
    store.add(record("6-1", { sessionId: "a" }));
    store.add(record("6-2", { sessionId: "b" }));
    expect(store.clear("session", "a")).toBe(1);
    expect(store.query({}).total).toBe(1);
    expect(store.clear("all")).toBe(1);
    expect(store.query({}).total).toBe(0);
  });

  it.skipIf(!POSIX)("creates the database file with owner-only permissions", async () => {
    store.add(record("7-1"));
    const info = await stat(store.path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("drops records older than the retention window", () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    store.add(record("8-1", { time: old }));
    store.add(record("8-2"));
    const ids = store.query({}).records.map((row) => row.id);
    expect(ids).not.toContain("8-1");
    expect(ids).toContain("8-2");
  });

  it.skipIf(!POSIX)("rejects a symlinked database file", async () => {
    const outside = await mkdtemp(join(tmpdir(), "rehydra-outside-"));
    const target = join(outside, "target.sqlite");
    const { writeFile, symlink } = await import("node:fs/promises");
    await writeFile(target, "", "utf-8");
    // 目录本身正常，只有库文件是指向目录外的符号链接。
    await symlink(target, join(dir, "records.sqlite"));
    const before = (await stat(target)).size;

    store.add(record("10-1"));
    expect(store.query({}).total).toBe(0);
    expect(store.droppedCount).toBeGreaterThan(0);
    // 链接目标既不能被写入，也不能被改权限。
    expect((await stat(target)).size).toBe(before);
    await rm(outside, { recursive: true, force: true });
  });

  it.skipIf(!POSIX)("rejects a dangling symlinked database file without creating its target", async () => {
    const outside = await mkdtemp(join(tmpdir(), "rehydra-dangling-"));
    const target = join(outside, "not-created.sqlite");
    const { symlink } = await import("node:fs/promises");
    // 目标不存在：existsSync 会跟随链接返回 false，正好绕过"是否存在"这种判断。
    await symlink(target, join(dir, "records.sqlite"));

    store.add(record("10-2"));
    expect(store.query({}).total).toBe(0);
    expect(store.droppedCount).toBeGreaterThan(0);
    // 关键：目录外的目标不能被创建。
    expect(existsSync(target)).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });

  it.skipIf(!POSIX)("rejects a dangling symlinked WAL sidecar", async () => {
    const outside = await mkdtemp(join(tmpdir(), "rehydra-dangling-wal-"));
    const target = join(outside, "not-created-wal");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, join(dir, "records.sqlite-wal"));

    store.add(record("10-3"));
    expect(store.query({}).total).toBe(0);
    expect(existsSync(target)).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });

  it.skipIf(!POSIX)("tightens an existing loose records directory to 0700", async () => {
    const loose = await mkdtemp(join(tmpdir(), "rehydra-loose-"));
    const { chmod } = await import("node:fs/promises");
    await chmod(loose, 0o777);
    const looseStore = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: 1024 * 1024,
        maxRecordBytes: 1024 * 1024,
        dir: loose,
      },
      () => undefined,
    );
    looseStore.add(record("11-1"));
    expect((await stat(loose)).mode & 0o777).toBe(0o700);
    looseStore.close();
    await rm(loose, { recursive: true, force: true });
  });

  it("keeps actual disk usage under the byte cap after trimming", async () => {
    const cap = 512 * 1024;
    const small = await mkdtemp(join(tmpdir(), "rehydra-sizecap-"));
    const capped = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: cap,
        maxRecordBytes: cap,
        dir: small,
      },
      () => undefined,
    );
    for (let i = 0; i < 60; i += 1) {
      capped.add(
        record(`12-${i}`, {
          snapshot: { before: "x".repeat(20_000), after: "y".repeat(20_000) },
        }),
      );
    }
    capped.flush();
    // 断言真实上限，而不是放宽一倍；库 + wal + shm 都算占用。
    expect(await diskUsage(small)).toBeLessThanOrEqual(cap);
    capped.close();
    await rm(small, { recursive: true, force: true });
  });

  it("reclaims disk space after expired records are dropped", async () => {
    const cap = 512 * 1024;
    const small = await mkdtemp(join(tmpdir(), "rehydra-expired-"));
    const capped = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: cap,
        maxRecordBytes: cap,
        dir: small,
      },
      () => undefined,
    );
    // 先写一批已过期的大记录，再写新记录触发按天裁剪。
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 30; i += 1) {
      capped.add({
        ...record(`13-old-${i}`, { time: old }),
        snapshot: { before: "x".repeat(20_000), after: "y".repeat(20_000) },
      });
    }
    capped.add(record("13-new-1"));
    capped.flush();

    expect(capped.query({}).records.every((row) => row.id.startsWith("13-new"))).toBe(true);
    // 过期记录删掉后，磁盘占用必须跟着降下来，而不是停在高水位。
    expect(await diskUsage(small)).toBeLessThanOrEqual(cap);
    capped.close();
    await rm(small, { recursive: true, force: true });
  });

  it("keeps the newest records when trimming by capacity", async () => {
    const cap = 256 * 1024;
    const small = await mkdtemp(join(tmpdir(), "rehydra-trim-"));
    const capped = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: cap,
        maxRecordBytes: cap,
        dir: small,
      },
      () => undefined,
    );
    for (let i = 0; i < 80; i += 1) {
      capped.add(
        record(`14-${i}`, {
          snapshot: { before: "x".repeat(8_000), after: "y".repeat(8_000) },
        }),
      );
    }
    capped.flush();

    const ids = capped.query({ limit: 200 }).records.map((row) => row.id);
    // 超标只淘汰最旧的：最新一条必须还在，也不能一次把库清空。
    expect(ids).toContain("14-79");
    expect(ids).not.toContain("14-0");
    expect(ids.length).toBeGreaterThan(5);
    expect(await diskUsage(small)).toBeLessThanOrEqual(cap);
    capped.close();
    await rm(small, { recursive: true, force: true });
  });

  it("stops trimming when the cap cannot hold any record", async () => {
    const small = await mkdtemp(join(tmpdir(), "rehydra-tiny-"));
    const capped = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: 1,
        maxRecordBytes: 1024,
        dir: small,
      },
      () => undefined,
    );
    // 容量比库本身的固定开销还小：删空后必须停下，不能死循环。
    capped.add(record("15-1"));
    capped.add(record("15-2"));
    expect(capped.query({}).total).toBe(0);
    capped.close();
    await rm(small, { recursive: true, force: true });
  });

  it("trims a backlog bigger than the SQL variable limit", async () => {
    const small = await mkdtemp(join(tmpdir(), "rehydra-many-"));
    const wide = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: 1024 * 1024 * 1024,
        maxRecordBytes: 4096,
        dir: small,
      },
      () => undefined,
    );
    // 打开一次库把表建出来，之后直接用 SQL 灌数据（走 add 会被逐条裁剪拖慢）。
    wide.query({});
    wide.close();

    // 直接灌 40000 行：一次裁剪要删的条数超过 SQLITE_MAX_VARIABLE_NUMBER（32766），
    // 单条无界 DELETE 会报 too many SQL variables，只有分批删才不会。
    const base = Date.now() - 400_000;
    // vite 解析不到 node:sqlite（实验模块），与 store 内部一样用 createRequire 取。
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): unknown }; close(): void };
    };
    const raw = new DatabaseSync(join(small, "records.sqlite"));
    raw.exec("BEGIN");
    const insert = raw.prepare(
      `INSERT INTO masking_records
       (id, session_id, time, source, status, masked, blocked, integrity, types, failure, payload, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 40_000; i += 1) {
      insert.run(
        `19-${i}`,
        "s1",
        new Date(base + i).toISOString(),
        "context",
        "ok",
        1,
        0,
        "complete",
        "",
        null,
        "{}",
        300,
        base + i,
      );
    }
    raw.exec("COMMIT");
    raw.close();

    const cap = 1024 * 1024;
    const narrow = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: cap,
        maxRecordBytes: 4096,
        dir: small,
      },
      () => undefined,
    );
    narrow.add(record("19-newest"));
    expect(narrow.droppedCount).toBe(0);
    expect(narrow.query({ limit: 200 }).records.map((row) => row.id)).toContain("19-newest");
    expect(narrow.query({}).total).toBeLessThan(40_000);
    expect(await diskUsage(small)).toBeLessThanOrEqual(cap);
    narrow.close();
    await rm(small, { recursive: true, force: true });
  });

  it("does not delete a big new record when the old small one already fits", async () => {
    const cap = 256 * 1024;
    const small = await mkdtemp(join(tmpdir(), "rehydra-boundary-"));
    const capped = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: cap,
        maxRecordBytes: cap,
        dir: small,
      },
      () => undefined,
    );
    const older = new Date(Date.now() - 60_000).toISOString();
    capped.add(
      record("17-old", {
        time: older,
        snapshot: { before: "x".repeat(20_000), after: "y".repeat(20_000) },
      }),
    );
    capped.add(
      record("17-new", {
        snapshot: { before: "x".repeat(90_000), after: "y".repeat(90_000) },
      }),
    );

    // 只要删掉小的旧记录就能回到预算内，就不该动大的新记录。
    expect(capped.get("17-new")).not.toBeNull();
    capped.close();
    await rm(small, { recursive: true, force: true });
  });

  it("keeps trimming across rounds when the cap is close to the empty-database footprint", async () => {
    const small = await mkdtemp(join(tmpdir(), "rehydra-floor-"));
    const wide = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: 64 * 1024 * 1024,
        maxRecordBytes: 4096,
        dir: small,
      },
      () => undefined,
    );
    for (let i = 0; i < 1000; i += 1) {
      wide.add(record(`20-${i}`, { time: new Date(Date.now() - 100_000 + i).toISOString() }));
    }
    wide.close();

    // 上限只比空库占用高一点：一轮删不够，必须多轮渐进才落到 cap 以下。
    const cap = 64 * 1024;
    const narrow = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: cap,
        maxRecordBytes: 4096,
        dir: small,
      },
      () => undefined,
    );
    narrow.add(record("20-newest"));
    expect(narrow.get("20-newest")).not.toBeNull();
    expect(await diskUsage(small)).toBeLessThanOrEqual(cap);
    narrow.close();
    await rm(small, { recursive: true, force: true });
  });

  it("derives the status from the record", () => {
    expect(statusOf(record("9-1"))).toBe("ok");
    expect(statusOf(record("9-2", { blocked: true }))).toBe("blocked");
    expect(statusOf(record("9-3", { failure: "boom" }))).toBe("failed");
    expect(statusOf(record("9-4", { integrity: "rules-only" }))).toBe("degraded");
  });
});
