/**
 * Anonymizer Session Base Implementation
 * Browser-safe session wrapper for automatic PII map storage.
 * Does NOT include createStream() to avoid pulling in node:stream.
 */

import type {
  AnonymizationResult,
  AnonymizationPolicy,
  TagFormat,
} from "../types/index.js";
import { walkJson } from "../utils/json-walk.js";
import type { KeyProvider } from "../crypto/index.js";
import { decryptPIIMap, encryptPIIMap } from "../crypto/index.js";
import { rehydrate as rehydrateText } from "../pipeline/tagger.js";
import type { RawPIIMap } from "../pipeline/tagger.js";
import type {
  AnonymizerSession,
  PIIStorageProvider,
  StoredPIIMap,
} from "./types.js";
import type { AnonymizeRun, PiiObserver } from "../core/observer.js";

/**
 * Interface for the parent Anonymizer (to avoid circular dependency)
 */
export interface IAnonymizer {
  anonymize(
    text: string,
    locale?: string,
    policy?: Partial<AnonymizationPolicy>,
    existingPiiMap?: RawPIIMap,
    observer?: PiiObserver,
    run?: AnonymizeRun
  ): Promise<AnonymizationResult>;
  readonly resolvedTagFormat: TagFormat;
}

/** 存储提供者的短别名：泛型参数里直接写全名会拼出与占位符前缀相同的字符序列。 */
type Storage = PIIStorageProvider;

/**
 * 已解密的映射缓存。
 *
 * `persisted` 决定"没有新条目时能否跳过写盘"：空映射从未写过时需要补写一次，
 * 否则新建实例调 `rehydrate()` 会找不到映射。
 */
interface SessionMapCache {
  piiMap: RawPIIMap | undefined;
  createdAt: number;
  entityCounts: Record<string, number>;
  persisted: boolean;
  /** 缓存是在哪把密钥下解出来的：换 key 时必须回落到重新读取并报错。 */
  key: Uint8Array;
}

/** 两把密钥是否相同（缓存命中前必须确认，否则会绕过 key 不匹配的检测）。 */
function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 同一存储 + 同一会话共享的状态：写入队列与已解密缓存。 */
interface SessionState {
  tail: Promise<void>;
  cache: SessionMapCache | null;
  /**
   * 每次缓存失效都自增。读操作在 await 前记下版本，回填缓存前比对：
   * 期间若被流式写入等外部路径失效过，就不能把旧快照塞回缓存。
   */
  version: number;
  /** 正在排队或执行中的任务数，用于判断该条目能否被回收。 */
  pending: number;
}

/**
 * 单个存储实例上保留多少条会话状态。
 *
 * proxy 每请求新建会话，条目只增不减会让内存随历史会话数增长；超过上限时
 * 回收空闲条目（不回收正在排队的，避免拆散同会话队列）。被回收的条目下次
 * 调用会重新从存储读取，不影响正确性。
 */
const MAX_TRACKED_SESSIONS = 64;

/**
 * 按存储实例记录的会话状态。
 *
 * 键是存储实例而不是会话 ID：同一份存储上，多个会话对象（例如 proxy 每条
 * 请求新建的实例）共享同一个键时才需要互斥。缓存也必须挂在同一维度上——
 * 否则一个实例用旧缓存写回，会把另一个实例刚分配的 ID 覆盖掉。
 */
const sessionStates = new WeakMap<Storage, Map<string, SessionState>>();

function stateFor(storage: Storage, sessionId: string): SessionState {
  let bySession = sessionStates.get(storage);
  if (bySession === undefined) {
    bySession = new Map<string, SessionState>();
    sessionStates.set(storage, bySession);
  }
  let state = bySession.get(sessionId);
  if (state === undefined) {
    state = { tail: Promise.resolve(), cache: null, version: 0, pending: 0 };
    bySession.set(sessionId, state);
  }
  return state;
}

/** 回收空闲条目，直到回到上限以内。 */
function evictIdleSessions(bySession: Map<string, SessionState>, keep: string): void {
  if (bySession.size <= MAX_TRACKED_SESSIONS) return;
  // Map 保持插入顺序，从最久未使用的开始是最省事的近似 LRU。
  for (const [id, state] of bySession) {
    if (bySession.size <= MAX_TRACKED_SESSIONS) return;
    if (id !== keep && state.pending === 0) bySession.delete(id);
  }
}

/**
 * 丢弃某会话的缓存。
 *
 * 供绕过会话实例直接写存储的路径使用（例如流式脱敏自己保存映射，或调用方
 * 直接用 `PIIStorageProvider.delete` / `cleanup`），避免缓存继续代表一个已经
 * 被改写的旧状态。
 */
export function invalidateSessionMapCache(storage: Storage, sessionId: string): void {
  const state = sessionStates.get(storage)?.get(sessionId);
  if (state !== undefined) {
    state.cache = null;
    state.version += 1;
  }
}

/**
 * 当前为该存储保留的会话状态条目数（诊断与测试用）。
 *
 * 用于确认上限回收生效，不作为业务指标。
 */
export function trackedSessionCount(storage: Storage): number {
  return sessionStates.get(storage)?.size ?? 0;
}

/** 丢弃某个存储上全部会话的缓存（`cleanup` 这类批量删除之后使用）。 */
export function invalidateStorageCaches(storage: Storage): void {
  const bySession = sessionStates.get(storage);
  if (bySession === undefined) return;
  for (const state of bySession.values()) {
    state.cache = null;
    state.version += 1;
  }
}

/**
 * 把一次读改写排到该会话的队尾，保证同一存储 + 同一会话的写入串行执行。
 *
 * 已知限制：锁只在进程内生效。多进程共用同一个 SQLite 文件时，各进程持有
 * 各自的存储实例，跨进程写入仍可能互相覆盖。
 *
 * 流式脱敏直接持有存储句柄，它的写盘也要排进这条队，否则会与进行中的
 * 脱敏/还原交错，让旧快照覆盖新映射。
 */
export async function withSessionLock<T>(
  storage: Storage,
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  return runExclusive(storage, sessionId, task);
}

async function runExclusive<T>(
  storage: Storage,
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const state = stateFor(storage, sessionId);
  state.pending += 1;
  // 队尾永不 reject，所以直接续接即可：本次任务在上一任务结束后开始。
  const running = state.tail.then(task);
  // 队尾只关心"已结束"，不关心成败；失败由 running 交给调用方。
  state.tail = running.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await running;
  } finally {
    state.pending -= 1;
    const bySession = sessionStates.get(storage);
    if (bySession !== undefined) evictIdleSessions(bySession, sessionId);
  }
}

/**
 * Session implementation that wraps an Anonymizer with automatic storage
 */
export class AnonymizerSessionImpl implements AnonymizerSession {
  readonly sessionId: string;


  constructor(
    protected readonly anonymizer: IAnonymizer,
    sessionId: string,
    protected readonly storage: Storage,
    protected readonly keyProvider: KeyProvider
  ) {
    this.sessionId = sessionId;
  }

  async anonymize(
    text: string,
    locale?: string,
    policy?: Partial<AnonymizationPolicy>,
    observer?: PiiObserver,
    run?: AnonymizeRun
  ): Promise<AnonymizationResult> {
    // 读改写全程在会话队列里执行：并发调用若读到同一份旧映射，会各自分配
    // 相同 ID 并互相覆盖，导致占位符还原成别人的值。
    return runExclusive(this.storage, this.sessionId, () =>
      this.anonymizeExclusive(text, locale, policy, observer, run),
    );
  }

  private async anonymizeExclusive(
    text: string,
    locale?: string,
    policy?: Partial<AnonymizationPolicy>,
    observer?: PiiObserver,
    run?: AnonymizeRun
  ): Promise<AnonymizationResult> {
    // Get the encryption key
    const key = await this.keyProvider.getKey();

    // 缓存挂在 storage + sessionId 上，与写入队列同域：同一次请求会逐字符串
    // 脱敏，重复解密同一份映射是纯浪费；跨实例也必须共享，否则旧缓存写回会
    // 覆盖别的实例刚分配的 ID。
    const state = stateFor(this.storage, this.sessionId);
    let existingPiiMap: RawPIIMap | undefined;
    let createdAt: number;
    let existingEntityCounts: Record<string, number>;
    let persisted: boolean;

    // 换过密钥时不能复用缓存：那会绕过 key 不匹配的检测，把旧密钥解出的
    // 明文用新密钥重新加密。回落到重新读取，让既有报错路径生效。
    if (state.cache !== null && sameKey(state.cache.key, key)) {
      existingPiiMap = state.cache.piiMap;
      createdAt = state.cache.createdAt;
      existingEntityCounts = state.cache.entityCounts;
      persisted = state.cache.persisted;
    } else {
      const existing = await this.storage.load(this.sessionId);
      if (existing !== null) {
        try {
          existingPiiMap = await decryptPIIMap(existing.piiMap, key);
          createdAt = existing.metadata.createdAt;
          existingEntityCounts = existing.metadata.entityCounts;
        } catch (error) {
          // Decryption failed - likely key mismatch
          const isKeyMismatch =
            error instanceof Error &&
            (error.name === "OperationError" ||
              error.message.includes("decrypt"));

          if (isKeyMismatch) {
            throw new Error(
              `Failed to decrypt existing session data for "${this.sessionId}". ` +
                `The encryption key may have changed since this session was created.\n\n` +
                `To fix this, either:\n` +
                `  1. Use the same key that was used to create the session\n` +
                `  2. Delete the old session: await session.delete()\n` +
                `  3. Use a persistent key provider (e.g., ConfigKeyProvider)`
            );
          }
          throw error;
        }
        persisted = true;
      } else {
        existingPiiMap = undefined;
        createdAt = Date.now();
        existingEntityCounts = {};
        persisted = false;
      }
      state.cache = {
        piiMap: existingPiiMap,
        createdAt,
        entityCounts: existingEntityCounts,
        persisted,
        // 快照独立副本：provider 可能复用同一个数组，原地改 key 会绕过校验。
        key: new Uint8Array(key),
      };
    }

    // Call the parent anonymizer with existing PII map for ID reuse
    const result = await this.anonymizer.anonymize(
      text,
      locale,
      policy,
      existingPiiMap,
      observer,
      run
    );

    // Sessions require a PII map (only available in pseudonymize mode)
    if (result.piiMap === undefined) {
      throw new Error(
        "Session anonymize() failed: no PII map returned.\n\n" +
          "This can happen if the anonymizer is in 'anonymize' mode.\n" +
          "Sessions require 'pseudonymize' mode for PII map storage."
      );
    }

    // Decrypt the new PII map
    const newPiiMap = await decryptPIIMap(result.piiMap, key);

    // Merge maps: start with existing (if any), add new entries
    const mergedPiiMap: RawPIIMap = existingPiiMap
      ? new Map<string, string>(existingPiiMap)
      : new Map<string, string>();
    for (const [k, v] of newPiiMap) {
      mergedPiiMap.set(k, v);
    }


    // 只在两种情况下需要回写：出现了新条目，或该会话从未落过盘（此时要补写
    // 一份空映射，否则新建实例调 rehydrate() 会找不到映射）。重扫历史时绝大
    // 多数轮次既无新实体又已落盘，跳过加密与保存。
    const hasNewEntry = [...newPiiMap.keys()].some(
      (k) => existingPiiMap === undefined || !existingPiiMap.has(k)
    );
    if (!hasNewEntry && persisted) {
      return result;
    }

    // Merge entity counts
    const mergedEntityCounts = { ...existingEntityCounts };
    for (const [type, count] of Object.entries(result.stats.countsByType)) {
      mergedEntityCounts[type] = (mergedEntityCounts[type] ?? 0) + count;
    }

    // Re-encrypt the merged PII map
    const encryptedMergedMap = await encryptPIIMap(mergedPiiMap, key);

    try {
      await this.storage.save(this.sessionId, encryptedMergedMap, {
        createdAt,
        entityCounts: mergedEntityCounts,
        modelVersion: result.stats.modelVersion,
      });
    } catch (error) {
      // 写盘失败后不能让缓存继续代表"已持久化"的事实。
      state.cache = null;
      throw error;
    }

    state.cache = {
      piiMap: mergedPiiMap,
      createdAt,
      entityCounts: mergedEntityCounts,
      persisted: true,
      key: new Uint8Array(key),
    };

    return result;
  }

  async rehydrate(text: string): Promise<string> {
    // 还原也会填缓存，必须与写入排在同一条队里：否则它读到旧快照后
    // 恢复执行，会把删除或更新后的新状态覆盖回旧版本。
    return runExclusive(this.storage, this.sessionId, () =>
      this.rehydrateExclusive(text),
    );
  }

  private async rehydrateExclusive(text: string): Promise<string> {
    const state = stateFor(this.storage, this.sessionId);
    const key = await this.keyProvider.getKey();
    // 有缓存就直接用：同一轮里脱敏刚建立的映射不必再解密一次。
    // 密钥换过时不能复用，必须回落到从存储重新解密（会按既有路径报错）。
    if (state.cache !== null && sameKey(state.cache.key, key)) {
      // piiMap 为空表示本会话确实没有任何实体，此时原样返回即可。
      if (state.cache.piiMap === undefined) return text;
      return rehydrateText(
        text,
        state.cache.piiMap,
        false,
        this.anonymizer.resolvedTagFormat,
      );
    }

    // 读取期间可能有外部写入（流式脱敏、直接调 provider）失效过缓存。
    // 记下版本，回填前比对，避免把旧快照塞回缓存。
    const version = state.version;

    // Load from storage
    const stored = await this.storage.load(this.sessionId);
    if (stored === null) {
      throw new Error(
        `No PII map found for session: ${this.sessionId}. ` +
          `Make sure to call anonymize() before rehydrate().`
      );
    }

    // Decrypt the PII map
    const piiMap = await decryptPIIMap(stored.piiMap, key);
    if (state.version === version) {
      state.cache = {
        piiMap,
        createdAt: stored.metadata.createdAt,
        entityCounts: stored.metadata.entityCounts,
        persisted: true,
        key: new Uint8Array(key),
      };
    }

    // Rehydrate the text
    return rehydrateText(text, piiMap, false, this.anonymizer.resolvedTagFormat);
  }

  async anonymizeJson<T>(
    value: T,
    locale?: string,
    policy?: Partial<AnonymizationPolicy>,
  ): Promise<T> {
    return walkJson(value, async (s: string) => {
      const result = await this.anonymize(s, locale, policy);
      return result.anonymizedText;
    });
  }

  async rehydrateJson<T>(value: T): Promise<T> {
    return walkJson(value, (s: string) => this.rehydrate(s));
  }

  async load(): Promise<StoredPIIMap | null> {
    return this.storage.load(this.sessionId);
  }

  async delete(): Promise<boolean> {
    // 与写入、还原同队：否则一个已挂起的还原会把删除后的缓存又填回来。
    return runExclusive(this.storage, this.sessionId, async () => {
      const deleted = await this.storage.delete(this.sessionId);
      invalidateSessionMapCache(this.storage, this.sessionId);
      return deleted;
    });
  }

  async exists(): Promise<boolean> {
    return this.storage.exists(this.sessionId);
  }
}
