import { resolve } from 'node:path';
import { Body, Controller, Post, ValidationPipe, HttpException, HttpStatus } from '@nestjs/common';
import type { ExceptionFilter, INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_COMPARE_LIMITS } from '../constants/content-compare.constants';
import { ContentCompareController } from '../modules/content-compare/content-compare.controller';
import { CompareContentDto } from '../modules/content-compare/dto/compare-content.dto';
import { ContentCompareHttpService } from '../modules/content-compare/content-compare-http.service';
import { ContentCompareException } from '../modules/content-compare/content-compare.exception';
import { ContentCompareService } from '../modules/content-compare/content-compare.service';
import type { ContentCompareResult } from '../modules/content-compare/content-compare.types';

const SECRET = 'SECRET_TOKEN_9f3a7c';
const COMPARE_PATH = '/api/content-compare';

const RESULT: ContentCompareResult = {
  leftText: '{}',
  rightText: '{}',
  stats: { added: 0, removed: 0, modified: 0 },
  tree: {
    key: '$',
    path: '$',
    hasLeft: true,
    hasRight: true,
    type: 'object',
    status: 'unchanged',
    leftDisplay: '{0}',
    rightDisplay: '{0}',
    children: [],
  },
  segments: { left: [{ text: '{}', status: null }], right: [{ text: '{}', status: null }] },
};

/** 其他路由用于确认比较路径之外的 body 行为不变。 */
@Controller('api/other')
class EchoController {
  @Post('echo')
  echo(@Body() body: Record<string, unknown>) {
    return { received: body };
  }
}

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(level: string, args: unknown[]) {
    this.lines.push(
      `${level} ${args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')}`,
    );
  }
  log(...args: unknown[]) {
    this.push('log', args);
  }
  error(...args: unknown[]) {
    this.push('error', args);
  }
  warn(...args: unknown[]) {
    this.push('warn', args);
  }
  debug(...args: unknown[]) {
    this.push('debug', args);
  }
  verbose(...args: unknown[]) {
    this.push('verbose', args);
  }
}

/**
 * vitest 的转译器不输出 emitDecoratorMetadata；这里补齐 tsc 构建会产生的 design:* 元数据，
 * 让构造注入、@Body 的 DTO 校验和隐式类型转换与生产行为一致。
 */
function emulateDecoratorMetadata() {
  Reflect.defineMetadata('design:paramtypes', [ContentCompareService], ContentCompareController);
  for (const method of ['compareJson', 'compareEnv']) {
    Reflect.defineMetadata(
      'design:paramtypes',
      [CompareContentDto],
      ContentCompareController.prototype,
      method,
    );
  }
  Reflect.defineMetadata('design:paramtypes', [Object], EchoController.prototype, 'echo');
  for (const field of ['left', 'right']) {
    Reflect.defineMetadata('design:type', String, CompareContentDto.prototype, field);
  }
}

const compare = vi.fn();
let logger: CaptureLogger;
let app: INestApplication;

/** 按 common-service bootstrap 的装配顺序创建应用：专用边界 -> 访问日志 -> 全局 filter/pipe。 */
async function createApp(globalPrefix = ''): Promise<INestApplication> {
  if (globalPrefix) process.env.GlobalPrefix = globalPrefix;
  else delete process.env.GlobalPrefix;

  emulateDecoratorMetadata();
  const moduleRef = await Test.createTestingModule({
    controllers: [ContentCompareController, EchoController],
    providers: [
      ContentCompareHttpService,
      { provide: ContentCompareService, useValue: { compare } },
    ],
  }).compile();
  const nestApp = moduleRef.createNestApplication();
  nestApp.useLogger(logger);
  if (globalPrefix) nestApp.setGlobalPrefix(globalPrefix);

  nestApp.get(ContentCompareHttpService).mount(nestApp);
  nestApp.use((req: Request, res: Response, next: NextFunction) => {
    // 与生产访问日志相同读取 finish 时的 req.body；此处不要求 req.route，比生产更严格
    res.on('finish', () => {
      logger.debug(
        JSON.stringify({ url: req.originalUrl, body: req.body || {}, status: res.statusCode }),
        'HttpAccess',
      );
    });
    next();
  });
  const filterModule = resolve(__dirname, '../../../common-service/src/exception/global.filter.ts');
  const { GlobalExceptionFilter } = (await import(filterModule)) as {
    GlobalExceptionFilter: new () => ExceptionFilter;
  };
  nestApp.useGlobalFilters(new GlobalExceptionFilter());
  nestApp.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      whitelist: true,
      forbidNonWhitelisted: false,
      validationError: { value: true, target: true },
      exceptionFactory: (e) => {
        throw new HttpException(e, HttpStatus.BAD_REQUEST);
      },
    }),
  );
  await nestApp.init();
  return nestApp;
}

function server() {
  return request(app.getHttpServer());
}

/** 等待 response finish 监听执行完毕后再检查日志。 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function allLogs() {
  return logger.lines.join('\n');
}

function expectNoSecret(response: { text: string }) {
  expect(response.text).not.toContain(SECRET);
  expect(allLogs()).not.toContain(SECRET);
}

beforeEach(async () => {
  compare.mockReset();
  compare.mockReturnValue(RESULT);
  logger = new CaptureLogger();
  app = await createApp();
});

afterEach(async () => {
  await app?.close();
  delete process.env.GlobalPrefix;
});

describe('content compare HTTP success path', () => {
  it.each([
    ['json', '{"10":1,"2":"old"}', '{"2":"new","10":1}'],
    ['env', `﻿# 配置\r\nTOKEN=${SECRET}\rNAME=old`, `TOKEN=${SECRET}\nNAME=new`],
  ] as const)('runs the real %s comparison through HTTP', async (format, left, right) => {
    const service = new ContentCompareService();
    compare.mockImplementation((input) => service.compare(input));

    const response = await server().post(`${COMPARE_PATH}/${format}`).send({ left, right });
    await flush();

    expect(response.status).toBe(200);
    expect(response.body.data.stats).toEqual({ added: 0, removed: 0, modified: 1 });
    for (const side of ['left', 'right'] as const) {
      expect(
        response.body.data.segments[side].map((segment: { text: string }) => segment.text).join(''),
      ).toBe(response.body.data[`${side}Text`]);
    }
    expect(response.body.data.leftText).toBe(
      format === 'env' ? left : '{\n  "10": 1,\n  "2": "old"\n}',
    );
    expect(response.body.data.rightText).toBe(
      format === 'env' ? right : '{\n  "10": 1,\n  "2": "new"\n}',
    );
    expect(allLogs()).not.toContain(SECRET);
  });

  it.each(['json', 'env'] as const)('returns 200 with no-store for %s', async (format) => {
    const response = await server()
      .post(`${COMPARE_PATH}/${format}`)
      .send({ left: `left ${SECRET}`, right: 'right' });
    await flush();

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ data: RESULT, message: 'ok', code: 200 });
    expect(compare).toHaveBeenCalledWith({ format, left: `left ${SECRET}`, right: 'right' });
    // 访问日志在 finish 时 body 已被清空，不含比较原文
    expect(allLogs()).toContain('"body":{}');
    expect(allLogs()).not.toContain(SECRET);
  });

  it('mounts the boundary under the global prefix', async () => {
    await app?.close();
    app = await createApp('nest');

    const prefixed = await server()
      .post(`/nest${COMPARE_PATH}/json`)
      .send({ left: '{}', right: '{}' });
    expect(prefixed.status).toBe(200);
    expect(prefixed.headers['cache-control']).toBe('no-store');

    const unprefixed = await server()
      .post(`${COMPARE_PATH}/json`)
      .send({ left: SECRET, right: '{}' });
    await flush();
    expect(unprefixed.status).toBe(404);
    expect(compare).toHaveBeenCalledTimes(1);
    expectNoSecret(unprefixed);
  });

  it('keeps request body for routes outside the compare path', async () => {
    const response = await server().post('/api/other/echo').send({ hello: 'world', n: 1 });
    await flush();

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ received: { hello: 'world', n: 1 } });
    expect(allLogs()).toContain('"body":{"hello":"world","n":1}');
  });
});

describe('content compare HTTP errors', () => {
  it.each([
    ['json', SECRET],
    ['env', `TOKEN=${SECRET}\nTOKEN=again`],
  ] as const)('returns safe side errors from the real %s parser', async (format, left) => {
    const service = new ContentCompareService();
    compare.mockImplementation((input) => service.compare(input));

    const response = await server()
      .post(`${COMPARE_PATH}/${format}`)
      .send({ left, right: format === 'json' ? '{}' : 'TOKEN=ok' });
    await flush();

    expect(response.status).toBe(400);
    expect(response.body.errors.left.length).toBeGreaterThan(0);
    expect(response.body.errors.right).toEqual([]);
    expectNoSecret(response);
  });

  it('returns parse errors per side without extra fields', async () => {
    compare.mockImplementation(() => {
      throw new ContentCompareException('输入解析失败', {
        left: [
          { code: 'JSON_SYNTAX', message: '语法错误', line: 1, column: 2, extra: SECRET } as never,
        ],
        right: [],
      });
    });

    const response = await server()
      .post(`${COMPARE_PATH}/json`)
      .send({ left: SECRET, right: '{}' });
    await flush();

    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      data: null,
      message: '输入解析失败',
      code: 400,
      errors: {
        left: [{ code: 'JSON_SYNTAX', message: '语法错误', line: 1, column: 2 }],
        right: [],
      },
    });
    expectNoSecret(response);
  });

  it('uses the exception status for oversized results', async () => {
    compare.mockImplementation(() => {
      throw new ContentCompareException('比较结果超过大小限制', undefined, 413);
    });

    const response = await server().post(`${COMPARE_PATH}/env`).send({ left: SECRET, right: '' });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ data: null, message: '比较结果超过大小限制', code: 413 });
    expectNoSecret(response);
  });

  it('hides unexpected exception details and stack', async () => {
    compare.mockImplementation(() => {
      throw new Error(`boom ${SECRET}`);
    });

    const response = await server()
      .post(`${COMPARE_PATH}/json`)
      .send({ left: SECRET, right: '{}' });
    await flush();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ data: null, message: '服务器内部错误', code: 500 });
    expectNoSecret(response);
  });

  it.each([
    ['number', { left: 12345, right: SECRET }],
    ['array', { left: [SECRET], right: SECRET }],
    ['object', { left: { value: SECRET }, right: SECRET }],
    ['null', { left: null, right: SECRET }],
    ['missing field', { right: SECRET }],
    ['too long', { left: 'a'.repeat(CONTENT_COMPARE_LIMITS.maxTextLength + 1), right: SECRET }],
  ])('rejects %s input without leaking validation values', async (_name, body) => {
    const response = await server().post(`${COMPARE_PATH}/json`).send(body);
    await flush();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ data: null, message: '请求参数不合法', code: 400 });
    expect(compare).not.toHaveBeenCalled();
    expectNoSecret(response);
  });

  it('returns 400 for malformed JSON without echoing the snippet', async () => {
    const response = await server()
      .post(`${COMPARE_PATH}/json`)
      .set('Content-Type', 'application/json')
      .send(`{"left":"${SECRET}`);
    await flush();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ data: null, message: '请求体不是有效的 JSON 对象', code: 400 });
    expect(compare).not.toHaveBeenCalled();
    expectNoSecret(response);
  });

  it.each([`[${JSON.stringify(SECRET)}]`, 'null', '', '"' + SECRET + '"'])(
    'rejects non-object JSON body %j',
    async (payload) => {
      const response = await server()
        .post(`${COMPARE_PATH}/env`)
        .set('Content-Type', 'application/json')
        .send(payload);
      await flush();

      expect(response.status).toBe(400);
      expect(response.body.data).toBeNull();
      expect(compare).not.toHaveBeenCalled();
      expectNoSecret(response);
    },
  );

  it('returns 413 when the route body exceeds the dedicated limit', async () => {
    const padding = 'a'.repeat(CONTENT_COMPARE_LIMITS.maxBodyBytes);
    const response = await server()
      .post(`${COMPARE_PATH}/json`)
      .set('Content-Type', 'application/json')
      .send(`{"left":"${SECRET}${padding}","right":""}`);
    await flush();

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ data: null, message: '请求体超过大小限制', code: 413 });
    expect(compare).not.toHaveBeenCalled();
    expectNoSecret(response);
  });

  it.each(['get', 'put', 'delete', 'patch'] as const)('returns 405 for %s', async (method) => {
    const response = await server()
      [method](`${COMPARE_PATH}/json`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ left: SECRET, right: '' }));
    await flush();

    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ data: null, message: '请求方法不受支持', code: 405 });
    expectNoSecret(response);
  });

  it.each([
    ['text/plain', `left=${SECRET}`],
    ['application/x-www-form-urlencoded', `left=${SECRET}&right=1`],
    ['application/xml', `<left>${SECRET}</left>`],
  ])('returns 415 for %s', async (contentType, payload) => {
    const response = await server()
      .post(`${COMPARE_PATH}/json`)
      .set('Content-Type', contentType)
      .send(payload);
    await flush();

    expect(response.status).toBe(415);
    expect(response.body.data).toBeNull();
    expect(compare).not.toHaveBeenCalled();
    expectNoSecret(response);
  });

  it.each(['/yaml', '/json/extra', '/', '//json'])(
    'returns 404 for unknown subpath %s',
    async (sub) => {
      const response = await server()
        .post(`${COMPARE_PATH}${sub}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ left: SECRET, right: '' }));
      await flush();

      expect(response.status).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ data: null, message: '接口未找到', code: 404 });
      expect(compare).not.toHaveBeenCalled();
      expectNoSecret(response);
    },
  );
});
