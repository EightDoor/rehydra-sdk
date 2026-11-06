# Proposal

## Why

`session-map-caching` 引入进程内映射缓存后，出现三个失效边界缺口，均可用公开 API 触发：

- 调用方直接用 `PIIStorageProvider.delete()` / `cleanup()` 时缓存不失效，删除后的 PII 仍能从缓存还原；再次脱敏相同实体还会因「已落盘」判定跳过保存。
- 流式脱敏的写盘发生在会话队列之外，能与进行中的还原交错，让旧快照回填缓存并覆盖流新增的映射。
- 缓存保存的是密钥数组引用，`InMemoryKeyProvider` 又返回内部数组，原地改 key 会让密钥校验恒等通过。

此外会话状态条目只增不减，proxy 每请求一个新 sessionId 的路径会让内存随历史会话数增长。

## What Changes

- 内置存储提供者的 `delete()` / `cleanup()` 主动失效对应缓存。
- 流式写盘排进会话队列；缓存回填加失效版本守卫。
- 缓存保存密钥快照（`new Uint8Array(key)`），不再持有 provider 的数组引用。
- 每个存储实例上的会话状态条目数设上限，超出时回收空闲条目；新增只读计数用于诊断与测试。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `session-map-caching`：补强"缓存何时必须失效"与"状态回收边界"两项要求。

## Impact

- 修改 `src/storage/session-base.ts`（版本号、待处理计数、容量回收、密钥快照、导出 `withSessionLock` 与 `trackedSessionCount`）。
- 修改 `src/storage/session.ts`（流式写盘入队）。
- 修改 `src/storage/in-memory.ts`、`sqlite.ts`、`indexeddb.ts`（删除/清理后失效缓存）。
- 新增 5 条回归测试。
- 无公开配置项变化；`invalidateSessionMapCache` 之外新增两个导出，均为诊断/内部用途。
