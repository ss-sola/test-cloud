import { createHash } from 'node:crypto';
import {
  RELEASE_AUTOMATION_REDACTED_VALUE,
  RELEASE_AUTOMATION_SENSITIVE_KEY_PATTERN,
} from './release-automation.constants';

const SECRET_TEXT_PATTERN =
  /(bearer\s+|token|password|secret|authorization|api[_-]?key|access[_-]?key)\s*[:=]\s*([^\s,;]+)/gi;

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function payloadHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      SECRET_TEXT_PATTERN,
      (_match, label: string) => `${label}${RELEASE_AUTOMATION_REDACTED_VALUE}`,
    )
    .replace(/https?:\/\/[^\s]+/gi, redactUrl)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 256);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${RELEASE_AUTOMATION_REDACTED_VALUE}_PATH`;
  } catch {
    return `https://${RELEASE_AUTOMATION_REDACTED_VALUE}_URL`;
  }
}

export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      RELEASE_AUTOMATION_SENSITIVE_KEY_PATTERN.test(key)
        ? RELEASE_AUTOMATION_REDACTED_VALUE
        : redactObject(item),
    ]),
  );
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}
