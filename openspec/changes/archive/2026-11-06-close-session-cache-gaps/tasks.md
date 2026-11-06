# Tasks

## 1. provider 级失效

- [x] 1.1 `in-memory.ts` / `sqlite.ts` / `indexeddb.ts` 的 `delete` 调用 `invalidateSessionMapCache`
- [x] 1.2 `cleanup` 在有删除时调用 `invalidateStorageCaches`
- [x] 1.3 回归测试：直接 `storage.delete` / `storage.cleanup` 后不再从缓存还原

## 2. 交错防护

- [x] 2.1 导出 `withSessionLock`，`createStream()` 的包装存储把 `save` / `delete` 送进会话队列
- [x] 2.2 `SessionState` 增加 `version`，失效时自增；`rehydrate` 回填前比对
- [x] 2.3 回归测试：流式写入后普通脱敏不覆盖流新增映射

## 3. 密钥快照

- [x] 3.1 三处缓存赋值改为 `new Uint8Array(key)`
- [x] 3.2 回归测试：原地修改密钥数组后不复用旧缓存

## 4. 状态回收

- [x] 4.1 `SessionState` 增加 `pending`；`runExclusive` 进出计数
- [x] 4.2 新增 `MAX_TRACKED_SESSIONS` 与 `evictIdleSessions`，只回收空闲条目
- [x] 4.3 新增 `trackedSessionCount` 供诊断与测试
- [x] 4.4 回归测试：120 个会话后条目数不超过上限，且被回收会话仍可用

## 5. 收尾

- [x] 5.1 `npm run build` 通过
- [x] 5.2 `npm run lint` 无新增警告（保持基线 4 条）
- [x] 5.3 `npm run test:run` 与基线一致（13 个既有离线下载失败），通过数 1609 → 1614
