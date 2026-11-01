/**
 * 策略配置规范化的单元测试。
 */
import { describe, it, expect } from "vitest";
import { normalizePolicyInput } from "../../src/host-agnostic/policy-input.js";
import { PIIType } from "../../src/types/index.js";

describe("normalizePolicyInput", () => {
  it("normalizes array forms into sets", () => {
    const result = normalizePolicyInput({
      enabledTypes: ["EMAIL", "PHONE"],
      regexEnabledTypes: ["EMAIL"],
      nerEnabledTypes: ["PERSON"],
      typePriority: ["EMAIL"],
      allowlistTerms: ["foo", "bar"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.enabledTypes).toEqual(new Set([PIIType.EMAIL, PIIType.PHONE]));
    expect(result.policy.regexEnabledTypes).toEqual(new Set([PIIType.EMAIL]));
    expect(result.policy.nerEnabledTypes).toEqual(new Set([PIIType.PERSON]));
    expect(result.policy.typePriority).toEqual([PIIType.EMAIL]);
    expect(result.policy.allowlistTerms).toEqual(new Set(["foo", "bar"]));
  });

  it("accepts programmatic Set and Map forms", () => {
    const result = normalizePolicyInput({
      enabledTypes: new Set([PIIType.EMAIL]),
      allowlistTerms: new Set(["foo"]),
      confidenceThresholds: new Map([[PIIType.PERSON, 0.8]]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.enabledTypes).toEqual(new Set([PIIType.EMAIL]));
    expect(result.policy.allowlistTerms).toEqual(new Set(["foo"]));
    expect(result.policy.confidenceThresholds?.get(PIIType.PERSON)).toBe(0.8);
  });

  it("normalizes threshold objects", () => {
    const result = normalizePolicyInput({
      confidenceThresholds: { PERSON: 0.85, EMAIL: 0.6 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.confidenceThresholds?.get(PIIType.PERSON)).toBe(0.85);
    expect(result.policy.confidenceThresholds?.get(PIIType.EMAIL)).toBe(0.6);
  });

  it("compiles denylist pattern strings", () => {
    const result = normalizePolicyInput({ denylistPatterns: ["\\d{4}"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const patterns = result.policy.denylistPatterns ?? [];
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.test("1234")).toBe(true);
  });

  it("rejects a malformed allowlist with the field name", () => {
    const result = normalizePolicyInput({ allowlistTerms: 42 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("policy.allowlistTerms");
  });

  it("rejects a threshold outside the valid range", () => {
    const result = normalizePolicyInput({ confidenceThresholds: { PERSON: 5 } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("policy.confidenceThresholds");
  });

  it("rejects an invalid denylist pattern", () => {
    const result = normalizePolicyInput({ denylistPatterns: ["("] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("policy.denylistPatterns");
  });

  it("rejects a non-object policy", () => {
    const result = normalizePolicyInput("nope");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("policy");
  });

  it("treats missing policy as empty", () => {
    const result = normalizePolicyInput(undefined);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy).toEqual({});
  });
});
