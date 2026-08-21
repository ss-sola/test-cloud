import { describe, it, expect } from 'vitest';
import { ValueUtil } from '../../util/value.util';

describe('ValueUtil', () => {
  it('should convert scalar values to strings safely', () => {
    expect(ValueUtil.toStringValue('hello')).toBe('hello');
    expect(ValueUtil.toStringValue(123)).toBe('123');
    expect(ValueUtil.toStringValue(true)).toBe('true');
    expect(ValueUtil.toStringValue({})).toBeUndefined();
  });

  it('should normalize boolean-like values with defaults', () => {
    expect(ValueUtil.toBoolean(true)).toBe(true);
    expect(ValueUtil.toBoolean('true')).toBe(true);
    expect(ValueUtil.toBoolean('false')).toBe(false);
    expect(ValueUtil.toBoolean(undefined, true)).toBe(true);

    expect(ValueUtil.parseBoolean(true)).toBe(true);
    expect(ValueUtil.parseBoolean('false')).toBe(false);
    expect(ValueUtil.parseBoolean('other')).toBe(true);
    expect(ValueUtil.parseBoolean(undefined, true)).toBe(true);
  });

  it('should detect plain objects and parse json strings', () => {
    expect(ValueUtil.isObject({ a: 1 })).toBe(true);
    expect(ValueUtil.isObject([])).toBe(false);
    expect(ValueUtil.isObject(null)).toBe(false);

    expect(ValueUtil.parseJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(ValueUtil.parseJsonValue('not-json')).toBe('not-json');
    expect(ValueUtil.parseJsonValue(1)).toBe(1);
  });
});
