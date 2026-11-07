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
| `session_start` | 实例化匿名器、装配会话映射、解析 `rehydra` 配置、启动本机查看页面 |
| `context_with_system` | 匿名化模型请求前的所有消息，并在本轮有替换时追加占位符说明 |
| `tool_call` | 在工具执行前严格还原工具入参中的 PII 标签；任一标签无法还原即阻断该次调用 |
| `tool_result` | 在结果返回给模型前脱敏真实 PII |
| `message_end` | 改写最终回答的文本块，把 PII 标签还原为真实值 |
| `session_shutdown` | 关闭查看页面、释放匿名器与会话注册表 |
覆盖的消息角色：`user`、`assistant`、`toolResult`、`system`（其 `content` 与各提示分段，工具声明段除外）、`bashExecution`（命令与输出）、`custom`、`branchSummary` 与 `compactionSummary`——这些正是宿主会转成模型输入的几种。本轮若发生过替换，占位符说明会作为独立提示分段注入，模型因此知道占位符是不可解析的透传值。

失败时的行为：扩展未初始化则阻止工具执行。单次脱敏失败不会中断请求——宿主会吞掉处理器异常并继续发送未脱敏内容，所以扩展自行捕获并写一条告警（只带事件名与原因，不含正文）。
## 脱敏记录与本机查看页面

扩展默认逐请求记录脱敏结果，并启动一个只监听本机的查看页面。启动时终端给出访问地址（例如 `http://127.0.0.1:53211/`），直接打开即可：左侧记录列表（会话/来源/类型/状态筛选、分页），右侧固定展示选中记录，打开即能看到首条内容；内容区支持自动换行、查找与复制。上下文与工具结果记录给出"扩展收到的内容 / 扩展输出的内容"并排对照、命中明细、字段级对照，以及这次脱敏是否可靠（正常 / 规则降级 / 失败放行 / 已阻断）。清理当前会话或全部记录在页面上完成，需要二次确认。

记录写入 `~/.pi/agent/rehydra/records/records.sqlite`（macOS/Linux 上目录 0700、库文件 0600；Windows 上权限位不生效，由用户目录的 NTFS 访问控制决定），按 7 天与 32 MiB 双上限裁剪，单条快照上限 4 MiB。**默认保存原文，真实值会明文写到本地磁盘**；不需要时关掉原文保存，页面仍可用（只保留类型、检测器、占位符、长度与偏移）：

```json
{
  "rehydra": {
    "record": { "includeOriginal": false },
    "dashboard": { "enabled": false }
  }
}
```

`dashboard.enabled: false` 关闭查看页面。页面没有登录态：跨站读取会被浏览器同源约束挡下，但本机其它进程仍能读到记录内容。

除扩展的输入输出外，扩展还会用宿主的 `before_provider_request` 把供应商格式的请求体单独记成 `provider_request` 记录（范围 `provider-payload`），页面标注为"发送前钩子采集"。它只观察、不改写载荷；排在后面的扩展仍可能改动请求，因此它不是网络抓包结果。该采集同样受 `record.enabled` 与 `includeOriginal` 控制，关闭原文保存时不落盘请求正文。

记录层任何失败（目录不可写、符号链接、SQLite 不可用）都只告警，不影响脱敏与请求；未落盘的记录数会在页面状态区显示。

## 限制
- 工具入参还原是严格的：标签不在本次会话映射中（或映射缺失、解密失败）时，该次工具调用会被阻止，不会把 `<PII .../>` 当作真实值执行。占位符只能由同一条会话的映射还原；默认使用内存映射，进程重启后旧标签无法还原。

- 会话映射在进程内缓存以避免重复解密。缓存按「存储实例 + 会话 ID」共享，因此同一存储上的多个会话实例看到的是一致的映射；流式脱敏写盘后也会让缓存失效。仅当**另一个进程**，或另一个指向同一份底层数据的存储实例改写时，本进程缓存不会失效。
- 不会拦截用户在 UI 里粘贴的、且未走这些 hook 的模型调用。
- 默认禁用 `URL`、`IP_ADDRESS`、`BIC_SWIFT`、`POSTAL_CODE`、`DATE`；只靠形状就能命中的识别器在代码与文档里误报率高。需要它们时把 `disableTypes` 写成 `["URL", "IP_ADDRESS"]` 即可恢复。即便恢复，银行标识码仍要求附近出现完整的银行语境词。
- `.env` 里只有敏感字段的值会进入全局已知值集合：项目名、端口这类普通配置值不会被替换。显式配置的 `redactValues` 不受这条筛选影响。
- `policy` 的集合类字段可写成数组、阈值可写成对象；字段类型不合法时扩展启动报错并指出字段名，不会静默丢掉保护规则。
- Pi 扩展无法保证消息标题（title）与元数据走相同的 hook，因此这些字段仍可能包含占位符。建议在脱敏时启用完整的 PII 脱敏策略。
- 查看页面没有登录态，只靠浏览器同源约束限制跨站读取；本机其它进程可以直接读记录库。默认保存原文时，真实值以明文留在本机磁盘上。
- 记录占用按磁盘实际大小控制：裁剪后执行 `VACUUM` 回收页。多个进程同时打开同一记录库时，`VACUUM` 与 WAL checkpoint 可能因文件锁失败（Windows 上更容易触发），这类失败只告警、不影响脱敏，回收会留到下次写入重试。

## License

MIT