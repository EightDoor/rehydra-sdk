#!/usr/bin/env node
// 校验 `pi-rehydra` 的打包产物是否包含运行所需的全部文件。
//
// 背景：`index.js` 从 `./dist/pi-extension/index.js` 再导出实现，`dist/` 由
// `scripts/sync-dist.mjs` 从 SDK 构建产物同步而来。同步步骤一旦没跑，
// 打出来的包会静默缺少 dist/，安装后加载扩展直接失败。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pkgRoot = path.join(repoRoot, "packages", "pi-extension");

/** 发布包里必须存在的文件。 */
const REQUIRED = [
  "index.js",
  "index.d.ts",
  "dist/pi-extension/index.js",
  "dist/pi-extension/index.d.ts",
  "README.md",
  "README.en.md",
];

// 通过 npm script 调用时优先复用 npm 自身的入口脚本：直接 spawn "npm"
// 在部分环境（nvm / Windows）下解析不到可执行文件。
const npmEntry = process.env["npm_execpath"];
const raw = npmEntry === undefined || npmEntry === ""
  ? execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: pkgRoot,
      encoding: "utf-8",
      shell: true,
    })
  : execFileSync(process.execPath, [npmEntry, "pack", "--dry-run", "--json"], {
      cwd: pkgRoot,
      encoding: "utf-8",
    });

const parsed = JSON.parse(raw.slice(raw.indexOf("[")));
const files = new Set(
  (parsed[0]?.files ?? []).map((entry) => String(entry.path).replace(/^\.\//, "")),
);

const missing = REQUIRED.filter((name) => !files.has(name));
if (missing.length > 0) {
  console.error("packaged tarball is missing required files:");
  for (const name of missing) console.error(`  - ${name}`);
  console.error(`\npackaged file count: ${files.size}`);
  process.exit(1);
}

console.log(`pack contents verified: ${files.size} files, all required entries present.`);
