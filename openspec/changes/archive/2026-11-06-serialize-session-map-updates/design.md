# Design

## Context

`AnonymizerSessionImpl.anonymize()`（`src/storage/session-base.ts`）当前的顺序是：

1. `storage.load(sessionId)` 取下已加密映射并解密；
2. 调 `anonymizer.anonymize()` 传入旧映射，让已有实体复用原 ID；
3. 合并新旧映射、重新加密、`storage.save()`。

并发来源有两个：

- Pi 扩展同一会话复用同一个 session 实例，但 `tool_result` 与 `context_with_system` 是不同事件，可交错进入。
- proxy 路径（`src/proxy/rehydra-fetch.ts`）每次请求 `new AnonymizerSessionImpl(...)`，`getSessionId` 固定时多个实例共享同一个存储键。

`PIIStorageProvider` 只有 `save` / `load`，没有"比较并交换"或事务语义，因此并发保护只能由会话层提供。

## Goals / Non-Goals

**Goals:**

- 同一存储实例 + 同一会话 ID 的并发 `anonymize()` 串行执行，ID 分配不冲突。
- 不同会话 ID 之间不互相阻塞。

**Non-Goals:**

- 不做跨进程一致性（多进程共用 SQLite 文件）。
- 不改 `PIIStorageProvider` 接口。
- 不改 `rehydrate()` 的语义：它只读，不需要锁。

## Decisions

### 用"按存储实例 + 会话 ID 的 Promise 链"串行化

按存储实例建一张 `WeakMap`，值为 `Map<sessionId, Promise<void>>`；`anonymize()` 的整个读改写在链条尾部排队。存储实例作为 WeakMap 键，天然覆盖"同存储 + 同会话"的所有会话实例，也避免长期持有存储对象。

备选：在 `InMemoryPIIStorageProvider` / `SQLitePIIStorageProvider` 里各自加锁。否决原因：锁语义应该在会话层统一，且任何第三方实现都会漏；改动面也更大。

备选：只给 Pi 扩展的 `resolveSession` 缓存实例。否决原因：缓存实例只解决 Pi 扩展一处，proxy 路径仍然并发，根因还在。
### 缓存与写入队列同域：按存储实例 + 会话 ID 共享

缓存挂在 `WeakMap<Storage, Map<sessionId, { tail, cache }>>` 上，与写入队列是同一份状态，读写只在 `runExclusive` 区内进行。

最初把缓存放在会话实例上是错的：锁按存储共享、缓存按实例私有，两者的作用域不一致。于是 A 用旧缓存写回时会算出一个已被 B 占用的 ID，覆盖掉 B 的映射——不只是"读到旧数据"，而是持久化数据丢失。审查发现了这点，现已改为共享。

缓存条目记录解出它的密钥：换 key 时必须回落成"重新读取并解密"，否则会绕过 key 不匹配的检测，把旧密钥解出的明文用新密钥重新加密。

流式脱敏直接持有存储句柄、不经过会话队列，因此 `createStream()` 传入一个包装过的存储，每次 `save` / `delete` 后失效缓存。


排队范围包含 `load` → `anonymize` → 合并 → `save`。只锁 `save` 无法阻止两个调用读到同一份旧映射后各自分配 ID。

### 链尾保持可用：失败不掐断后续排队

每个任务的 `finally` 把链推进到已完成状态，`catch` 只用于防止链上出现未处理的拒绝把后续任务拖死；本次调用的错误照常抛给调用方。

## Risks / Trade-offs

- [同一会话的并发脱敏被串行化，吞吐下降] → 正确性优先；同一会话的写入本就共享同一个映射，并行写没有意义。基准在长会话场景下验证不劣化（每轮本来就只有少量写入）。
- [Promise 链在极端并发下长期占用内存] → 链条只保留最新一个 promise，`Map` 条目在会话空闲后由 `WeakMap` 随存储实例回收。
- [跨进程仍可能串号] → 在代码注释与 proposal 中写明该限制，避免误以为已完全解决。

## Migration Plan

1. 纯内部实现变更，无配置项、无数据格式变化。
2. 回滚只需还原 `session-base.ts` 的锁逻辑，已有存储数据不受影响。

## Open Questions

无。
