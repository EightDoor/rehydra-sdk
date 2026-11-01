# Spec Delta

## Purpose

规定识别器在什么证据强度下才允许把文本替换成占位符、哪些值才允许进入全局已知值集合，避免"形状相似"直接等于"敏感信息"，并以负例回归集固定这些边界。

## ADDED Requirements

### Requirement: weak-evidence types are opt-in for the Pi default

Pi 扩展的默认配置 SHALL 禁用仅凭形状即可匹配的类型（银行标识码、英国邮编、通用日期）；用户显式启用后才参与扫描。SDK 通用默认策略 MUST NOT 因本要求改变。

#### Scenario: bank identifier not masked by default
- **WHEN** Pi 默认配置下文本中出现 8 位或 11 位大写字母组合
- **THEN** 该文本不被替换为银行标识码占位符

#### Scenario: date not masked by default
- **WHEN** Pi 默认配置下文本中出现符合日历规则的日期
- **THEN** 该文本不被替换为日期占位符

#### Scenario: explicit opt-in restores detection
- **WHEN** 用户显式启用银行标识码类型并给出带银行语境的合法代码
- **THEN** 该代码被替换为银行标识码占位符

#### Scenario: sdk defaults unchanged
- **WHEN** 调用方使用 SDK 默认策略
- **THEN** 三个类型的启用状态与本变更前一致

### Requirement: shape alone never satisfies the bank identifier

银行标识码识别 SHALL 在有限窗口内要求完整语境词，MUST NOT 以子串匹配代替。

#### Scenario: uppercase word is not a bank code
- **WHEN** 文本中出现 8 位大写英文单词且附近没有银行语境词
- **THEN** 不产生占位符，即使该类型已显式启用

#### Scenario: full word context is required
- **WHEN** 文本中附近只有部分片段偶然匹配语境词
- **THEN** 不产生占位符

#### Scenario: real usage is detected
- **WHEN** 文本出现带银行语境词与合法代码的写法
- **THEN** 该代码被替换为银行标识码占位符

### Requirement: business identifiers require an explicit prefix

业务编号识别 SHALL 要求显式前缀词加分隔符，且编号中含数字；纯结构匹配 MUST NOT 成立。

#### Scenario: bare structured number is left alone
- **WHEN** 文本中出现符合编号结构的裸数字串或裸字母数字串
- **THEN** 不产生业务编号占位符

#### Scenario: prefixed reference is detected
- **WHEN** 文本出现带前缀词与分隔符的编号
- **THEN** 该编号被替换为业务编号占位符

#### Scenario: language keyword is not an identifier
- **WHEN** 文本中出现语言关键字加标识符的写法
- **THEN** 不产生业务编号占位符

### Requirement: secret field detection separates credentials from metadata

字段名命中敏感词后，值 SHALL 结合字段语义、引号、赋值位置与表达式边界判断；元数据字段与代码引用 MUST NOT 被当作秘密，判断 MUST NOT 以"必须同时含字母与数字"作为普遍硬条件。

#### Scenario: counter and method fields are not secrets
- **WHEN** 文本中出现计数、类型或方法类字段
- **THEN** 其值不产生占位符

#### Scenario: code naming a secret is not a secret
- **WHEN** 值是指标识符路径、函数调用或类型引用
- **THEN** 不产生占位符

#### Scenario: written secret is still masked
- **WHEN** 值以引号包裹或出现在赋值位置且形态像真实凭证
- **THEN** 值被替换为对应类型的占位符

#### Scenario: alphabetic or numeric password is still masked
- **WHEN** 凭证仅由字母组成或仅由数字组成但形态符合真实凭证
- **THEN** 仍被替换，不因缺少字母数字混合被放过

#### Scenario: meta fields are allowed through
- **WHEN** 文本中出现排序键、缓存键、公钥等字段名
- **THEN** 其值不因字段名被认定为秘密

### Requirement: known value collection keeps field names

环境文件解析 SHALL 保留键名，并只把判定为敏感字段的值加入自动已知值集合；显式配置的值 MUST 按用户意图保留。

#### Scenario: non-secret env values are not global words
- **WHEN** 环境文件中包含项目名、端口、普通配置值
- **THEN** 这些值不进入全局已知值集合，不导致后续文本被替换

#### Scenario: secret env values are collected
- **WHEN** 环境文件中出现敏感字段名对应的值
- **THEN** 该值进入已知值集合，并在后续文本中被遮蔽

#### Scenario: explicit values keep user intent
- **WHEN** 用户显式指定要遮蔽的值
- **THEN** 该值不因自动筛选的长度或复杂度规则被丢弃

#### Scenario: empty value is rejected
- **WHEN** 用户显式指定空串
- **THEN** 该项被拒绝并给出可读错误

### Requirement: no blanket length threshold for known values

已知值匹配 SHALL 按来源分档，MUST NOT 统一抬高最短长度以致短凭证与纯字母/纯数字凭证失去保护。

#### Scenario: high confidence value matches inside context
- **WHEN** 已知值出现在命令、路径或 URL 中间
- **THEN** 该值仍被替换为同一占位符

#### Scenario: short credential still protected
- **WHEN** 已知值来自敏感字段或用户显式指定但长度较短
- **THEN** 该值仍被遮蔽

#### Scenario: ordinary short word is not collected
- **WHEN** 普通短词只出现在非敏感字段中
- **THEN** 它不进入已知值集合

### Requirement: policy configuration is validated

来自配置的脱敏策略 SHALL 在使用前校验并规范化；JSON 中的数组/对象形态与程序化的 `Set` / `Map` 都要支持。非法项 MUST 产生仅含字段名的配置错误，MUST NOT 通过丢弃保护规则让请求继续。

#### Scenario: array forms are normalized
- **WHEN** 用户把集合类字段写成字符串数组
- **THEN** 该字段被规范化为运行时结构并生效

#### Scenario: malformed value is rejected
- **WHEN** 策略字段类型错误
- **THEN** 返回含字段名的配置错误，不启动带残缺策略的会话

#### Scenario: protections are not silently dropped
- **WHEN** 某项配置无法解析
- **THEN** 该错误被明确报告，而不是忽略后继续运行

### Requirement: negative regression set

识别器 SHALL 具备按类别组织的负例测试集，覆盖代码、配置、文档、命令四类文本，并与正例一起在默认测试中运行；测试 SHALL 覆盖完整检测管线，而不只是孤立正则。

#### Scenario: negative cases run by default
- **WHEN** 执行默认测试命令
- **THEN** 负例集全部运行，任一负例被误遮蔽即测试失败

#### Scenario: positives still pass
- **WHEN** 执行默认测试命令
- **THEN** 真实凭证、邮箱、手机号、身份证号等正例仍被正确替换

#### Scenario: pipeline level assertions
- **WHEN** 负例与正例被断言
- **THEN** 断言经由匿名化入口的整体结果，覆盖冲突解决与策略过滤
