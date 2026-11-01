/**
 * Environment Variable Secret Recognizer
 * Detects secrets in .env-style KEY=VALUE lines
 */

import { PIIType, type SpanMatch, DetectionSource } from "../../types/index.js";
import type { Recognizer } from "../base.js";
import { isCredentialField } from "./key-patterns.js";

const ENV_VAR_LINE = /^[ \t]*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*["']?(.+?)["']?$/gm;

const PLACEHOLDER_VALUES = new Set([
  "changeme", "your-api-key-here", "your_api_key_here",
  "xxx", "yyy", "zzz", "todo", "fixme", "replace_me",
  "example", "test", "dummy", "placeholder",
]);

const DEFAULT_MIN_LENGTH = 4;

/** 代码里读取配置的方式，不是密钥本身。 */
const ENV_CODE_PREFIXES = ["process.env.", "os.environ", "os.getenv", "Deno.env."];

/** 判断值是否是代码引用（变量占位、调用、环境读取）。 */
function looksLikeEnvCodeReference(value: string): boolean {
  const first = value[0];
  if (first !== undefined && "$%{<*".includes(first)) return true;
  if (value.includes("(")) return true;
  return ENV_CODE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function createEnvVarSecretRecognizer(
  minValueLength: number = DEFAULT_MIN_LENGTH,
  extraKeyPatterns: RegExp[] = [],
): Recognizer {
  return {
    type: PIIType.ENV_VAR_SECRET,
    name: "Environment Variable Secret",
    defaultConfidence: 0.88,

    find(text: string): SpanMatch[] {
      const matches: SpanMatch[] = [];

      for (const match of text.matchAll(ENV_VAR_LINE)) {
        if (match.index === undefined) continue;
        const key = match[1]!;
        const value = match[2]!;

        // Check if key name suggests a secret
        const keyIsSecret =
          isCredentialField(key) ||
          extraKeyPatterns.some((p) => p.test(key));
        if (!keyIsSecret) continue;

        // Filter out short or placeholder values
        if (value.length < minValueLength) continue;
        if (PLACEHOLDER_VALUES.has(value.toLowerCase())) continue;
        if (looksLikeEnvCodeReference(value)) continue;

        // Span covers the VALUE portion only
        const fullLine = match[0];
        const valueStartInLine = fullLine.lastIndexOf(value);
        const valueStart = match.index + valueStartInLine;

        matches.push({
          type: PIIType.ENV_VAR_SECRET,
          start: valueStart,
          end: valueStart + value.length,
          confidence: 0.88,
          source: DetectionSource.REGEX,
          text: value,
        });
      }

      return matches;
    },
  };
}

export const envVarSecretRecognizer = createEnvVarSecretRecognizer();
