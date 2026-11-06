# Proposal

## Why

Pi 扩展的脱敏只覆盖 `user` / `assistant` / `toolResult` 三种消息角色，但宿主在构造模型请求时还会把 `system`、`bashExecution`、`custom`、`branchSummary`、`compactionSummary` 一起转成文本发出。结果是：系统提示里的自由文本段、用户在会话里执行命令的输出、扩展消息与摘要文本都能绕过脱敏直接抵达模型。

同时，扩展对"脱敏失败"的处理建立在错误前提上——代码注释认为抛出异常会让宿主停在本次请求，但宿主实际只记录错误并继续用未脱敏的内容发请求；同时 `session_start` 初始化失败时 `tool_call` 直接放行，工具会拿到带占位符的参数。

## What Changes

- 补齐模型请求路径上的角色覆盖：`system` 消息的自由文本段、`bashExecution` 的命令与输出、`custom` 的内容、两类摘要的摘要文本都纳入脱敏。
- 让已计算但从未使用的 rehydra 指令真正送达模型，使占位符在模型侧被当作不可解析的透传值。
- 明确脱敏失败语义：初始化失败时阻断工具执行；单次脱敏失败不阻断模型请求，但产出可定位的告警。
- 修正扩展注释中"宿主会停在该请求"的失效假设。

## Capabilities

### New Capabilities

- `pi-extension-coverage`：Pi 扩展在模型请求路径上的消息角色脱敏覆盖范围、占位符说明的送达方式，以及脱敏失败时的阻断与告警语义。

### Modified Capabilities

（无：本项目 `openspec/specs/` 目前为空，两个已归档 change 的能力尚未同步为主规格。）

## Impact

- 修改 `src/pi-extension/extension.ts`：角色到脱敏结构的映射与回写、脱敏指令注入、初始化失败状态与工具阻断、失败告警。
- 修改 `src/pi-extension/host-types.ts`：补齐本地宿主类型里缺失的消息角色字段。
- 修改 `src/host-agnostic/scrub.ts`：让共享脱敏核心能处理角色自定义的字符串字段。
- 行为变化：脱敏覆盖范围扩大（更多内容被替换为占位符）；初始化失败时工具调用会被阻断而非放行。
- 不引入新依赖，不改公开配置项，不改 `/rehydra` 命令语义。
- 自动压缩与摘要路径不在本变更范围内：它不经过 `context_with_system`，原始消息会被序列化发往模型。该风险单独立项处理。
