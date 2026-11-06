# Design

## Context

`AnonymizerSessionImpl.anonymize()` 每次调用都完整执行：`storage.load` → `decryptPIIMap` → 脱敏 → 合并 → `encryptPIIMap` → `storage.save`。

Pi 扩展的 `context_with_system` 会对整段历史逐字符串调用它（`src/host-agnostic/scrub.ts` 的 `scrubString`），所以一次请求里同一个会话的映射会被反复解密；历史有 N 条消息时，解密次数与字符串数同阶。

第 2 期已经给读改写加了会话级串行化（`runExclusive`），因此缓存可以安全地放在串行区内，不会被并发写入打乱。

## Goals / Non-Goals

**Goals:**

- 消除同一会话内重复的 `load` + `decrypt`。
- 消除"没有新实体"时的 `encrypt` + `save`。
- 保持脱敏输出逐字节不变。

**Non-Goals:**

- 不改 `PIIStorageProvider` 接口（不加 transaction / CAS）。
- 不做跨进程或跨实例的缓存失效通知。
- 不做批量接口（一次事件一次 load/save）——那要改 `AnonymizerSession` 形状，需单独立项。

## Decisions

### 缓存与写入队列同域：按存储实例 + 会话 ID 共享

缓存挂在 `WeakMap<Storage, Map<sessionId, { tail, cache }>>` 上，与写入队列是同一份状态，读写只在 `runExclusive` 区内进行。

最初把缓存放在会话实例上是错的：锁按存储共享、缓存按实例私有，两者作用域不一致。于是 A 用旧缓存写回时会算出一个已被 B 占用的 ID，覆盖掉 B 的映射——不只是"读到旧数据"，而是持久化数据丢失。代码审查发现后改为共享。

缓存条目记录解出它的密钥：换 key 时必须回落成"重新读取并解密"，否则会绕过 key 不匹配检测，把旧密钥解出的明文用新密钥重新加密。

流式脱敏直接持有存储句柄、不经过会话队列，因此 `createStream()` 传入包装过的存储，每次 `save` / `delete` 后失效缓存。

`rehydrate()` 与 `delete()` 也进同一条队列：否则一个已挂起的还原会把删除或更新后的状态覆盖回旧版本。

### 无新增条目、且已落盘时不写盘

跳过条件是「没有新条目 **且** 该会话已落过盘」。单纯看"没有新条目"会让首次无 PII 的会话不落任何映射，导致新建实例调 `rehydrate()` 抛错——这是既有契约的回归（`AnonymizerSession` 约定 anonymize 自动保存映射）。现在空映射会补写一次。

### 缓存失效的已知限制

只有另一种情况会拿到旧缓存：**另一个进程**，或另一个指向同一份底层数据的存储实例。同一存储上的多个会话实例现在共享同一份缓存，不再有窗口。这条写进注释与两个 README。

## Risks / Trade-offs

- [跨进程写入感知不到] → 已在代码注释与 README 写明；跨进程一致性不在本期范围。
- [跳过写盘后映射未持久化] → 仅在"已落盘且无新条目"时跳过。
- [缓存使内存随会话增长] → 缓存内容与该会话的映射同阶，`WeakMap` 随存储实例回收。
- [共享缓存需要 key 校验] → `sameKey` 在每次命中前比较密钥字节，避免绕过 key 不匹配检测。

## Migration Plan

1. 纯内部实现变更，无配置项、无数据格式变化。
2. 回滚只需移除缓存字段与跳过逻辑。

## Open Questions

无。

## Measured results

基准脚本：`test/benchmark/session-long-history.bench.ts`（`ner: disabled`，`InMemory` 存储，逐字符串脱敏）。

| 场景 | 改造前 | 改造后 | 变化 |
|---|---|---|---|
| 50 条历史 | 14.98 ms | 5.48 ms | 2.7× 更快 |
| 200 条历史 | 148.66 ms | 31.58 ms | 4.7× 更快 |
| 200 条历史重复扫描（无新实体） | 295.72 ms | 62.74 ms | 4.7× 更快 |

改造前"重复扫描"与"单次扫描"耗时同为约 2 倍关系，说明此前没有任何复用；改造后同口径仍是两遍扫描，但每遍成本降到约三分之一。

基线原始数字记录在 `benchmarks/history/2026-11-06-session-cache-baseline.json`（该目录不入库）。
