/**
 * 记录结构辅助函数测试：发现者派生与显示名。
 */
import { describe, it, expect } from "vitest";
import { detectorLabel, finderOf } from "../../src/records/types.js";

describe("finderOf", () => {
  it("maps model detectors", () => {
    expect(finderOf("ner:0.1.0", "ner")).toBe("model");
    expect(finderOf("ner:0.1.0", "regex")).toBe("model");
  });

  it("maps known values", () => {
    expect(finderOf("known-value", "regex")).toBe("known");
    expect(finderOf("known-value:.env", "regex")).toBe("known");
  });

  it("maps plain detectors to rules", () => {
    expect(finderOf("email", "regex")).toBe("rule");
    expect(finderOf("case-id:german", "regex")).toBe("rule");
  });

  it("falls back to unknown", () => {
    expect(finderOf(undefined, "regex")).toBe("unknown");
    expect(finderOf("", "regex")).toBe("unknown");
  });
});

describe("detectorLabel", () => {
  it("keeps renaming-safe stable ids readable", () => {
    expect(detectorLabel("case-id:german")).toBe("case id (german)");
    expect(detectorLabel("known-value")).toBe("known value");
    expect(detectorLabel("known-value:.env")).toBe("known value (.env)");
    expect(detectorLabel("ner:1.2.3")).toBe("model (1.2.3)");
  });

  it("passes unknown ids through unchanged", () => {
    expect(detectorLabel("email")).toBe("email");
    expect(detectorLabel("something-new")).toBe("something-new");
  });
});
