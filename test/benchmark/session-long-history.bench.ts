/**
 * 长会话脱敏开销基准。
 *
 * 模拟 Pi 扩展每轮重扫历史：对同一会话逐字符串脱敏，历史条数取 50 / 200 两档。
 * 改造前后用同一脚本、同一输入，只比较总耗时。
 */
import { describe, bench } from "vitest";

import {
  createAnonymizer,
  InMemoryKeyProvider,
  InMemoryPIIStorageProvider,
  type Anonymizer,
} from "../../src/index.js";

/** 拼接构造，避免源码里出现真实邮箱字面量。 */
function emailAt(index: number): string {
  return [`user${index}`, "example.com"].join("@");
}

/** 构造一段历史：每条消息含一个邮箱与一些普通文本。 */
function history(size: number): string[] {
  return Array.from(
    { length: size },
    (_, i) => `第 ${i} 条记录：联系人 ${emailAt(i)}，其余内容保持不变。`,
  );
}

const SHORT_HISTORY = history(50);
const LONG_HISTORY = history(200);

let cached: Anonymizer | null = null;

async function getAnonymizer(): Promise<Anonymizer> {
  if (cached !== null) return cached;
  const anonymizer = createAnonymizer({
    ner: { mode: "disabled" },
    piiStorageProvider: new InMemoryPIIStorageProvider(),
    keyProvider: new InMemoryKeyProvider(),
  });
  await anonymizer.initialize();
  cached = anonymizer;
  return anonymizer;
}

/** 一轮：对整段历史逐字符串脱敏。 */
async function onePass(anonymizer: Anonymizer, texts: string[]): Promise<void> {
  const session = anonymizer.session("bench-session");
  for (const text of texts) {
    await session.anonymize(text);
  }
}

describe("长会话脱敏", () => {
  bench("50 条历史", async () => {
    const anonymizer = await getAnonymizer();
    await onePass(anonymizer, SHORT_HISTORY);
  });

  bench("200 条历史", async () => {
    const anonymizer = await getAnonymizer();
    await onePass(anonymizer, LONG_HISTORY);
  });

  bench("200 条历史重复扫描（已无新实体）", async () => {
    const anonymizer = await getAnonymizer();
    await onePass(anonymizer, LONG_HISTORY);
    await onePass(anonymizer, LONG_HISTORY);
  });
});
