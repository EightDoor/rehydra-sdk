/**
 * 环境文件按字段名分档的回归测试。
 *
 * 背景：旧实现把 .env 里所有变量值都收进已知值集合，项目名、端口这类
 * 普通配置值因此在后续文本里被替换。
 *
 * fixture 用片段拼接，避免在文件里留下形似敏感值的字面量。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAnonymizer,
  InMemoryKeyProvider,
} from "../../src/index.js";
import type { Anonymizer } from "../../src/index.js";

const SECRET = ["sk-", "proj-", "9f8a7b6c5d4e3f2a1b0c9d8e"].join("");
const ORDINARY = ["my-", "project-", "name"].join("");

describe("env file values by field name", () => {
  let anonymizer: Anonymizer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (anonymizer) {
      await anonymizer.dispose();
      anonymizer = undefined;
    }
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function anonymizerWithEnv(content: string): Promise<Anonymizer> {
    dir = await mkdtemp(join(tmpdir(), "rehydra-env-"));
    await writeFile(join(dir, ".env"), content, "utf-8");
    const created = createAnonymizer({
      keyProvider: new InMemoryKeyProvider(),
      secrets: { enabled: true, envFiles: [".env"], envBaseDirectory: dir },
    });
    await created.initialize();
    anonymizer = created;
    return created;
  }

  it("collects secret field values", async () => {
    const instance = await anonymizerWithEnv(`API_KEY=${SECRET}\n`);

    const result = await instance.anonymize(`the value is ${SECRET} here`);
    expect(result.anonymizedText).not.toContain(SECRET);
  });

  it("does not collect ordinary configuration values", async () => {
    const instance = await anonymizerWithEnv(`PROJECT_NAME=${ORDINARY}\n`);

    const result = await instance.anonymize(`the project is ${ORDINARY} today`);
    expect(result.anonymizedText).toContain(ORDINARY);
  });

  it("keeps explicit redact values regardless of field name", async () => {
    dir = await mkdtemp(join(tmpdir(), "rehydra-env-"));
    const created = createAnonymizer({
      keyProvider: new InMemoryKeyProvider(),
      secrets: {
        enabled: true,
        envFiles: [],
        redactValues: [ORDINARY],
      },
    });
    await created.initialize();
    anonymizer = created;

    const result = await created.anonymize(`the project is ${ORDINARY} today`);
    expect(result.anonymizedText).not.toContain(ORDINARY);
  });
});
