# Design

## Context

见 proposal.md 的 Why。相关既有实现：`src/storage/session-base.ts` 的 `sessionStates`（`WeakMap<Storage, Map<sessionId, SessionState>>`）同时承载写入队列与已解密缓存。

## Goals / Non-Goals

**Goals:**

- 任何"映射被外部改写"的公开路径都不会留下可用旧缓存。
- 缓存与队列的作用域一致，允许的并发交错不会产生旧快照回填。
- 会话状态条目数有上限。

**Non-Goals:**

- 不做跨进程失效通知（多进程共用同一 SQLite 文件）。
- 不改 `PIIStorageProvider` 接口签名。

## Decisions

### provider 主动失效，而不是让会话层轮询

`delete` / `cleanup` 是公开 API，调用方不一定经过会话对象。让内置 provider 在完成后调用 `invalidateSessionMapCache` / `invalidateStorageCaches`，是把失效点放在唯一知道"数据变了"的地方。

备选：会话层每次命中前用 `exists()` 验证。否决原因：那等于每个字符串一次存储查询，抵消缓存收益。

依赖方向是 provider → session-base。`session-base` 只从 `./types.js` 取类型，不 import 任何 provider，因此不构成循环。

### 流式写盘入队 + 回填版本守卫（双保险）

`createStream()` 传入的包装存储把 `save` / `delete` 送进 `withSessionLock`，从根上消除"流写入与进行中的还原交错"。

同时在 `SessionState` 上维护 `version`，每次失效自增；`rehydrate` 在 `await storage.load` 前记下版本，回填前比对，不一致就不回填。这层守卫生效于队列外的失效（例如直接调 provider 删除）。

两层都要：队列解决交错，版本守卫解决队列外的失效。

### 容量回收只回收空闲条目

`MAX_TRACKED_SESSIONS = 64`，超出时按插入顺序回收 `pending === 0` 的条目。回收后下次调用重新从存储读取，正确性不变。不回收正在排队的条目，避免拆散同会话队列。

备选：按 TTL 过期。否决原因：需要定时器，且与"队列空闲"这个真正安全的回收时机无关。

## Risks / Trade-offs

- [provider 主动失效引入 provider → 会话层依赖] → 只依赖两个纯函数，无状态耦合；不构成循环。
- [容量上限会淘汰仍在使用的会话缓存] → 仅是性能回退（重新解密一次），不影响正确性。
- [版本守卫在多进程场景无效] → 已在 README 与注释写明跨进程不在范围内。

## Migration Plan

纯内部实现变更，无配置项与数据格式变化。
