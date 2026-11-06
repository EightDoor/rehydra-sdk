# Proposal

## Why

`AnonymizerSessionImpl.anonymize()` 是"读映射 → 分配 ID → 合并 → 写回"四步，中间没有串行化。两个并发调用读到同一份旧映射时，会给不同实体分配同一个 ID，后写者覆盖先写者。结果不只是丢映射：同一个占位符可能被还原成另一个人的值。

并发来源是真实存在的：Pi 扩展里 `tool_result` 与 `context_with_system` 可能交错执行；proxy 路径每次请求新建一个会话实例，而 `getSessionId` 返回固定 ID 时同键并发直接成立。

## What Changes

- 在会话层为"同一存储实例 + 同一会话 ID"的读改写过程加串行化，不同会话之间仍然并行。
- 不改变 `PIIStorageProvider` 接口，不改变 `AnonymizerSession` 的公开形状。
- 新增并发回归测试：同一会话并发脱敏后，ID 不串、每个占位符都能还原回自己的原值。

## Capabilities

### New Capabilities

- `session-map-consistency`：会话级 PII 映射在并发写入下的可见性与一致性约定。

### Modified Capabilities

（无）

## Impact

- 修改 `src/storage/session-base.ts`：为 `anonymize()` 的读改写加会话级串行化。
- 新增 `test/storage/session-concurrency.test.ts`。
- 已知限制：多进程共享同一个 SQLite 文件时，各进程持有各自的存储实例，进程内锁不跨进程。本变更不处理跨进程一致性，在代码注释中写明。
- 无配置项变化，无数据迁移。
