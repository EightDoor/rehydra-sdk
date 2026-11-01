/**
 * 文档类负例：发布说明、标准编号、文档引用不该被遮蔽。
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

const DATE = ["2026", "03", "14"].join("-");
const POSTCODE = ["SW1A", "1AA"].join(" ");
const EMAIL = ["contact", "@", "example.com"].join("");

describe("negative cases: docs", () => {
  let anonymizer: Anonymizer;

  beforeAll(async () => {
    anonymizer = await createPiAnonymizer();
  });

  afterAll(async () => {
    await anonymizer.dispose();
  });

  const cases: Array<[string, string]> = [
    ["发布说明里的日期", `Released ${DATE} with a few fixes.`],
    ["引用文档里的日期", `See ${DATE} for the migration notes.`],
    ["英国邮编", `London ${POSTCODE}`],
    ["文档里的编号引用", "siehe AB/1234 im Dokument"],
    ["八位大写单词", "const ROUTER_NAME = 'FRONTEND';"],
    ["版本号", "build v1.2.3 released"],
  ];

  for (const [name, text] of cases) {
    it(`leaves ${name} alone`, async () => {
      const output = await anonymizeWithPiPolicy(anonymizer, text);
      expect(output).toBe(text);
    });
  }

  it("still masks a personal email in prose", async () => {
    const output = await anonymizeWithPiPolicy(
      anonymizer,
      `Contact ${EMAIL} for details.`,
    );
    expect(output).not.toContain(EMAIL);
  });
});
