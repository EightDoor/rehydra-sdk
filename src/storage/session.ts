/**
 * Anonymizer Session Implementation (Node.js)
 * Extends the base session with streaming support (requires node:stream).
 */

export { type IAnonymizer } from "./session-base.js";
import {
  AnonymizerSessionImpl as BaseSessionImpl,
  invalidateSessionMapCache,
} from "./session-base.js";
import type { KeyProvider } from "../crypto/index.js";
import { decryptPIIMap } from "../crypto/index.js";
import type { RawPIIMap } from "../pipeline/tagger.js";
import type { PIIStorageProvider } from "./types.js";
import { AnonymizerStream } from "../streaming/anonymizer-stream.js";
import type { StreamConfig } from "../streaming/types.js";
import type { IAnonymizer } from "./session-base.js";

/**
 * 包装存储：写盘成功后丢弃该会话的缓存。
 *
 * 流式脱敏直接持有存储句柄，不经过会话队列，所以缓存只能在这里失效。
 */
function withCacheInvalidation(
  storage: PIIStorageProvider,
  sessionId: string,
): PIIStorageProvider {
  return {
    save: async (id, piiMap, metadata): Promise<void> => {
      await storage.save(id, piiMap, metadata);
      invalidateSessionMapCache(storage, sessionId);
    },
    load: (id) => storage.load(id),
    delete: async (id): Promise<boolean> => {
      const deleted = await storage.delete(id);
      invalidateSessionMapCache(storage, sessionId);
      return deleted;
    },
    exists: (id) => storage.exists(id),
    list: (options) => storage.list(options),
    cleanup: (olderThan) => storage.cleanup(olderThan),
  };
}
/**
 * Node.js session implementation with streaming support
 */
export class AnonymizerSessionImpl extends BaseSessionImpl {
  constructor(
    anonymizer: IAnonymizer,
    sessionId: string,
    storage: PIIStorageProvider,
    keyProvider: KeyProvider
  ) {
    super(anonymizer, sessionId, storage, keyProvider);
  }

  async createStream(config?: Partial<StreamConfig>): Promise<AnonymizerStream> {
    // Load existing PII map to seed the stream for ID continuity
    let initialPiiMap: RawPIIMap | undefined;
    const existing = await this.storage.load(this.sessionId);
    if (existing !== null) {
      const key = await this.keyProvider.getKey();
      initialPiiMap = await decryptPIIMap(existing.piiMap, key);
    }

    // 流自己直接写存储，绕过了会话队列；每次写盘后都要丢弃缓存，
    // 否则后续 anonymize / rehydrate 会基于流写入之前的旧映射。
    const storage = withCacheInvalidation(this.storage, this.sessionId);

    return new AnonymizerStream(
      this.anonymizer,
      {
        ...config,
        sessionId: this.sessionId,
        piiStorageProvider: storage,
        keyProvider: this.keyProvider,
      },
      initialPiiMap,
    );
  }
}
