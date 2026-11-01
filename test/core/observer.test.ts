/**
 * 观察者通道测试：偏移折算、原值开关、默认行为不变。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createAnonymizer,
  InMemoryKeyProvider,
  InMemoryPIIStorageProvider,
} from "../../src/index.js";
import type { Anonymizer, AnonymizationResult } from "../../src/index.js";
import type { ObservedEntity } from "../../src/core/observer.js";

const EMAIL = ["alice", "@", "example.com"].join("");
const PHONE = ["+49", "30", "1234567"].join(" ");
const NAME = "张三";

let anonymizer: Anonymizer | undefined;

afterEach(async () => {
  if (anonymizer !== undefined) {
    await anonymizer.dispose();
    anonymizer = undefined;
  }
});

async function newAnonymizer(): Promise<Anonymizer> {
  const instance = createAnonymizer({
    keyProvider: new InMemoryKeyProvider(),
    piiStorageProvider: new InMemoryPIIStorageProvider(),
    ner: { mode: "disabled" },
  });
  await instance.initialize();
  return instance;
}

function collect(text: string, includeOriginal = false) {
  const entities: ObservedEntity[] = [];
  return {
    entities,
    observer: {
      includeOriginal,
      onEntity(entity: ObservedEntity) {
        entities.push(entity);
      },
    },
    text,
  };
}

describe("observer", () => {
  it("does not change output when no observer is registered", async () => {
    anonymizer = await newAnonymizer();
    const withObserver = await anonymizer.anonymize(`a ${EMAIL} b`);
    const without = await anonymizer.anonymize(`a ${EMAIL} b`);

    expect(without.anonymizedText).toBe(withObserver.anonymizedText);
    expect(without.entities).toEqual(withObserver.entities);
    // 只比较确定性字段：processingTimeMs 天然每次不同
    const { processingTimeMs: _a, ...statsA } = without.stats;
    const { processingTimeMs: _b, ...statsB } = withObserver.stats;
    expect(statsA).toEqual(statsB);
    expect(without.detectionErrors).toBeUndefined();
    expect(without.integrity).toBeUndefined();
  });

  it("reports type, detector, placeholder, length and offsets", async () => {
    anonymizer = await newAnonymizer();
    const collected = collect(`a ${EMAIL} b`);
    const result = await anonymizer.anonymize(
      collected.text,
      undefined,
      undefined,
      undefined,
      collected.observer,
    );

    expect(collected.entities).toHaveLength(1);
    const [entity] = collected.entities;
    expect(entity!.type).toBe("EMAIL");
    expect(entity!.recognizer).toBe("email");
    expect(entity!.replaced).toMatch(/^</);
    expect(entity!.end - entity!.start).toBe(EMAIL.length);
    expect(collected.text.slice(entity!.start, entity!.end)).toBe(EMAIL);
    // 观察者得到的占位符就是最终输出里的那个
    expect(result.anonymizedText).toContain(entity!.replaced);
  });

  it("omits the original value unless asked", async () => {
    anonymizer = await newAnonymizer();
    const collected = collect(`a ${EMAIL} b`);
    await anonymizer.anonymize(collected.text, undefined, undefined, undefined, collected.observer);
    expect(collected.entities[0]!.original).toBeUndefined();

    const withOriginal = collect(`a ${EMAIL} b`, true);
    await anonymizer.anonymize(
      withOriginal.text,
      undefined,
      undefined,
      undefined,
      withOriginal.observer,
    );
    expect(withOriginal.entities[0]!.original).toBe(EMAIL);
  });

  it("maps offsets back through CRLF normalization", async () => {
    anonymizer = await newAnonymizer();
    const text = `line1\r\nline2 ${EMAIL}\r\nline3`;
    const collected = collect(text);
    await anonymizer.anonymize(text, undefined, undefined, undefined, collected.observer);

    const [entity] = collected.entities;
    expect(text.slice(entity!.start, entity!.end)).toBe(EMAIL);
  });

  it("maps offsets for CJK text", async () => {
    anonymizer = await newAnonymizer();
    const text = `${NAME}的邮箱是 ${EMAIL}，请勿外传`;
    const collected = collect(text);
    await anonymizer.anonymize(text, undefined, undefined, undefined, collected.observer);

    const [entity] = collected.entities;
    expect(text.slice(entity!.start, entity!.end)).toBe(EMAIL);
  });

  it("maps offsets after non-BMP characters", async () => {
    anonymizer = await newAnonymizer();
    const text = `𝔘𝔫𝔦𝔠𝔬𝔡𝔢 😀 ${EMAIL}`;
    const collected = collect(text);
    await anonymizer.anonymize(text, undefined, undefined, undefined, collected.observer);

    const [entity] = collected.entities;
    expect(text.slice(entity!.start, entity!.end)).toBe(EMAIL);
  });

  it("reports every distinct hit and keeps existing result fields", async () => {
    anonymizer = await newAnonymizer();
    const text = `${EMAIL} 和 ${PHONE}`;
    const collected = collect(text, true);
    const result: AnonymizationResult = await anonymizer.anonymize(
      text,
      undefined,
      undefined,
      undefined,
      collected.observer,
    );

    expect(collected.entities.length).toBeGreaterThanOrEqual(2);
    for (const entity of collected.entities) {
      expect(text.slice(entity.start, entity.end)).toBe(entity.original);
    }
    expect(result.piiMap).toBeDefined();
    expect(result.entities.length).toBe(result.stats.totalEntities);
  });
});
