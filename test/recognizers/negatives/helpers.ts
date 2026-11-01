/**
 * 负例回归集的公共入口。
 *
 * 断言走完整的匿名化管线（策略过滤 → 识别器 → 冲突解决 → 打标签），
 * 而不是单个正则，这样跨识别器的误遮蔽也能被捕获。
 *
 * 策略用 Pi 扩展的默认策略：形状级类型默认关闭。
 */
import {
  createAnonymizer,
  InMemoryKeyProvider,
  type Anonymizer,
  type AnonymizationPolicy,
} from "../../../src/index.js";
import {
  normalizeRehydraOptions,
  policyFromOptions,
} from "../../../src/host-agnostic/normalize-options.js";

/** 创建带 Pi 默认策略与 secret 识别的匿名器。 */
export async function createPiAnonymizer(): Promise<Anonymizer> {
  const anonymizer = createAnonymizer({
    keyProvider: new InMemoryKeyProvider(),
    secrets: { enabled: true },
  });
  await anonymizer.initialize();
  return anonymizer;
}

/** Pi 扩展实际使用的策略。 */
export function piPolicy(): Partial<AnonymizationPolicy> {
  return policyFromOptions(normalizeRehydraOptions({})) ?? {};
}

/** 用 Pi 默认策略跑一次匿名化，返回替换后的文本。 */
export async function anonymizeWithPiPolicy(
  anonymizer: Anonymizer,
  text: string,
): Promise<string> {
  const result = await anonymizer.anonymize(text, undefined, piPolicy());
  return result.anonymizedText;
}
