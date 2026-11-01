/**
 * Shared secret key name patterns
 * Used by ENV_VAR_SECRET and CONFIG_SECRET recognizers
 */

const SECRET_KEY_PATTERN = /^(?:.*_)?(?:password|passwd|pwd|pass|secret|secret_key|secretkey|token|access_token|refresh_token|auth_token|api_key|apikey|api_secret|private_key|privatekey|credential|credentials|connection_string|connectionstring|database_url|dsn|encryption_key|signing_key|client_secret|app_secret|master_key|auth|bearer|jwt|api_token)(?:_.*)?$/i;

/**
 * 元数据字段的整名：这些名字里虽然含敏感词，但存的是计数、类型、缓存键之类的
 * 元信息，不是凭证本身。
 */
const METADATA_KEY_NAMES = new Set([
  "sort_key",
  "cache_key",
  "public_key",
  "prompt_cache_key",
  "keyboard",
  "token_count",
  "auth_method",
]);

/**
 * 元数据字段的后缀。`scope: "all"` 表示对所有敏感词生效（路径、计数这类永远
 * 不是密钥值）；`scope: "ambiguous"` 只对语义不明确的词生效，避免误伤
 * `database_url` 这类确实是凭证的名字。
 */
const METADATA_SUFFIXES: Array<{ suffix: string; scope: "all" | "ambiguous" }> = [
  { suffix: "_count", scope: "all" },
  { suffix: "_len", scope: "all" },
  { suffix: "_size", scope: "all" },
  { suffix: "_name", scope: "all" },
  { suffix: "_enabled", scope: "all" },
  { suffix: "_disabled", scope: "all" },
  { suffix: "_expires", scope: "all" },
  { suffix: "_expiry", scope: "all" },
  { suffix: "_ttl", scope: "all" },
  { suffix: "_mode", scope: "all" },
  { suffix: "_format", scope: "all" },
  { suffix: "_version", scope: "all" },
  { suffix: "_prefix", scope: "all" },
  { suffix: "_suffix", scope: "all" },
  { suffix: "_algorithm", scope: "all" },
  { suffix: "_algo", scope: "all" },
  { suffix: "_provider", scope: "all" },
  { suffix: "_class", scope: "all" },
  { suffix: "_index", scope: "all" },
  { suffix: "_limit", scope: "all" },
  { suffix: "_max", scope: "all" },
  { suffix: "_min", scope: "all" },
  { suffix: "_path", scope: "all" },
  { suffix: "_dir", scope: "all" },
  { suffix: "_file", scope: "all" },
  { suffix: "_label", scope: "all" },
  { suffix: "_scheme", scope: "all" },
  { suffix: "_host", scope: "all" },
  { suffix: "_port", scope: "all" },
  { suffix: "_region", scope: "all" },
  { suffix: "_bucket", scope: "all" },
  { suffix: "_id", scope: "all" },
  { suffix: "_type", scope: "ambiguous" },
  { suffix: "_method", scope: "ambiguous" },
  { suffix: "_timeout", scope: "ambiguous" },
  { suffix: "_endpoint", scope: "ambiguous" },
  { suffix: "_url", scope: "ambiguous" },
];

/** 明确是凭证的名字，即使以元数据后缀结尾也不排除。 */
const CREDENTIAL_NAME_OVERRIDES = new Set(["database_url", "connection_string", "dsn"]);

/** 语义明确、不会指代元数据的敏感词。 */
const UNAMBIGUOUS_SECRET_WORDS = [
  "password",
  "passwd",
  "pwd",
  "pass",
  "secret_key",
  "secretkey",
  "api_key",
  "apikey",
  "api_secret",
  "private_key",
  "privatekey",
  "connection_string",
  "connectionstring",
  "database_url",
  "dsn",
  "encryption_key",
  "signing_key",
  "client_secret",
  "app_secret",
  "master_key",
];

/**
 * Checks if a key/variable name suggests it holds a secret value.
 * Handles snake_case, camelCase, and kebab-case.
 */
export function isSecretKeyName(key: string): boolean {
  // Normalize camelCase/PascalCase to snake_case for matching
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/-/g, "_");
  return SECRET_KEY_PATTERN.test(normalized);
}

/** 把键名归一化成 snake_case，便于按后缀判断。 */
export function normalizeKeyName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

/**
 * 判断键名是否真的存放凭证。
 *
 * `isSecretKeyName` 只看词，`token_count`、`auth_method` 这类元数据字段同样
 * 含敏感词；这里把它们与真正的凭证字段区分开。
 */
export function isCredentialField(key: string): boolean {
  const normalized = normalizeKeyName(key);
  if (!isSecretKeyName(normalized)) return false;
  if (CREDENTIAL_NAME_OVERRIDES.has(normalized)) return true;
  if (METADATA_KEY_NAMES.has(normalized)) return false;

  const ambiguous = !UNAMBIGUOUS_SECRET_WORDS.some(
    (word) => normalized === word || normalized.endsWith(`_${word}`),
  );
  for (const { suffix, scope } of METADATA_SUFFIXES) {
    if (!normalized.endsWith(suffix)) continue;
    if (scope === "all" || ambiguous) return false;
  }
  return true;
}

/** 标识符或带点的字段路径，如 `details.2`、`device.privateKey`。 */
const IDENTIFIER_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

/** 变量占位与遮罩形式。 */
const PLACEHOLDER_PREFIX = /^[$%{<*]/;

/**
 * 判断一个值是不是"代码在引用秘密"而不是"秘密本身"。
 *
 * 判定依据与 Magpie 一致：代码里写的密钥是字符串（带引号），不带引号且紧跟
 * `": "` 的标识符路径多半是类型或字段引用（`secretKey: Uint8Array;`、
 * `private_key: details.2,`），而赋值号后或行尾的裸值按真实密钥处理。
 */
export function looksLikeCodeReference(
  text: string,
  start: number,
  end: number,
): boolean {
  const raw = text.slice(start, end);
  const value = raw.replace(/[;,)\]}]+$/, "");
  if (value.length === 0) return true;
  if (PLACEHOLDER_PREFIX.test(value)) return true;
  if (value.includes("(")) return true;
  // 不是标识符形态：带引号或含特殊字符的真实凭证
  if (!IDENTIFIER_PATH.test(value)) return false;

  const before = text.slice(0, start);
  if (before.endsWith('"') || before.endsWith("'")) return false;
  if (!/:[ \t]*$/.test(before)) return false;

  // 捕获值里带的结尾标点，加上其后紧跟的字符，构成 Magpie 的 "rest"
  const rest = (raw.slice(value.length) + text.slice(end)).replace(/^[ \t]*/, "");
  if (rest.length === 0) return false;
  const first = rest[0] as string;
  // 字段路径加语句标点：`private_key: details.2,`
  if (value.includes(".") && ";,)]}".includes(first)) return true;
  // 语句结束标点：`secretKey: Uint8Array;`
  return ";)]}".includes(first);
}
