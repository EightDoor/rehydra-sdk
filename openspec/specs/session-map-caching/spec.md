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

任何删除映射的公开路径完成后，会话 SHALL 丢弃对应缓存，MUST NOT 继续用已删除的映射服务后续调用。写盘失败时同样丢弃缓存。

#### Scenario: deleted session does not serve stale data

- **WHEN** 会话被删除后再次脱敏
- **THEN** 不会复用删除前的缓存内容

#### Scenario: write failure clears cache

- **WHEN** 一次写盘失败
- **THEN** 该会话的缓存被丢弃，后续调用重新从存储读取

#### Scenario: provider-level delete clears cache

- **WHEN** 调用方直接通过存储提供者删除某个会话的映射
- **THEN** 该会话的缓存被丢弃
- **AND** 之后的还原不再返回已删除的原值

#### Scenario: provider-level cleanup clears affected cache

- **WHEN** 调用方通过存储提供者批量清理过期的映射
- **THEN** 受该存储影响的缓存被丢弃

### Requirement: cache is not refilled with a stale snapshot

读取映射的过程若期间发生过缓存失效，会话 SHALL NOT 把读到的旧快照写回缓存。

#### Scenario: external write during read

- **WHEN** 一次还原在读取存储期间，流式脱敏写入了新的映射
- **THEN** 该次还原不会把读到的旧映射写回缓存
- **AND** 后续脱敏与还原基于新的映射

#### Scenario: streaming write does not interleave with a running operation

- **WHEN** 流式脱敏保存映射，同时有脱敏或还原正在进行
- **THEN** 两者串行执行，不存在旧快照覆盖新映射的窗口

### Requirement: cached key is a snapshot

缓存 SHALL 保存密钥的独立副本，MUST NOT 持有密钥提供者返回的数组引用。

#### Scenario: mutating the key array in place

- **WHEN** 调用方原地修改密钥提供者返回的数组
- **THEN** 缓存不再与之匹配，后续操作重新解密并暴露密钥不匹配

### Requirement: tracked session state is bounded

单个存储实例上保留的会话状态条目 SHALL 有上限；超出时 SHALL 回收空闲条目，MUST NOT 回收正在排队或执行中的条目。

#### Scenario: many distinct sessions

- **WHEN** 同一存储上先后出现远多于上限的会话 ID
- **THEN** 会话状态条目数不超过上限

#### Scenario: evicted session still works

- **WHEN** 某会话的状态条目已被回收
- **THEN** 该会话之后的脱敏与还原仍然正确，只是重新从存储读取

### Requirement: streaming save does not delete persisted entries

流式脱敏保存映射时 SHALL 与存储里的最新映射合并，MUST NOT 用创建流时的快照整体
覆盖已落盘的条目。

#### Scenario: concurrent anonymize during an open stream

- **WHEN** 流尚未结束时，同一会话上的普通脱敏写入了新条目
- **THEN** 流保存后这些新条目仍然存在
- **AND** 普通脱敏返回的占位符仍能还原出原值

#### Scenario: baseline entries survive stream save

- **WHEN** 流的输出中只包含创建流之前就已存在的实体
- **THEN** 流结束时这些基线条目仍然存在

#### Scenario: key rotation during stream

- **WHEN** 流的生命周期内加密密钥被更换
- **THEN** 保存失败并把错误抛给调用方，不会退化成只写流自身的映射
