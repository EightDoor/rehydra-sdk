/**
 * 命令类负例：命令行、路径、版本号、远程地址不该被遮蔽。
 *
 * 断言走完整匿名化管线，期望输出与输入逐字相同。
 *
 * fixture 用片段拼接，避免在文件里留下形似敏感值的字面量。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Anonymizer } from "../../../src/index.js";
import {
  anonymizeWithPiPolicy,
  createPiAnonymizer,
} from "./helpers.js";

const HOST = ["git", "@", "github.com"].join("");
const TOKEN = ["ghp_", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b"].join("");

describe("negative cases: shell", () => {
  let anonymizer: Anonymizer;

  beforeAll(async () => {
    anonymizer = await createPiAnonymizer();
  });

  afterAll(async () => {
    await anonymizer.dispose();
  });

  const cases: Array<[string, string]> = [
    ["普通命令", "cd gateway && go get gopkg.in/yaml.v3@latest"],
    ["本地路径", "cat /Users/alice/project/src/index.ts"],
    ["版本号", "node --version\nnpm run build:1.2.3"],
    ["包版本固定", "js-tokens@4.0.0"],
    ["远程地址", `${HOST}:project/repo.git`],
    ["带参数的 git 命令", "git log --since=2026-03-14 --author=alice"],
  ];

  for (const [name, text] of cases) {
    it(`leaves ${name} alone`, async () => {
      const output = await anonymizeWithPiPolicy(anonymizer, text);
      expect(output).toBe(text);
    });
  }

  it("still masks a token in a command", async () => {
    const output = await anonymizeWithPiPolicy(
      anonymizer,
      `git push https://x-access-token:${TOKEN}@github.com/org/repo.git`,
    );
    expect(output).not.toContain(TOKEN);
  });
});
