# Tasks

## 1. Pi 默认禁用弱证据类型

- [x] 1.1 `src/host-agnostic/normalize-options.ts` 的 `DEFAULT_DISABLE_TYPES` 扩展为 `["URL","IP_ADDRESS","BIC_SWIFT","POSTAL_CODE","DATE"]`；`test/pi-extension/normalize-options.test.ts` 断言默认值
- [x] 1.2 断言 `disableTypes: ["URL","IP_ADDRESS"]` 能恢复三个类型；断言 `createDefaultPolicy()` 的默认集合未被改动
- [x] 1.3 `/rehydra` 无参数输出增加"当前生效的正则类型"一行；`test/pi-extension/extension.test.ts` 断言输出包含该行

## 2. 银行标识码语境

- [x] 2.1 `src/recognizers/bic-swift.ts` 增加值前 32 字符、不跨行、按词边界匹配的语境词检查（`bic`、`swift`、`bank`、`银行`、`bankleitzahl`）；`test/recognizers/bic-swift.test.ts` 补"无语境不命中""有语境命中"两例
- [x] 2.2 断言 `basic`、`bankruptcy` 这类子串不构成语境；断言 8 位大写英文单词在启用状态下仍不命中

## 3. 业务编号收紧

- [x] 3.1 `src/recognizers/custom-id.ts` 的 `germanCaseId` 改为"前缀词 + 分隔符 + 含数字编号"；`test/recognizers/case-id.test.ts` 补负例（裸结构不命中）与正例（带 `Az.` 前缀命中）
- [x] 3.2 断言 `1234/26`、`AB/1234`、`v1.2.3` 不命中

## 4. 凭证字段与代码引用判断

- [x] 4.1 `src/recognizers/secrets/key-patterns.ts` 新增 `isCredentialField(key)`：区分凭证字段与元数据字段（`_count`、`_type`、`_method`、`_len`、`_size`、`_name`、`_url`、`_endpoint`、`_timeout` 及 `sort_key`、`cache_key`、`public_key`、`prompt_cache_key`、`keyboard`）；单元测试覆盖两档
- [x] 4.2 新增 `looksLikeCodeReference(text, start, end)`：标识符路径、调用表达式、类型引用、占位形式返回真；单元测试覆盖每种形态
- [x] 4.3 `src/recognizers/secrets/config-secret.ts` 改用上述判断；`test/recognizers/secrets/config-secret.test.ts` 断言 `token_count: 4096`、`auth_method: oauth2`、`max_tokens: 4096` 不命中，`password: Passw0rd123` 命中
- [x] 4.4 断言纯字母密码与纯数字 PIN 在赋值位置仍被遮蔽
- [x] 4.5 `src/recognizers/secrets/env-var.ts` 改用上述判断，保持最短长度 4；`test/recognizers/secrets/env-var.test.ts` 断言真实值命中、变量占位与代码引用不命中
- [x] 4.6 断言 `secretKey: Uint8Array;`、`privateKey: toBase64Url(x)`、`details.2` 不命中

## 5. 环境文件按字段名分档

- [x] 5.1 `src/core/anonymizer.ts` 的 `parseEnvFile()` 改为返回 `{ key, value }[]`；`test/core/anonymizer.test.ts`（或就近既有测试）覆盖常规、`export` 前缀、引号包裹、注释与空值
- [x] 5.2 `initialize()` 按 `isCredentialField(key)` 分档：敏感字段值进入已知值集合，非敏感字段值不进入；单元测试断言普通配置值不会在后续文本中被替换
- [x] 5.3 显式 `redactValues` 单独收集，不受筛选与长度规则影响；空串拒绝并告警；单元测试覆盖
- [x] 5.4 断言已知值匹配仍无边界（值出现在命令、路径、URL 中间时命中）；`test/recognizers/secrets/literal-value.test.ts` 覆盖

## 6. 策略配置校验

- [x] 6.1 新增 `src/host-agnostic/policy-input.ts`：集合类字段接受数组或 `Set`，`confidenceThresholds` 接受对象或 `Map`，`denylistPatterns` 存字符串并由使用处编译；单元测试覆盖每种字段形态
- [x] 6.2 非法字段或类型返回 `{ ok: false, field }`；`test/host-agnostic/policy-input.test.ts` 覆盖错误分支
- [x] 6.3 `src/host-agnostic/normalize-options.ts` 接入校验：成功则使用规范化结果，失败则抛出含字段名的配置错误；`test/pi-extension/normalize-options.test.ts` 断言 `allowlistTerms: ["foo"]` 不再触发运行时 `.has` 异常
- [x] 6.4 断言非法 `denylistPatterns` 返回配置错误，而不是静默丢弃

## 7. 负例回归集

- [x] 7.1 `test/recognizers/negatives/code.test.ts`：类型声明、函数调用、字段读取、枚举、测试断言中的日期，断言经 `Anonymizer.anonymize()` 的命中为 0
- [x] 7.2 `test/recognizers/negatives/config.test.ts`：`token_count`、`auth_method`、`max_tokens`、`sort_key`、`public_key`，断言命中为 0
- [x] 7.3 `test/recognizers/negatives/docs.test.ts`：发布说明日期、文档引用编号、标准编号、8 位大写单词，断言命中为 0
- [x] 7.4 `test/recognizers/negatives/shell.test.ts`：命令、路径、版本号、git 远程地址，断言命中为 0
- [x] 7.5 每个负例文件同时放该类别正例（真实凭证、邮箱、手机号），断言仍被替换

## 8. 文档与收尾

- [x] 8.1 `README.md`、`README.en.md`、`packages/pi-extension/README*.md` 写明三个类型默认关闭、恢复配置、环境文件只收集敏感字段值、策略配置非法会报错
- [x] 8.2 `npm run test:run`、`npm run lint`、`npm run build` 通过；既有环境失败给出基线对比
- [x] 8.3 手动验证：Pi 默认配置下普通代码与文档不再被替换；显式启用后银行代码与业务编号仍被替换；SDK 默认行为未变
