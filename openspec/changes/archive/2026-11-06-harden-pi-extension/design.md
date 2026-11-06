# Design

## Context

- `src/pi-extension/extension.ts` 的 `agentMessageToScrub()`（L515-561）只把 `user` / `assistant` / `toolResult` 三种角色映射成共享核心的 `ScrubPart` 结构，其余角色返回空对象，因此完全不参与脱敏。
- 宿主 `dist/core/messages.js` 的 `convertToLlm()`（L75-143）会把 `bashExecution`（命令+输出）、`custom`（content）、`branchSummary` 与 `compactionSummary`（summary）转成 user 角色文本；`system` 消息的 `content` 与 `sections` 各段由 `getSystemMessageText()`（`chunk-V6KH5QG4.js`）拼进最终提示。
- 宿主 `dist/core/extensions/runner.js` L1057-1064 与 L938-947：`context_with_system` 与 `tool_result` 处理器的异常只被 `emitError` 记录，随后继续用未脱敏内容发请求。扩展顶部注释「任何 scrub 异常都向上抛出，Pi 会停在该请求而不是泄漏」与实际行为不符。
- `session_start` 处理器抛错时，宿主 `runner.js` 的 `emit()`（L813-838）同样只记录错误；`runtime.state` 保持 `undefined`，此后 `tool_call` 处理器 L764 直接 `return undefined`，工具照常执行。
- `state.rehydraInstruction` 在 `setupRuntime()` 内计算并写入 state（L657、L676），但全仓库没有任何读取点；README 承诺的「按需追加 rehydra 指令」从未接线。
- 宿主 `runner.js` 的 `emitContext()` 对 `messages` 做 `structuredClone()` 后交给处理器；处理器就地改写 `event.messages` 不会污染会话存储。

## Goals / Non-Goals

**Goals:**

- 让模型请求路径上的每种消息角色都被脱敏覆盖，范围与宿主的 `convertToLlm()` 保持一致。
- 让占位符说明真正到达模型，避免模型把占位符当噪声自行删除或"还原"。
- 让脱敏失败与初始化失败产生可定位的日志与确定的工具阻断行为。

**Non-Goals:**

- 不处理自动压缩与摘要路径：它不经过 `context_with_system`，原始消息会被 `serializeConversation` 拼进摘要请求。该风险单独立项。
- 不改 `scrubCore` 的核心扫描语义、冲突解决与占位符格式。
- 不改公开配置项、`/rehydra` 命令与 `RehydraPiHandle`。
- 不引入新依赖。

## Decisions

### 用"投影 + 字段回写计划"扩展角色，而非改共享核心

把新增角色的可脱敏字段投影成现有的 `ScrubPart` 文本块，复用 `scrubCore` 的扫描、统计与记录能力；脱敏完成后按计划写回原字段。

写回计划按消息下标记录，与该消息投影出的文本块一一对应：

```ts
type FieldWriteTarget =
  | { kind: "field"; field: string }   // 顶层字段：command / output / summary / content
  | { kind: "section"; key: string };  // system 消息的 sections[key]
```

`MessageRewrite` 增加 `fieldWrites: Map<number, FieldWriteTarget[]>`。回写时，若某消息下标出现在该表中，则只执行字段回写并跳过原有的按索引回写；否则保持原逻辑。

备选：给 `ScrubPart` 增加 `texts: Record<string, string>` 这类通用字段容器，由共享核心统一遍历。否决原因：那会把 Pi 特有的角色语义下沉进宿主无关的共享核心，违反该层的边界。

备选：在 Pi 扩展里为每种角色单独调用 `session.anonymize()`。否决原因：会绕过共享核心的统一预算、统计与记录路径，四套逻辑重复。

### system 消息只脱敏自由文本段，跳过工具声明

system 消息的 `sections` 中，`tools` 段是工具声明文本，`null` 值表示移除该 section。脱敏规则：

- `content` 为字符串时脱敏并写回。
- `sections` 中每个字符串值脱敏并写回同名键；`null` 值原样保留。
- **`sections.tools` 不脱敏**：工具声明被替换成占位符会改变模型看到的工具语义。
- `toolsAdded` / `toolsRemoved` 不动。

备选：整条 system 消息都不脱敏。否决原因：`project_context`（AGENTS.md 内容）、`preamble`、`skills` 段都可能含用户真实姓名或邮箱。

### rehydra 指令以独立 section 注入

在首条 system 消息的 `sections` 上新增 `rehydra` 键，内容为 `state.rehydraInstruction`。仅当本轮 `scrubCore` 的 `scrubbed > 0` 时注入；没有 system 消息时跳过。

用独立 section 而不是拼进 `preamble`：section 是宿主原生结构，`getCurrentSystemMessage()` 会合并各 system 消息的同名 section，Pi 自身也用 section 表达提示增量，注入方式与宿主一致。

备选：把指令追加到 `preamble` 末尾。否决原因：`preamble` 是用户与 Pi 共用的提示段，改写它会与 Pi 的提示更新逻辑相互覆盖。

### 失败语义：阻断工具执行，模型请求照常但留痕

按已确认的取舍，模型请求不因脱敏失败而中断：

- `session_start` 初始化失败：`runtime.state` 保持 `undefined`，`tool_call` 处理器返回 `{ block: true, reason }`，避免工具拿到未还原的占位符参数。
- `context_with_system` / `tool_result` 的脱敏异常：在处理器内部捕获，记录 `warn`（含角色与消息下标，不含正文），消息保持原样继续走宿主流程。

异常改为在扩展内捕获而非依赖宿主吞掉，是为了产出扩展自己的、可定位的告警；宿主那条 `emitError` 仍然存在，但只反映扩展抛出的错误。

备选：脱敏失败时把消息整条丢弃。否决原因：会静默改变对话语义，且用户无法从界面判断发生了什么。

### `custom` 角色按 content 形态分两条路径

`custom.content` 可能是字符串，也可能是内容块数组：

- 字符串：投影成一个文本块，用 `fieldWrites` 写回 `content` 字段。
- 数组：复用 assistant 的按块映射与按索引回写（`assistantBlockToPart` / `writeScrubbedBlock`），不改其形状。

## Risks / Trade-offs

- [system 消息的 `sections` 被替换后，Pi 的提示缓存键发生变化，可能降低缓存命中率] → 只在确有脱敏时注入 `rehydra` section，其余段落的替换范围本就由脱敏结果决定。
- [跳过 `sections.tools` 会让工具声明里的示例值（如示例邮箱）保持原样] → 工具声明由代码生成、不含用户真实 PII，优先保证工具语义正确。
- [把 `bashExecution` 的 `command` 与 `output` 分别脱敏后，命令与输出的占位符可能不一致] → 同一会话的映射按值复用，同一值在两处得到同一占位符。
- [字段回写依赖投影顺序与写回计划一一对应，新增角色时漏配会静默漏脱敏] → 每种新增角色都配一条断言"字段被替换"的测试，漏配即测试失败。
- [初始化失败时阻断全部工具调用，用户可能不理解为何工具不可用] → 阻断原因文本明确说明扩展未初始化，并写日志。

## Migration Plan

1. 行为变化写入 `packages/pi-extension/README*.md` 与 `CHANGELOG.md`：脱敏覆盖范围扩大、初始化失败时工具被阻断。
2. 回滚只需还原 `src/pi-extension/extension.ts` 与 `src/pi-extension/host-types.ts` 的本次改动，无数据迁移、无配置迁移。

## Open Questions

无。
