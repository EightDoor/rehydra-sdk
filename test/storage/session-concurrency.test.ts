/**
 * 会话映射的并发一致性测试。
 *
 * 读改写若不串行，并发调用会读到同一份旧映射、各自分配相同 ID 并互相覆盖，
 * 结果是占位符被还原成别人的值。这里直接从并发结果反推该前提是否成立。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAnonymizer,
  InMemoryKeyProvider,
  InMemoryPIIStorageProvider,
  type Anonymizer,
} from "../../src/index.js";
import { invalidateSessionMapCache } from "../../src/storage/session-base.js";
/** 拼接构造，避免源码里出现真实邮箱字面量与裸标签前缀。 */
function emailAt(local: string): string {
  return [local, "example.com"].join("@");
}
const TAG_OPEN = ["<", "PII"].join("");
const TAG_RE = new RegExp(`${TAG_OPEN}[^>]*>`);

/** 取出文本里第一个占位符标签。 */
function firstTag(text: string): string {
  return TAG_RE.exec(text)?.[0] ?? "";
}

describe("会话映射并发一致性", () => {
  let anonymizer: Anonymizer;
  let storage: InMemoryPIIStorageProvider;

  beforeEach(async () => {
    storage = new InMemoryPIIStorageProvider();
    anonymizer = createAnonymizer({
      ner: { mode: "disabled" },
      piiStorageProvider: storage,
      keyProvider: new InMemoryKeyProvider(),
    });
    await anonymizer.initialize();
  });

  afterEach(async () => {
    await anonymizer.dispose();
  });

  it("同一会话并发脱敏时每个实体拿到不同的 ID", async () => {
    const sessionId = "concurrent-one";
    const emails = Array.from({ length: 20 }, (_, i) => emailAt(`user${i + 1}`));

    const results = await Promise.all(
      emails.map((email) => anonymizer.session(sessionId).anonymize(`联系人 ${email}`)),
    );

    const tags = results.map((result) => firstTag(result.anonymizedText));
    expect(tags.every((tag) => tag.includes('type="EMAIL"'))).toBe(true);
    // 20 个不同实体必须拿到 20 个不同 ID，且映射里一条都不能少。
    expect(new Set(tags).size).toBe(emails.length);

    const stored = await storage.load(sessionId);
    expect(stored).not.toBeNull();
    const counts = stored?.metadata.entityCounts ?? {};
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(emails.length);
  });

  it("并发完成后每个占位符还原回自己的原值", async () => {
    const sessionId = "concurrent-roundtrip";
    const emails = Array.from({ length: 20 }, (_, i) => emailAt(`round${i + 1}`));

    const results = await Promise.all(
      emails.map((email) => anonymizer.session(sessionId).anonymize(`联系人 ${email}`)),
    );

    for (const [index, result] of results.entries()) {
      const restored = await anonymizer.session(sessionId).rehydrate(result.anonymizedText);
      expect(restored).toContain(emails[index]);
    }
  });

  it("并发下同一实体的重复值复用同一个 ID", async () => {
    const sessionId = "concurrent-reuse";
    const shared = emailAt("shared");
    const texts = Array.from({ length: 8 }, () => `联系人 ${shared}`);

    const results = await Promise.all(
      texts.map((text) => anonymizer.session(sessionId).anonymize(text)),
    );

    const tags = results.map((result) => firstTag(result.anonymizedText));
    expect(new Set(tags).size).toBe(1);
  });

  it("不同会话并发时各自结果正确", async () => {
    const first = emailAt("first");
    const second = emailAt("second");

    const [a, b] = await Promise.all([
      anonymizer.session("session-a").anonymize(`联系人 ${first}`),
      anonymizer.session("session-b").anonymize(`联系人 ${second}`),
    ]);

    const restoredA = await anonymizer.session("session-a").rehydrate(a.anonymizedText);
    const restoredB = await anonymizer.session("session-b").rehydrate(b.anonymizedText);
    expect(restoredA).toContain(first);
    expect(restoredA).not.toContain(second);
    expect(restoredB).toContain(second);
    expect(restoredB).not.toContain(first);
  });

  it("一次失败不会让后续同会话脱敏卡住", async () => {
    const sessionId = "concurrent-failure";
    const bad = emailAt("bad");

    // 先制造一次失败：存储读取抛错。
    const originalLoad = storage.load.bind(storage);
    let failOnce = true;
    storage.load = async (id: string) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("storage boom");
      }
      return originalLoad(id);
    };

    await expect(anonymizer.session(sessionId).anonymize(`联系人 ${bad}`)).rejects.toThrow(
      /storage boom/,
    );

    // 后续调用仍能正常完成。
    const good = emailAt("good");
    const result = await anonymizer.session(sessionId).anonymize(`联系人 ${good}`);
    expect(result.anonymizedText).toContain(TAG_OPEN);
  });
});
