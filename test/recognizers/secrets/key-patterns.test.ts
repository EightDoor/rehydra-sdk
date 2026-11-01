/**
 * 凭证字段名与代码引用判断的单元测试。
 */
import { describe, it, expect } from "vitest";
import {
  isCredentialField,
  isSecretKeyName,
  looksLikeCodeReference,
  normalizeKeyName,
} from "../../../src/recognizers/secrets/key-patterns.js";

describe("isSecretKeyName", () => {
  it("matches credential-like names", () => {
    for (const key of [
      "PASSWORD",
      "api_key",
      "apiKey",
      "client_secret",
      "DATABASE_PASSWORD",
      "AUTH_TOKEN",
    ]) {
      expect(isSecretKeyName(key), key).toBe(true);
    }
  });

  it("does not match unrelated names", () => {
    for (const key of ["NODE_ENV", "PORT", "host", "username"]) {
      expect(isSecretKeyName(key), key).toBe(false);
    }
  });
});

describe("normalizeKeyName", () => {
  it("normalizes camelCase, kebab-case and spaces", () => {
    expect(normalizeKeyName("apiKey")).toBe("api_key");
    expect(normalizeKeyName("API-KEY")).toBe("api_key");
    expect(normalizeKeyName("Auth Method")).toBe("auth_method");
  });
});

describe("isCredentialField", () => {
  it("accepts real credential fields", () => {
    for (const key of [
      "PASSWORD",
      "password",
      "api_key",
      "apiKey",
      "client_secret",
      "DATABASE_PASSWORD",
      "AUTH_TOKEN",
      "access_token",
      "private_key",
      "encryption_key",
      "signing_key",
      "master_key",
      "database_url",
      "connection_string",
      "dsn",
    ]) {
      expect(isCredentialField(key), key).toBe(true);
    }
  });

  it("rejects metadata fields that only mention a secret word", () => {
    for (const key of [
      "token_count",
      "auth_method",
      "token_type",
      "max_tokens_count",
      "secret_name",
      "sort_key",
      "cache_key",
      "public_key",
      "prompt_cache_key",
      "keyboard",
      "api_key_type",
      "secret_path",
      "private_key_file",
    ]) {
      expect(isCredentialField(key), key).toBe(false);
    }
  });

  it("rejects fields that are not secret-like at all", () => {
    for (const key of ["NODE_ENV", "PORT", "host", "username"]) {
      expect(isCredentialField(key), key).toBe(false);
    }
  });
});

describe("looksLikeCodeReference", () => {
  /** 判断 text 中 value 部分是否被当作代码引用。 */
  const check = (text: string, value: string): boolean => {
    const start = text.indexOf(value);
    return looksLikeCodeReference(text, start, start + value.length);
  };

  it("treats type and field references after a colon as code", () => {
    expect(check("secretKey: Uint8Array;", "Uint8Array")).toBe(true);
    expect(check("private_key: details.2,", "details.2")).toBe(true);
    expect(check("privateKey: device.privateKey,", "device.privateKey")).toBe(true);
    expect(check("secretKey: toBase64Url(x)", "toBase64Url(x)")).toBe(true);
  });

  it("keeps a bare identifier as a real secret", () => {
    expect(check("Uint8Array;", "Uint8Array")).toBe(false);
    expect(check("details.2", "details.2")).toBe(false);
  });

  it("treats placeholders as code", () => {
    expect(check("${TOKEN}", "${TOKEN}")).toBe(true);
    expect(check("{{SECRET}}", "{{SECRET}}")).toBe(true);
    expect(check("<token>", "<token>")).toBe(true);
  });

  it("treats a quoted value as a real secret", () => {
    expect(check("'hunter2'", "hunter2")).toBe(false);
    expect(check('"hunter2"', "hunter2")).toBe(false);
  });

  it("treats a value after an assignment as a real secret", () => {
    expect(check("hunter2", "hunter2")).toBe(false);
    expect(check("Passw0rd123", "Passw0rd123")).toBe(false);
  });

  it("only applies the colon context", () => {
    const text = "secretKey: Uint8Array;";
    const start = text.indexOf("Uint8Array");
    expect(looksLikeCodeReference(text, start, text.length)).toBe(true);
  });
});
