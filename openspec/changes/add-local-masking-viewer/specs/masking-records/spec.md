# Spec Delta

## Purpose

让用户逐请求核对本扩展的脱敏结果：扩展收到什么、扩展输出什么、哪些内容被拦截、失败时是否放行，并在本机网页中直接对照原文与脱敏结果。

## ADDED Requirements

### Requirement: per-request masking record

扩展 SHALL 为每次发生上下文处理的宿主事件建立一条记录，包含记录标识、会话标识、事件类别、时间、处理耗时、命中数、阻断标记、检测完整性标记与状态。

#### Scenario: record per context request

- **WHEN** 一次 `context_with_system` 处理完成
- **THEN** 产生一条记录，即使本次没有任何命中

#### Scenario: record scope is stated honestly

- **WHEN** 展示一条记录
- **THEN** 该记录被明确表述为「本扩展处理后的模型输入」，且不包含宿主未提供的供应商、模型或发送结果

### Requirement: related events are distinguished from requests

工具调用前的还原与阻断、回复结束时的还原 SHALL 作为关联事件记录，不得作为独立模型请求，也不得重复计入检测命中。

#### Scenario: tool call blocked is a related event

- **WHEN** 工具调用因参数无法严格还原被阻断
- **THEN** 产生一条关联事件，含阻断原因码且不含参数正文，不增加任何请求的命中数

#### Scenario: message end restore is not a hit

- **WHEN** 回复结束时把占位符还原为真实值
- **THEN** 记为关联事件，不计入命中

### Requirement: hit attribution

每条命中 SHALL 标明发现者类别（规则 / 已知值 / 模型）、稳定的检测器标识、脱敏类型、长度、偏移、实际替换文本与来源字段路径。归因不得依赖可修改的显示名称。

#### Scenario: rule finder attribution

- **WHEN** 邮箱识别器命中一个地址
- **THEN** 命中记录发现者为规则，检测器标识稳定，类型为邮箱

#### Scenario: model finder attribution

- **WHEN** 模型发现者命中一个人名
- **THEN** 命中记录发现者为模型，包含服务标识

### Requirement: complete text snapshot

记录 SHALL 保存完整文本快照：扩展在处理前实际收到的内容，以及扩展实际交给宿主的内容；快照 SHALL 覆盖未命中的字段，并保留消息角色、块顺序与工具参数结构。

#### Scenario: unchanged fields are visible

- **WHEN** 请求中包含未发生命中的大段文本
- **THEN** 该文本仍出现在快照的扩展输入侧

#### Scenario: tool result original text is kept

- **WHEN** 工具结果在回填给模型前被脱敏
- **THEN** 记录同时保存该结果的原始文本与脱敏后的文本

#### Scenario: binary payloads are not stored

- **WHEN** 消息中包含图片等二进制载荷
- **THEN** 快照用占位标记代替该载荷，不写入其内容

#### Scenario: snapshot is bounded and declares truncation

- **WHEN** 快照超过单条记录预算
- **THEN** 快照被截断并标记为不完整，展示时明确说明内容不完整

### Requirement: record storage and retention

记录 SHALL 落 SQLite，存放在用户级专用目录，目录权限 0700、数据库文件权限 0600，拒绝符号链接与不安全权限目标，并按保留天数、单条上限与总容量上限控制占用。

#### Scenario: records are persisted by default

- **WHEN** 用户未显式配置记录选项
- **THEN** 记录仍然写入 SQLite，且保存原文与完整快照

#### Scenario: original capture can be turned off

- **WHEN** 用户配置 `includeOriginal: false`
- **THEN** 记录只含类型、检测器、占位符、长度与偏移，不含任何前后文本快照

#### Scenario: recompute limits on write

- **WHEN** 记录总量超过配置上限
- **THEN** 写入时即执行容量控制，而不是等到下次定时裁剪

#### Scenario: storage failure does not break scrubbing

- **WHEN** 记录目录不可写或 SQLite 驱动不可用
- **THEN** 脱敏与请求流程照常完成，只输出一条不含原文的告警，并在页面状态区显示存储异常

#### Scenario: no disk writes under test

- **WHEN** 扩展在测试环境中运行
- **THEN** 记录只写到测试指定的目录，不写入用户目录

### Requirement: record clearing

记录 SHALL 可被清理：清理当前会话或清理全部，两者都要求确认；清理 SHALL NOT 影响 PII 还原映射。

#### Scenario: clear requires confirmation

- **WHEN** 用户发起清理但未确认
- **THEN** 不删除任何记录，记录保持不变

#### Scenario: clear current session

- **WHEN** 用户确认清理当前会话
- **THEN** 该会话的记录被删除，其他会话记录保留

#### Scenario: clear all

- **WHEN** 用户确认执行清理全部
- **THEN** 全部记录被删除

#### Scenario: rehydration map survives

- **WHEN** 记录被清理
- **THEN** 会话仍然可以把占位符还原为真实值

### Requirement: masking failure is visible in records

脱敏失败并按现有策略放行时，扩展 SHALL 记录该次事件的实际输入与输出，并把失败标记在记录上，使查看者能识别出未被脱敏的请求。

#### Scenario: failed request is recorded and flagged

- **WHEN** 脱敏过程中抛出异常，请求按现有策略照常发出
- **THEN** 产生一条带失败标记的记录，保存该次请求的实际输入与输出

#### Scenario: degraded detection is flagged

- **WHEN** 模型检测不可用而降级为规则
- **THEN** 记录的完整性标记为降级，查看者可据此判断检测覆盖不完整

### Requirement: records disabled leaves behavior unchanged

关闭记录功能时，脱敏、阻断、还原与标签语义 SHALL 与关闭前完全一致。

#### Scenario: masking unchanged when records off

- **WHEN** 记录功能关闭且请求中包含敏感值
- **THEN** 交给模型的内容与启用记录时相同，仅缺少记录产物
