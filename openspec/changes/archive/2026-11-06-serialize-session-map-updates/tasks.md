# Tasks

## 1. 会话级串行化

- [x] 1.1 `src/storage/session-base.ts` 增加按存储实例的 `WeakMap`，值为 `Map<sessionId, Promise<void>>`；提供 `runExclusive(sessionId, task)` 把任务排到该会话链条尾部
- [x] 1.2 `anonymize()` 的 `load` → 脱敏 → 合并 → `save` 全程放进 `runExclusive`；`rehydrate()` 与只读方法不变
- [x] 1.3 链条在任务失败时仍推进（`finally` 解开排队），本次调用的错误照常抛给调用方
- [x] 1.4 注释写明已知限制：多进程共用同一存储文件时不跨进程

## 2. 并发回归测试

- [x] 2.1 新增 `test/storage/session-concurrency.test.ts`：同一会话并发 20 次脱敏，各含不同邮箱，断言最终映射条目数为 20、所有 ID 互不相同
- [x] 2.2 断言每个占位符经 `rehydrate()` 还原回各自的原始值（不串号）
- [x] 2.3 断言同一实体的重复值在并发下复用同一个 ID
- [x] 2.4 断言两个不同会话并发时各自结果正确
- [x] 2.5 断言一次脱敏失败后，同会话后续脱敏仍能完成

## 3. 收尾

- [x] 3.1 `npm run build` 通过
- [x] 3.2 `npm run test:run` 与 `npm run lint` 通过；离线语义数据下载失败为既有基线
