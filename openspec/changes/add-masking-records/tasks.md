# Tasks

## 1. 归因字段

- [x] 1.1 `src/types/index.ts` 为 `SpanMatch` 与 `DetectedEntity` 增加可选 `recognizer?: string`（稳定标识）；`npx tsc --noEmit` 通过
- [x] 1.2 为每个识别器补稳定标识常量（邮箱、已知值-环境文件、已知值-显式配置、模型服务等），`src/recognizers/registry.ts` 的 `findAll()` 填充；`test/recognizers/registry.test.ts` 断言"每个命中都带标识"通过
- [x] 1.3 `src/pipeline/tagger.ts` 透传检测器标识；`npm run test:run -- test/pipeline` 通过
- [x] 1.4 新增 records 层的标识→显示名映射；单元测试断言改名不影响已落盘记录的归因

## 2. 诊断采集入口

- [x] 2.1 `src/core/anonymizer.ts` 的 `anonymize()` 增加可选 `observer`（`{ type, recognizer, start, end, replaced, original? }`），替换发生处回调；单元测试断言未注册 observer 时行为与输出完全不变
- [x] 2.2 `original` 仅在 observer 显式声明需要时填充；单元测试断言不需要时不产生明文原值
- [x] 2.3 偏移折算：用 `createLineEndingMapping()` 把规范化偏移还原到原始文本；单元测试覆盖 CRLF、中文、非 BMP 字符的片段一致性
- [x] 2.4 断言 `AnonymizationResult` 与加密映射的既有字段未变化

## 3. 请求记录与关联事件

- [x] 3.1 新增 `src/records/types.ts`：`MaskingRecord`（含 `scope: "model-input"`、`requestId`、`relatedEvents`、`integrity`、`errors`）、`MaskingHit`、`MaskingComparison`；单元测试覆盖 finder 派生与缺省值
- [x] 3.2 `context_with_system` 生成 requestId 并产出请求记录，零命中同样留摘要；`test/pi-extension/extension.test.ts` 断言脱敏文本不变、记录存在
- [ ] 3.3 `tool_result` 首次脱敏写入来源表（会话 + 工具调用 + 字段路径），后续请求按路径关联；单元测试覆盖关联成功与关联失败标记 `origin: "unknown"`
- [x] 3.4 `tool_call` 阻断与 `message_end` 还原记为关联事件，不增加命中数；单元测试断言计数
- [x] 3.5 只记录胜出命中；单元测试构造规则与模型重叠，断言单条命中且无被丢弃分数
- [ ] 3.6 只为变化字段生成对照，单条记录 256 KiB 上限并标 `truncated`；单元测试覆盖超长 `tool_result`

## 4. 记录器与存储

- [x] 4.1 新增 `src/records/recorder.ts`：按天追加 JSONL，目录 0700、文件 0600、文件名带实例后缀；单元测试断言权限与追加顺序
- [x] 4.2 单实例串行追加 + 队列上限 200，超限丢弃并告警一次；单元测试覆盖率队行为
- [x] 4.3 每次写入后检查天数与字节上限并立即删除最旧文件；单元测试构造超限目录断言清理
- [x] 4.4 打开前 `lstat` 拒绝符号链接、校验目录权限；单元测试构造符号链接目录断言拒绝
- [x] 4.5 读取跳过损坏尾行并告警（不含原文）；单元测试构造半行文件
- [x] 4.6 写入、清理、读取异常全部不影响脱敏，只告警；单元测试让目录不可写，断言不抛错
- [x] 4.7 测试环境不写磁盘；断言测试运行后用户目录无新增文件
- [x] 4.8 `clear(kind)` 支持当前会话与全部，删除文件并清空内存；单元测试断言不触碰 PII 还原映射

## 5. 配置

- [x] 5.1 `src/pi-extension/options.ts` 增加 `record?: { enabled, includeOriginal, keepInMemory, keepDays, keepBytes, maxRecordBytes, dir }` 与 `nerFailure?: "rules" | "block"`
- [x] 5.2 `src/host-agnostic/normalize-options.ts` 校验上述选项（未知字段忽略、畸形值回落默认、路径相对 cwd 解析、`nerFailure` 默认 `rules`）；`test/pi-extension/normalize-options.test.ts` 覆盖默认值与非法值
- [x] 5.3 默认值：`enabled: false`、`includeOriginal: false`、`keepInMemory: 50`、`keepDays: 7`、`keepBytes: 32 MiB`、`maxRecordBytes: 256 KiB`；单元测试断言未配置时不落盘

## 6. 模型发现者

- [x] 6.1 `src/ner/inference-server-client.ts`：非回环地址强制 `https:`、`redirect: "error"`、错误信息不含响应正文；单元测试覆盖三类拒绝
- [x] 6.2 响应逐实体校验（映射类型、置信度范围、跨度合法、文本一致），不符则丢弃并记 `protocol-error`；单元测试用 stub 服务覆盖每种非法响应
- [x] 6.3 `src/core/anonymizer.ts` 的 NER 步骤按 `nerFailure` 处理失败与超时，`errors` 带 `finder: "model"` 与原因码；单元测试覆盖 `rules` 与 `block` 两种策略
- [x] 6.4 每次宿主事件传入 deadline，同事件多字段共享剩余预算；单元测试断言预算耗尽后剩余字段只走规则
- [x] 6.5 取消（AbortSignal）直接结束，不进入降级；单元测试覆盖
- [ ] 6.6 失败告警按服务地址每分钟至多一条；单元测试断言连续失败只产生一条告警
- [x] 6.7 未启用 NER 时无 `model` 命中；断言默认配置下记录无模型条目

## 7. 命令与输出

- [x] 7.1 `/rehydra` 子命令解析（`log`、`log <id|prefix>`、`log --type <TYPE>`、`clear`、`clear --all`），未知子命令给用法；单元测试覆盖分支
- [x] 7.2 列表摘要默认当前会话最近 20 条；快照测试断言格式
- [x] 7.3 单条详情输出命中行 + 字段级对照（长文本分段并标注截断）；快照测试覆盖超长字段
- [x] 7.4 前缀有歧义时列出候选并拒绝；单元测试覆盖
- [x] 7.5 重启后从磁盘读取历史记录；集成测试断言可读
- [x] 7.6 展示前转义终端控制字符，且记录不回填模型上下文；单元测试断言转义与不回填
- [x] 7.7 `clear` 两条路径均需确认，未确认不删除；单元测试覆盖
- [x] 7.8 保留 `/rehydra` 无参数行为；断言既有输出未变

## 8. 文档与收尾

- [x] 8.1 `README.md`、`README.en.md`、`packages/pi-extension/README*.md` 说明记录开关、落盘位置、原文风险、清理方式、NER 原文外发与降级风险
- [x] 8.2 `npm run test:run`、`npm run lint`、`npm run build` 通过；既有环境失败给出基线对比
- [ ] 8.3 手动验证：开启记录后一次带敏感值的会话能看对照、能按类型筛选、重启仍可读、清理后文件消失且还原仍可用

## 未完成（本轮范围外或仅实现未测）

- `3.3` tool_result 来源表（会话 + 工具调用 + 字段路径）未建，`tool_result` 记录只带 `source`，后续请求不做跨事件关联。
- `3.6` 对照预算与 `truncated` 已实现，但"超长 tool_result"用例未补。
- `6.6` 降级告警限频（`warnDegradedOnce`，每 60s 一条）已实现，未加断言。
- `8.3` 手动验证未执行（本机无可用推理服务，未走真实 NER 路径）。
