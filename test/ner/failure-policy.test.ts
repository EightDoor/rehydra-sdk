/**
 * 模型检测失败策略测试：降级与阻断。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createAnonymizer,
  InMemoryKeyProvider,
  InMemoryPIIStorageProvider,
  PIIType,
} from "../../src/index.js";
import type { Anonymizer } from "../../src/index.js";
import type { INERModel, NERPrediction } from "../../src/ner/ner-model.js";

let anonymizer: Anonymizer | undefined;

afterEach(async () => {
  if (anonymizer !== undefined) {
    await anonymizer.dispose();
    anonymizer = undefined;
  }
});

/** 一个总是失败的模型，用来模拟服务不可用。 */
const failingModel: INERModel = {
  loaded: true,
  version: "test-model",
  async load() {},
  async predict(): Promise<NERPrediction> {
    throw new Error("Failed to connect to stub");
  },
  async dispose() {},
};

const EMAIL = ["alice", "@", "example.com"].join("");

describe("ner failure policy", () => {
  it("degrades to rules and marks the result incomplete", async () => {
    anonymizer = createAnonymizer({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      ner: { mode: "disabled" },
      nerFailure: "rules",
    });
    await anonymizer.initialize();
    // 注入失败模型
    (anonymizer as unknown as { nerModel: INERModel }).nerModel = failingModel;

    const result = await anonymizer.anonymize(`mail ${EMAIL} now`);

    expect(result.detectionErrors?.[0]?.code).toBe("model-unreachable");
    expect(result.integrity).toBe("rules-only");
    // 规则命中仍然生效
    expect(result.anonymizedText).not.toContain(EMAIL);
    expect(result.stats.countsByType[PIIType.EMAIL]).toBe(1);
  });

  it("blocks when configured to block", async () => {
    anonymizer = createAnonymizer({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      ner: { mode: "disabled" },
      nerFailure: "block",
    });
    await anonymizer.initialize();
    (anonymizer as unknown as { nerModel: INERModel }).nerModel = failingModel;

    await expect(anonymizer.anonymize("hello")).rejects.toThrow(/connect/);
  });

  it("keeps the previous behavior when not configured", async () => {
    anonymizer = createAnonymizer({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      ner: { mode: "disabled" },
    });
    await anonymizer.initialize();
    (anonymizer as unknown as { nerModel: INERModel }).nerModel = failingModel;

    await expect(anonymizer.anonymize("hello")).rejects.toThrow(/connect/);
  });

  it("reports no detection errors when the model works", async () => {
    anonymizer = createAnonymizer({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      ner: { mode: "disabled" },
    });
    await anonymizer.initialize();

    const result = await anonymizer.anonymize(`mail ${EMAIL} now`);
    expect(result.detectionErrors).toBeUndefined();
    expect(result.integrity).toBeUndefined();
  });
});

describe("run budget", () => {
  it("skips the model when the deadline has already passed", async () => {
    anonymizer = createAnonymizer({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      ner: { mode: "disabled" },
      nerFailure: "rules",
    });
    await anonymizer.initialize();
    let called = 0;
    (anonymizer as unknown as { nerModel: INERModel }).nerModel = {
      ...failingModel,
      async predict() {
        called += 1;
        return { spans: [], processingTimeMs: 0, modelVersion: "t", truncated: false, coverageChars: 0 };
      },
    };

    const result = await anonymizer.anonymize(`mail ${EMAIL}`, undefined, undefined, undefined, undefined, {
      deadline: Date.now() - 1,
    });

    expect(called).toBe(0);
    expect(result.detectionErrors?.[0]?.code).toBe("model-deadline");
    expect(result.integrity).toBe("rules-only");
    // 规则结果仍生效
    expect(result.anonymizedText).not.toContain(EMAIL);
  });

  it("stops waiting when the model exceeds the budget", async () => {
    anonymizer = createAnonymizer({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      ner: { mode: "disabled" },
      nerFailure: "rules",
    });
    await anonymizer.initialize();
    (anonymizer as unknown as { nerModel: INERModel }).nerModel = {
      ...failingModel,
      predict: () => new Promise(() => {}),
    };

    const result = await anonymizer.anonymize(`mail ${EMAIL}`, undefined, undefined, undefined, undefined, {
      deadline: Date.now() + 20,
    });

    expect(result.detectionErrors?.[0]?.code).toBe("model-deadline");
  });

  it("propagates cancellation instead of degrading", async () => {
    anonymizer = createAnonymizer({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      ner: { mode: "disabled" },
      nerFailure: "rules",
    });
    await anonymizer.initialize();
    const controller = new AbortController();
    controller.abort(new Error("cancelled by host"));

    await expect(
      anonymizer.anonymize("hello", undefined, undefined, undefined, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled by host/);
  });
});
