# Design

## Context

- 脱敏集中在 `src/host-agnostic/scrub.ts`：逐 part 调用 `session.anonymize()`，成功后回写，失败由宿主 fail-closed。
- `AnonymizationResult.entities` 已剥离 `original`；原文只存在于加密 PII map 与 `tagEntities` 内部。
- `SpanMatch` 只有 `type / start / end / confidence / source(REGEX|NER)`，无法归因到具体检测器。
- `anonymize()` 先用 `prenormalize()` 把 CRLF 归一为 LF，因此规范化文本的偏移与原始文本不总一致。
- `tool_result` 在回填前就调用 `session.anonymize()`；同一段内容进入下一轮 `context_with_system` 时只剩占位符。
- Pi 侧事件：`context_with_system`、`tool_call`、`tool_result`、`message_end`；扩展 UI 只有 `ctx.ui.notify`，`/rehydra` 已存在且 handler 收到字符串 `args`。
- 远端 NER 已有 `/health` 与 `/v1/predict` 协议，配置字段为 `backend: "inference-server"`、`inferenceServerUrl`、`inferenceServerTimeout`；类型映射只有 PERSON / ORG / LOCATION。
- `policyFromOptions()` 与 `DEFAULT_DISABLE_TYPES` 只被 Pi 扩展使用；SDK 的 `createDefaultPolicy()` 是另一条路径。

## Goals / Non-Goals

**Goals:**

- 逐请求给出可核对的清单：命中类型、发现者、占位符、原文与本扩展输出文本的差异。
- 归因稳定，不依赖可改名的显示字符串。
- 模型检测的隐私边界与失败语义明确，不让降级悄悄发生。

**Non-Goals:**

- 不实现 GUI、网络抓包、供应商实际报文比对。
- 不保留被冲突解决丢弃的候选证据。
- 不做记录的上传或跨机器同步。

## Decisions

### 请求边界是 `context_with_system`，其余是关联事件

一次 `context_with_system` = 一条请求记录，携带 `requestId`。`tool_result` 的首次脱敏写入一份来源表（会话 + 工具调用 + 字段路径 → 命中集合），后续请求按同一路径匹配来源；匹配不到就标 `origin: "unknown"`。

`tool_call` 的还原/阻断与 `message_end` 的还原记为 `relatedEvents`，不增加 `masked` 计数。

备选：把每次 `anonymize()` 调用都当一条请求。否决原因：一次请求内有几十个字段，用户无法按请求核对。

### 记录只声称「本扩展处理后的模型输入」

宿主不暴露供应商请求体与发送状态，因此 `MaskingRecord.scope` 固定为 `model-input`，不写 `provider` / `model` / `sent` 字段。

备选：从会话配置推断供应商。否决原因：推断值写进记录会被当成事实，审计时无法分辨。

### 归因用稳定 detectorId，同时保留可读名

`SpanMatch` / `DetectedEntity` 增加可选 `recognizer?: string`（稳定标识，如 `email`、`literal-env`、`inference-server`），`RecognizerRegistry.findAll()` 填充。显示名单独由 records 层的映射表提供，改名不影响已落盘记录的归因。

发现者类别由 `source` + detectorId 派生，不新增冗余字段：

| 条件 | finder |
| --- | --- |
| `source === REGEX` 且 detectorId 属于已知值检测器 | `known` |
| `source === REGEX` 其余 | `rule` |
| `source === NER` | `model` |

### 原文通过开放诊断采集入口获取，默认关闭

`Anonymizer.anonymize()` 增加可选第 5 参数 `observer?: PiiObserver`，在替换发生处回调 `{ type, recognizer, start, end, replaced, original? }`。`original` 只在 observer 声明需要且记录开启原文时填充。

这样 `AnonymizationResult` 与加密映射的契约不变，原文不通过公开结果扩散。

备选：在结果里加 `entities[].original`。否决原因：那会把明文原值扩散到所有调用方与潜在日志。

### 偏移以原始文本为准

`prenormalize()` 只处理 CRLF。observer 报告的偏移在规范化文本空间，records 层按 `createLineEndingMapping()` 折算回原始文本再切片，避免 CRLF 文本里原文片段错位。

备选：直接把规范化文本当原文。否决原因：对照就不是用户看到的文本了。

### 对照只记录变化字段，另有硬上限

`scrubString` 在 before ≠ after 时产出一条 `comparison`。单条记录对照总字节上限 256 KiB，超出逐字段截断并标 `truncated: true`，不宣称完整对照。

### 存储用按天追加文件 + 有界队列

目录 `~/.pi/agent/rehydra/records`（0700），文件 `YYYY-MM-DD.jsonl`（0600）。多实例并发时文件名带实例后缀避免交错写。

- 追加走单实例串行 promise 链，队列上限 200 条，超出丢弃并告警一次。
- 每次写入后检查总量（天数 + 字节），超限立即删除最旧文件，不依赖定时器。
- 打开前用 `lstat` 拒绝符号链接；`mkdir` 后校验目录权限，不安全则拒绝写入并告警。
- 读取时逐行 `JSON.parse`，失败的尾行跳过并告警（不含原文）。

备选：复用 `PIIStorageProvider`。否决原因：那是加密 PII map 存储，语义与清理策略不同。

### 记录标识可读且可前缀匹配

`recordId = <unix-ms>-<实例序号>`，`/rehydra log <prefix>` 支持唯一前缀；多命中时列出候选并拒绝执行。

### 模型失败在核心检测阶段处理

`Anonymizer` 的 NER 步骤包一层策略：`nerFailure: "rules" | "block"`（Pi 侧默认 `rules`，SDK 未配置时保持现有抛错行为）。

- 失败或超时 → 追加 `{ finder: "model", code }` 到本次检测的 `errors`，`nerMatches = []`，继续走 resolver。
- 每次宿主事件由 extension 传入 `deadline`，同事件的多个字段共享剩余预算（默认 5000 ms）；耗尽即按失败处理。
- `AbortSignal` 取消 → 直接抛出，不进入降级路径。
- 告警按服务地址限频：每分钟至多一条。

备选：在 `context_with_system` 的 try/catch 里兜底。否决原因：`tool_result` 直接调 `anonymize()`，会绕过。

### 模型端点与响应校验

`inference-server-client` 增加：

- 非回环 URL 必须 `https:`，否则配置阶段报错。
- `fetch(..., { redirect: "error" })`，不跟随重定向。
- 响应逐实体校验：类型已映射、`0 <= confidence <= 1`、`0 <= start < end <= text.length`、`text.slice(start, end) === entity.text`；任一不符则该实体丢弃并记 `protocol-error`。
- 错误信息只带状态码与类别，不回显响应正文。

## Risks / Trade-offs

- [记录文件是新的明文落点] → 默认关闭；开启后 0600 + 目录 0700 + 符号链接拒绝 + `clear`；文档写明开启即写真实值到本地磁盘。
- [降级期间模型独有实体漏检] → 记录与日志都标 `rules-only`，README 单列一段风险说明；需要强保证的用户可配 `block`。
- [每次字段都过 observer 有性能成本] → observer 未注册时零开销；注册后只做对象构造，不做序列化，序列化留在记录层。
- [对照占内存] → 单记录 256 KiB 上限 + 只记变化字段；超限截断并标记。
- [按天文件多实例交错] → 文件名带实例后缀，读取时合并同一天的多个文件。
- [前缀匹配歧义] → 拒绝并列出候选，不猜。

## Migration Plan

无数据结构迁移。新增配置默认关闭，旧配置行为不变。回滚只需移除 `record` 配置与 `nerFailure` 配置，记录文件可保留或删除。

## Open Questions

无。
