# Spec Delta

## Purpose

记录层 SHALL 除扩展处理后的上下文外，也保存供应商格式的发送前请求体，并明确其采集边界。

## ADDED Requirements

### Requirement: provider request payload is captured before sending

扩展 SHALL 在宿主触发 `before_provider_request` 时保存该次请求的载荷，作为来源 `provider_request`、范围 `provider-payload` 的独立记录；扩展 SHALL NOT 修改或替换该载荷。

#### Scenario: payload is recorded unchanged

- **WHEN** 宿主触发 `before_provider_request`
- **THEN** 一条请求体记录落盘，载荷与钩子收到的一致，脱敏主流程与请求不受影响

#### Scenario: capture follows record switches

- **WHEN** 记录被关闭或 `includeOriginal` 为 false
- **THEN** 不落盘请求正文，也不产生空白请求体记录

#### Scenario: capture failure is contained

- **WHEN** 载荷无法序列化或写入失败
- **THEN** 只输出一条不含正文的告警，请求照常发送

### Requirement: captured payload is bounded and sanitized

请求体 SHALL 遵循 `maxRecordBytes` 预算，超限时截断并标记；二进制与内嵌图片载荷 SHALL 只保留省略标记。

#### Scenario: oversized payload

- **WHEN** 请求体超过单条预算
- **THEN** 记录被截断并标记为不完整

#### Scenario: embedded image data

- **WHEN** 请求体包含图片数据或 `data:` URL
- **THEN** 只保存省略标记，不保存原始字节

#### Scenario: old records remain readable

- **WHEN** 读取不含请求体字段的旧记录
- **THEN** 列表与详情照常工作，不补造请求体
