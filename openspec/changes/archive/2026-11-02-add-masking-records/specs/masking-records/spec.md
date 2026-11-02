# Spec Delta

## Purpose

让用户逐请求核对本扩展的脱敏结果：哪些内容被拦截、由哪种发现者命中、原始内容与本扩展交给模型的内容差在哪里，并能定位误遮蔽和清理记录。

## ADDED Requirements

### Requirement: per-request masking record

扩展 SHALL 为每次发生上下文处理的宿主事件建立一条请求记录，包含独立 requestId、会话标识、事件类别、时间、处理耗时、命中数、状态与检测完整性标记。

#### Scenario: record per context request
- **WHEN** 一次 `context_with_system` 处理完成
- **THEN** 产生一条带独立 requestId 的请求记录，即使本次没有任何命中

#### Scenario: zero-hit request keeps summary
- **WHEN** 一次请求未命中任何敏感值
- **THEN** 记录仍保留该请求的摘要与零命中状态，不产生对照条目

#### Scenario: record scope is stated honestly
- **WHEN** 展示一条请求记录
- **THEN** 该记录被明确表述为「本扩展处理后的模型输入」，且不包含宿主未提供的供应商、模型或发送结果

### Requirement: related events are distinguished from requests

工具调用前的还原与阻断、回复结束时的还原 SHALL 作为关联事件记录，不得作为独立模型请求，也不得重复计入检测命中。

#### Scenario: tool call blocked is a related event
- **WHEN** 工具调用因参数无法严格还原被阻断
- **THEN** 产生一条关联事件，含阻断原因码且不含参数正文，不增加任何请求的命中数

#### Scenario: message end restore is not a hit
- **WHEN** 回复结束时把占位符还原为真实值
- **THEN** 记为关联事件，不计入命中

#### Scenario: tool result origin is linked
- **WHEN** 工具结果在回填前已脱敏，随后被下一轮请求再度处理
- **THEN** 记录能通过会话、工具调用与字段路径关联到该结果的首次命中

#### Scenario: unknown origin is not guessed
- **WHEN** 无法可靠关联已有命中来源
- **THEN** 记录标记来源未知，不推测原文

### Requirement: hit attribution

每条命中 SHALL 标明发现者类别（规则 / 已知值 / 模型）、稳定的检测器标识、脱敏类型、置信度、偏移、实际替换文本与来源字段路径。归因不得依赖可修改的显示名称。

#### Scenario: rule finder attribution
- **WHEN** 邮箱识别器命中一个地址
- **THEN** 命中记录发现者为规则，检测器标识稳定，类型为邮箱

#### Scenario: known value attribution
- **WHEN** 文本中出现环境文件中的敏感值
- **THEN** 命中记录发现者为已知值，并区分来源是环境文件还是显式配置

#### Scenario: model finder attribution
- **WHEN** 模型发现者命中一个人名
- **THEN** 命中记录发现者为模型，包含服务标识与该次置信度

#### Scenario: only winning hits are recorded
- **WHEN** 多个发现者命中同一段重叠文本
- **THEN** 记录只包含冲突解决后的胜出命中，不保留被丢弃候选的分数

### Requirement: original and output comparison

记录 SHALL 包含字段级对照，给出字段路径、原始文本与本扩展输出文本，并可标注截断。对照 SHALL 只覆盖内容发生变化的字段。

#### Scenario: comparison per changed field
- **WHEN** 一条消息的文本块被脱敏
- **THEN** 该字段产生一条对照，路径指向该文本块，原始文本与输出文本可直接比较

#### Scenario: unchanged fields are not copied
- **WHEN** 请求中包含未发生命中的大段文本
- **THEN** 记录不复制该文本

#### Scenario: line ending normalization keeps original aligned
- **WHEN** 原文包含 CRLF 换行
- **THEN** 对照中的原始文本保持原样，命中偏移与替换文本仍与原文一致

#### Scenario: multibyte text keeps offsets correct
- **WHEN** 文本包含中文或非 BMP 字符
- **THEN** 命中的偏移与截取的原文片段对应正确字符边界

### Requirement: optional original capture

扩展 SHALL 通过可选的诊断采集入口提供记录，默认不采集原文；普通脱敏结果类型 MUST NOT 新增明文原值字段。

#### Scenario: originals off by default
- **WHEN** 用户启用记录但未开启原文保存
- **THEN** 记录只含类型、检测器、占位符、长度与偏移，不含原文或全文对照

#### Scenario: result contract unchanged
- **WHEN** 记录能力开启
- **THEN** 脱敏结果对象与加密映射的既有契约不变

### Requirement: record storage and retention

记录功能 SHALL 默认关闭。启用后 SHALL 写入用户级专用目录，目录权限 0700、文件权限 0600，拒绝符号链接与不安全权限目标，并按保留天数、单记录上限与总容量上限控制占用。

#### Scenario: disabled by default
- **WHEN** 用户未配置记录选项
- **THEN** 不产生记录文件，仅保留既有的脱敏计数日志

#### Scenario: recompute limits on write
- **WHEN** 记录总量超过配置上限
- **THEN** 写入时即执行容量控制，而不是等到下次定时裁剪

#### Scenario: serialized append with bounded queue
- **WHEN** 同一实例短时间内产生大量记录
- **THEN** 追加按顺序执行，队列有界，超限丢弃并告警

#### Scenario: corrupt tail is skipped
- **WHEN** 读取时遇到损坏或被截断的行
- **THEN** 跳过该行并输出不含原文的告警，其余记录可读

#### Scenario: storage failure does not break scrubbing
- **WHEN** 记录目录不可写
- **THEN** 脱敏与请求流程照常完成，只输出一条不含原文的告警

#### Scenario: no disk writes under test
- **WHEN** 扩展在测试环境中运行
- **THEN** 记录只存在于内存，不写入用户目录

### Requirement: record inspection command

扩展 SHALL 提供 `/rehydra log`：默认列出当前会话最近记录摘要，支持按记录标识查看单条详情与按脱敏类型筛选；标识前缀有歧义时明确拒绝。

#### Scenario: list recent records
- **WHEN** 用户执行 `/rehydra log`
- **THEN** 按时间倒序列出当前会话最近若干条记录的标识、时间、事件类别、命中数与耗时

#### Scenario: inspect one record
- **WHEN** 用户指定一个存在的记录标识
- **THEN** 展示命中列表与字段级对照，长文本分段展示并标注截断

#### Scenario: reload after restart
- **WHEN** 用户在新会话中查看历史记录
- **THEN** 能从磁盘读取既有记录

#### Scenario: ambiguous prefix
- **WHEN** 用户给出的标识前缀匹配多条记录
- **THEN** 返回歧义提示并列出候选标识，不任选一条展示

#### Scenario: unknown record id
- **WHEN** 用户指定的标识不存在
- **THEN** 返回未找到提示，不抛出异常

#### Scenario: filter by type
- **WHEN** 用户指定一个脱敏类型
- **THEN** 只展示包含该类型命中的记录

#### Scenario: terminal output is escaped
- **WHEN** 记录中的原文包含终端控制字符
- **THEN** 展示时进行转义，且原文不会回填到模型上下文或普通日志

### Requirement: record clearing

扩展 SHALL 提供 `/rehydra clear` 删除记录，默认只清理当前会话，`--all` 清理全部，两者均要求确认；清理 SHALL NOT 影响 PII 还原映射。

#### Scenario: clear requires confirmation
- **WHEN** 用户执行清理但未确认
- **THEN** 不删除任何文件，记录保持不变

#### Scenario: clear current session
- **WHEN** 用户确认清理当前会话
- **THEN** 该会话的记录被删除，其他会话记录保留

#### Scenario: clear all
- **WHEN** 用户确认执行清理全部
- **THEN** 记录文件与内存记录一并清除

#### Scenario: rehydration map survives
- **WHEN** 记录被清理
- **THEN** 会话仍然可以把占位符还原为真实值

### Requirement: records disabled leaves behavior unchanged

关闭记录功能时，脱敏、阻断、还原与标签语义 SHALL 与本变更前完全一致。

#### Scenario: masking unchanged when records off
- **WHEN** 记录功能关闭且请求中包含敏感值
- **THEN** 交给模型的内容与启用记录时相同，仅缺少记录产物
