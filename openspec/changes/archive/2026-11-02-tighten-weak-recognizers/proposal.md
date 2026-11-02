# Proposal

## Why

默认策略把"形状像敏感信息"直接当作"就是敏感信息"。已复现的误遮蔽包括：8 位大写单词被判定为 BIC/SWIFT、发布说明与测试断言里的日期被判定为 DATE、文档编号被判定为 CASE_ID、`token_count: 4096` 与 `auth_method: oauth2` 被判定为配置密钥。

更直接的根因在环境文件处理：`parseEnvFile()` 把**所有**变量值都放进已知值集合，没有保留键名，项目名和普通配置值因此变成全局替换词。

这些误判都发生在 `context_with_system` 的统一扫描路径上，直接污染模型输入与工具参数。

## What Changes

- 仅在 Pi 扩展的默认禁用集合中新增 BIC_SWIFT、POSTAL_CODE、DATE；SDK 通用默认策略不变。
- 显式启用 BIC 后仍要求有限窗口内的完整银行语境词；业务编号要求明确前缀、分隔符与含数字编号。
- 密钥字段检测区分凭证字段与 count/type/method 等元数据，并结合引号、赋值位置与表达式边界排除代码引用；不再用"必须同时含字母与数字"作为所有秘密的硬条件。
- 环境文件解析保留键名，只自动收集被判定为敏感字段的值；显式 `redactValues` 保持用户指定的保护意图，不因自动筛选规则被丢弃。
- 不统一抬高已知值长度门槛；短值与纯字母/纯数字凭证进入回归用例。
- 配置入口把 JSON 友好的集合形态规范化为运行时结构（同时兼容程序化 `Set` / `Map`）；非法保护配置返回仅含字段名的配置错误，不静默丢弃规则。
- 新增 code / config / docs / shell 四类负例集，并保留真实凭证与个人信息的正例。

## Capabilities

### New Capabilities

- `recognizer-accuracy`：识别器的误遮蔽控制约定——哪些形状证据足以独立成立、哪些必须带上下文、哪些值可以进入全局已知值集合，以及负例回归要求。

### Modified Capabilities

（本项目首次引入 OpenSpec 规格，无既有主规格。）

## Impact

- 修改 `src/host-agnostic/normalize-options.ts`（Pi 默认禁用集合、选项校验）、`src/recognizers/bic-swift.ts`、`src/recognizers/custom-id.ts`、`src/recognizers/secrets/key-patterns.ts`、`src/recognizers/secrets/config-secret.ts`、`src/recognizers/secrets/env-var.ts`、`src/recognizers/secrets/literal-value.ts`、`src/core/anonymizer.ts`（环境文件解析保留键名、显式值与自动值分档）。
- 行为变化：Pi 默认配置下 BIC/SWIFT、英国邮编、日期不再被替换，需显式启用；这一变化写入 README 与 CHANGELOG。
- SDK 默认策略与既有调用方行为不变。
- 新增 `test/recognizers/negatives/` 负例集。
