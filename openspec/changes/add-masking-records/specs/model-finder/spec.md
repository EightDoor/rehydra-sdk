# Spec Delta

## Purpose

让自部署的 NER 服务作为独立的模型发现者参与脱敏，约定协议校验、失败降级与阻断行为，使模型不可用时不会静默降低保护强度。

## ADDED Requirements

### Requirement: model finder is opt-in and trusted

模型发现者 SHALL 默认关闭，只向用户显式配置的自部署服务发送待检测原文；非回环地址 MUST 使用 HTTPS，且不得自动跟随跨源重定向。

#### Scenario: disabled by default
- **WHEN** 用户未配置 NER
- **THEN** 脱敏只使用规则与已知值发现者，记录中不出现模型命中

#### Scenario: plaintext leaves the machine only when configured
- **WHEN** 用户显式启用远端 NER 并给出服务地址
- **THEN** 待检测文本按既有预测协议发送给该服务，且该行为在文档中明确说明

#### Scenario: insecure endpoint is rejected
- **WHEN** 用户把非回环地址配置为 HTTP
- **THEN** 配置被拒绝并给出可读错误，不发起请求

### Requirement: supported entity types are bounded

模型发现者 SHALL 只承诺协议已映射的实体类型；未映射类型 MUST 被忽略而不是猜测。

#### Scenario: unmapped type is dropped
- **WHEN** 服务返回协议未映射的实体类型
- **THEN** 该实体不产生占位符，也不出现在记录中

#### Scenario: credential detection stays with rules
- **WHEN** 文本包含凭证类敏感值但未配置规则之外的能力
- **THEN** 凭证仍由规则与已知值发现者处理，模型发现者不宣称覆盖凭证

### Requirement: response validation

模型响应 SHALL 校验结构、类型、置信度范围、跨度合法性与对应文本；不一致 MUST 视为协议错误，不得据此替换任何文本。

#### Scenario: span out of range is rejected
- **WHEN** 服务返回的跨度超出文本边界或逆序
- **THEN** 本次响应按协议错误处理，不产生占位符

#### Scenario: mismatched text is rejected
- **WHEN** 服务返回的实体文本与跨度对应的原文不一致
- **THEN** 该实体被丢弃并记录协议错误

#### Scenario: malformed body is rejected
- **WHEN** 响应缺少必需字段或类型错误
- **THEN** 本次响应按协议错误处理，不据此替换任何文本

### Requirement: threshold filtering

模型返回的实体 SHALL 按类型的置信度阈值过滤，低于阈值的实体不得进入命中与标签。

#### Scenario: below threshold is dropped
- **WHEN** 模型以低于该类型阈值的置信度返回一个实体
- **THEN** 该实体不产生占位符，也不出现在记录中

#### Scenario: threshold overridden per type
- **WHEN** 用户为某类型配置了更高阈值
- **THEN** 该类型只保留达到新阈值的实体

### Requirement: failure handling in the core detection stage

模型加载、预测失败或超时 SHALL 在核心检测阶段统一处理，对扩展的每个宿主事件生效，而不是只在单个事件处理器内兜底。

#### Scenario: failure applies to every host event
- **WHEN** 模型不可用且有工具结果需要脱敏
- **THEN** 该路径同样按既定失败策略处理，不存在绕过处理的入口

#### Scenario: per-event budget
- **WHEN** 同一次宿主事件内有多个字段需要检测
- **THEN** 这些字段共享该事件的模型时间预算，预算耗尽后本次剩余字段只走规则，下个事件可重试

#### Scenario: no automatic retry storm
- **WHEN** 模型连续失败
- **THEN** 不发起额外重试循环，只按固定频率告警

### Requirement: degradation is explicit

默认失败策略 SHALL 降级为规则检测并标记检测不完整；用户可改为失败即阻断。

#### Scenario: degrade to rules and mark incomplete
- **WHEN** 模型超时或不可用且策略为降级
- **THEN** 请求继续，规则与已知值命中仍被脱敏，记录标记为仅规则且注明失败原因

#### Scenario: explicit block
- **WHEN** 用户配置模型不可用即阻断
- **THEN** 请求被拒绝并返回可读错误，记录标记载荷未发出及原因

#### Scenario: cancellation is not degradation
- **WHEN** 宿主取消本次请求
- **THEN** 处理随取消结束，不按降级路径继续发送

#### Scenario: degradation risk is documented
- **WHEN** 用户查阅文档
- **THEN** 明确说明降级期间模型独有实体可能漏检

### Requirement: model hits are attributed separately

由模型发现的命中 SHALL 与规则、已知值命中在记录中区分，包含服务标识与该次置信度；重叠命中以既有冲突解决策略为准。

#### Scenario: overlapping rule and model hit
- **WHEN** 同一段文本同时被规则和模型命中
- **THEN** 只产生一个占位符，记录的发现者按既有优先级为规则，且不保留被丢弃的模型分数
