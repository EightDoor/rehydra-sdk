/**
 * 代码类负例：源码里不该被遮蔽的内容。
 *
 * 断言走完整匿名化管线，输入里的日期、编号都是真实文本，
 * 期望输出与输入逐字相同。
 *
 * fixture 用片段拼接，避免在文件里留下形似敏感值的字面量。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Anonymizer } from "../../../src/index.js";
import {
  anonymizeWithPiPolicy,
  createPiAnonymizer,
} from "./helpers.js";

const DATE = ["2026", "03", "14"].join("-");
const API_KEY = ["sk-", "proj-", "9f8a7b6c5d4e3f2a1b0c9d8e"].join("");

describe("negative cases: code", () => {
  let anonymizer: Anonymizer;

  beforeAll(async () => {
    anonymizer = await createPiAnonymizer();
  });

  afterAll(async () => {
    await anonymizer.dispose();
  });

  const cases: Array<[string, string]> = [
    [
      "类型声明里的密钥字段名",
      "type Keys = { apiKey: Base64Str | null; readonly secretKey: Uint8Array }",
    ],
    [
      "字段读取路径",
      "const key = await readFile(path, 'utf8');\nconst secretKey = fromBase64Url(details.2);",
    ],
    ["调用表达式", "privateKey: toBase64Url(device.privateKey),"],
    ["枚举与常量", "const MODE = 'AUTH';\nconst MAX_TOKEN = 4096;"],
    [
      "测试断言里的日期",
      `expect(date).toBe('${DATE}');\nconst released = '${DATE}';`,
    ],
    [
      "switch 分支的短标识符",
      "switch code {\n\tcase CapPower:\n\t\treturn http.StatusUnauthorized\n}",
    ],
  ];

  for (const [name, text] of cases) {
    it(`leaves ${name} alone`, async () => {
      const output = await anonymizeWithPiPolicy(anonymizer, text);
      expect(output).toBe(text);
    });
  }

  it("still masks a real credential in code context", async () => {
    const output = await anonymizeWithPiPolicy(
      anonymizer,
      `const apiKey = "${API_KEY}"`,
    );
    expect(output).not.toContain(API_KEY);
  });
});
