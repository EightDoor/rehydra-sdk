# Tasks

## 1. 基准先行

- [x] 1.1 新增 `test/benchmark/session-long-history.bench.ts`：构造 50 条与 200 条历史，逐字符串脱敏，记录耗时；用同一脚本跑改造前后
- [x] 1.2 记录改造前基线数字到 `benchmarks/history/`（目录不入库）

## 2. 会话内缓存

- [x] 2.1 `src/storage/session-base.ts` 增加私有缓存字段（已解密映射 + 是否需要回写），仅在串行区内读写
- [x] 2.2 `anonymizeExclusive` 优先使用缓存；缓存缺失时从存储读取并解密后填入
- [x] 2.3 新增 `test/storage/session-cache.test.ts` 断言：新实体拿到新 ID、脱敏结果与不缓存时一致

## 3. 写盘抑制

- [x] 3.1 本次脱敏无新增或变更条目时，跳过 `encryptPIIMap` 与 `storage.save`
- [x] 3.2 断言：无新实体时不触发 `save`；有新实体时触发 `save` 且该实体可还原
- [x] 3.3 `delete()` 成功后清空缓存；`save` 抛错时也清空
- [x] 3.4 断言：删除后再次脱敏不复用旧缓存；写盘失败后下一次调用重新读取

## 4. 收尾

- [x] 4.1 同口径复测基准并把改造前后数字写进 design.md
- [x] 4.2 `packages/pi-extension/README.md` 与 `README.en.md` 写明缓存一致性的已知限制
- [x] 4.3 `npm run build` 通过
- [x] 4.4 `npm run test:run` 与 `npm run lint` 通过；离线语义数据下载失败为既有基线

## 5. 审查修复（codex-review）

- [x] 5.1 缓存从「会话实例私有」改为「按 storage + sessionId 共享」，与写入队列同域；避免旧缓存写回覆盖他人映射
- [x] 5.2 `rehydrate()` 与 `delete()` 纳入同一队列，避免已挂起的还原把删除/更新后的状态写回旧版本
- [x] 5.3 跳过写盘的条件加上「已落盘」：首次无 PII 的空映射补写一次，恢复跨实例 `rehydrate()` 契约
- [x] 5.4 缓存记录解出它的密钥，命中前用 `sameKey` 比较；换 key 时回落重新解密并报出 key 不匹配
- [x] 5.5 `createStream()` 传入包装存储，流每次 `save` / `delete` 后失效缓存
- [x] 5.6 补 4 条回归测试：冷缓存无 PII 还原、两实例交替脱敏不覆盖、删除后不复活、换 key 报错
