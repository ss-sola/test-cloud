import { describe, it, expect } from 'vitest';
import { ResponseUtil } from '../../util/response.util';

describe('ResponseUtil', () => {
  it('should build success responses with defaults and overrides', () => {
    expect(ResponseUtil.success({ ok: true })).toEqual({
      data: { ok: true },
      message: 'ok',
      code: 200,
    });

    expect(ResponseUtil.success(['x'], 'created', 201)).toEqual({
      data: ['x'],
      message: 'created',
      code: 201,
    });
  });

  it('should build error responses with defaults and overrides', () => {
    expect(ResponseUtil.error()).toEqual({
      data: null,
      message: '服务器错误无可奉告',
      code: 500,
    });

    expect(ResponseUtil.error('bad request', 400)).toEqual({
      data: null,
      message: 'bad request',
      code: 400,
    });
  });
});
