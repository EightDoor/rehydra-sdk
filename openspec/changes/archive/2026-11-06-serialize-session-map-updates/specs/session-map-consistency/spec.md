# Spec Delta

## Purpose

规定同一会话的 PII 映射在并发读写下的可见性与一致性：并发脱敏不得互相覆盖、不得给不同实体分配同一个占位符 ID，且不同会话之间不得相互阻塞。

## ADDED Requirements

### Requirement: concurrent anonymization in one session is serialized

同一存储实例上针对同一会话 ID 的脱敏写入 SHALL 串行执行；任一写入完成前 MUST NOT 有另一次写入读到旧的映射快照。

#### Scenario: parallel calls get distinct ids

- **WHEN** 同一会话被并发发起多次脱敏，每次含不同的实体值
- **THEN** 每个实体获得互不相同的占位符 ID
- **AND** 最终映射同时包含全部实体的条目，没有条目被覆盖丢失

#### Scenario: each placeholder restores its own value

- **WHEN** 并发脱敏完成后按 ID 还原每个占位符
- **THEN** 每个占位符还原为它自己对应的原值，不会还原成另一个实体的值

#### Scenario: repeated value keeps one id

- **WHEN** 同一实体的同一个值在并发调用中的多次出现
- **THEN** 这些出现复用同一个占位符 ID

### Requirement: different sessions do not block each other

针对不同会话 ID 的脱敏 MUST NOT 因彼此而排队等待。

#### Scenario: separate sessions proceed independently

- **WHEN** 两个不同会话 ID 同时发起脱敏
- **THEN** 两者的结果都正确，且任一方的等待不依赖另一方完成

### Requirement: a failed write does not stall later writes

某次脱敏失败时，扩展 SHALL 把错误返回给该次调用方，且 SHALL NOT 让后续针对同一会话的脱敏永久等待。

#### Scenario: failure is isolated to its own call

- **WHEN** 同一会话上的一次脱敏失败
- **THEN** 该次调用收到错误
- **AND** 之后发起的脱敏仍能正常完成
