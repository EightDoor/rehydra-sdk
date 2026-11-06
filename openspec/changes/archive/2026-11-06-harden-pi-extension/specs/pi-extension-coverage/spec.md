# Spec Delta

## Purpose

规定 Pi 扩展在模型请求路径上对各类消息角色的脱敏覆盖范围、占位符说明送达模型的方式，以及脱敏失败与初始化失败时的阻断与告警语义。

## ADDED Requirements

### Requirement: every model-bound message role is masked

Pi 扩展 SHALL 对宿主会转成模型输入的全部消息角色执行脱敏，覆盖范围 MUST 与宿主的角色转换行为一致；SHALL NOT 出现"某些角色的内容原样进入模型请求"的情况。

#### Scenario: system prompt sections are masked

- **WHEN** 请求上下文中的 system 消息的自由文本段含有可识别为 PII 的值
- **THEN** 该段内容被替换为占位符标签
- **AND** 该 system 消息仍然位于消息列表首位，且其工具声明字段未被改动

#### Scenario: tool declarations are left intact

- **WHEN** system 消息的工具声明段含有形似 PII 的示例值
- **THEN** 该段内容不被替换

#### Scenario: command output is masked

- **WHEN** 会话中执行过的命令记录含有可识别为 PII 的值
- **THEN** 命令与输出中的该值都被替换为占位符标签

#### Scenario: extension messages are masked

- **WHEN** 上下文中的扩展消息含有可识别为 PII 的值
- **THEN** 其正文被替换为占位符标签

#### Scenario: summary text is masked

- **WHEN** 上下文中的分支摘要或压缩摘要含有可识别为 PII 的值
- **THEN** 摘要正文被替换为占位符标签

#### Scenario: masking does not alter message shape

- **WHEN** 任一角色的消息完成脱敏
- **THEN** 消息的字段结构、块类型与顺序保持不变，仅字符串内容被替换

### Requirement: placeholder guidance reaches the model

当一轮请求中实际产生了脱敏替换时，扩展 SHALL 让模型看到占位符的使用说明，使占位符被当作不可解析的透传值；未产生替换时 MUST NOT 注入该说明。

#### Scenario: guidance present when masking happened

- **WHEN** 本轮请求中至少有一处内容被替换为占位符
- **THEN** 模型的系统提示中包含占位符的使用说明

#### Scenario: guidance absent when nothing was masked

- **WHEN** 本轮请求中没有产生任何替换
- **THEN** 模型的系统提示中不包含占位符的使用说明

### Requirement: masking failure is reported without blocking the request

单次脱敏失败时，扩展 SHALL 保留该内容的原有形态继续处理本次请求，并 SHALL 记录一条可定位的告警；告警 MUST NOT 包含被脱敏的正文。

#### Scenario: failure keeps request alive and logs

- **WHEN** 脱敏过程中发生异常
- **THEN** 该次请求照常发出，不抛出异常终止扩展处理
- **AND** 产生一条标明失败位置的告警日志，且日志不含原文正文

#### Scenario: failure does not leak content into the log

- **WHEN** 脱敏失败并记录告警
- **THEN** 告警内容中不出现原始 PII 值

### Requirement: uninitialized extension blocks tool execution

扩展初始化失败时，扩展 SHALL 阻止工具调用执行，并 SHALL 给出说明原因；MUST NOT 让工具在缺少脱敏映射的情况下运行。

#### Scenario: tool call is blocked after failed initialization

- **WHEN** 扩展初始化失败后收到一次工具调用
- **THEN** 该次工具调用被阻止
- **AND** 返回的原因说明扩展未初始化

#### Scenario: tool call proceeds after successful initialization

- **WHEN** 扩展初始化成功后收到一次工具调用
- **THEN** 该次工具调用不被阻止
