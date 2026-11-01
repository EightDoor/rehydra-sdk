/**
 * 脱敏记录器。
 *
 * 内存里保留最近若干条供 `/rehydra log` 读取；开启后按天追加写入用户目录。
 * 记录层任何失败都只告警，绝不影响脱敏与请求。
 */
import { appendFile, mkdir, readFile, readdir, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { MaskingRecord } from "./types.js";

/** 记录器配置。 */
export interface RecorderOptions {
  /** 是否启用记录。 */
  enabled: boolean;
  /** 是否保存原文与全文对照。 */
  includeOriginal: boolean;
  /** 内存保留条数。 */
  keepInMemory: number;
  /** 磁盘保留天数。 */
  keepDays: number;
  /** 磁盘总量上限（字节）。 */
  keepBytes: number;
  /** 单条记录对照总量上限（字节）。 */
  maxRecordBytes: number;
  /** 记录目录。 */
  dir: string;
}

export const DEFAULT_RECORDER_OPTIONS: Omit<RecorderOptions, "dir"> = {
  enabled: false,
  includeOriginal: false,
  keepInMemory: 50,
  keepDays: 7,
  keepBytes: 32 * 1024 * 1024,
  maxRecordBytes: 256 * 1024,
};

/** 追加队列上限：超出的记录直接丢弃并告警一次。 */
const MAX_QUEUE = 200;

/** 记录标识前缀匹配的结果。 */
export type RecordLookup =
  | { kind: "found"; record: MaskingRecord }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "missing" };

type Log = (level: "warn" | "error", message: string, extra?: Record<string, unknown>) => void;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 记录器。 */
export class MaskingRecorder {
  private readonly options: RecorderOptions;
  private readonly log: Log;
  private readonly fileName: string;
  private readonly memory: MaskingRecord[] = [];
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private dropped = 0;
  private lastPrune = 0;
  private warnedWrite = false;

  constructor(
    options: Partial<RecorderOptions> & { dir: string },
    log: Log,
    instanceSuffix: string,
  ) {
    this.options = { ...DEFAULT_RECORDER_OPTIONS, ...options };
    this.log = log;
    // 多实例并发时按天文件不比拼接：各自写自己的文件，读取时合并
    this.fileName = instanceSuffix;
  }

  /** 是否启用。 */
  get enabled(): boolean {
    return this.options.enabled;
  }

  /** 是否保存原文。 */
  get includeOriginal(): boolean {
    return this.options.enabled && this.options.includeOriginal;
  }

  /** 单条对照可用预算。 */
  get maxRecordBytes(): number {
    return this.options.maxRecordBytes;
  }

  /** 记录一条。内存永远保留（用于即时查看），落盘按开关。 */
  add(record: MaskingRecord): void {
    if (!this.options.enabled) return;
    this.memory.push(record);
    if (this.memory.length > this.options.keepInMemory) {
      this.memory.splice(0, this.memory.length - this.options.keepInMemory);
    }

    if (this.pending >= MAX_QUEUE) {
      this.dropped += 1;
      if (this.dropped === 1) {
        this.log("warn", "record queue is full, dropping records", { dropped: true });
      }
      return;
    }
    this.pending += 1;
    this.queue = this.queue
      .then(() => this.persist(record))
      .catch((error: unknown) => {
        this.warnWrite(error);
      })
      .finally(() => {
        this.pending -= 1;
      });
  }

  /** 分配一条新记录的标识。 */
  nextId(now: number): string {
    this.sequence += 1;
    return `${now}-${this.sequence}`;
  }

  /** 内存中的最近记录，按时间倒序。 */
  recent(limit: number, sessionId?: string): MaskingRecord[] {
    const filtered =
      sessionId === undefined
        ? [...this.memory]
        : this.memory.filter((record) => record.sessionId === sessionId);
    return filtered.reverse().slice(0, limit);
  }

  /** 按标识或唯一前缀查找记录（内存优先，其次磁盘）。 */
  async find(idOrPrefix: string): Promise<RecordLookup> {
    const fromMemory = this.match(this.memory, idOrPrefix);
    if (fromMemory.kind !== "missing") return fromMemory;

    const disk = await this.readAll();
    return this.match(disk, idOrPrefix);
  }

  /** 清除记录：`session` 只清当前会话，`all` 清全部。 */
  async clear(kind: "session" | "all", sessionId?: string): Promise<void> {
    if (kind === "all") {
      this.memory.length = 0;
      await this.removeAllFiles();
      return;
    }
    for (let i = this.memory.length - 1; i >= 0; i -= 1) {
      if (this.memory[i]?.sessionId === sessionId) this.memory.splice(i, 1);
    }
    // 磁盘记录按天成文件，无法只删一个会话；保留文件，读取时按会话过滤
  }

  /** 等待队列落盘（测试与退出前使用）。 */
  async flush(): Promise<void> {
    await this.queue;
  }

  private match(records: MaskingRecord[], idOrPrefix: string): RecordLookup {
    const exact = records.find((record) => record.id === idOrPrefix);
    if (exact !== undefined) return { kind: "found", record: exact };
    const prefixed = records.filter((record) => record.id.startsWith(idOrPrefix));
    if (prefixed.length === 1 && prefixed[0] !== undefined) {
      return { kind: "found", record: prefixed[0] };
    }
    if (prefixed.length > 1) {
      return { kind: "ambiguous", ids: prefixed.map((record) => record.id).slice(0, 10) };
    }
    return { kind: "missing" };
  }

  private dayFile(now: number): string {
    const day = new Date(now).toISOString().slice(0, 10);
    return join(this.options.dir, `${day}.${this.fileName}.jsonl`);
  }

  private async persist(record: MaskingRecord): Promise<void> {
    if (!(await this.ensureDir())) return;
    const path = this.dayFile(Date.parse(record.time));
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
    if (Date.now() - this.lastPrune > 60 * 60 * 1000) {
      this.lastPrune = Date.now();
      await this.prune();
    }
  }

  private async ensureDir(): Promise<boolean> {
    try {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
      const info = await lstat(this.options.dir);
      if (info.isSymbolicLink()) {
        // 符号链接可能把记录写到别处，直接拒绝
        if (!this.warnedWrite) {
          this.warnedWrite = true;
          this.log("warn", "records directory is a symlink, refusing to write");
        }
        return false;
      }
      return true;
    } catch (error) {
      this.warnWrite(error);
      return false;
    }
  }

  private async prune(): Promise<void> {
    try {
      const files = await this.dayFiles();
      const oldest = new Date(Date.now() - this.options.keepDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      let total = 0;
      const sizes: number[] = [];
      for (const file of files) {
        const info = await lstat(file.path);
        sizes.push(info.size);
        total += info.size;
      }
      for (const [index, file] of files.entries()) {
        if (file.day >= oldest && total <= this.options.keepBytes) break;
        await rm(file.path, { force: true });
        total -= sizes[index] ?? 0;
      }
    } catch (error) {
      this.warnWrite(error);
    }
  }

  private async dayFiles(): Promise<Array<{ day: string; path: string }>> {
    let entries: string[];
    try {
      entries = await readdir(this.options.dir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ day: name.slice(0, 10), path: join(this.options.dir, name) }))
      .filter((file) => DAY_PATTERN.test(file.day))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  private async readAll(): Promise<MaskingRecord[]> {
    const files = await this.dayFiles();
    const records: MaskingRecord[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file.path, "utf-8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (line.trim() === "") continue;
        try {
          records.push(JSON.parse(line) as MaskingRecord);
        } catch {
          // 半行/损坏行：跳过并告警，不输出原文
          this.log("warn", "skipped a corrupt record line", { file: file.day });
        }
      }
    }
    return records;
  }

  private async removeAllFiles(): Promise<void> {
    for (const file of await this.dayFiles()) {
      await rm(file.path, { force: true });
    }
  }

  private warnWrite(error: unknown): void {
    if (this.warnedWrite) return;
    this.warnedWrite = true;
    this.log("warn", "failed to persist masking records", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
