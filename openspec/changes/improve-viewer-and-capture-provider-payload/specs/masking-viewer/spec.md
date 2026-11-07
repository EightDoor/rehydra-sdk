# Spec Delta

## Purpose

查看页面 SHALL 让用户在打开后立即看到脱敏处理的实际内容，并按记录类型给出可读的详情。

## ADDED Requirements

### Requirement: viewer serves the records for comparison

页面 SHALL 展示记录列表、会话/来源/类型/状态筛选、分页，以及单条记录的详情；详情 SHALL 按记录类型展示，并 SHALL 在打开页面时默认展示当前页首条记录。

#### Scenario: list and filter

- **WHEN** 用户打开页面
- **THEN** 页面列出记录并可按会话、来源、类型与状态筛选，列表可分页

#### Scenario: detail is visible without scrolling

- **WHEN** 页面加载完成且当前页有记录
- **THEN** 首条记录的详情立即可见，选中项在列表中高亮

#### Scenario: side by side comparison

- **WHEN** 用户打开一条上下文记录
- **THEN** 页面并排展示扩展收到的内容与扩展输出的内容，并可切换自动换行

#### Scenario: hit details are shown

- **WHEN** 记录包含命中或字段级对照
- **THEN** 页面列出命中类型、发现方式、检测器、占位符与原值，以及字段路径的前后对照

#### Scenario: provider payload is labeled

- **WHEN** 用户打开一条发送前请求体记录
- **THEN** 页面展示请求体，并标明它是发送前钩子采集、后续扩展可能改写、不代表网络发送成功

#### Scenario: failed or degraded requests are marked

- **WHEN** 记录带失败标记或降级标记
- **THEN** 页面明确标出该记录的处理状态

#### Scenario: content tools

- **WHEN** 用户在内容区使用查找或复制
- **THEN** 匹配内容被高亮，复制结果与展示文本一致，失败时给出提示

#### Scenario: missing states are explained

- **WHEN** 列表为空、详情加载失败、记录已删除或未保存原文
- **THEN** 页面显示对应说明，而不是空白区域

#### Scenario: stale responses do not overwrite selection

- **WHEN** 用户在一次详情加载完成前切换到另一条记录
- **THEN** 先前的响应被丢弃，详情与当前选中项一致
