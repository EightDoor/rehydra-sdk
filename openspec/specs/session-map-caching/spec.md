# session-map-caching Specification

## Purpose
规定会话内 PII 映射的缓存与写盘抑制规则：在不改变脱敏输出与还原结果的前提下，避免重复解密与无谓写盘。

## Requirements

### Requirement: repeated decryption is avoided within a session

同一会话实例在连续脱敏之间 SHALL 复用已解密的映射，MUST NOT 为每个字符串重新解密同一份数据。

#### Scenario: many strings reuse one decryption

- **WHEN** 同一会话实例对同一份历史连续脱敏多次
- **THEN** 已解密映射被复用，脱敏结果与不缓存时逐字节相同

#### Scenario: new entity still gets a new id

- **WHEN** 缓存生效期间出现一个此前未见过的新实体
- **THEN** 该实体获得新的占位符 ID，且不与他人重复

### Requirement: unchanged maps are not written back

本次脱敏没有产生新增或变更的映射条目时，会话 SHALL 跳过重新加密与写盘。

#### Scenario: no new entity means no write

- **WHEN** 一次脱敏没有引入任何新实体
- **THEN** 该次调用不触发重新加密与写盘

#### Scenario: new entity is persisted

- **WHEN** 一次脱敏引入了新实体
- **THEN** 更新后的映射被写入存储，之后可通过还原读回该实体

### Requirement: cache is invalidated by destructive operations

删除会话后，会话 SHALL 丢弃缓存，MUST NOT 继续用已删除的映射服务后续调用。写盘失败时同样丢弃缓存。

#### Scenario: deleted session does not serve stale data

- **WHEN** 会话被删除后再次脱敏
- **THEN** 不会复用删除前的缓存内容

#### Scenario: write failure clears cache

- **WHEN** 一次写盘失败
- **THEN** 该会话的缓存被丢弃，后续调用重新从存储读取
