# Tasks

## 1. 宿主类型补齐

- [x] 1.1 `src/pi-extension/host-types.ts` 补齐 `AgentMessage` 的 `sections`（字符串或 null 的字典）、`command`、`output`、`summary`、`customType` 字段类型；保持 `[key: string]: unknown` 索引签名不变
- [x] 1.2 `npm run build` 通过，类型检查无新增错误

## 2. 角色投影与字段回写

- [x] 2.1 `src/pi-extension/extension.ts` 新增 `FieldWriteTarget` 类型与 `MessageRewrite.fieldWrites` 映射，记录每条消息投影出的文本块各自对应哪个顶层字段或哪个 section 键
- [x] 2.2 `agentMessageToScrub()` 扩展 system 角色：投影 `content` 字符串与 `sections` 中每个非 null 字符串值，跳过 `sections.tools`；`sections` 中 `null` 值不投影也不改动
- [x] 2.3 `agentMessageToScrub()` 扩展 `bashExecution` 角色：投影 `command` 与 `output` 两个字符串
- [x] 2.4 `agentMessageToScrub()` 扩展 `custom` 角色：`content` 为字符串时投影为单个文本块，为数组时复用 assistant 的按块映射
- [x] 2.5 `agentMessageToScrub()` 扩展 `branchSummary` 与 `compactionSummary` 角色：投影 `summary` 字符串
- [x] 2.6 `restoreMessagesFromScrub()` 执行字段回写：有 `fieldWrites` 计划的消息按计划写回并跳过原有按索引回写；无计划的消息保持原有按索引回写逻辑不变
- [x] 2.7 `test/pi-extension/extension.test.ts` 断言：system 消息自由文本段被替换、`sections.tools` 段与 `null` 值不变、`toolsAdded` 不变、system 消息仍在首位
- [x] 2.8 `test/pi-extension/extension.test.ts` 断言：`bashExecution` 的 `command` 与 `output` 均被替换；`custom` 的字符串 `content` 与数组 `content` 均被替换且块结构不变；两类摘要的 `summary` 被替换

## 3. 占位符说明送达模型

- [x] 3.1 `src/pi-extension/extension.ts` 在 `context_with_system` 中，当本轮 `scrubbed > 0` 且上下文含 system 消息时，向该 system 消息的 `sections` 写入 `rehydra` 键，值为 `state.rehydraInstruction`
- [x] 3.2 `test/pi-extension/extension.test.ts` 断言：产生脱敏时 system 消息含 `rehydra` section 且内容包含占位符说明；无脱敏时不出现该 section

## 4. 失败语义

- [x] 4.1 `src/pi-extension/extension.ts` 的 `tool_call` 处理器：`runtime.state` 为 `undefined`（初始化未完成或失败）时返回 `{ block: true, reason }`，reason 说明扩展未初始化
- [x] 4.2 `src/pi-extension/extension.ts` 的 `context_with_system` 与 `tool_result` 处理器：捕获脱敏异常，记录 `warn`（含事件名与消息下标，不含正文），保持内容原样继续
- [x] 4.3 修正 `src/pi-extension/extension.ts` 顶部注释中「Pi 会停在该请求而不是泄漏」的失效假设，改为描述实际的阻断与告警语义
- [x] 4.4 `test/pi-extension/extension.test.ts` 断言：初始化失败后 `tool_call` 返回 `block: true` 且 reason 指向未初始化；脱敏抛错时 `context_with_system` 不抛异常且产生告警
- [x] 4.5 `test/pi-extension/extension.test.ts` 断言：脱敏失败的告警内容中不含原始 PII 值

## 5. 文档与收尾

- [x] 5.1 `packages/pi-extension/README.md` 与 `README.en.md` 写明脱敏覆盖的消息角色、占位符说明的注入方式、初始化失败时工具被阻断
- [x] 5.2 行为变化写入 README；`CHANGELOG.md` 由 release-please 依据提交信息生成，不手工编辑
- [x] 5.3 `npm run test:run` 与 `npm run lint` 通过；既有失败项（离线环境下载语义数据）与本次改动无关，基线一致
- [x] 5.4 `npm run build` 通过
