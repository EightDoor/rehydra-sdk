# Proposal

## Why

脱敏能力已经接入 Pi 扩展，但核对脱敏结果只能靠 `/rehydra log` 看变化字段的 before/after，无法看到模型实际收到的完整内容，也看不到未命中的部分；原始内容与脱敏内容分散在两个视图里，无法直接对照。需要一个启动即可访问的本机页面，把"扩展收到的内容"与"扩展输出的内容"并排展示，并落到 SQLite 便于留存与检索。

## What Changes

- 新增本机查看网页：扩展启动时监听 `127.0.0.1` 的随机端口并展示访问地址，页面提供记录列表、筛选、分页、原文与脱敏结果并排对照、命中明细。
- 记录改为落 SQLite：每条记录保存完整文本快照（钩子收到的内容与扩展输出的内容，含未命中字段），并保存索引字段用于筛选。
- 记录默认开启且默认保存原文，不再需要命令行切换。
- **BREAKING** 移除 `/rehydra` 命令：状态、记录查看与清理统一由网页提供。
- 新增 `dashboard.enabled` 配置项（默认 `true`），用于关闭网页服务；不提供运行时切换。
- 旧 JSONL 记录文件保留原样，不导入、不删除，也不在新页面展示。

## Capabilities

### New Capabilities
- `masking-records`: 脱敏请求记录的采集、完整文本快照、SQLite 落盘、保留策略与清理语义。
- `masking-viewer`: 本机网页查看器的服务边界、访问控制、只读接口与清理接口。

### Modified Capabilities
- `pi-extension-coverage`: 扩展启动后必须提供查看入口；命令入口被网页取代。

## Impact

- 新增：`src/records/sqlite-store.ts`、`src/records/snapshot.ts`、`src/records/viewer/`。
- 改动：`src/records/types.ts`、`src/records/recorder.ts`（移除）、`src/pi-extension/extension.ts`、`src/pi-extension/options.ts`、`src/host-agnostic/normalize-options.ts`。
- 依赖：不新增运行时依赖；使用 Node.js 22.5+ 自带的 `node:sqlite`，仅在 Pi 扩展路径按需加载。
- 文档：根 README、`packages/pi-extension/README.md` 及英文版同步更新。
