# Proposal

## Why

Pi 扩展每轮请求都会重扫整段历史。每个字符串各走一次 `session.anonymize()`，而每次调用都要 `storage.load()` → `decryptPIIMap()` → 脱敏 → 合并 → `encryptPIIMap()` → `storage.save()`。历史越长、映射越大，重复的解密与写盘越多；即使本轮没有任何新实体，也要完整走一遍加解密与保存。

这项开销随会话长度线性叠加，而绝大多数轮次只新增极少或零个实体。

## What Changes

- 在会话内缓存已解密的映射，避免每个字符串重复解密同一份数据。
- 本轮没有新增实体时跳过重新加密与写盘。
- 先建可复现的基准，改造后同口径对比；没有实测数字前不做提速宣称。
- 缓存不得改变脱敏结果：同一段文本连续脱敏两次，第二次结果与第一次逐字节相同。

## Capabilities

### New Capabilities

- `session-map-caching`：会话内 PII 映射的缓存与写盘抑制规则，以及它们必须保持的可观测行为。

### Modified Capabilities

（无）

## Impact

- 修改 `src/storage/session-base.ts`：会话内解密缓存、无变更跳过写盘。
- 新增 `test/benchmark/session-long-history.bench.ts` 与对应的正确性回归测试。
- 不改 `PIIStorageProvider` 接口、不改 `AnonymizerSession` 公开形状、不改占位符格式。
- 缓存失效边界：`delete()` 之后必须丢弃缓存，否则会读到已删除的映射。
- 已知限制：非本会话的其他进程/实例改写同一存储键时，本进程缓存不会自动失效。这与当前"每轮重新读取"的行为不同，需在文档与注释中写明。
