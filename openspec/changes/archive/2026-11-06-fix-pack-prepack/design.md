# Design

## Context

- `packages/pi-extension/index.js` 用 `export { default, createRehydraPiExtension } from "./dist/pi-extension/index.js"` 再导出实现。
- `packages/pi-extension/package.json` 的 `files` 已包含 `dist/`，`pi.extensions` 指向 `./dist/pi-extension/index.js`。
- `dist/` 不在版本控制里（根 `.gitignore` 忽略 `dist/`），只能由 `scripts/sync-dist.mjs` 从根 `dist/` 复制。
- 现状只有 `prepublishOnly` 触发同步。`prepublishOnly` 仅由 `npm publish` 触发，`npm pack` 不触发。

## Goals / Non-Goals

**Goals:**

- 任何打包路径（`npm pack`、`npm publish`、`npm run pack:dry-run`）都先同步 `dist/`。
- 产物缺文件时构建/预检失败，而不是静默产出坏包。

**Non-Goals:**

- 不改包内容结构，不改 `files` 清单，不改版本号流程。
- 不引入打包工具（如 `tsup` / `rollup`）。

## Decisions

### 用 `prepack` 而不是靠脚本调用方记得同步

`prepack` 由 `npm pack` 与 `npm publish` 共同触发，是 npm 提供的标准"打包前"钩子。把同步放在这里，任何入口都不会漏。`prepublishOnly` 保留，覆盖 `npm publish` 场景下的额外保障。

备选：只在根脚本里串联同步。否决原因：开发者直接 `cd packages/pi-extension && npm pack` 时仍会漏。

### 校验脚本解析 `npm pack --dry-run --json` 而不是自己推 `files`

`npm pack` 的 `files` 字段是 glob，还要考虑 `.npmignore` 与默认忽略规则。自己实现等于复刻 npm 的解析逻辑，容易与真实行为偏离。直接读 npm 的输出，是唯一可信来源。

### 通过 `npm_execpath` 调用 npm 自身入口

`npm` 在多数平台是脚本而非可执行文件，且 nvm / Windows 下 PATH 解析不一致。npm script 环境一定设置 `npm_execpath`，用它配 `process.execPath` 调用最稳；直接 `node scripts/verify-pack.mjs` 时退回 `shell: true`。

## Risks / Trade-offs

- [`prepack` 让 `npm pack` 变慢（要复制整份 `dist/`）] → 包体积本就包含 `dist/`，这点复制低于构建成本；换来的是不会发出坏包。
- [校验脚本依赖 npm 的 JSON 输出格式稳定] → `--json` 是 npm 的稳定输出；脚本只读 `files[].path`，字段面很小。
- [在 `packages/pi-extension` 单独 `npm pack` 时，根 `dist/` 可能还没构建] → 此时 `sync-dist.mjs` 会因源目录缺失而报错退出，属于正确的失败方式（而不是产出空包）。

## Migration Plan

1. 纯构建流程变更，无运行时影响。
2. 回滚：移除 `prepack`，恢复根 `pack:dry-run` 原样，删除 `scripts/verify-pack.mjs`。

## Open Questions

无。
