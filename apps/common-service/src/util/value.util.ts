/** Stateless conversions shared by controllers and services. */
export class ValueUtil {
  static toStringValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    return undefined;
  }

  static toBoolean(value: unknown, defaultValue = false): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    const normalized = ValueUtil.toStringValue(value)?.toLowerCase();
    if (normalized === undefined) {
      return defaultValue;
    }

    return normalized === 'true';
  }

  static parseBoolean(value: unknown, defaultValue = false): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    const normalized = ValueUtil.toStringValue(value)?.toLowerCase();
    if (normalized === undefined) {
      return defaultValue;
    }

    return normalized !== 'false';
  }

  static isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  static parseJsonValue(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }

    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
}
