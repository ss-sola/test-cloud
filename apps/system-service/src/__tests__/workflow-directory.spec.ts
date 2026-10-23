import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

const load = createRequire(__filename);
const Directory = load(resolve(__dirname, '../../public/js/workflow-directory.js'));
const { DIRECTORY, LIMITS, ProjectDirectoryService, filenameOf, mount } = Directory;

const LIST_URL = '/api/workflow-directory/list';
const DOCUMENT_URL = '/api/workflow-directory/document';
const REVISION_A = 'a'.repeat(64);
const REVISION_B = 'b'.repeat(64);
const MAX_BYTES = 20;

type Handler = (event: unknown) => void;
type RequestMock = ReturnType<typeof createRequest>;

/** 可控 Response：不访问真实网络，只提供服务使用的 ok、status 与 json。 */
function reply(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const success = (data: unknown) => reply({ code: 200, data });
const conflict = (revision?: unknown) => reply({ code: 409, message: '文件已变化', revision }, 409);

function createRequest(impl: (url: string, init: RequestInit) => Promise<unknown>) {
  return vi.fn(impl);
}

function createService(request: RequestMock, options: { timeoutMs?: number } = {}) {
  return new ProjectDirectoryService({ maxBytes: MAX_BYTES, request, ...options });
}

/** 返回 POST 请求体，便于核对保存快照。 */
function bodyOf(request: RequestMock, index: number) {
  return JSON.parse(request.mock.calls[index][1].body as string);
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolvePromise = done;
  });
  return { promise, resolve: resolvePromise };
}

/** 最小 DOM 元素，只记录 mount 实际使用的属性、事件和子节点。 */
function createElement() {
  const listeners = new Map<string, Handler[]>();
  const attributes: Record<string, string> = {};
  const element = {
    hidden: false,
    open: true,
    disabled: false,
    textContent: '',
    value: '',
    className: '',
    type: '',
    dataset: {} as Record<string, string>,
    children: [] as ReturnType<typeof createElement>[],
    attributes,
    classList: { toggle: vi.fn() },
    focus: vi.fn(),
    contains: vi.fn(() => false),
    setAttribute: (name: string, value: string) => {
      attributes[name] = value;
    },
    addEventListener: (type: string, handler: Handler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: Handler) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((item) => item !== handler),
      );
    },
    append: (...nodes: ReturnType<typeof createElement>[]) => {
      element.children.push(...nodes);
    },
    replaceChildren: (fragment: { children: ReturnType<typeof createElement>[] }) => {
      element.children = [...fragment.children];
    },
    emit: (type: string, event: Record<string, unknown> = {}) => {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    },
    parentNode: null as { insertBefore: Mock } | null,
    nextSibling: null as unknown,
  };
  return element;
}

/** mount 实际访问的 refs；已移除的关闭、刷新、保存等控件不在其中。 */
const REF_NAMES = [
  'sidebar',
  'directory-panel',
  'palette-panel',
  'nav-directory',
  'nav-palette',
  'directory-folder',
  'directory-list',
  'directory-search',
  'palette-search',
  'error',
];

/** 仅提供新版 mount 允许访问的 refs，访问已移除控件会直接抛错。 */
function createMount(
  request: RequestMock,
  options: {
    root?: { hidden: boolean };
    host?: ReturnType<typeof createElement>;
    client?: unknown;
  } = {},
) {
  const refs = Object.fromEntries(REF_NAMES.map((name) => [name, createElement()]));
  const importDocument = vi.fn();
  vi.stubGlobal('document', {
    createElement: () => createElement(),
    createDocumentFragment: () => createElement(),
  });
  vi.stubGlobal('fetch', request);
  const directory = mount({ refs, importDocument, maxBytes: 1024, ...options });
  return { refs, importDocument, directory };
}

/** 等待 mount 内部未被事件监听返回的异步操作完成。 */
const flush = () => new Promise((done) => setTimeout(done, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('工作流项目固定目录服务', () => {
  it('只通过固定同源接口读取列表，成功后才替换 entries，且没有目录句柄入口', async () => {
    const request = createRequest(async () =>
      success({ directory: 'public/workflow', list: [{ name: 'a.json', extra: 'ignored' }] }),
    );
    const service = createService(request);
    await service.refresh();
    expect(service.entries).toEqual([{ name: 'a.json' }]);
    expect(request).toHaveBeenCalledWith(
      LIST_URL,
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(request.mock.calls[0][1]).not.toHaveProperty('body');
    expect(DIRECTORY).toBe('public/workflow');
    for (const legacy of ['connect', 'navigate', 'directories', 'locks']) {
      expect(service).not.toHaveProperty(legacy);
    }
  });

  it('读取使用 encodeURIComponent 编码文件名，返回的文本按 UTF-8 字节预算检查', async () => {
    const name = 'a b&中#.json';
    const request = createRequest(async () =>
      success({ filename: name, text: '中中中', revision: REVISION_A }),
    );
    const service = createService(request);
    expect(await service.read(name)).toBe('中中中');
    expect(request.mock.calls[0][0]).toBe(`${DOCUMENT_URL}?filename=${encodeURIComponent(name)}`);
    expect(request.mock.calls[0][0]).toBe(`${DOCUMENT_URL}?filename=a%20b%26%E4%B8%AD%23.json`);

    const large = createService(
      createRequest(async () =>
        success({ filename: name, text: '中中中中中中中', revision: REVISION_A }),
      ),
    );
    await expect(large.read(name)).rejects.toThrow('4 MiB');
  });

  it.each([
    '../a.json',
    'a/b.json',
    'a\\b.json',
    'a.txt',
    '.json',
    'x.json ',
    ' x.json',
    'CON.json',
    'lpt1.json',
    'a\n.json',
    'a:1.json',
    'a*.json',
    '',
    `${'a'.repeat(116)}.json`,
    '..json',
    '...json',
    '.hidden.json',
    '.隐藏流程.json',
    'a .json',
    'a.tmp.json',
    'A.TMP.json',
    'a​.json',
    'a\ud800.json',
    'com¹.json',
    `${'周'.repeat(85)}.json`,
  ])('拒绝路径或非法文件名 %j，读取和保存都不发起请求', async (name) => {
    const request = createRequest(async () => success({}));
    const service = createService(request);
    await expect(service.read(name)).rejects.toThrow('有效的 JSON 文件名');
    await expect(service.save({ name, text: '{}', confirmOverwrite: vi.fn() })).rejects.toThrow(
      '有效的 JSON 文件名',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([undefined, 42, null])('文件名不是字符串（%j）时拒绝', async (name) => {
    const request = createRequest(async () => success({}));
    await expect(createService(request).read(name)).rejects.toThrow('有效的 JSON 文件名');
    expect(request).not.toHaveBeenCalled();
  });

  it('允许长度上限内的 JSON 文件名，扩展名大小写不敏感', async () => {
    const names = [`${'a'.repeat(115)}.json`, 'A.JSON', '周报.json'];
    const request = createRequest(async (_url) => success({ filename: 'x', revision: REVISION_A }));
    for (const name of names) {
      request.mockResolvedValueOnce(success({ filename: name, revision: REVISION_A }));
      expect(
        await createService(request).save({ name, text: '{}', confirmOverwrite: vi.fn() }),
      ).toBe(true);
    }
    expect(request).toHaveBeenCalledTimes(names.length);
  });

  it.each([
    ['目录不是固定值', { directory: 'public', list: [] }],
    ['列表不是数组', { directory: 'public/workflow', list: {} }],
    ['缺少数据', undefined],
    ['条目缺少名称', { directory: 'public/workflow', list: [{ name: 'a.json' }, {}] }],
    ['条目名称不是字符串', { directory: 'public/workflow', list: [{ name: 1 }] }],
    ['条目为空', { directory: 'public/workflow', list: [null] }],
    ['名称超过 255 字符', { directory: 'public/workflow', list: [{ name: 'a'.repeat(256) }] }],
    [
      '条目数量超过上限',
      {
        directory: 'public/workflow',
        list: Array.from({ length: LIMITS.entries + 1 }, (_, i) => ({ name: `${i}.json` })),
      },
    ],
  ])('列表格式或预算无效（%s）时抛错并保留原 entries，不静默截断', async (_title, data) => {
    const request = createRequest(async () =>
      success({ directory: 'public/workflow', list: [{ name: 'old.json' }] }),
    );
    const service = createService(request);
    await service.refresh();
    const previous = service.entries;
    request.mockResolvedValueOnce(success(data));
    await expect(service.refresh()).rejects.toThrow('无效文件列表');
    expect(service.entries).toBe(previous);
  });

  it('列表恰好达到条目上限时接受', async () => {
    const list = Array.from({ length: LIMITS.entries }, (_, i) => ({ name: `${i}.json` }));
    const service = createService(
      createRequest(async () => success({ directory: DIRECTORY, list })),
    );
    await service.refresh();
    expect(service.entries).toHaveLength(LIMITS.entries);
  });

  it.each([
    ['文件名不一致', { filename: 'other.json', text: '{}', revision: REVISION_A }],
    ['text 不是字符串', { filename: 'a.json', text: 1, revision: REVISION_A }],
    ['revision 缺失', { filename: 'a.json', text: '{}' }],
    [
      'revision 不是小写 64 位十六进制',
      { filename: 'a.json', text: '{}', revision: 'A'.repeat(64) },
    ],
    ['revision 长度不足', { filename: 'a.json', text: '{}', revision: 'a'.repeat(63) }],
    ['没有数据', undefined],
  ])('读取响应格式无效（%s）时拒绝', async (_title, data) => {
    const service = createService(createRequest(async () => success(data)));
    await expect(service.read('a.json')).rejects.toThrow('无效工作流');
  });

  it('网络、解析和 5xx 错误只返回安全文案，不回显请求正文或服务端细节', async () => {
    const secret = 'token=top-secret SELECT * FROM users';
    const service = createService(
      createRequest(async () => reply({ code: 500, message: secret }, 500)),
    );
    const serverError = await service.refresh().catch((error: Error) => error);
    expect(serverError.message).toBe('项目目录服务暂不可用，请稍后重试。');
    expect((serverError as Error & { status: number }).status).toBe(500);

    const network = createService(
      createRequest(async () => {
        throw new Error(`ECONNREFUSED ${secret}`);
      }),
    );
    const networkError = await network
      .save({ name: 'a.json', text: '{"private":"body"}', confirmOverwrite: vi.fn() })
      .catch((error: Error) => error);
    expect(networkError.message).toBe('保存结果尚未确认，请刷新目录检查文件状态。');
    expect(networkError.message).not.toContain('private');
    expect(networkError.message).not.toContain('secret');
    const readError = await network.refresh().catch((error: Error) => error);
    expect(readError.message).toBe('无法连接项目目录，请检查服务后重试。');

    const badJson = createService(
      createRequest(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(secret);
        },
      })),
    );
    const parseError = await badJson.refresh().catch((error: Error) => error);
    expect(parseError.message).toBe('无法连接项目目录，请检查服务后重试。');
  });

  it('4xx 使用业务 message，缺少 message 时给出状态码；业务 code 非 200 视为失败', async () => {
    const withMessage = createService(
      createRequest(async () => reply({ code: 400, message: '文件名无效' }, 400)),
    );
    await expect(withMessage.refresh()).rejects.toThrow('文件名无效');
    const withoutMessage = createService(createRequest(async () => reply({}, 404)));
    await expect(withoutMessage.refresh()).rejects.toThrow('目录请求失败（404）');
    const businessError = createService(
      createRequest(async () => reply({ code: 400, message: '业务失败', data: {} })),
    );
    await expect(businessError.refresh()).rejects.toThrow('业务失败');
    expect(businessError.entries).toEqual([]);
  });

  it('请求超时会中止信号，即使 mock 不响应 abort 也能结束', async () => {
    vi.useFakeTimers();
    const request = createRequest(() => new Promise(() => {}));
    const service = createService(request, { timeoutMs: 50 });
    const outcome = service.refresh().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect((await outcome).message).toBe('项目目录请求超时，请重试。');
    expect(request.mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it('响应体解析阶段超时同样结束，且保存超时不会重试', async () => {
    vi.useFakeTimers();
    const request = createRequest(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    }));
    const service = createService(request, { timeoutMs: 50 });
    const outcome = service
      .save({ name: 'a.json', text: '{}', confirmOverwrite: vi.fn() })
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect((await outcome).message).toContain('保存请求超时');
    expect(request).toHaveBeenCalledOnce();

    const reading = service.refresh().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect((await reading).message).toBe('项目目录请求超时，请重试。');
  });

  it('destroy 取消未完成请求（即使 mock 不响应 abort），并拒绝后续请求', async () => {
    const request = createRequest(() => new Promise(() => {}));
    const service = createService(request);
    const outcome = service.refresh().catch((error: Error) => error);
    service.destroy();
    expect((await outcome).message).toBe('目录请求已取消。');
    expect(request.mock.calls[0][1].signal?.aborted).toBe(true);
    await expect(service.refresh()).rejects.toThrow('目录请求已取消');
    await expect(service.read('a.json')).rejects.toThrow('目录请求已取消');
    expect(request).toHaveBeenCalledOnce();
  });

  it('缺少 request 实现时给出降级提示，不抛出原生错误', async () => {
    const service = new ProjectDirectoryService({ maxBytes: MAX_BYTES, request: null });
    await expect(service.refresh()).rejects.toThrow('无法访问项目目录');
  });

  it('保存新文件时携带 expectedRevision:null 与固定快照，成功返回 true', async () => {
    const request = createRequest(async () =>
      success({ filename: 'flow.json', revision: REVISION_A }),
    );
    const confirm = vi.fn();
    expect(
      await createService(request).save({
        name: 'flow.json',
        text: '{"a":1}',
        confirmOverwrite: confirm,
      }),
    ).toBe(true);
    expect(request).toHaveBeenCalledWith(
      DOCUMENT_URL,
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(bodyOf(request, 0)).toEqual({
      filename: 'flow.json',
      text: '{"a":1}',
      expectedRevision: null,
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('保存前检查 UTF-8 字节预算，超限不发起请求', async () => {
    const request = createRequest(async () => success({}));
    await expect(
      createService(request).save({
        name: 'a.json',
        text: '中中中中中中中',
        confirmOverwrite: vi.fn(),
      }),
    ).rejects.toThrow('4 MiB');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['文件名不一致', { filename: 'other.json', revision: REVISION_A }],
    ['revision 无效', { filename: 'a.json', revision: 'xyz' }],
    ['缺少数据', undefined],
  ])('保存响应无效（%s）时提示刷新目录确认', async (_title, data) => {
    const service = createService(createRequest(async () => success(data)));
    await expect(
      service.save({ name: 'a.json', text: '{}', confirmOverwrite: vi.fn() }),
    ).rejects.toThrow('刷新目录');
  });

  it('409 冲突后用户取消：返回 false，只提示一次且不重试', async () => {
    const request = createRequest(async () => conflict(REVISION_A));
    const confirm = vi.fn(async () => false);
    expect(
      await createService(request).save({ name: 'a.json', text: '{}', confirmOverwrite: confirm }),
    ).toBe(false);
    expect(confirm).toHaveBeenCalledExactlyOnceWith('a.json');
    expect(request).toHaveBeenCalledOnce();
  });

  it('409 冲突后确认：携带原快照与冲突 revision 只重试一次', async () => {
    const request = createRequest(async () => conflict(REVISION_A));
    request.mockResolvedValueOnce(conflict(REVISION_A));
    request.mockResolvedValueOnce(success({ filename: 'a.json', revision: REVISION_B }));
    const confirm = vi.fn(() => true);
    expect(
      await createService(request).save({
        name: 'a.json',
        text: '{"v":1}',
        confirmOverwrite: confirm,
      }),
    ).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(bodyOf(request, 0)).toEqual({
      filename: 'a.json',
      text: '{"v":1}',
      expectedRevision: null,
    });
    expect(bodyOf(request, 1)).toEqual({
      filename: 'a.json',
      text: '{"v":1}',
      expectedRevision: REVISION_A,
    });
  });

  it('确认覆盖后再次冲突直接抛错，不再次提示也不第三次请求', async () => {
    const request = createRequest(async () => conflict(REVISION_B));
    request.mockResolvedValueOnce(conflict(REVISION_A));
    const confirm = vi.fn(() => true);
    const error = await createService(request)
      .save({ name: 'a.json', text: '{}', confirmOverwrite: confirm })
      .catch((reason: Error & { status: number; revision: string }) => reason);
    expect(error.message).toBe('文件已变化');
    expect(error.status).toBe(409);
    expect(error.revision).toBe(REVISION_B);
    expect(confirm).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(bodyOf(request, 1).expectedRevision).toBe(REVISION_A);
  });

  it.each([
    ['缺少 revision', undefined],
    ['revision 非法', 'not-a-revision'],
    ['revision 含大写', 'A'.repeat(64)],
    ['revision 类型错误', 123],
  ])('409 %s 时不提示覆盖也不重试，直接抛出冲突错误', async (_title, revision) => {
    const request = createRequest(async () => conflict(revision));
    const confirm = vi.fn(() => true);
    await expect(
      createService(request).save({ name: 'a.json', text: '{}', confirmOverwrite: confirm }),
    ).rejects.toThrow('文件已变化');
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it('非 409 的顶层 revision 不触发覆盖流程', async () => {
    const request = createRequest(async () =>
      reply({ code: 400, message: '请求无效', revision: REVISION_A }, 400),
    );
    const confirm = vi.fn(() => true);
    await expect(
      createService(request).save({ name: 'a.json', text: '{}', confirmOverwrite: confirm }),
    ).rejects.toThrow('请求无效');
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it('确认期间 destroy 后禁止覆盖重试', async () => {
    const request = createRequest(async () => conflict(REVISION_A));
    const service = createService(request);
    await expect(
      service.save({
        name: 'a.json',
        text: '{}',
        confirmOverwrite: () => {
          service.destroy();
          return true;
        },
      }),
    ).rejects.toThrow('目录请求已取消');
    expect(request).toHaveBeenCalledOnce();
  });

  it('refresh 失败保留旧 entries，成功才替换', async () => {
    const request = createRequest(async () =>
      success({ directory: DIRECTORY, list: [{ name: 'a.json' }] }),
    );
    const service = createService(request);
    await service.refresh();
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(service.refresh()).rejects.toThrow('无法连接项目目录');
    expect(service.entries).toEqual([{ name: 'a.json' }]);
    request.mockResolvedValueOnce(success({ directory: DIRECTORY, list: [{ name: 'b.json' }] }));
    await service.refresh();
    expect(service.entries).toEqual([{ name: 'b.json' }]);
  });

  it('read 使用 metadata 选项时返回文件名、文本与版本，默认仍只返回文本', async () => {
    const data = { filename: 'a.json', text: '{}', revision: REVISION_A };
    const request = createRequest(async () => success(data));
    const service = createService(request);
    expect(await service.read('a.json', { metadata: true })).toEqual(data);
    expect(await service.read('a.json')).toBe('{}');
    request.mockResolvedValueOnce(success({ ...data, revision: 'bad' }));
    await expect(service.read('a.json', { metadata: true })).rejects.toThrow('无效工作流');
  });

  it('save 使用 metadata 选项时返回服务端文件名与版本', async () => {
    const request = createRequest(async () =>
      success({ filename: 'flow.json', revision: REVISION_B }),
    );
    const saved = await createService(request).save({
      name: 'flow.json',
      text: '{}',
      metadata: true,
      confirmOverwrite: vi.fn(),
    });
    expect(saved).toEqual({ filename: 'flow.json', revision: REVISION_B });
  });

  it('已知版本直接写入：携带 expectedRevision，不确认也不在冲突后自动重试', async () => {
    const request = createRequest(async () =>
      success({ filename: 'flow.json', revision: REVISION_B }),
    );
    const confirm = vi.fn(() => true);
    const service = createService(request);
    expect(
      await service.save({
        name: 'flow.json',
        text: '{"v":2}',
        expectedRevision: REVISION_A,
        metadata: true,
        confirmOverwrite: confirm,
      }),
    ).toEqual({ filename: 'flow.json', revision: REVISION_B });
    expect(bodyOf(request, 0)).toEqual({
      filename: 'flow.json',
      text: '{"v":2}',
      expectedRevision: REVISION_A,
    });

    request.mockResolvedValueOnce(conflict(REVISION_B));
    await expect(
      service.save({
        name: 'flow.json',
        text: '{"v":3}',
        expectedRevision: REVISION_A,
        confirmOverwrite: confirm,
      }),
    ).rejects.toThrow('文件已变化');
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);

    request.mockResolvedValueOnce(conflict(REVISION_B));
    await expect(
      service.save({
        name: 'flow.json',
        text: '{}',
        expectedRevision: null,
        confirmOverwrite: confirm,
      }),
    ).rejects.toThrow('文件已变化');
    expect(confirm).not.toHaveBeenCalled();
    expect(bodyOf(request, 2).expectedRevision).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('未指定版本且没有确认函数时，冲突直接抛出；不合法的 expectedRevision 不发请求', async () => {
    const request = createRequest(async () => conflict(REVISION_A));
    const service = createService(request);
    await expect(service.save({ name: 'a.json', text: '{}' })).rejects.toThrow('文件已变化');
    expect(request).toHaveBeenCalledOnce();
    for (const expectedRevision of ['abc', 'A'.repeat(64), 123]) {
      await expect(service.save({ name: 'a.json', text: '{}', expectedRevision })).rejects.toThrow(
        '文件版本不合法',
      );
    }
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('建议文件名转换', () => {
  it('兼容中文、非法字符、控制字符、空名称和 Windows 保留名', () => {
    expect(filenameOf('周报流程')).toBe('周报流程.json');
    expect(filenameOf('a/b:c')).toBe('a_b_c.json');
    expect(filenameOf('a\\b*c?"d<e>f|g')).toBe('a_b_c__d_e_f_g.json');
    expect(filenameOf('a\u0001b')).toBe('a_b.json');
    expect(filenameOf('   ')).toBe('workflow.json');
    expect(filenameOf('...')).toBe('workflow.json');
    expect(filenameOf('CON')).toBe('_CON.json');
    expect(filenameOf('lpt1.log')).toBe('_lpt1.log.json');
    expect(filenameOf('flow. ')).toBe('flow.json');
  });

  it('长名称被截断到上限内，且转换结果总能通过保存校验', async () => {
    expect(filenameOf('x'.repeat(300)).length).toBeLessThanOrEqual(LIMITS.filename);
    const request = createRequest(async () => success({}));
    for (const name of ['CON', 'a/b', 'x'.repeat(300), '   ', 'flow. ', 'a:b']) {
      const filename = filenameOf(name);
      request.mockResolvedValueOnce(success({ filename, revision: REVISION_A }));
      expect(
        await createService(request).save({
          name: filename,
          text: '{}',
          confirmOverwrite: vi.fn(),
        }),
      ).toBe(true);
    }
  });

  it('默认名称移除前导点，点文件名称生成的文件名可保存', async () => {
    expect(filenameOf('.隐藏流程')).toBe('隐藏流程.json');
    expect(filenameOf('..hidden. ')).toBe('hidden.json');
    expect(filenameOf('...')).toBe('workflow.json');
    const request = createRequest(async () => success({}));
    for (const name of ['.隐藏流程', '.hidden', '. .a']) {
      const filename = filenameOf(name);
      expect(filename.startsWith('.')).toBe(false);
      request.mockResolvedValueOnce(success({ filename, revision: REVISION_A }));
      expect(
        await createService(request).save({
          name: filename,
          text: '{}',
          confirmOverwrite: vi.fn(),
        }),
      ).toBe(true);
    }
    expect(bodyOf(request, 0).filename).toBe('隐藏流程.json');
  });

  it('长中文、emoji 与上标设备名生成的默认文件名受 UTF-16 与 UTF-8 预算约束且可保存', async () => {
    expect(filenameOf('COM¹')).toBe('_COM¹.json');
    expect(filenameOf('lpt².txt')).toBe('_lpt².txt.json');
    expect(filenameOf('a.tmp.b')).toBe('a_b.json');
    expect(filenameOf('a​b\ud800c')).toBe('a_b_c.json');
    const request = createRequest(async () => success({}));
    for (const name of ['周'.repeat(200), '😀'.repeat(100), 'COM¹'.repeat(40), '😀 '.repeat(80)]) {
      const filename = filenameOf(name);
      expect(filename.length).toBeLessThanOrEqual(LIMITS.filename);
      expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(255);
      expect(filename).toMatch(/\S\.json$/u);
      request.mockResolvedValueOnce(success({ filename, revision: REVISION_A }));
      expect(
        await createService(request).save({
          name: filename,
          text: '{}',
          confirmOverwrite: vi.fn(),
        }),
      ).toBe(true);
    }
  });
});

describe('工作流目录面板挂载', () => {
  const listOf = (...names: string[]) =>
    success({ directory: DIRECTORY, list: names.map((name) => ({ name })) });
  const documentOf = (name: string, text: string) =>
    success({ filename: name, text, revision: REVISION_A });
  /** 按接口路径返回受控响应，不访问真实网络。 */
  const route = (list: unknown, documents: Record<string, unknown> = {}) =>
    createRequest(async (url) => {
      if (url.startsWith(LIST_URL)) return list;
      const query = new URL(url, 'http://local').searchParams.get('filename') ?? '';
      return documents[query] ?? reply({ code: 404, message: '文件不存在' }, 404);
    });
  const escape = (target: object = {}) => ({
    key: 'Escape',
    defaultPrevented: false,
    target,
    preventDefault: vi.fn(),
  });

  it('只返回 refreshDirectory 与 destroy，仅依赖文件夹、列表与全局错误出口，挂载和打开节点库不请求目录', async () => {
    const request = route(listOf('a.json'));
    const { refs, directory } = createMount(request);
    expect(Object.keys(directory).sort()).toEqual(['destroy', 'refreshDirectory']);
    expect(Object.keys(refs).sort()).toEqual([...REF_NAMES].sort());
    expect(refs['directory-panel'].hidden).toBe(true);
    refs['nav-palette'].emit('click');
    await flush();
    expect(refs['palette-panel'].hidden).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('文件列表只渲染纯文本文件名按钮，文件名中的 HTML 不会成为子节点', async () => {
    const hostile = '<img src=x onerror=alert(1)>.json';
    const { refs } = createMount(route(listOf('a.json', hostile)));
    refs['nav-directory'].emit('click');
    await flush();
    const buttons = refs['directory-list'].children;
    // 文件名可直接作为按钮文本，或放在唯一的纯文本 span 内；不得出现其他节点。
    const labelOf = (button: (typeof buttons)[number]) =>
      [button.textContent, ...button.children.map((child) => child.textContent)].join('');
    expect(buttons.map(labelOf)).toEqual(['a.json', hostile]);
    expect(buttons.map((button) => button.dataset.directoryName)).toEqual(['a.json', hostile]);
    expect(
      buttons.every(
        (button) =>
          button.type === 'button' &&
          button.children.length <= 1 &&
          button.children.every((child) => child.children.length === 0),
      ),
    ).toBe(true);
    expect(refs['directory-panel'].hidden).toBe(false);
    expect(refs['nav-directory'].attributes['aria-expanded']).toBe('true');
    expect(refs['palette-panel'].hidden).toBe(true);
  });

  it('导航重新打开且文件夹展开时刷新；文件夹收起或面板关闭时的 toggle 不刷新', async () => {
    const request = route(listOf('a.json'));
    const { refs } = createMount(request);
    const folder = refs['directory-folder'];
    folder.emit('toggle'); // 面板未打开
    await flush();
    expect(request).not.toHaveBeenCalled();

    refs['nav-directory'].emit('click');
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    refs['nav-directory'].emit('click'); // 关闭
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    refs['nav-directory'].emit('click'); // 重新打开
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    folder.open = false;
    folder.emit('toggle');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    folder.open = true;
    folder.emit('toggle');
    await flush();
    expect(request).toHaveBeenCalledTimes(3);

    refs['nav-directory'].emit('click'); // 关闭
    folder.open = false;
    refs['nav-directory'].emit('click'); // 文件夹收起时打开面板不读取
    await flush();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every((call) => call[0] === LIST_URL)).toBe(true);
  });

  it('加载中锁定文件按钮并忽略重复刷新与点击，完成后恢复', async () => {
    const reloading = deferred<unknown>();
    const request = route(listOf('a.json'));
    const { refs } = createMount(request);
    refs['nav-directory'].emit('click');
    await flush();
    request.mockReturnValueOnce(reloading.promise);
    refs['nav-directory'].emit('click');
    refs['nav-directory'].emit('click');
    refs['directory-folder'].emit('toggle');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(refs['directory-panel'].attributes['aria-busy']).toBe('true');
    const [button] = refs['directory-list'].children;
    expect(button.disabled).toBe(true);
    button.emit('click');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    reloading.resolve(listOf('a.json', 'b.json'));
    await flush();
    expect(refs['directory-panel'].attributes['aria-busy']).toBe('false');
    expect(refs['directory-list'].children.map((item) => item.disabled)).toEqual([false, false]);
  });

  it('点击文件按固定接口读取并交给工作区导入，成功后清除旧错误', async () => {
    const name = '周报 1.json';
    const request = route(listOf(name), { [name]: documentOf(name, '{"ok":1}') });
    const { refs, importDocument } = createMount(request);
    refs.error.hidden = false;
    refs['nav-directory'].emit('click');
    await flush();
    refs['directory-list'].children[0].emit('click');
    await flush();
    expect(request.mock.calls[1][0]).toBe(`${DOCUMENT_URL}?filename=${encodeURIComponent(name)}`);
    expect(importDocument).toHaveBeenCalledExactlyOnceWith('{"ok":1}', {
      filename: name,
      text: '{"ok":1}',
      revision: REVISION_A,
    });
    expect(refs.error.hidden).toBe(true);
  });

  it('错误只写入页面共享出口，不进入目录内容；刷新失败保留旧列表，成功后清除', async () => {
    const request = route(listOf('a.json'));
    const { refs } = createMount(request);
    refs['nav-directory'].emit('click');
    await flush();
    const before = refs['directory-list'].children.map((button) => button.dataset.directoryName);
    expect(before).toEqual(['a.json']);

    request.mockResolvedValueOnce(reply({ code: 500, message: 'SQL secret' }, 503));
    refs['nav-directory'].emit('click');
    refs['nav-directory'].emit('click');
    await flush();
    expect(refs.error.hidden).toBe(false);
    expect(refs.error.textContent).toBe('项目目录服务暂不可用，请稍后重试。');
    expect(refs.error.textContent).not.toContain('secret');
    expect(refs['directory-list'].children.map((button) => button.dataset.directoryName)).toEqual(
      before,
    );
    expect(refs['directory-list'].textContent).toBe('');
    expect(refs['directory-panel'].children).toHaveLength(0);
    expect(refs['directory-panel'].textContent).toBe('');
    expect(refs['directory-panel'].attributes['aria-busy']).toBe('false');

    refs['directory-folder'].emit('toggle');
    await flush();
    expect(refs.error.hidden).toBe(true);
  });

  it('首次列表失败时目录为空，读取无效或超限文件不导入并显示错误', async () => {
    const failed = createMount(route(reply({}, 503)));
    failed.refs['nav-directory'].emit('click');
    await flush();
    expect(failed.refs['directory-list'].children).toHaveLength(0);
    expect(failed.refs.error.hidden).toBe(false);

    const large = route(listOf('big.json', 'bad.json'), {
      'big.json': documentOf('big.json', 'x'.repeat(2000)),
      'bad.json': documentOf('other.json', '{}'),
    });
    const { refs, importDocument } = createMount(large);
    refs['nav-directory'].emit('click');
    await flush();
    refs['directory-list'].children[0].emit('click');
    await flush();
    expect(refs.error.textContent).toContain('4 MiB');
    refs['directory-list'].children[1].emit('click');
    await flush();
    expect(refs.error.textContent).toContain('无效工作流');
    expect(importDocument).not.toHaveBeenCalled();
    expect(failed.importDocument).not.toHaveBeenCalled();
  });

  it('销毁后迟到的读取不导入、不显示错误，且监听器已解除', async () => {
    const lateRead = deferred<unknown>();
    const request = route(listOf('a.json'));
    const { refs, importDocument, directory } = createMount(request);
    refs['nav-directory'].emit('click');
    await flush();
    request.mockReturnValueOnce(lateRead.promise);
    refs['directory-list'].children[0].emit('click');
    await flush();
    const readSignal = request.mock.calls[1][1].signal;
    directory.destroy();
    expect(readSignal?.aborted).toBe(true);
    lateRead.resolve(documentOf('a.json', '{"late":1}'));
    await flush();
    expect(importDocument).not.toHaveBeenCalled();
    expect(refs.error.hidden).toBe(true);
    expect(refs.error.textContent).toBe('');

    refs['nav-directory'].emit('click');
    refs['directory-folder'].emit('toggle');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('销毁时仍在加载的列表不会覆盖旧列表或报告错误', async () => {
    const lateList = deferred<unknown>();
    const request = route(listOf('a.json'));
    const { refs, directory } = createMount(request);
    refs['nav-directory'].emit('click');
    await flush();
    request.mockReturnValueOnce(lateList.promise);
    refs['nav-directory'].emit('click');
    refs['nav-directory'].emit('click');
    await flush();
    directory.destroy();
    lateList.resolve(listOf('late.json'));
    await flush();
    expect(refs['directory-list'].children.map((button) => button.dataset.directoryName)).toEqual([
      'a.json',
    ]);
    expect(refs.error.hidden).toBe(true);
  });

  it('Esc 仅处理侧栏内的事件：先清空查询并触发 input，无查询再收起并恢复焦点', () => {
    const { refs } = createMount(route(listOf()));
    const onInput = vi.fn();
    refs['palette-search'].addEventListener('input', onInput);
    refs['nav-palette'].emit('click');
    expect(refs['palette-panel'].hidden).toBe(false);
    expect(refs.sidebar.classList.toggle).toHaveBeenLastCalledWith('wf-sidebar--expanded', true);

    const outside = escape();
    refs.sidebar.emit('keydown', outside);
    expect(outside.preventDefault).not.toHaveBeenCalled();
    expect(refs['palette-panel'].hidden).toBe(false);
    refs['palette-panel'].contains.mockReturnValue(true);
    refs.sidebar.emit('keydown', { ...escape(), defaultPrevented: true });
    expect(refs['palette-panel'].hidden).toBe(false);

    refs['palette-search'].value = '同步';
    const first = escape();
    refs.sidebar.emit('keydown', first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(refs['palette-search'].value).toBe('');
    expect(onInput).toHaveBeenCalledOnce();
    expect(refs['palette-panel'].hidden).toBe(false);

    const second = escape();
    refs.sidebar.emit('keydown', second);
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(refs['palette-panel'].hidden).toBe(true);
    expect(refs['nav-palette'].focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(refs.sidebar.classList.toggle).toHaveBeenLastCalledWith('wf-sidebar--expanded', false);
  });

  it('项目目录 Esc 同样分两步，并与节点库互斥', async () => {
    const { refs } = createMount(route(listOf('a.json')));
    refs['nav-palette'].emit('click');
    refs['nav-directory'].emit('click');
    await flush();
    expect(refs['palette-panel'].hidden).toBe(true);
    expect(refs['nav-palette'].attributes['aria-expanded']).toBe('false');
    refs['directory-panel'].contains.mockReturnValue(true);
    refs['directory-search'].value = 'a';
    refs.sidebar.emit('keydown', escape());
    expect(refs['directory-search'].value).toBe('');
    expect(refs['directory-panel'].hidden).toBe(false);
    refs.sidebar.emit('keydown', escape());
    expect(refs['directory-panel'].hidden).toBe(true);
    expect(refs['nav-directory'].focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  describe('文件名搜索', () => {
    const names = ['Weekly Report.json', 'weekly-plan.json', 'ＡＢＣ报告.json', '月报.json'];
    const shown = (refs: ReturnType<typeof createMount>['refs']) =>
      refs['directory-list'].children.map((button) => button.dataset.directoryName);
    const search = (refs: ReturnType<typeof createMount>['refs'], value: string) => {
      refs['directory-search'].value = value;
      refs['directory-search'].emit('input', { type: 'input' });
    };

    it('本地按 NFKC、大小写不敏感和多词全匹配过滤，不发请求也不导入', async () => {
      const request = route(listOf(...names));
      const { refs, importDocument } = createMount(request);
      refs['nav-directory'].emit('click');
      await flush();
      expect(shown(refs)).toEqual(names);

      search(refs, 'abc');
      expect(shown(refs)).toEqual(['ＡＢＣ报告.json']);
      search(refs, 'ＷＥＥＫＬＹ   REPORT');
      expect(shown(refs)).toEqual(['Weekly Report.json']);
      search(refs, 'weekly 月');
      expect(shown(refs)).toEqual([]);
      search(refs, '月报');
      expect(shown(refs)).toEqual(['月报.json']);
      search(refs, '   ');
      expect(shown(refs)).toEqual(names);
      expect(request).toHaveBeenCalledTimes(1);
      expect(importDocument).not.toHaveBeenCalled();
    });

    it('查询临时展开文件夹且清空后恢复，由搜索引发的 toggle 不请求', async () => {
      const request = route(listOf(...names));
      const { refs } = createMount(request);
      const folder = refs['directory-folder'];
      refs['nav-directory'].emit('click');
      await flush();
      folder.open = false;
      folder.emit('toggle');
      await flush();
      expect(request).toHaveBeenCalledTimes(1);

      search(refs, 'weekly');
      expect(folder.open).toBe(true);
      folder.emit('toggle'); // 浏览器异步派发的 toggle
      search(refs, 'weekly plan');
      search(refs, '');
      expect(folder.open).toBe(false);
      folder.emit('toggle');
      await flush();
      expect(request).toHaveBeenCalledTimes(1);

      folder.open = true; // 用户手动展开仍然刷新
      folder.emit('toggle');
      await flush();
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('文件夹本来展开时查询不改变其状态', async () => {
      const { refs } = createMount(route(listOf(...names)));
      refs['nav-directory'].emit('click');
      await flush();
      search(refs, 'weekly');
      expect(refs['directory-folder'].open).toBe(true);
      search(refs, '');
      expect(refs['directory-folder'].open).toBe(true);
    });

    it('切换到节点库再返回时查询保持，列表仍按查询过滤，错误不进入搜索', async () => {
      const request = route(listOf(...names));
      const { refs, importDocument } = createMount(request);
      refs['nav-directory'].emit('click');
      await flush();
      search(refs, '月报');
      refs['nav-palette'].emit('click');
      expect(refs['directory-panel'].hidden).toBe(true);
      expect(refs['directory-search'].value).toBe('月报');
      refs['palette-search'].value = 'json';
      refs['nav-directory'].emit('click');
      await flush();
      expect(refs['directory-search'].value).toBe('月报');
      expect(refs['palette-search'].value).toBe('json');
      expect(shown(refs)).toEqual(['月报.json']);
      expect(importDocument).not.toHaveBeenCalled();
    });
  });

  describe('可注入 client 与目录可见性刷新', () => {
    /** 受控 client：只提供 mount 使用的列表、读取与销毁能力。 */
    const fakeClient = (names: string[]) => ({
      entries: [] as { name: string }[],
      refresh: vi.fn(async function (this: { entries: { name: string }[] }) {
        this.entries = names.map((name) => ({ name }));
      }),
      read: vi.fn(async (name: string) => ({ filename: name, text: '{}', revision: REVISION_A })),
      destroy: vi.fn(),
    });

    it('使用注入的 client 读取列表，销毁时一并销毁，不创建默认 fetch 客户端', async () => {
      const request = route(listOf('never.json'));
      const client = fakeClient(['x.json']);
      const { refs, directory, importDocument } = createMount(request, { client });
      refs['nav-directory'].emit('click');
      await flush();
      expect(client.refresh).toHaveBeenCalledOnce();
      expect(refs['directory-list'].children.map((button) => button.dataset.directoryName)).toEqual(
        ['x.json'],
      );
      refs['directory-list'].children[0].emit('click');
      await flush();
      expect(client.read).toHaveBeenCalledWith('x.json', { metadata: true });
      expect(importDocument).toHaveBeenCalledExactlyOnceWith('{}', {
        filename: 'x.json',
        text: '{}',
        revision: REVISION_A,
      });
      directory.destroy();
      expect(client.destroy).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
    });

    it('refreshDirectory 只在工作流可见、目录面板打开且文件夹展开时刷新，并保留查询', async () => {
      const client = fakeClient(['Weekly.json', 'plan.json']);
      const root = { hidden: false };
      const { refs, directory } = createMount(route(listOf()), { client, root });
      await directory.refreshDirectory(); // 面板未打开
      expect(client.refresh).not.toHaveBeenCalled();

      refs['nav-directory'].emit('click');
      await flush();
      expect(client.refresh).toHaveBeenCalledTimes(1);
      refs['directory-search'].value = 'weekly';
      refs['directory-search'].emit('input', { type: 'input' });
      await directory.refreshDirectory();
      expect(client.refresh).toHaveBeenCalledTimes(2);
      expect(refs['directory-search'].value).toBe('weekly');
      expect(refs['directory-list'].children.map((button) => button.dataset.directoryName)).toEqual(
        ['Weekly.json'],
      );

      root.hidden = true; // 离开工作流路由
      await directory.refreshDirectory();
      expect(client.refresh).toHaveBeenCalledTimes(2);
      root.hidden = false;

      refs['directory-folder'].open = false; // 文件夹收起
      await directory.refreshDirectory();
      expect(client.refresh).toHaveBeenCalledTimes(2);
      refs['directory-folder'].open = true;

      refs['nav-palette'].emit('click'); // 切换到节点库
      await directory.refreshDirectory();
      expect(client.refresh).toHaveBeenCalledTimes(2);
    });

    it('refreshDirectory 失败时错误进入共享出口并保留旧列表，加载中不会重复刷新', async () => {
      const client = fakeClient(['a.json']);
      const { refs, directory } = createMount(route(listOf()), { client });
      refs['nav-directory'].emit('click');
      await flush();
      client.refresh.mockRejectedValueOnce(new Error('刷新失败'));
      await directory.refreshDirectory();
      expect(refs.error.hidden).toBe(false);
      expect(refs.error.textContent).toBe('刷新失败');
      expect(refs['directory-list'].children).toHaveLength(1);

      const pending = deferred<void>();
      client.refresh.mockReturnValueOnce(pending.promise);
      const first = directory.refreshDirectory();
      await directory.refreshDirectory(); // busy 时直接返回
      expect(client.refresh).toHaveBeenCalledTimes(3);
      pending.resolve();
      await first;
      expect(refs.error.hidden).toBe(true);
    });
  });

  describe('挂载到系统侧栏', () => {
    class FakeObserver {
      static instances: FakeObserver[] = [];
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(readonly callback: () => void) {
        FakeObserver.instances.push(this);
      }
    }

    it('整体移入 host、跟随 root.hidden，销毁后恢复原位置并隐藏 host', () => {
      FakeObserver.instances = [];
      vi.stubGlobal('MutationObserver', FakeObserver);
      const root = { hidden: true };
      const host = createElement();
      host.hidden = false;
      const parent = { insertBefore: vi.fn() };
      const sibling = {};
      const request = route(listOf());
      const refs = Object.fromEntries(REF_NAMES.map((name) => [name, createElement()]));
      refs.sidebar.parentNode = parent;
      refs.sidebar.nextSibling = sibling;
      vi.stubGlobal('document', {
        createElement: () => createElement(),
        createDocumentFragment: () => createElement(),
      });
      vi.stubGlobal('fetch', request);
      const directory = mount({ root, refs, host, importDocument: vi.fn(), maxBytes: 1024 });
      expect(host.children).toEqual([refs.sidebar]);
      expect(host.hidden).toBe(true);
      const [observer] = FakeObserver.instances;
      expect(observer.observe).toHaveBeenCalledWith(root, {
        attributes: true,
        attributeFilter: ['hidden'],
      });

      root.hidden = false;
      observer.callback();
      expect(host.hidden).toBe(false);
      root.hidden = true;
      observer.callback();
      expect(host.hidden).toBe(true);

      root.hidden = false;
      observer.callback();
      directory.destroy();
      expect(observer.disconnect).toHaveBeenCalledOnce();
      expect(host.hidden).toBe(true);
      expect(parent.insertBefore).toHaveBeenCalledExactlyOnceWith(refs.sidebar, sibling);
      expect(request).not.toHaveBeenCalled();
    });
  });
});
