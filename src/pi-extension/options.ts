/**
 * Pi extension 配置类型。
 *
 * 去掉只在服务端宿主上下文存在的字段：
 * - 不需要 `envBaseDirectory`（Pi 扩展以当前 `cwd` 为根）。
 *
 * 字段由用户在 `~/.pi/agent/settings.json` 的 `rehydra` 键提供；扩展只读取，不写。
 */
import type { AnonymizerConfig } from "../core/anonymizer.js";
import type {
  AnonymizationPolicy,
  TagFormat,
} from "../types/index.js";
import type { PIIType } from "../types/pii-types.js";

/** PII 类型字符串名集合。 */
export type PIITypeName = `${PIIType}`;

export interface RehydraPiExtensionOptions {
  /** Paths/globs relative to the Pi project directory (cwd). Defaults to recursive .env discovery. */
  envFiles?: string[];

  /** Explicit values to always redact. */
  redactValues?: string[];

  /** Minimum value length to consider a secret (default: 4). */
  minValueLength?: number;

  /** PII types to disable (default: ["URL", "IP_ADDRESS"]). Pass [] to enable all types. */
  disableTypes?: PIITypeName[];

  /** Locale hint for anonymization. */
  locale?: string;

  /** Redact identities found in Git and GitHub CLI output. */
  vcsIdentities?: boolean;
  /** 允许这些工具的参数里出现无法还原的字面标签（默认空 = 一律阻断）。 */
  allowLiteralTagsIn?: string[];

  /** Policy overrides applied to every scrub pass. */
  policy?: Partial<AnonymizationPolicy>;

  /** Advanced: full anonymizer config (overrides envFiles/redactValues/minValueLength). */
  anonymizer?: AnonymizerConfig;

  /** Tag format configuration. */
  tagFormat?: TagFormat;

  /** 脱敏记录：默认开启，落 SQLite，保存完整文本快照。 */
  record?: {
    enabled?: boolean;
    /** 是否保存原文与全文快照（默认 true）。 */
    includeOriginal?: boolean;
    keepDays?: number;
    keepBytes?: number;
    maxRecordBytes?: number;
    /** 记录目录，缺省为 `~/.pi/agent/rehydra/records`。 */
    dir?: string;
  };

  /** 模型检测不可用时的处理：默认降级为规则。 */
  nerFailure?: "rules" | "block";

  /** 本机脱敏查看页面：默认开启。 */
  dashboard?: {
    enabled?: boolean;
  };
}
