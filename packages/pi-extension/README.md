# pi-rehydra

在主 LLM 请求发出之前，脱敏 Pi 对话中检测到的密钥。

[English](./README.en.md)

这个扩展拦截 [Pi](https://pi.dev) 与 LLM 之间的对话。你的 `.env` 文件中的密钥在离开本机前被替换为占位符，并在工具（shell 命令、文件写入等）在本地执行前透明还原；无法还原的占位符会阻止该次工具调用。

它依赖 Pi 的 `ExtensionAPI`：`context_with_system`、`tool_call`、`tool_result`、`message_end`、`session_start` / `session_shutdown`。

脱敏和还原都在本地进行；模型只用占位符推理，工具始终拿到真实值。

## 安装

```bash
pi install npm:pi-rehydra
```

Pi 会在 `~/.pi/agent/settings.json` 写入包声明。然后编辑该文件添加扩展配置：

```json
{
  "packages": [
    {
      "source": "npm:pi-rehydra"
    }
  ],
  "rehydra": {
    "envFiles": [".env", ".env.local"],
    "redactValues": ["sk-live-abc123..."],
    "allowLiteralTagsIn": ["write", "edit"]
  }
}
```

`rehydra` 键的所有字段都是扩展配置项：`envFiles`、`redactValues`、`minValueLength`、`disableTypes`、`locale`、`vcsIdentities`、`policy`、`anonymizer`、`tagFormat`。`envFiles` 默认是 `["**/.env*"]`，会跳过 `node_modules`、`.git` 和符号链接。

`allowLiteralTagsIn` 默认是空数组（一律阻断）。列进这个数组的工具（通常是 `write`、`edit`）在参数里出现**无法还原**的字面标签时不再阻断，而是原样保留——用于写文档或测试时故意写标签示例。放行会在日志里留痕（`allowed literal tag in tool args`，只带工具名与参数路径）；能还原的标签在任何工具里都照常还原。

## 工作原理

| 钩子 | 作用 |
|---|---|
| `session_start` | 实例化匿名器、装配会话映射、解析 `rehydra` 配置 |
| `context_with_system` | 匿名化模型请求前的所有消息，并按需追加 rehydra 指令 |
| `tool_call` | 在工具执行前严格还原工具入参中的 PII 标签；任一标签无法还原即阻断该次调用 |
| `tool_result` | 在结果返回给模型前脱敏真实 PII |
| `message_end` | 改写最终回答的文本块，把 PII 标签还原为真实值 |
| `session_shutdown` | 释放匿名器与会话注册表 |

## 脱敏记录与对照

开启后可以逐请求核对"哪些内容被拦截、模型实际收到了什么"：

```json
{
  "rehydra": {
    "record": {
      "enabled": true,
      "includeOriginal": true
    }
  }
}
```

`/rehydra log` 列出当前会话最近 20 条记录，`/rehydra log <id>` 看单条详情（命中行 + 字段级 before/after），`/rehydra log --type EMAIL` 按类型筛选；`/rehydra clear` 清当前会话，`/rehydra clear --all` 清全部（都要确认）。

记录默认关闭。开启后写入 `~/.pi/agent/rehydra/records/`（目录 0700、文件 0600），按 7 天与 32 MiB 双上限裁剪，单条记录对照上限 256 KiB。**`includeOriginal` 为 true 时真实值会写到本地磁盘**；不需要时设成 `false`，记录只保留类型、检测器、占位符、长度与偏移。记录里出现的终端控制字符在展示时会转义，原文不会回填到模型上下文。

记录层任何失败（目录不可写、符号链接、半行文件）都只告警，不影响脱敏与请求。

## 限制
- 工具入参还原是严格的：标签不在本次会话映射中（或映射缺失、解密失败）时，该次工具调用会被阻止，不会把 `<PII .../>` 当作真实值执行。占位符只能由同一条会话的映射还原；默认使用内存映射，进程重启后旧标签无法还原。

- 不会拦截用户在 UI 里粘贴的、且未走这些 hook 的模型调用。
- 默认禁用 `URL`、`IP_ADDRESS`、`BIC_SWIFT`、`POSTAL_CODE`、`DATE`；只靠形状就能命中的识别器在代码与文档里误报率高。需要它们时把 `disableTypes` 写成 `["URL", "IP_ADDRESS"]` 即可恢复。即便恢复，银行标识码仍要求附近出现完整的银行语境词。
- `.env` 里只有敏感字段的值会进入全局已知值集合：项目名、端口这类普通配置值不会被替换。显式配置的 `redactValues` 不受这条筛选影响。
- `policy` 的集合类字段可写成数组、阈值可写成对象；字段类型不合法时扩展启动报错并指出字段名，不会静默丢掉保护规则。
- Pi 扩展无法保证消息标题（title）与元数据走相同的 hook，因此这些字段仍可能包含占位符。建议在脱敏时启用完整的 PII 脱敏策略。

## License

MIT