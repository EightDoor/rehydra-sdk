# Proposal

## Why

本机查看页面已经能落盘完整的脱敏前后快照，但页面只有在列表底部点击记录后才把详情渲染到页尾，长内容被压成一行 JSON，容易被当成"看不到内容"。同时现有记录只覆盖扩展处理后的上下文，用户无法核对供应商序列化后真正准备发送的请求体。

## What Changes

- 页面改为浅色调试工作台：桌面端左侧记录列表、右侧固定详情，默认选中首条记录，保留筛选与分页。
- 详情按记录类型展示：上下文记录并排展示脱敏前后快照与命中明细；供应商请求记录展示发送前请求体。
- 内容区提供换行开关、查找与显式复制；补齐加载中、空列表、加载失败、未保存原文、截断等状态。
- 新增 `before_provider_request` 采集：把供应商格式的请求体作为独立来源的记录落盘，仅观察不改写载荷。
- 请求体采集遵循现有 `record.enabled` 与 `includeOriginal`；不采集请求头与凭证，二进制载荷只留省略标记。

## Capabilities

### New Capabilities
无。

### Modified Capabilities
- `masking-viewer`: 详情布局、记录类型化展示、内容工具与状态提示。
- `masking-records`: 新增发送前请求体记录的来源、范围与采集边界。

## Impact

- 改动：`src/records/viewer/page.ts`、`src/records/types.ts`、`src/records/snapshot.ts`、`src/pi-extension/host-types.ts`、`src/pi-extension/extension.ts`。
- 测试：`test/records/viewer.test.ts`、`test/records/snapshot.test.ts`、`test/records/extension-records.test.ts`、`test/pi-extension/extension.test.ts`。
- 依赖：不新增；继续使用宿主现成的 `before_provider_request` 钩子与内联页面。
- 存储：不新增表结构，记录仍以 JSON payload 保存；旧记录继续可读。
