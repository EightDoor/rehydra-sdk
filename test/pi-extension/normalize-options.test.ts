/**
 * 共享选项规范化测试（Pi 扩展路径）。
 *
 * 重点锁住 envBaseDirectory 的回退：未显式配置时必须落在 ctxDirectory（cwd），
 * 不再回退到任何宿主专属配置目录。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECORD_OPTIONS,
  anonymizerConfigFromOptions,
  normalizeRehydraOptions,
  policyFromOptions,
} from "../../src/host-agnostic/normalize-options.js";

describe("anonymizerConfigFromOptions", () => {
  it("falls back to ctxDirectory (cwd) as the envFiles root", () => {
    const options = normalizeRehydraOptions({ envFiles: [".env"] });
    const config = anonymizerConfigFromOptions(options, "/project");
    expect(config.secrets?.envBaseDirectory).toBe("/project");
  });

  it("preserves an explicit secrets.envBaseDirectory", () => {
    const options = normalizeRehydraOptions({
      anonymizer: { secrets: { envBaseDirectory: "/custom" } },
    });
    const config = anonymizerConfigFromOptions(options, "/project");
    expect(config.secrets?.envBaseDirectory).toBe("/custom");
  });
});

describe("normalizeRehydraOptions", () => {
  it("ignores unknown fields and falls back malformed values to defaults", () => {
    const options = normalizeRehydraOptions({
      unknownField: 1,
      minValueLength: -3,
      envFiles: "not-an-array",
    });
    expect(options.minValueLength).toBe(4);
    expect(options.envFiles).toEqual(["**/.env*"]);
    expect("unknownField" in options).toBe(false);
  });

  it("keeps the default disabled types", () => {
    const options = normalizeRehydraOptions({});
    expect(options.disableTypes).toEqual([
      "URL",
      "IP_ADDRESS",
      "BIC_SWIFT",
      "POSTAL_CODE",
      "DATE",
    ]);
  });

  it("lets the user restore the shape-based types", () => {
    const options = normalizeRehydraOptions({ disableTypes: ["URL", "IP_ADDRESS"] });
    const policy = policyFromOptions(options);
    expect(policy?.regexEnabledTypes?.has("BIC_SWIFT")).toBe(true);
    expect(policy?.regexEnabledTypes?.has("DATE")).toBe(true);
  });

  it("normalizes a JSON-style policy instead of crashing on it", () => {
    const options = normalizeRehydraOptions({
      policy: { allowlistTerms: ["foo"], confidenceThresholds: { PERSON: 0.8 } },
    });
    const policy = policyFromOptions(options);
    expect(policy?.allowlistTerms).toEqual(new Set(["foo"]));
    expect(policy?.confidenceThresholds?.get("PERSON")).toBe(0.8);
  });

  it("reports an invalid policy field instead of dropping it", () => {
    const options = normalizeRehydraOptions({
      policy: { allowlistTerms: 42 },
    });
    expect(() => policyFromOptions(options)).toThrow(/policy\.allowlistTerms/);
  });
});

describe("record retention defaults", () => {
  it("keeps records for 7 days with a 300 MiB cap by default", () => {
    expect(DEFAULT_RECORD_OPTIONS.keepDays).toBe(7);
    expect(DEFAULT_RECORD_OPTIONS.keepBytes).toBe(300 * 1024 * 1024);
  });

  it("honours explicit retention settings", () => {
    const record = normalizeRehydraOptions({ record: { keepDays: 3, keepBytes: 1024 } }).record;
    expect(record?.keepDays).toBe(3);
    expect(record?.keepBytes).toBe(1024);
  });
});

describe("nerFailure resolution", () => {
  it("defaults to rules", () => {
    expect(normalizeRehydraOptions({}).nerFailure).toBe("rules");
  });

  it("honours the top-level setting", () => {
    expect(normalizeRehydraOptions({ nerFailure: "block" }).nerFailure).toBe("block");
  });

  it("lets the explicit anonymizer config win over the default", () => {
    const normalized = normalizeRehydraOptions({ anonymizer: { nerFailure: "block" } });
    expect(normalized.nerFailure).toBe("block");
  });

  it("prefers the anonymizer config over the shortcut", () => {
    const normalized = normalizeRehydraOptions({
      nerFailure: "rules",
      anonymizer: { nerFailure: "block" },
    });
    expect(normalized.nerFailure).toBe("block");
  });

  it("ignores unknown values", () => {
    expect(
      normalizeRehydraOptions({ nerFailure: "maybe", anonymizer: { nerFailure: "nah" } })
        .nerFailure,
    ).toBe("rules");
  });
});
