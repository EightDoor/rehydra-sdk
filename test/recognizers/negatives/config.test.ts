/**
 * 配置类负例：配置里的元数据字段不该被当秘密遮蔽。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Anonymizer } from "../../../src/index.js";
import {
  anonymizeWithPiPolicy,
  createPiAnonymizer,
} from "./helpers.js";

describe("negative cases: config", () => {
  let anonymizer: Anonymizer;

  beforeAll(async () => {
    anonymizer = await createPiAnonymizer();
  });

  afterAll(async () => {
    await anonymizer.dispose();
  });

  const cases: Array<[string, string]> = [
    ["计数器字段", '{\n  "token_count": 4096,\n  "max_tokens": 4096\n}'],
    ["方法与类型字段", '{\n  "auth_method": "oauth2",\n  "token_type": "bearer"\n}'],
    ["排序键与缓存键", '{\n  "sort_key": "created_at",\n  "cache_key": "user:42"\n}'],
    ["公钥字段", '{\n  "public_key": "ssh-rsa AAAAB3NzaC1yc2EAAAA"\n}'],
    ["普通配置项", '{\n  "host": "db.example.com",\n  "port": 5432\n}'],
  ];

  for (const [name, text] of cases) {
    it(`leaves ${name} alone`, async () => {
      const output = await anonymizeWithPiPolicy(anonymizer, text);
      expect(output).toBe(text);
    });
  }

  it("still masks a real credential in config", async () => {
    const output = await anonymizeWithPiPolicy(
      anonymizer,
      '{\n  "password": "Passw0rd123",\n  "api_token": "s3cret_hunter2_value"\n}',
    );
    expect(output).not.toContain("Passw0rd123");
    expect(output).not.toContain("s3cret_hunter2_value");
  });

  it("still masks an alphabetic password", async () => {
    const output = await anonymizeWithPiPolicy(
      anonymizer,
      '{\n  "password": "correcthorse"\n}',
    );
    expect(output).not.toContain("correcthorse");
  });

  it("still masks a numeric password", async () => {
    const output = await anonymizeWithPiPolicy(
      anonymizer,
      '{\n  "password": "918273645"\n}',
    );
    expect(output).not.toContain("918273645");
  });
});
