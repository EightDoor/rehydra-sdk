/**
 * 会话内映射缓存与写盘抑制的正确性测试。
 *
 * 缓存只允许改变"做了多少工作"，不允许改变"算出什么"：脱敏结果、ID 分配、
 * 还原结果都必须与无缓存时一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAnonymizer,
  InMemoryKeyProvider,
  InMemoryPIIStorageProvider,
  type Anonymizer,
} from "../../src/index.js";
import {
  invalidateSessionMapCache,
  trackedSessionCount,
} from "../../src/storage/session-base.js";

/** 拼接构造，避免源码里出现真实邮箱字面量与裸标签前缀。 */
function emailAt(local: string): string {
  return [local, "example.com"].join("@");
}
const TAG_OPEN = ["<", "PII"].join("");
const TAG_RE = new RegExp(`${TAG_OPEN}[^>]*>`);

function firstTag(text: string): string {
  return TAG_RE.exec(text)?.[0] ?? "";
}

describe("会话映射缓存", () => {
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
    vi.restoreAllMocks();
  });

  it("同一文本连续脱敏两次结果一致", async () => {
    const session = anonymizer.session("cache-stable");
    const text = `联系人 ${emailAt("stable")}`;

    const first = await session.anonymize(text);
    const second = await session.anonymize(text);

    expect(second.anonymizedText).toBe(first.anonymizedText);
    expect(firstTag(second.anonymizedText)).toBe(firstTag(first.anonymizedText));
  });

  it("缓存生效期间新实体仍拿到新 ID", async () => {
    const session = anonymizer.session("cache-new-id");
    const first = await session.anonymize(`联系人 ${emailAt("one")}`);
    const second = await session.anonymize(`联系人 ${emailAt("two")}`);

    const firstId = firstTag(first.anonymizedText);
    const secondId = firstTag(second.anonymizedText);
    expect(firstId).not.toBe(secondId);
  });

  it("没有新实体时不触发写盘", async () => {
    const session = anonymizer.session("cache-no-write");
    const text = `联系人 ${emailAt("once")}`;

    // 首次：产生新实体，应当写盘。
    await session.anonymize(text);
    const saveSpy = vi.spyOn(storage, "save");

    // 再次脱敏同一内容：没有新实体，不应写盘。
    await session.anonymize(text);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("出现新实体时写盘且之后可还原", async () => {
    const session = anonymizer.session("cache-write");
    await session.anonymize(`联系人 ${emailAt("a")}`);

    const saveSpy = vi.spyOn(storage, "save");
    const target = emailAt("b");
    const result = await session.anonymize(`联系人 ${target}`);
    expect(saveSpy).toHaveBeenCalled();

    const restored = await session.rehydrate(result.anonymizedText);
    expect(restored).toContain(target);
  });

  it("删除会话后不再复用旧缓存", async () => {
    const session = anonymizer.session("cache-delete");
    const target = emailAt("gone");
    await session.anonymize(`联系人 ${target}`);
    await session.delete();

    // 删除后重新脱敏：必须重新分配 ID（旧映射已不存在）。
    const again = await session.anonymize(`联系人 ${target}`);
    expect(again.anonymizedText).toContain(TAG_OPEN);

    // 存储里应重新出现该会话的映射。
    const stored = await storage.load("cache-delete");
    expect(stored).not.toBeNull();
  });

  it("写盘失败后不保留缓存，下一次调用重新读取", async () => {
    const session = anonymizer.session("cache-save-fail");

    const failingSave = vi
      .spyOn(storage, "save")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(session.anonymize(`联系人 ${emailAt("x")}`)).rejects.toThrow(/disk full/);
    failingSave.mockRestore();

    // 缓存已清空，下一次调用从存储重新读取并能成功写盘。
    const target = emailAt("y");
    const result = await session.anonymize(`联系人 ${target}`);
    const restored = await session.rehydrate(result.anonymizedText);
    expect(restored).toContain(target);
  });

  it("无 PII 的会话还原时原样返回", async () => {
    const session = anonymizer.session("cache-empty");
    const plain = "状态 ok，代码 200";
    await session.anonymize(plain);

    // 没有实体、也没有写盘；还原应原样返回而不是报错。
    expect(await session.rehydrate(plain)).toBe(plain);
  });

  // 回归：审查发现 3 —— 首次无 PII 必须落一份空映射，否则新建实例无法还原。
  it("无 PII 的会话仍会落一份空映射，冷缓存也能还原", async () => {
    const sessionId = "cache-empty-cross";
    const plain = "状态 ok，代码 200";
    await anonymizer.session(sessionId).anonymize(plain);

    // 清掉缓存模拟另一个进程/冷启动：此时只能靠存储里的那份空映射。
    invalidateSessionMapCache(storage, sessionId);

    const fresh = anonymizer.session(sessionId);
    expect(await fresh.rehydrate(plain)).toBe(plain);
  });

  // 回归：审查发现 1 —— 两个实例共用同一存储时，旧缓存不得覆盖新映射。
  it("两个会话实例交替脱敏不会覆盖对方映射", async () => {
    const sessionId = "cache-cross-instance";
    const a = anonymizer.session(sessionId);
    const b = anonymizer.session(sessionId);

    const results = [
      await a.anonymize(`联系人 ${emailAt("alpha")}`),
      await b.anonymize(`联系人 ${emailAt("beta")}`),
      await a.anonymize(`联系人 ${emailAt("gamma")}`),
    ];
    const tags = results.map((r) => firstTag(r.anonymizedText));
    // 三者的占位符必须互不相同，否则说明有实体被覆盖。
    expect(new Set(tags).size).toBe(3);

    // 每个占位符都必须还能还原回自己的原值。
    const expected = ["alpha", "beta", "gamma"];
    for (const [index, tag] of tags.entries()) {
      const restored = await anonymizer.session(sessionId).rehydrate(tag);
      expect(restored).toContain(emailAt(expected[index] ?? ""));
    }
  });

  // 回归：审查发现 2 —— delete 之后不能再拿旧缓存还原。
  it("删除后还原不会复活旧映射", async () => {
    const sessionId = "cache-delete-race";
    const target = emailAt("revive");
    const session = anonymizer.session(sessionId);
    const result = await session.anonymize(`联系人 ${target}`);
    await session.rehydrate(result.anonymizedText);

    await session.delete();

    const fresh = anonymizer.session(sessionId);
    await expect(fresh.rehydrate(result.anonymizedText)).rejects.toThrow(
      /No PII map found/,
    );
  });

  // 回归：同一 storage 换密钥时，缓存不得绕过 key 不匹配的检测。
  it("换密钥后不复用旧缓存并报出 key 不匹配", async () => {
    const sessionId = "cache-key-rotate";
    await anonymizer.session(sessionId).anonymize(`联系人 ${emailAt("rot")}`);

    const other = createAnonymizer({
      ner: { mode: "disabled" },
      piiStorageProvider: storage,
      keyProvider: new InMemoryKeyProvider(),
    });
    await other.initialize();
    try {
      await expect(
        other.session(sessionId).anonymize(`联系人 ${emailAt("rot2")}`),
      ).rejects.toThrow(/Failed to decrypt existing session data/);
    } finally {
      await other.dispose();
    }
  });

  // 回归（审查二轮 1）：直接调 provider 的 delete/cleanup 也要让缓存失效。
  it("直接调 storage.delete 之后不再从缓存还原", async () => {
    const sessionId = "cache-provider-delete";
    const target = emailAt("gone2");
    const session = anonymizer.session(sessionId);
    const result = await session.anonymize(`联系人 ${target}`);
    await session.rehydrate(result.anonymizedText);

    await storage.delete(sessionId);

    const fresh = anonymizer.session(sessionId);
    await expect(fresh.rehydrate(result.anonymizedText)).rejects.toThrow(
      /No PII map found/,
    );
  });

  it("直接调 storage.cleanup 之后不再从缓存还原", async () => {
    const sessionId = "cache-provider-cleanup";
    const target = emailAt("aged");
    const session = anonymizer.session(sessionId);
    const result = await session.anonymize(`联系人 ${target}`);

    // 用一个未来时间点清掉全部记录。
    await storage.cleanup(new Date(Date.now() + 1000));

    const fresh = anonymizer.session(sessionId);
    await expect(fresh.rehydrate(result.anonymizedText)).rejects.toThrow(
      /No PII map found/,
    );
  });

  // 回归（审查二轮 3）：provider 原地改密钥数组不得绕过 key 校验。
  it("原地修改密钥数组后不复用旧缓存", async () => {
    const sessionId = "cache-key-mutation";
    const mutableKey = new InMemoryKeyProvider();
    const sharedStorage = new InMemoryPIIStorageProvider();
    const first = createAnonymizer({
      ner: { mode: "disabled" },
      piiStorageProvider: sharedStorage,
      keyProvider: mutableKey,
    });
    await first.initialize();
    try {
      await first.session(sessionId).anonymize(`联系人 ${emailAt("mut")}`);

      // 原地翻转密钥字节：缓存里存的是快照，因此必须判定为不匹配。
      const key = await mutableKey.getKey();
      key[0] = (key[0] ?? 0) ^ 0xff;

      // 关键在于不能静默返回明文：解密失败应直接抛错。
      await expect(
        first.session(sessionId).rehydrate(`联系人 ${emailAt("mut")}`),
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await first.dispose();
    }
  });

  // 回归（审查二轮 4）：会话状态要有上限，不能随历史会话无限增长。
  it("会话状态条目数受上限约束", async () => {
    const target = emailAt("b0");
    const firstResult = await anonymizer
      .session("bounded-0")
      .anonymize(`联系人 ${target}`);

    for (let i = 1; i < 120; i += 1) {
      await anonymizer.session(`bounded-${i}`).anonymize(`联系人 ${emailAt(`b${i}`)}`);
    }

    // 条目数必须有上限，不能随历史会话数无限增长。
    expect(trackedSessionCount(storage)).toBeLessThanOrEqual(64);

    // 被回收的条目重新从存储读取，功能不受影响。
    const restored = await anonymizer
      .session("bounded-0")
      .rehydrate(firstResult.anonymizedText);
    expect(restored).toContain(target);
  });

  // 回归（审查二轮 2 / 三轮 P1）：流持有旧快照，结束时整体覆盖会删掉
  // 期间普通脱敏写入的新条目，导致已发出的占位符还原不回来。
  it("流式保存不覆盖期间普通脱敏写入的映射", async () => {
    const sessionId = "cache-stream-merge";
    const session = anonymizer.session(sessionId);
    const baseEmail = emailAt("base");
    const concurrentEmail = emailAt("concurrent");

    // 建立基线映射，流创建时把这份快照种进自己的缓冲区。
    const baseResult = await session.anonymize(`联系人 ${baseEmail}`);

    // 流只重用基线实体，不分配新 ID，从而排除撞号干扰：
    // 结束时它会带着"仅含基线"的旧快照写盘。
    const stream = await session.createStream();
    let streamOutput = "";
    stream.on("data", (chunk: Buffer) => {
      streamOutput += chunk.toString();
    });
    stream.write(`联系人 ${baseEmail}`);

    // 交错点：流尚未结束，普通脱敏先完成并写入新条目。
    const concurrentResult = await session.anonymize(`联系人 ${concurrentEmail}`);

    await new Promise<void>((resolve) => {
      stream.on("end", () => resolve());
      stream.end();
    });

    // 流的输出仍是可还原的（说明流的快照本身没被破坏）。
    expect(await session.rehydrate(streamOutput)).toContain(baseEmail);
    // 关键断言：并发写入的条目没有被流的旧快照覆盖。
    expect(await session.rehydrate(concurrentResult.anonymizedText)).toContain(
      concurrentEmail,
    );
  });
});
