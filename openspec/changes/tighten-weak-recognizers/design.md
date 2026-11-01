# Design

## Context

- `createDefaultPolicy()` 的 `regexEnabledTypes` 包含 ADDRESS、EMAIL、PHONE、POSTAL_CODE、IBAN、BIC_SWIFT、CREDIT_CARD、IP_ADDRESS、URL、DATE、CASE_ID、CUSTOMER_ID。
- `policyFromOptions()` 用 `createDefaultPolicy()` 的集合减去 `options.disableTypes`（默认 `["URL","IP_ADDRESS"]`），`disableTypes: []` 表示全部启用。该函数与 `DEFAULT_DISABLE_TYPES` 只被 Pi 扩展使用。
- 识别器的 `validate` 只做形状与校验位判断：BIC 查国家码、邮编查语法、日期查日历合法性，都没有上下文要求。
- `config-secret` 只按字段名（`isSecretKeyName`）判断值，不看值的语义；`env-var` 相同，另过滤少数占位词。
- `parseEnvFile()`（`src/core/anonymizer.ts`）只返回值数组，丢掉键名，所有值都进已知值集合。
- `literal-value` 用 `indexOf` 在全文本任意位置匹配，最短长度来自调用方传入（当前固定 4）。
- `normalizeRehydraOptions()` 对 `policy` 只做类型断言，JSON 里的数组会原样进入运行时；`applyAllowlist` 因此可能调用不存在的 `.has`。

## Goals / Non-Goals

**Goals:**

- 让"形状相似"不再单独构成遮蔽理由，且变化范围限于 Pi 默认配置。
- 把代码、配置、文档、命令四类文本的误遮蔽固定成回归测试。

**Non-Goals:**

- 不改变 SDK 的默认策略与既有调用方行为。
- 不引入模型判定（模型路径见 `add-masking-records`）。
- 不新增通用正则配置语言，也不重构冲突解决机制。

## Decisions

### 默认关闭只改 Pi 一侧

`DEFAULT_DISABLE_TYPES` 扩展为 `["URL","IP_ADDRESS","BIC_SWIFT","POSTAL_CODE","DATE"]`，`createDefaultPolicy()` 不动。用户把 `disableTypes` 写成 `["URL","IP_ADDRESS"]` 即恢复这三个类型。

备选：直接改 `createDefaultPolicy()`。否决原因：那会改掉 SDK 默认策略，属于未请求的破坏性变更。

### 显式启用后 BIC 仍要求完整语境词

`bic-swift.ts` 增加值前 32 字符窗口内的完整词匹配：`bic`、`swift`、`bank`、`银行`、`bankleitzahl`，按词边界判断，不允许子串命中（例如 `basic`、`bankruptcy` 里不成立）。窗口以命中起点向前取，不跨行。

备选：启用即全量匹配。否决原因：8 位大写字母在真实文本里密度很高，显式启用也会立刻误遮蔽。

### 业务编号要求前缀、分隔符与数字

`germanCaseId` 改为"前缀词 + 分隔符 + 含数字编号"，前缀覆盖 `Az`、`Aktenzeichen`、`Fall`、`Vorgang`、`Ref`、`Geschäftsvorfall`。裸结构（如 `1234/26`、`AB/1234`）不再命中。

备选：整类默认关闭。否决原因：业务编号是真实 PII，直接关闭会漏。

### 凭证字段判断不依赖字母数字混合

新增两个纯函数（与 `isSecretKeyName` 同文件）：

- `isCredentialField(key)`：区分凭证字段与元数据字段。凭证：`password`、`secret`、`token`、`api_key`、`private_key`、`credential` 等；元数据：以 `_count`、`_type`、`_method`、`_len`、`_size`、`_name`、`_enabled`、`_url`、`_endpoint`、`_timeout` 结尾，或整体为 `sort_key`、`cache_key`、`public_key`、`prompt_cache_key`、`keyboard`。
- `looksLikeCodeReference(text, start, end)`：值为标识符路径（`a.b.c`）、调用（`f(`）、类型引用（`Uint8Array`、`string`）、占位形式（`${…}`、`{{…}}`、`<…>`）时返回真。

`config-secret` 与 `env-var` 共用这两个判断。**不**要求值同时含字母与数字——纯字母密码、纯数字 PIN 都必须在赋值位置被遮蔽。

备选：以值形态（字母+数字）作为唯一闸门。否决原因：会漏掉真实凭证，而且 `token_count: 4096` 这类元数据仍会因字段名命中。

### 环境文件解析保留键名

`parseEnvFile()` 改为返回 `Array<{ key, value }>`，`initialize()` 里按 `isCredentialField(key)` 分档：

- 敏感字段的值 → 进入已知值集合；
- 非敏感字段的值 → 不进入集合（仍可由 `env-var` 识别器在 `.env` 原文行内遮蔽）。

显式 `redactValues` 单独收集，不受上述筛选与长度规则影响，只拒绝空串并告警。

备选：保留全集，只靠在已知值匹配里加过滤。否决原因：项目名这类值已经在集合里，任何后续过滤都在猜哪些是用户本意。

### 已知值门槛按来源分档，不统一抬高

- 自动收集（环境文件敏感字段）：沿用调用方 `minValueLength`（默认 4），不做额外长度判断。
- 显式 `redactValues`：不设长度门槛，空值拒绝。
- 匹配仍保持无边界语义（值出现在命令、路径、URL 中间也要命中）。

备选：统一提到 8。否决原因：会让显式保护悄悄失效，属于降低保护换降噪。

### 配置入口规范化策略，非法即报错

新增 `src/host-agnostic/policy-input.ts`：

- 集合类字段（`enabledTypes`、`regexEnabledTypes`、`nerEnabledTypes`、`allowlistTerms`、`typePriority`、`excludeLocationScopes`）接受数组或 `Set`；
- `confidenceThresholds` 接受普通对象或 `Map`，值必须是 `0..1` 的数字；
- `denylistPatterns` 接受字符串数组并存为字符串，由使用处编译；非法正则返回配置错误；
- 无法识别的字段或类型错误 → 返回 `{ ok: false, field }`，扩展启动时报错并列出字段名，不带残缺策略运行。

备选：丢弃非法项继续运行。否决原因：用户会以为保护仍然生效。

### 负例集按文本类别组织，断言走匿名化入口

`test/recognizers/negatives/{code,config,docs,shell}.test.ts`，每个用例是"文本 + 期望命中数"，断言经 `Anonymizer.anonymize()` 的整体结果，覆盖冲突解决与策略过滤，而不是只测单个识别器。每个文件同时保留该类别下的正例。

## Risks / Trade-offs

- [Pi 默认关闭 BIC/日期/邮编后，真实银行代码与生日直接发给模型] → README 与 CHANGELOG 写明变化与恢复方式；文档给出保留日期的推荐配置片段。
- [环境文件只收敏感字段值会漏掉某些非标准命名的凭证] → `secretKeyPatterns` 仍可扩展字段名；文档说明该行为。
- [策略配置改为报错会打断已有用户的启动] → 错误信息列出字段名与期望类型，README 提前给出迁移说明。
- [业务编号收紧可能漏真实编号] → 保留带前缀与分隔符的形式，并在负例集中同时放正例断言。
- [负例集断言走完整管线，重构时容易连带失败] → 断言只关心"是否被替换"与类型，不断言占位符 id。

## Migration Plan

1. CHANGELOG 与 README 标注 Pi 默认三个类型关闭，附恢复配置。
2. README 说明环境文件只收集敏感字段值、策略配置非法会报错。
3. 回滚只需还原 `DEFAULT_DISABLE_TYPES`、相关识别器与 `parseEnvFile` 的返回结构。

## Open Questions

无。
