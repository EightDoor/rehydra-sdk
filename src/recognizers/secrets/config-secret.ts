/**
 * Config Secret Recognizer
 * Detects key-value secrets in JSON, YAML, and TOML
 */

import { PIIType, type SpanMatch, DetectionSource } from "../../types/index.js";
import type { Recognizer } from "../base.js";
import { isCredentialField, looksLikeCodeReference } from "./key-patterns.js";

// JSON: "key": "value" or 'key': 'value'
const JSON_SECRET = /["']([a-zA-Z_][a-zA-Z0-9_.-]*)["']\s*:\s*["']([^"'\n]{4,})["']/g;

// YAML: key: value (unquoted or quoted)
const YAML_SECRET = /^[ \t]*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*:\s*["']?([^\n"'#]{4,})["']?$/gm;

// TOML: key = "value"
const TOML_SECRET = /^[ \t]*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*=\s*["']([^"'\n]{4,})["']$/gm;

const DEFAULT_MIN_LENGTH = 4;

export function createConfigSecretRecognizer(
  minValueLength: number = DEFAULT_MIN_LENGTH,
  extraKeyPatterns: RegExp[] = [],
): Recognizer {
  return {
    type: PIIType.CONFIG_SECRET,
    name: "Config Secret",
    id: 'config-secret',
    defaultConfidence: 0.85,

    find(text: string): SpanMatch[] {
      const matches: SpanMatch[] = [];
      const seen = new Set<string>();

      const patterns = [JSON_SECRET, YAML_SECRET, TOML_SECRET];

      for (const pattern of patterns) {
        const p = new RegExp(pattern.source, pattern.flags);
        for (const match of text.matchAll(p)) {
          if (match.index === undefined) continue;
          const key = match[1]!;
          const value = match[2]!.trim();
          if (value.length === 0) continue;

          const keyIsSecret =
            isCredentialField(key) ||
            extraKeyPatterns.some((pat) => pat.test(key));
          if (!keyIsSecret) continue;
          if (value.length < minValueLength) continue;

          // Find exact position of value in the matched text
          const fullMatch = match[0];
          const valueStartInMatch = fullMatch.lastIndexOf(value);
          const valueStart = match.index + valueStartInMatch;
          const valueEnd = valueStart + value.length;
          // 代码里引用秘密（类型、字段读取）不是秘密本身
          if (looksLikeCodeReference(text, valueStart, valueEnd)) continue;
          const spanKey = `${valueStart}:${valueEnd}`;
          if (seen.has(spanKey)) continue;
          seen.add(spanKey);

          matches.push({
            type: PIIType.CONFIG_SECRET,
            start: valueStart,
            end: valueEnd,
            confidence: 0.85,
            source: DetectionSource.REGEX,
            text: value,
          });
        }
      }

      return matches;
    },
  };
}

export const configSecretRecognizer = createConfigSecretRecognizer();
