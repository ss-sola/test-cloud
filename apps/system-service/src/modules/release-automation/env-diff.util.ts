import { sha256 } from './release-automation.security';
import {
  RELEASE_AUTOMATION_REDACTED_VALUE,
  RELEASE_AUTOMATION_SENSITIVE_KEY_PATTERN,
} from './release-automation.constants';
import type { EnvDiffEntry, EnvDiffResult } from './release-automation.types';

interface ParsedEnvValue {
  normalized: string;
  sensitive: boolean;
}

export function parseEnv(text: string): Map<string, ParsedEnvValue> {
  const result = new Map<string, ParsedEnvValue>();
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const key = assignment[1];
    const rawValue = assignment[2].trim();
    const normalized = normalizeEnvValue(rawValue);
    result.set(key, {
      normalized,
      sensitive: RELEASE_AUTOMATION_SENSITIVE_KEY_PATTERN.test(key),
    });
  }
  return result;
}

export function normalizeEnvValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value
        .slice(1, -1)
        .replace(/\\([\\"'])/g, '$1')
        .trim();
    }
  }
  return value.trim();
}

export function diffEnv(beforeText: string, afterText: string): EnvDiffResult {
  const before = parseEnv(beforeText);
  const after = parseEnv(afterText);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  const result: EnvDiffResult = {
    added: [],
    removed: [],
    changed: [],
    unchanged: [],
    beforeChecksum: sha256(beforeText),
    afterChecksum: sha256(afterText),
  };

  for (const key of keys) {
    const previous = before.get(key);
    const current = after.get(key);
    const sensitive = previous?.sensitive || current?.sensitive || false;
    const status = !previous
      ? 'added'
      : !current
        ? 'removed'
        : previous.normalized !== current.normalized
          ? 'changed'
          : 'unchanged';
    const entry: EnvDiffEntry = {
      key,
      status,
      beforeValue: sensitive ? RELEASE_AUTOMATION_REDACTED_VALUE : (previous?.normalized ?? ''),
      afterValue: sensitive ? RELEASE_AUTOMATION_REDACTED_VALUE : (current?.normalized ?? ''),
      sensitive,
    };
    result[status].push(entry);
  }
  return result;
}
