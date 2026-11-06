# Tasks

## 1. 打包前同步

- [x] 1.1 `packages/pi-extension/package.json` 新增 `prepack` 指向 `node ./scripts/sync-dist.mjs`，保留 `prepublishOnly`
- [x] 1.2 验证：移走 `dist/` 后在包目录执行 `npm pack --dry-run`，产物包含 `dist/pi-extension/index.js`

## 2. 产物校验

- [x] 2.1 新增 `scripts/verify-pack.mjs`：解析 `npm pack --dry-run --json`，断言必需文件齐全，缺失时以非零码退出并列出文件名
- [x] 2.2 通过 `npm_execpath` 调用 npm，避免 nvm / Windows 下 `npm` 不可直接 spawn
- [x] 2.3 验证：`dist/` 缺失且无 `prepack` 时脚本退出码为 1 并列出缺失文件

## 3. 串联预检

- [x] 3.1 根 `package.json` 的 `pack:dry-run` 改为「构建 → 同步 dist → 校验产物」，新增 `verify-pack` 脚本
- [x] 3.2 验证：移走 `dist/` 后 `npm run pack:dry-run` 自动重建并通过，报告 413 个文件
