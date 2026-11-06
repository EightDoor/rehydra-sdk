# Spec Delta

## ADDED Requirements

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
