import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKFLOW_DIRECTORY_DISPLAY_PATH,
  WORKFLOW_DIRECTORY_LIMITS,
  WORKFLOW_DIRECTORY_LOCK_NAME,
  WORKFLOW_DIRECTORY_ROOT,
  WORKFLOW_DIRECTORY_TEMP_PREFIX,
} from '../constants/workflow-directory.constants';
import { WorkflowDirectoryService } from '../modules/workflow-directory/workflow-directory.service';
import { WorkflowDirectoryUtil } from '../modules/workflow-directory/workflow-directory.util';

const SECRET = 'github-secret-token-9f3a';
const REVISION = 'b'.repeat(64);
const CASE_BASE = resolve(__dirname, '../../node_modules/.cache/workflow-directory-tests');
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

const textNode = {
  id: 'text-1',
  type: 'text',
  version: 1,
  name: '文本',
  position: { x: 10, y: 20 },
  size: { width: 320, height: 280 },
  config: { text: 'hello' },
};
const startNode = {
  id: 'start',
  type: 'start',
  version: 1,
  name: '开始',
  position: { x: 0, y: 0 },
  size: { width: 320, height: 520 },
  config: { githubToken: SECRET },
};

/** 构造可通过真实校验的最小工作流文本。 */
function workflow(patch: Record<string, unknown> = {}, nodes: object[] = [textNode]): string {
  return JSON.stringify({
    version: 1,
    id: 'wf-test',
    name: '测试流程',
    nodes,
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...patch,
  });
}

let root: string;

/** 以项目内临时目录替换固定 root，绝不触及真实工作流目录。 */
function createService(target = root): WorkflowDirectoryService {
  const service = new WorkflowDirectoryService();
  Object.defineProperty(service, 'root', { value: target });
  return service;
}

/** 捕获受控异常的状态、文案与版本。 */
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const { getStatus, message, revision } = error as {
      getStatus: () => number;
      message: string;
      revision?: string | null;
    };
    return { status: getStatus.call(error), message, revision };
  }
  throw new Error('期望操作失败');
}

const fileOf = (name: string) => join(root, name);
const bytesOf = (name: string) => readFileSync(fileOf(name));

beforeEach(() => {
  mkdirSync(CASE_BASE, { recursive: true });
  root = mkdtempSync(join(CASE_BASE, 'case-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('workflow directory fixed root', () => {
  it('derives the data directory from the code location, not cwd or configuration', () => {
    expect(WORKFLOW_DIRECTORY_ROOT).toBe(resolve(__dirname, '../../public/workflow'));
    expect(WORKFLOW_DIRECTORY_DISPLAY_PATH).toBe('public/workflow');
    expect((new WorkflowDirectoryService() as unknown as { root: string }).root).toBe(
      WORKFLOW_DIRECTORY_ROOT,
    );
  });

  it('treats a missing directory as empty or 404 and only creates it on explicit create', async () => {
    const target = join(root, 'workflow');
    const service = createService(target);

    expect(await service.list()).toEqual({ directory: 'public/workflow', list: [] });
    expect(await failure(service.read('a.json'))).toMatchObject({ status: 404 });
    // 覆盖保存不创建目录，只报告文件已不存在
    expect(
      await failure(
        service.save({ filename: 'a.json', text: workflow(), expectedRevision: REVISION }),
      ),
    ).toMatchObject({ status: 409, revision: null });
    expect(existsSync(target)).toBe(false);

    const saved = await service.save({
      filename: 'a.json',
      text: workflow(),
      expectedRevision: null,
    });
    expect(saved.filename).toBe('a.json');
    expect(readdirSync(target)).toEqual(['a.json']);
  });

  it('does not create the data directory when its parent is missing', async () => {
    const service = createService(join(root, 'no-public', 'workflow'));

    const failed = await failure(
      service.save({ filename: 'a.json', text: workflow(), expectedRevision: null }),
    );

    expect(failed).toMatchObject({ status: 500, message: '工作流目录不可用' });
    expect(failed.message).not.toContain(root);
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects a root that is a file, a link, or reached through a linked ancestor', async () => {
    writeFileSync(fileOf('plain-file'), '');
    expect((await failure(createService(fileOf('plain-file')).list())).status).toBe(500);

    mkdirSync(join(fileOf('real'), 'workflow'), { recursive: true });
    try {
      symlinkSync(fileOf('real'), fileOf('public-link'), 'junction');
      symlinkSync(join(fileOf('real'), 'workflow'), fileOf('workflow-link'), 'junction');
    } catch {
      return;
    }
    const direct = await failure(createService(fileOf('workflow-link')).list());
    expect(direct).toMatchObject({ status: 500, message: '工作流目录不可用' });
    // 根目录本身是真实目录，但 public 祖先是链接：realpath 与预期固定路径不一致
    const escaped = createService(join(fileOf('public-link'), 'workflow'));
    expect((await failure(escaped.list())).status).toBe(500);
    expect(
      (
        await failure(
          escaped.save({ filename: 'a.json', text: workflow(), expectedRevision: null }),
        )
      ).status,
    ).toBe(500);
    expect(readdirSync(join(fileOf('real'), 'workflow'))).toEqual([]);
  });
});

describe('workflow directory filename rules', () => {
  it.each([
    '周报.json',
    'a.json',
    'UPPER.JSON',
    'Mixed.Json',
    'my flow.v2.json',
    'a..json',
    'x'.repeat(115) + '.json',
  ])('accepts %s', (name) => {
    expect(WorkflowDirectoryUtil.isValidFilename(name)).toBe(true);
  });

  it.each([
    '',
    'a',
    'a.txt',
    '.json',
    '.hidden.json',
    '.a.json',
    '...JSON',
    ' .json',
    ' a.json',
    'a .json',
    'a/b.json',
    'a\\b.json',
    '../a.json',
    'a:stream.json',
    'a\u0000.json',
    'a\nb.json',
    'a‮.json',
    'CON.json',
    'con.JSON',
    'nul.txt.json',
    'LPT1.json',
    'a.tmp.json',
    'a.TMP.json',
    '.tmp.json',
    'x'.repeat(116) + '.json',
    `${'汉'.repeat(90)}.json`,
  ])('rejects %j', (name) => {
    expect(WorkflowDirectoryUtil.isValidFilename(name)).toBe(false);
  });

  it('rejects invalid names before touching the directory', async () => {
    const service = createService();
    expect(await failure(service.read('../outside.json'))).toMatchObject({
      status: 400,
      message: '文件名不合法',
    });
    expect(
      await failure(
        service.save({ filename: 'a/b.json', text: workflow(), expectedRevision: null }),
      ),
    ).toMatchObject({ status: 400 });
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('workflow directory list and read', () => {
  it('lists only top-level regular single-link json files', async () => {
    writeFileSync(fileOf('b.json'), workflow());
    writeFileSync(fileOf('a.json'), workflow());
    writeFileSync(fileOf('note.txt'), 'x');
    writeFileSync(fileOf('UPPER.JSON'), workflow());
    writeFileSync(fileOf('.hidden.json'), workflow());
    writeFileSync(fileOf('bad.tmp.json'), workflow());
    writeFileSync(fileOf(`${WORKFLOW_DIRECTORY_TEMP_PREFIX}abc`), workflow());
    writeFileSync(fileOf(WORKFLOW_DIRECTORY_LOCK_NAME), '');
    mkdirSync(fileOf('folder'));
    writeFileSync(join(fileOf('folder'), 'nested.json'), workflow());
    mkdirSync(fileOf('dir.json'));
    writeFileSync(fileOf('original.json'), workflow());
    linkSync(fileOf('original.json'), fileOf('hardlink.json'));
    try {
      symlinkSync(fileOf('a.json'), fileOf('symlink.json'), 'file');
    } catch {
      // Windows 无权限创建符号链接时跳过该样例
    }

    expect(await createService().list()).toEqual({
      directory: 'public/workflow',
      list: [{ name: 'UPPER.JSON' }, { name: 'a.json' }, { name: 'b.json' }],
    });
  });

  it('enumerates at most 1000 entries and rejects larger directories instead of truncating', async () => {
    const limit = WORKFLOW_DIRECTORY_LIMITS.maxListEntries;
    expect(limit).toBe(1000);
    for (let index = 0; index < limit; index += 1) writeFileSync(fileOf(`f${index}.json`), '');

    expect((await createService().list()).list).toHaveLength(limit);

    writeFileSync(fileOf('extra.txt'), '');
    expect(await failure(createService().list())).toMatchObject({
      status: 413,
      message: '工作流目录条目数超过上限',
    });
  });

  it('returns the normalized document with the raw-byte SHA-256 revision', async () => {
    const raw = `{"version":1,"id":"wf-test","name":" 测试流程 ","nodes":[${JSON.stringify(textNode)}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`;
    writeFileSync(fileOf('a.json'), raw);

    const result = await createService().read('a.json');

    expect(result.filename).toBe('a.json');
    expect(result.revision).toBe(sha256(raw));
    expect(JSON.parse(result.text)).toMatchObject({ name: '测试流程' });
    expect(bytesOf('a.json').toString()).toBe(raw);
  });

  it('removes start-node credentials when reading', async () => {
    writeFileSync(fileOf('a.json'), workflow({}, [startNode, textNode]));

    const { text } = await createService().read('a.json');

    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).nodes[0].config).toMatchObject({ githubToken: '' });
  });

  it('maps missing, invalid, oversized, linked and non-UTF-8 files to safe errors', async () => {
    const service = createService();
    expect(await failure(service.read('missing.json'))).toMatchObject({
      status: 404,
      message: '工作流文件不存在',
    });

    writeFileSync(fileOf('bad.json'), `{"version":1,"leak":"${SECRET}"`);
    const invalid = await failure(service.read('bad.json'));
    expect(invalid).toMatchObject({ status: 400, message: '工作流文件内容无效' });
    expect(invalid.message).not.toContain(SECRET);

    writeFileSync(fileOf('binary.json'), Buffer.from([0xff, 0xfe, 0x00]));
    expect((await failure(service.read('binary.json'))).status).toBe(400);

    writeFileSync(
      fileOf('big.json'),
      Buffer.alloc(WORKFLOW_DIRECTORY_LIMITS.maxDocumentBytes + 1, 0x20),
    );
    expect(await failure(service.read('big.json'))).toMatchObject({ status: 413 });

    writeFileSync(fileOf('one.json'), workflow());
    linkSync(fileOf('one.json'), fileOf('two.json'));
    expect(await failure(service.read('two.json'))).toMatchObject({
      status: 400,
      message: '文件类型或链接不受支持',
    });

    mkdirSync(fileOf('dir.json'));
    expect((await failure(service.read('dir.json'))).status).toBe(400);
  });

  it('does not follow file symlinks', async () => {
    writeFileSync(fileOf('target.json'), workflow());
    try {
      symlinkSync(fileOf('target.json'), fileOf('link.json'), 'file');
    } catch {
      return;
    }
    expect((await failure(createService().read('link.json'))).status).toBe(400);
  });
});

describe('workflow directory save', () => {
  it('creates a normalized file, drops credentials and extra fields, and leaves no temp files', async () => {
    const text = workflow({ outputs: { leak: SECRET }, runtime: { running: true } }, [
      { ...startNode, state: 'running', output: SECRET },
      textNode,
    ]);

    const saved = await createService().save({
      filename: '新流程.json',
      text,
      expectedRevision: null,
    });

    const written = bytesOf('新流程.json');
    expect(saved).toEqual({ filename: '新流程.json', revision: sha256(written) });
    const disk = written.toString();
    expect(disk).not.toContain(SECRET);
    expect(JSON.parse(disk)).not.toHaveProperty('outputs');
    expect(JSON.parse(disk)).not.toHaveProperty('runtime');
    expect(JSON.parse(disk).nodes[0]).not.toHaveProperty('state');
    expect(JSON.parse(disk).nodes[0].config.githubToken).toBe('');
    expect(readdirSync(root)).toEqual(['新流程.json']);
  });

  it('keeps a client-valid near-4MiB compact document with nine text nodes within budget', async () => {
    const target = WORKFLOW_DIRECTORY_LIMITS.maxDocumentBytes - 8;
    const nodes = Array.from({ length: 9 }, (_item, index) => ({
      ...textNode,
      id: `text-${index}`,
      config: { text: index < 8 ? 'a'.repeat(500_000) : '' },
    }));
    const base = Buffer.byteLength(workflow({}, nodes));
    nodes[8].config.text = 'a'.repeat(target - base);
    const compact = workflow({}, nodes);
    expect(Buffer.byteLength(compact)).toBe(target);

    const service = createService();
    const saved = await service.save({
      filename: 'big.json',
      text: compact,
      expectedRevision: null,
    });

    // 紧凑规范化且不追加换行：落盘字节与前端导出一致，不因缩进超出 4 MiB
    expect(bytesOf('big.json').toString()).toBe(compact);
    expect(saved.revision).toBe(sha256(compact));
    expect((await service.read('big.json')).text).toBe(compact);
  });

  it('returns 409 with the current revision when creating over an existing file', async () => {
    writeFileSync(fileOf('a.json'), workflow());
    const before = bytesOf('a.json');

    const conflict = await failure(
      createService().save({
        filename: 'a.json',
        text: workflow({ name: '新' }),
        expectedRevision: null,
      }),
    );

    expect(conflict).toMatchObject({ status: 409, revision: sha256(before) });
    expect(bytesOf('a.json').equals(before)).toBe(true);
    expect(readdirSync(root)).toEqual(['a.json']);
  });

  it('overwrites only with the matching revision and rejects stale or missing targets', async () => {
    const service = createService();
    const first = await service.save({
      filename: 'a.json',
      text: workflow(),
      expectedRevision: null,
    });
    const second = await service.save({
      filename: 'a.json',
      text: workflow({ name: '第二版' }),
      expectedRevision: first.revision,
    });
    expect(JSON.parse(bytesOf('a.json').toString()).name).toBe('第二版');
    expect(second.revision).toBe(sha256(bytesOf('a.json')));

    const stale = await failure(
      service.save({
        filename: 'a.json',
        text: workflow({ name: '第三版' }),
        expectedRevision: first.revision,
      }),
    );
    expect(stale).toMatchObject({ status: 409, revision: second.revision });
    expect(JSON.parse(bytesOf('a.json').toString()).name).toBe('第二版');

    const gone = await failure(
      service.save({ filename: 'none.json', text: workflow(), expectedRevision: first.revision }),
    );
    expect(gone).toMatchObject({ status: 409, revision: null });
    expect(existsSync(fileOf('none.json'))).toBe(false);
    expect(readdirSync(root)).toEqual(['a.json']);
  });

  it('rejects invalid and oversized documents without creating anything', async () => {
    const service = createService();
    for (const text of ['not json', workflow({ version: 2 }), workflow({ nodes: 'x' })]) {
      expect(
        await failure(service.save({ filename: 'a.json', text, expectedRevision: null })),
      ).toMatchObject({ status: 400, message: '工作流文件内容无效' });
    }
    const huge = 'x'.repeat(WORKFLOW_DIRECTORY_LIMITS.maxDocumentBytes + 1);
    expect(
      await failure(service.save({ filename: 'a.json', text: huge, expectedRevision: null })),
    ).toMatchObject({ status: 413 });
    expect(readdirSync(root)).toEqual([]);
  });

  it('lets exactly one of concurrent creations succeed within one instance', async () => {
    const service = createService();
    const results = await Promise.allSettled(
      ['一', '二', '三'].map((name) =>
        service.save({ filename: 'a.json', text: workflow({ name }), expectedRevision: null }),
      ),
    );

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(readdirSync(root)).toEqual(['a.json']);
  });

  it('lets exactly one of concurrent overwrites with the same revision succeed', async () => {
    const service = createService();
    const { revision } = await service.save({
      filename: 'a.json',
      text: workflow(),
      expectedRevision: null,
    });
    const other = createService();

    const results = await Promise.allSettled([
      service.save({
        filename: 'a.json',
        text: workflow({ name: '甲' }),
        expectedRevision: revision,
      }),
      other.save({
        filename: 'a.json',
        text: workflow({ name: '乙' }),
        expectedRevision: revision,
      }),
    ]);

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(readdirSync(root)).toEqual(['a.json']);
  });

  it('does not overwrite a file created by another process between check and link', async () => {
    const realLink = fsp.link.bind(fsp);
    const external = workflow({ name: '外部创建' });
    vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
      writeFileSync(String(to), external);
      return realLink(from, to);
    });

    const conflict = await failure(
      createService().save({ filename: 'a.json', text: workflow(), expectedRevision: null }),
    );

    expect(conflict).toMatchObject({ status: 409, revision: sha256(external) });
    expect(bytesOf('a.json').toString()).toBe(external);
    expect(readdirSync(root)).toEqual(['a.json']);
  });

  it('rechecks the revision right before committing an overwrite', async () => {
    const service = createService();
    const { revision } = await service.save({
      filename: 'a.json',
      text: workflow(),
      expectedRevision: null,
    });
    const external = workflow({ name: '外部修改' });
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await realOpen(path, flags as string, mode);
      if (String(path).includes(WORKFLOW_DIRECTORY_TEMP_PREFIX)) {
        // 临时文件写完之后、提交之前，目标被外部修改
        handle.sync = async () => writeFileSync(fileOf('a.json'), external);
      }
      return handle;
    });

    const conflict = await failure(
      service.save({
        filename: 'a.json',
        text: workflow({ name: '我的' }),
        expectedRevision: revision,
      }),
    );

    expect(conflict).toMatchObject({ status: 409, revision: sha256(external) });
    expect(bytesOf('a.json').toString()).toBe(external);
    expect(readdirSync(root)).toEqual(['a.json']);
  });

  it('does not take over an existing write lock and keeps it in place', async () => {
    const service = createService();
    const { revision } = await service.save({
      filename: 'a.json',
      text: workflow(),
      expectedRevision: null,
    });
    const before = bytesOf('a.json');
    writeFileSync(fileOf(WORKFLOW_DIRECTORY_LOCK_NAME), '');

    const busy = await failure(
      service.save({
        filename: 'a.json',
        text: workflow({ name: '新' }),
        expectedRevision: revision,
      }),
    );

    expect(busy).toMatchObject({ status: 409, message: '工作流目录正被占用，请稍后重试' });
    expect(busy.revision).toBeUndefined();
    expect(bytesOf('a.json').equals(before)).toBe(true);
    expect(readdirSync(root).sort()).toEqual([WORKFLOW_DIRECTORY_LOCK_NAME, 'a.json'].sort());
  });

  it.each(['EPERM', 'EBUSY'])(
    'turns a Windows %s rename failure into a retryable conflict and cleans up',
    async (code) => {
      const service = createService();
      const { revision } = await service.save({
        filename: 'a.json',
        text: workflow(),
        expectedRevision: null,
      });
      const before = bytesOf('a.json');
      const rename = vi
        .spyOn(fsp, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error(root), { code }));

      const busy = await failure(
        service.save({
          filename: 'a.json',
          text: workflow({ name: '新' }),
          expectedRevision: revision,
        }),
      );

      expect(busy.status).toBe(409);
      expect(busy.revision).toBeUndefined();
      expect(busy.message).not.toContain(root);
      expect(bytesOf('a.json').equals(before)).toBe(true);
      expect(readdirSync(root)).toEqual(['a.json']);

      rename.mockRestore();
      await expect(
        service.save({
          filename: 'a.json',
          text: workflow({ name: '重试' }),
          expectedRevision: revision,
        }),
      ).resolves.toMatchObject({ filename: 'a.json' });
    },
  );

  it('turns an EPERM link failure into a retryable conflict when creating', async () => {
    vi.spyOn(fsp, 'link').mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EPERM' }));

    const busy = await failure(
      createService().save({ filename: 'a.json', text: workflow(), expectedRevision: null }),
    );

    expect(busy.status).toBe(409);
    expect(busy.revision).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });

  it('keeps the old file and removes the temp file when the write fails', async () => {
    const service = createService();
    const { revision } = await service.save({
      filename: 'a.json',
      text: workflow(),
      expectedRevision: null,
    });
    const before = bytesOf('a.json');
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await realOpen(path, flags as string, mode);
      if (String(path).includes(WORKFLOW_DIRECTORY_TEMP_PREFIX)) {
        handle.writeFile = async () => {
          throw Object.assign(new Error(`disk full ${root}`), { code: 'ENOSPC' });
        };
      }
      return handle;
    });

    const failed = await failure(
      service.save({
        filename: 'a.json',
        text: workflow({ name: '新' }),
        expectedRevision: revision,
      }),
    );

    expect(failed).toEqual({ status: 500, message: '服务器内部错误', revision: undefined });
    expect(bytesOf('a.json').equals(before)).toBe(true);
    expect(readdirSync(root)).toEqual(['a.json']);
  });
});
