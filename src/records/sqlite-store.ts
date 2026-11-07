/**
 * 脱敏记录的 SQLite 存储。
 *
 * 记录是"本扩展处理后的模型输入"，与加密 PII 映射（`pii_maps`）是两套数据：
 * 后者用于还原，前者用于核对。写入失败只告警，绝不影响脱敏与请求。
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { MaskingRecord } from "./types.js";

/** `node:sqlite` 的最小接口，避免依赖尚未进入项目类型定义的模块声明。 */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** 记录存储配置。 */
export interface RecordStoreOptions {
  enabled: boolean;
  includeOriginal: boolean;
  keepDays: number;
  keepBytes: number;
  maxRecordBytes: number;
  dir: string;
}

/** 列表筛选条件。 */
export interface RecordQuery {
  limit?: number;
  offset?: number;
  sessionId?: string;
  source?: string;
  status?: string;
  type?: string;
}

/** 列表行：只带索引字段，正文按需读取。 */
export interface RecordSummary {
  id: string;
  sessionId: string;
  time: string;
  source: string;
  status: RecordStatus;
  masked: number;
  blocked: boolean;
  integrity: string;
  types: string[];
  failure?: string;
}

/** 记录状态：由阻断、降级与失败原因派生，供页面直接展示。 */
export type RecordStatus = "ok" | "degraded" | "failed" | "blocked";

type Log = (level: "warn", message: string, extra?: Record<string, unknown>) => void;

const DB_FILE = "records.sqlite";
/** 单条 DELETE 的 id 个数；SQLITE_MAX_VARIABLE_NUMBER 默认 32766，留足余量。 */
const DELETE_BATCH = 500;

/**
 * Windows 的 chmod 只映射到只读位，0o700 / 0o600 不会生效；那里的保护来自
 * NTFS ACL（用户目录默认只有本人可访问）。所以权限位只在 POSIX 上收紧和检查。
 */
const POSIX_PERMISSIONS = process.platform !== "win32";
const REQUIRE = createRequire(import.meta.url);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS masking_records (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    masked INTEGER NOT NULL,
    blocked INTEGER NOT NULL,
    integrity TEXT NOT NULL,
    types TEXT NOT NULL,
    failure TEXT,
    payload TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_masking_records_order ON masking_records(created_at, id);
  CREATE INDEX IF NOT EXISTS idx_masking_records_session ON masking_records(session_id, created_at);
  -- 旧的单列索引换成 (created_at, id)：裁剪按 (created_at, id) 键集翻页，
  -- 单列索引下这个比较用不上索引 seek。DROP IF EXISTS 之后是无操作。
  DROP INDEX IF EXISTS idx_masking_records_created;
`;

/**
 * 加载 `node:sqlite`。
 *
 * 该模块在 Node.js 22/24 仍是实验特性，导入时会向 stderr 打印一条实验警告；
 * 扩展的 stderr 可能被宿主协议占用，这里临时吞掉这一条警告。
 */
function loadSqlite(): (new (path: string) => SqliteDatabase) | undefined {
  type EmitWarning = typeof process.emitWarning;
  const original = process.emitWarning.bind(process);
  const patched = ((...args: Parameters<EmitWarning>): void => {
    const warning = args[0];
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite is an experimental feature")) return;
    original(...args);
  }) as EmitWarning;
  process.emitWarning = patched;
  try {
    const { DatabaseSync } = REQUIRE("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    return DatabaseSync;
  } catch {
    return undefined;
  } finally {
    process.emitWarning = original;
  }
}

/** 由记录自身条件派生状态。 */
export function statusOf(record: MaskingRecord): RecordStatus {
  if (record.blocked) return "blocked";
  if (record.failure !== undefined) return "failed";
  if (record.integrity === "rules-only") return "degraded";
  return "ok";
}

/** 记录存储。 */
export class MaskingRecordStore {
  private readonly options: RecordStoreOptions;
  private readonly log: Log;
  private db: SqliteDatabase | null = null;
  private warned = false;
  private dropped = 0;
  private sequence = 0;
  private closed = false;
  /** 增量回收是否可用；不可用时退化为整库 VACUUM。 */
  private incremental = true;

  constructor(options: RecordStoreOptions, log: Log) {
    this.options = options;
    this.log = log;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** 是否保存原文与完整快照。 */
  get includeOriginal(): boolean {
    return this.options.enabled && this.options.includeOriginal;
  }

  get maxRecordBytes(): number {
    return this.options.maxRecordBytes;
  }

  /** 因写入失败而未落盘的记录数。 */
  get droppedCount(): number {
    return this.dropped;
  }

  /** 数据库文件路径，用于页面展示。 */
  get path(): string {
    return join(this.options.dir, DB_FILE);
  }

  /** 分配一条新记录的标识；带进程号，避免多进程写同一库时撞主键。 */
  nextId(now: number): string {
    this.sequence += 1;
    return `${now}-${process.pid}-${this.sequence}`;
  }

  /** 写入一条记录（同步，失败只告警）。 */
  add(record: MaskingRecord): void {
    if (!this.options.enabled) return;
    const db = this.open();
    if (db === null) {
      this.dropped += 1;
      return;
    }
    const payload = JSON.stringify(record);
    const types = [...new Set(record.hits.map((hit) => String(hit.type)))].join(",");
    try {
      db.prepare(
        `INSERT OR REPLACE INTO masking_records
         (id, session_id, time, source, status, masked, blocked, integrity, types, failure, payload, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.sessionId,
        record.time,
        record.source,
        statusOf(record),
        record.masked,
        record.blocked ? 1 : 0,
        record.integrity,
        types,
        record.failure ?? null,
        payload,
        new TextEncoder().encode(payload).length,
        Date.parse(record.time) || Date.now(),
      );
      this.prune(db);
    } catch (error) {
      this.dropped += 1;
      this.warnWrite(error);
    }
  }

  /** 列表查询，按时间倒序。 */
  query(options: RecordQuery = {}): { records: RecordSummary[]; total: number } {
    if (!this.options.enabled) return { records: [], total: 0 };
    const db = this.open();
    if (db === null) return { records: [], total: 0 };
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.sessionId !== undefined && options.sessionId !== "") {
      where.push("session_id = ?");
      params.push(options.sessionId);
    }
    if (options.source !== undefined && options.source !== "") {
      where.push("source = ?");
      params.push(options.source);
    }
    if (options.status !== undefined && options.status !== "") {
      where.push("status = ?");
      params.push(options.status);
    }
    if (options.type !== undefined && options.type !== "") {
      where.push("(',' || types || ',') LIKE ?");
      params.push(`%,${options.type},%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const sql = `SELECT id, session_id, time, source, status, masked, blocked, integrity, types, failure
                 FROM masking_records ${clause}
                 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS total FROM masking_records ${clause}`)
      .get(...params) as { total: number } | undefined;
    return {
      records: this.rows(db, sql, [...params, limit, offset]),
      total: Number(totalRow?.total ?? 0),
    };
  }

  /** 读取单条完整记录。 */
  get(id: string): MaskingRecord | null {
    if (!this.options.enabled) return null;
    const db = this.open();
    if (db === null) return null;
    const row = db.prepare("SELECT payload FROM masking_records WHERE id = ?").get(id) as
      | { payload: string }
      | undefined;
    if (row === undefined) return null;
    try {
      return JSON.parse(row.payload) as MaskingRecord;
    } catch {
      return null;
    }
  }

  /** 会话列表，供页面筛选。 */
  sessions(): Array<{ sessionId: string; records: number }> {
    if (!this.options.enabled) return [];
    const db = this.open();
    if (db === null) return [];
    const rows = db
      .prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS records
         FROM masking_records GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT 50`,
      )
      .all() as Array<{ sessionId: string; records: number }>;
    return rows;
  }

  /** 删除记录：`session` 只删指定会话，`all` 全删。 */
  clear(kind: "session" | "all", sessionId?: string): number {
    if (!this.options.enabled) return 0;
    const db = this.open();
    if (db === null) return 0;
    try {
      const result =
        kind === "all"
          ? db.prepare("DELETE FROM masking_records").run()
          : db.prepare("DELETE FROM masking_records WHERE session_id = ?").run(sessionId ?? "");
      // 安全删除只是把页标记为可复用；回收页并把 WAL 截断，避免清理后文件大小不变。
      this.reclaim();
      return result.changes;
    } catch (error) {
      this.warnWrite(error);
      return 0;
    }
  }

  /** 兼容旧调用点的刷盘语义：SQLite 写入是同步的。 */
  flush(): Promise<void> {
    return Promise.resolve();
  }

  /** 关闭数据库；可重复调用。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const db = this.db;
    this.db = null;
    try {
      db?.close();
    } catch {
      // 关闭失败不影响会话退出
    }
  }

  private rows(db: SqliteDatabase, sql: string, params: unknown[]): RecordSummary[] {
    try {
      const raw = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return raw.map((row) => {
        const types = String(row["types"] ?? "");
        return {
          id: String(row["id"]),
          sessionId: String(row["session_id"]),
          time: String(row["time"]),
          source: String(row["source"]),
          status: String(row["status"]) as RecordStatus,
          masked: Number(row["masked"]),
          blocked: Number(row["blocked"]) === 1,
          integrity: String(row["integrity"]),
          types: types === "" ? [] : types.split(","),
          ...(row["failure"] === null || row["failure"] === undefined
            ? {}
            : { failure: String(row["failure"]) }),
        };
      });
    } catch (error) {
      this.warnWrite(error);
      return [];
    }
  }

  /** 打开数据库；目录或文件不安全、驱动不可用时返回 null 并告警一次。 */
  private open(): SqliteDatabase | null {
    if (this.closed) return null;
    if (this.db !== null) return this.db;
    try {
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      const info = lstatSync(this.options.dir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        this.warnOnce("records directory is not a real directory, refusing to write");
        return null;
      }
      // 已存在的目录可能是宽松权限建出来的；mkdirSync 的 mode 不改变既有权限。
      if (POSIX_PERMISSIONS && (info.mode & 0o077) !== 0) {
        chmodSync(this.options.dir, 0o700);
      }
      // 库文件与 WAL/SHM 都必须是普通文件：否则会写到链接目标、并改掉目标的权限。
      if (!this.filesAreSafe()) {
        this.warnOnce("records database is a symlink or not a regular file, refusing to write");
        return null;
      }
      const DatabaseSync = loadSqlite();
      if (DatabaseSync === undefined) {
        this.warnOnce("node:sqlite is unavailable; masking records are not persisted");
        return null;
      }
      const db = new DatabaseSync(this.path);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 250");
      this.enableIncrementalVacuum(db);
      db.exec("PRAGMA secure_delete = ON");
      db.exec(SCHEMA);
      this.tightenFileModes();
      this.db = db;
      return db;
    } catch (error) {
      this.warnWrite(error);
      return null;
    }
  }

  /**
   * 库文件与旁路文件必须是普通文件；符号链接一律拒绝。
   *
   * 不能用 `existsSync` 先判存在：它跟随链接，悬空链接会返回 false 被跳过，
   * 于是链接目标在目录外被创建。只能用 `lstatSync` 逐项判断，ENOENT 才算不存在。
   */
  private filesAreSafe(): boolean {
    for (const file of this.sidecarFiles()) {
      let info;
      try {
        info = lstatSync(file);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        return false;
      }
      if (info.isSymbolicLink() || !info.isFile()) return false;
    }
    return true;
  }

  /** 打开后把库文件与旁路文件收紧到 0600（仅 POSIX；Windows 由 ACL 决定）。 */
  private tightenFileModes(): void {
    if (!POSIX_PERMISSIONS) return;
    for (const file of this.sidecarFiles()) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }


  private sidecarFiles(): string[] {
    return [this.path, `${this.path}-wal`, `${this.path}-shm`];
  }

  /** 按保留天数裁剪，并以实际磁盘占用驱动容量裁剪。 */
  private prune(db: SqliteDatabase): void {
    const cutoff = Date.now() - this.options.keepDays * 24 * 60 * 60 * 1000;
    const expired = db
      .prepare("DELETE FROM masking_records WHERE created_at < ?")
      .run(cutoff).changes;
    // 删过就必须回收：WAL 模式下 VACUUM 的结果要再 checkpoint 才落回主库文件，
    // 否则库文件停在历史高水位，把整个容量预算吃光。
    if (expired > 0 && !this.shrink()) return;
    this.trimToBytes(db);
  }

  /**
   * 容量裁剪：只删够填平超限量的最旧记录，一次写入不做整库 VACUUM。
   *
   * 顺序不能变：先截断 WAL、再归还空页，文件大小才接近存活数据；否则 WAL 和
   * 空页会把"超限量"放大到超过全部记录字节，删多也填不平，最后把库删空。
   */
  private trimToBytes(db: SqliteDatabase): void {
    const cap = this.options.keepBytes;
    // 每轮按比例估算删多少，一轮删不够就下一轮继续；上限只为防死循环，
    // 正常几轮收敛，接近容量下限时可能要多删几次才落到 cap 以下。
    for (let round = 0; round < 64; round += 1) {
      if (this.diskBytes() <= cap) return;
      if (!this.checkpoint()) return;
      if (this.diskBytes() <= cap) return;
      if (!this.shrink()) return;
      const usage = this.diskBytes();
      if (usage <= cap) return;
      // 记录字节只是载荷，磁盘上还有索引与页开销，按同一比例折算才删得准。
      const excess = Math.ceil(((usage - cap) * this.liveBytes(db)) / usage);
      if (excess <= 0) return;
      const victims = this.oldestWithin(db, excess);
      if (victims.length === 0) return;
      this.deleteByIds(db, victims);
      // 回收失败时磁盘测不准，继续删会误伤未过期记录，先停手。
      if (!this.shrink()) return;
    }
  }

  /** 按 id 删除；一次 DELETE 的参数个数受 SQLITE_MAX_VARIABLE_NUMBER 限制，必须分批。 */
  private deleteByIds(db: SqliteDatabase, ids: string[]): void {
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const chunk = ids.slice(i, i + DELETE_BATCH);
      const placeholders = chunk.map(() => "?").join(",");
      db.prepare(`DELETE FROM masking_records WHERE id IN (${placeholders})`).run(...chunk);
    }
  }

  /**
   * 从最旧开始挑累计字节不超过预算的记录 id。
   *
   * 不越过预算：一条记录的 `bytes` 只是载荷，物理开销可能更大或更小，
   * 多挑一条就可能把本来放得下的新记录也删掉。宁可下一轮再删。
   *
   * 用 (created_at, id) 键集翻页而不是 OFFSET：OFFSET 每页都要重新跳过前面的
   * 行，几万条记录要一次裁掉时会退化成 O(n²)，卡在同步写入路径上。
   */
  private oldestWithin(db: SqliteDatabase, excess: number): string[] {
    const victims: string[] = [];
    let freed = 0;
    let cursor: { createdAt: number; id: string } | undefined;
    for (;;) {
      const rows = (
        cursor === undefined
          ? db
              .prepare(
                "SELECT id, bytes, created_at AS createdAt FROM masking_records ORDER BY created_at ASC, id ASC LIMIT 64",
              )
              .all()
          : db
              .prepare(
                `SELECT id, bytes, created_at AS createdAt FROM masking_records
                 WHERE (created_at, id) > (?, ?)
                 ORDER BY created_at ASC, id ASC LIMIT 64`,
              )
              .all(cursor.createdAt, cursor.id)
      ) as Array<{ id: string; bytes: number; createdAt: number }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const bytes = Math.max(Number(row.bytes), 1);
        // 预算不够就收手；游标只跟着真正取走的行走，否则会跳过整页。
        if (victims.length > 0 && freed + bytes > excess) return victims;
        victims.push(row.id);
        freed += bytes;
        cursor = { createdAt: Number(row.createdAt), id: row.id };
        if (freed >= excess) return victims;
      }
    }
    return victims;
  }

  /**
   * 整库 VACUUM 并截断 WAL。只在显式清理时用：大库上要重写整个文件。
   *
   * 返回是否成功：失败时磁盘数字不可信，调用方不能再据此继续删记录。
   */
  private reclaim(): boolean {
    const db = this.db;
    if (db === null) return false;
    try {
      db.exec("VACUUM");
    } catch (error) {
      this.warnWrite(error);
      return false;
    }
    return this.checkpoint();
  }

  /**
   * 截断 WAL，返回是否真的截断成功。
   *
   * `PRAGMA wal_checkpoint` 遇到别的连接持有读事务时以 `busy=1` 返回而不抛错；
   * 只看异常会把"没截断"当成成功，再按虚高的占用继续删记录。
   */
  private checkpoint(): boolean {
    const db = this.db;
    if (db === null) return false;
    try {
      const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        | { busy: number }
        | undefined;
      return row === undefined || Number(row.busy) === 0;
    } catch (error) {
      this.warnWrite(error);
      return false;
    }
  }

  /**
   * 只把已删记录留下的空页还给系统，不重写整库。
   *
   * 依赖打开库时启用的 `auto_vacuum = INCREMENTAL`；没有它这里不生效，
   * 文件会停在高水位，裁剪看不出效果。
   */
  private shrink(): boolean {
    if (!this.incremental) return this.reclaim();
    const db = this.db;
    if (db === null) return false;
    try {
      db.exec("PRAGMA incremental_vacuum");
    } catch (error) {
      this.warnWrite(error);
      return false;
    }
    return this.checkpoint();
  }

  /**
   * 打开库时启用增量回收。
   *
   * `auto_vacuum` 只在库文件创建时生效，已有库必须 VACUUM 一次才能改过来；
   * 这是一次性成本（300 MiB 库约几秒），换来之后每次裁剪不必整库重写。
   */
  private enableIncrementalVacuum(db: SqliteDatabase): void {
    const row = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | undefined;
    if (Number(row?.auto_vacuum) === 2) return;
    try {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("VACUUM");
    } catch (error) {
      // 别的连接占着库时转换会失败；退化为每次裁剪做整库 VACUUM，功能不受影响。
      this.incremental = false;
      this.log("warn", "failed to enable incremental vacuum; falling back to full VACUUM", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 库文件加旁路文件的实际占用。 */
  private diskBytes(): number {
    let total = 0;
    for (const file of this.sidecarFiles()) {
      try {
        total += statSync(file).size;
      } catch {
        // 文件可能尚未创建（例如尾部 WAL），忽略
      }
    }
    return total;
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.log("warn", message);
  }
  /** 存活记录的载荷字节总数。 */
  private liveBytes(db: SqliteDatabase): number {
    const row = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM masking_records").get() as
      | { total: number }
      | undefined;
    return Number(row?.total ?? 0);
  }

  private warnWrite(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.log("warn", "failed to persist masking records", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
