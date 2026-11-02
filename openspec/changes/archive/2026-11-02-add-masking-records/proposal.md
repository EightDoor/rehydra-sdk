# Proposal

## Why

扩展对每个字符串无差别脱敏，用户看不到「哪些内容被拦截、被谁发现、本扩展最终交给模型的是什么」。没有对照，就无法区分真实保护与误遮蔽，只能靠读源码推断；上一轮已确认存在 BIC/SWIFT、日期、业务编号、`token_*` 字段名等误判。

同时，若要引入模型检测，必须先定清隐私边界：待检测原文会离开本机，服务失败时是否放行直接决定防泄漏强度。

## What Changes

- 新增按请求的脱敏记录：每次 `context_with_system` 分配 requestId，记录本次处理的命中、耗时、状态与字段级对照；`tool_result` 的首次命中可关联回后续请求。
- 记录名称固定为「本扩展处理后的模型输入」，不宣称是供应商实际收到的报文；宿主未提供的供应商、模型、发送状态一律不写。
- 命中条目带发现者类别（`rule` / `known` / `model`）、稳定 detectorId、置信度、偏移与实际替换文本；记录继承开放诊断采集入口，默认不采集原文。
- 新增 `/rehydra log`（列表、单条详情、按类型筛选）与 `/rehydra clear`（当前会话 / 全部），原文只在本机交互界面显示。
- 记录可选落盘到用户级目录，目录 0700、文件 0600；默认关闭，开启后按用户选择保留原文。
- 自部署 NER 作为 `model` 发现者：复用现有 `/health` 与 `/v1/predict` 协议与 `backend` 配置，失败时降级为规则检测并明确标记检测不完整；可配置为失败即阻断。
- `SpanMatch` / `DetectedEntity` 增加可选 `recognizer` 归因字段，不透出原文。

## Capabilities

### New Capabilities

- `masking-records`：按请求记录脱敏命中、发现者归因、原文与本扩展输出对照，以及记录存储、保留、查看与清理的行为约定。
- `model-finder`：自部署 NER 作为模型发现者的选择、协议校验、失败降级与阻断约定。

### Modified Capabilities

（本项目首次引入 OpenSpec 规格，无既有主规格。）

## Impact

- 新增 `src/records/`（类型、记录器、格式化输出）与 `/rehydra` 子命令解析。
- 修改 `src/types/index.ts`（`recognizer` 可选字段）、`src/recognizers/registry.ts`、`src/pipeline/tagger.ts`、`src/host-agnostic/scrub.ts`、`src/core/anonymizer.ts`（可选采集入口与 NER 失败处理）、`src/pi-extension/*`、`src/host-agnostic/normalize-options.ts`。
- 不改变现有脱敏与阻断语义：记录失败不影响请求，规则/还原失败仍按 fail-closed 阻断。
- 新增本地明文落点，仅在用户显式开启记录后产生。
