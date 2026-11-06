# Proposal

## Why

`pi-rehydra` 的入口 `index.js` 从 `./dist/pi-extension/index.js` 再导出实现，而 `dist/` 只由 `prepublishOnly` 里的 `sync-dist.mjs` 生成。根脚本 `pack:dry-run` 直接执行 `npm pack --dry-run`，**不会**触发 `prepublishOnly`。

实测后果：当前仓库里 `packages/pi-extension/dist` 不存在，`npm run pack:dry-run` 打出的包只有 5 个文件（`index.js`、`index.d.ts`、两个 README、`package.json`），完全没有 `dist/`。这样的包发布后，Pi 加载扩展会直接失败——而预检脚本还显示"成功"。

## What Changes

- 在 `packages/pi-extension` 增加 `prepack` 钩子：`npm pack` 与 `npm publish` 都会先同步 `dist/`。
- 根 `pack:dry-run` 改为：构建 → 同步 `dist` → 校验产物清单。
- 新增 `scripts/verify-pack.mjs`：解析 `npm pack --dry-run --json` 的文件清单，缺少入口或 `dist` 关键文件时以非零码退出。

## Capabilities

### New Capabilities

- `package-contents`：发布包的产物完整性契约——哪些文件必须出现在 tarball 里，以及打包前必须完成哪些准备步骤。

### Modified Capabilities

（无）

## Impact

- 修改 `packages/pi-extension/package.json`（新增 `prepack`）。
- 修改根 `package.json`（`pack:dry-run` 串联同步与校验，新增 `verify-pack` 脚本）。
- 新增 `scripts/verify-pack.mjs`。
- 不改变已发布包的运行时行为；只保证打出来的包可加载。
- 不引入新依赖（只用 `node:child_process` / `node:path` / `node:url`）。
