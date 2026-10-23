import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const load = createRequire(__filename);
const Core = load('../../public/js/workflow-core.js');
const { createRegistry } = load('../../public/js/workflow-nodes.js');
const Directory = load('../../public/js/workflow-directory.js');
const { STORAGE_KEY, WorkflowFileService } = load('../../public/js/workflow-files.js');

const REV_A = 'a'.repeat(64);
const REV_B = 'b'.repeat(64);
const REV_C = 'c'.repeat(64);
const SECRET = 'node-text-secret-9f3a';

/** 构造可被真实工作区校验的项目文件文本。 */
const fileText = (name = '项目流程', id = 'remote-1') =>
  JSON.stringify({
    version: 1,
    id,
    name,
    nodes: [
      {
        id: 'text-1',
        type: 'text',
        version: 1,
        name: '文本',
        position: { x: 0, y: 0 },
        size: { width: 320, height: 280 },
        config: { text: SECRET },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });

function memoryStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(STORAGE_KEY, initial);
  return {
    map,
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value);
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

/** 以真实工作区与注册表创建服务，目录客户端和存储为可控替身。 */
function setup(options: { raw?: string; workspace?: unknown } = {}) {
  const workspace = options.workspace ?? new Core.Workspace({ registry: createRegistry() });
  const storage = memoryStorage(options.raw);
  const directory = { save: vi.fn(), destroy: vi.fn() };
  const confirmOverwrite = vi.fn();
  const service = new WorkflowFileService({ workspace, directory, storage, confirmOverwrite });
  return { workspace, storage, directory, confirmOverwrite, service };
}

const persisted = (storage: ReturnType<typeof memoryStorage>) =>
  JSON.parse(storage.map.get(STORAGE_KEY) as string);

describe('open project files', () => {
  it('imports as a new document keeping the name and stores only id, filename and revision', () => {
    const { workspace, service, storage } = setup();

    const document = service.open({ filename: 'a.json', text: fileText(), revision: REV_A });

    expect(document.name).toBe('项目流程');
    expect(document.id).not.toBe('remote-1');
    expect(workspace.activeId).toBe(document.id);
    expect(service.bindings.get(document.id)).toEqual({ filename: 'a.json', revision: REV_A });
    expect(persisted(storage)).toEqual({
      version: 1,
      records: [{ id: document.id, filename: 'a.json', revision: REV_A }],
    });
    expect(storage.map.get(STORAGE_KEY)).not.toContain(SECRET);
  });

  it('reuses the linked document with the same file and revision and keeps unsaved edits', () => {
    const { workspace, service } = setup();
    const first = service.open({ filename: 'a.json', text: fileText(), revision: REV_A });
    workspace.rename(first.id, '编辑中');
    workspace.create('其他');
    const count = workspace.documents.length;

    const again = service.open({ filename: 'a.json', text: fileText(), revision: REV_A });

    expect(again.id).toBe(first.id);
    expect(again.name).toBe('编辑中');
    expect(workspace.activeId).toBe(first.id);
    expect(workspace.documents).toHaveLength(count);
  });

  it('imports a new copy for a changed revision or a removed document and never deletes drafts', () => {
    const { workspace, service } = setup();
    const first = service.open({ filename: 'a.json', text: fileText(), revision: REV_A });

    const updated = service.open({ filename: 'a.json', text: fileText(), revision: REV_B });
    expect(updated.id).not.toBe(first.id);
    expect(workspace.documents.some((item: { id: string }) => item.id === first.id)).toBe(true);

    workspace.remove(updated.id);
    const reopened = service.open({ filename: 'a.json', text: fileText(), revision: REV_B });
    expect(reopened.id).not.toBe(updated.id);
    expect(service.bindings.has(updated.id)).toBe(false);
  });

  it('cleans records of documents that no longer exist when persisting', () => {
    const { workspace, service, storage } = setup();
    const first = service.open({ filename: 'a.json', text: fileText(), revision: REV_A });
    workspace.remove(first.id);

    const second = service.open({ filename: 'b.json', text: fileText(), revision: REV_B });

    expect(persisted(storage).records).toEqual([
      { id: second.id, filename: 'b.json', revision: REV_B },
    ]);
  });
});

describe('save', () => {
  it('saves a linked document in place with the known revision, even after renaming', async () => {
    const { workspace, service, directory, confirmOverwrite } = setup();
    const document = service.open({ filename: 'a.json', text: fileText(), revision: REV_A });
    workspace.rename(document.id, '新名称');
    directory.save.mockResolvedValueOnce({ filename: 'a.json', revision: REV_B });

    const saved = await service.save({ id: document.id, name: '新名称', text: 'text-1' });

    expect(saved).toEqual({ filename: 'a.json', revision: REV_B });
    // 不携带 confirmOverwrite，版本冲突由服务端拒绝
    expect(directory.save).toHaveBeenCalledWith({
      name: 'a.json',
      text: 'text-1',
      expectedRevision: REV_A,
      metadata: true,
    });
    expect(confirmOverwrite).not.toHaveBeenCalled();
    expect(service.bindings.get(document.id)).toEqual({ filename: 'a.json', revision: REV_B });
  });

  it('keeps the binding and does not retry when the server reports a conflict', async () => {
    const { service, directory } = setup();
    const document = service.open({ filename: 'a.json', text: fileText(), revision: REV_A });
    directory.save.mockRejectedValueOnce(
      Object.assign(new Error('文件版本已变化'), { status: 409 }),
    );

    await expect(service.save({ id: document.id, name: '流程', text: 'x' })).rejects.toThrow(
      '文件版本已变化',
    );

    expect(directory.save).toHaveBeenCalledTimes(1);
    expect(service.bindings.get(document.id)).toEqual({ filename: 'a.json', revision: REV_A });
  });

  it('saves an unlinked document under the generated filename with the overwrite confirmation', async () => {
    const { workspace, service, directory, confirmOverwrite, storage } = setup();
    const document = workspace.create('周报/生成');
    directory.save.mockResolvedValueOnce({ filename: '周报_生成.json', revision: REV_A });

    const saved = await service.save({ id: document.id, name: '周报/生成', text: 'x' });

    expect(saved).toEqual({ filename: '周报_生成.json', revision: REV_A });
    expect(directory.save).toHaveBeenCalledWith({
      name: Directory.filenameOf('周报/生成'),
      text: 'x',
      metadata: true,
      confirmOverwrite,
    });
    expect(service.bindings.get(document.id)).toEqual({
      filename: '周报_生成.json',
      revision: REV_A,
    });
    expect(persisted(storage).records).toHaveLength(1);
  });

  it('returns null without linking when the first overwrite confirmation is declined', async () => {
    const { workspace, service, directory, storage } = setup();
    const document = workspace.create('流程');
    directory.save.mockResolvedValueOnce(false);

    expect(await service.save({ id: document.id, name: '流程', text: 'x' })).toBeNull();

    expect(service.bindings.size).toBe(0);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('links only the saved document even if another one is selected meanwhile', async () => {
    const { workspace, service, directory } = setup();
    const saving = workspace.create('保存中');
    const other = workspace.create('其他');
    const gate = deferred<{ filename: string; revision: string }>();
    directory.save.mockReturnValueOnce(gate.promise);

    const pending = service.save({ id: saving.id, name: '保存中', text: 'x' });
    workspace.select(other.id);
    gate.resolve({ filename: '保存中.json', revision: REV_A });
    await pending;

    expect(service.bindings.get(saving.id)).toEqual({ filename: '保存中.json', revision: REV_A });
    expect(service.bindings.has(other.id)).toBe(false);
  });

  it('queues saves with a snapshot and reads the latest revision when each starts', async () => {
    const { workspace, service, directory, confirmOverwrite } = setup();
    const document = workspace.create('流程');
    const gate = deferred<{ filename: string; revision: string }>();
    directory.save
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce({ filename: '流程.json', revision: REV_C });

    const snapshot = { id: document.id, name: '流程', text: 'v1' };
    const first = service.save(snapshot);
    snapshot.text = 'mutated';
    const second = service.save({ id: document.id, name: '流程', text: 'v2' });
    await flush();

    expect(directory.save).toHaveBeenCalledTimes(1);
    expect(directory.save.mock.calls[0][0]).toEqual({
      name: '流程.json',
      text: 'v1',
      metadata: true,
      confirmOverwrite,
    });

    gate.resolve({ filename: '流程.json', revision: REV_B });
    await Promise.all([first, second]);

    // 第二次保存使用第一次刚返回的版本，不会自己制造 409
    expect(directory.save.mock.calls[1][0]).toEqual({
      name: '流程.json',
      text: 'v2',
      expectedRevision: REV_B,
      metadata: true,
    });
    expect(service.bindings.get(document.id)).toEqual({ filename: '流程.json', revision: REV_C });
  });

  it('does not let a failed save block the next one', async () => {
    const { workspace, service, directory } = setup();
    const document = workspace.create('流程');
    directory.save
      .mockRejectedValueOnce(new Error('网络失败'))
      .mockResolvedValueOnce({ filename: '流程.json', revision: REV_A });

    const failed = service.save({ id: document.id, name: '流程', text: 'v1' });
    const next = service.save({ id: document.id, name: '流程', text: 'v2' });

    await expect(failed).rejects.toThrow('网络失败');
    await expect(next).resolves.toEqual({ filename: '流程.json', revision: REV_A });
  });

  it('keeps the memory link and warns when metadata cannot be written, without failing the save', async () => {
    const { workspace, service, directory, storage } = setup();
    const document = workspace.create('流程');
    directory.save
      .mockResolvedValueOnce({ filename: '流程.json', revision: REV_A })
      .mockResolvedValueOnce({ filename: '流程.json', revision: REV_B });
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('quota');
    });

    const saved = await service.save({ id: document.id, name: '流程', text: 'v1' });

    expect(saved).toEqual({ filename: '流程.json', revision: REV_A });
    expect(service.storageError).toContain('刷新后请从目录重新打开');
    expect(service.bindings.get(document.id)?.revision).toBe(REV_A);

    await service.save({ id: document.id, name: '流程', text: 'v2' });
    expect(service.storageError).toBe('');
    expect(persisted(storage).records[0].revision).toBe(REV_B);
  });
});

describe('restore and unknown sources', () => {
  it('restores records for existing documents and filters unknown ids', () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const existing = workspace.create('流程');
    const raw = JSON.stringify({
      version: 1,
      records: [
        { id: existing.id, filename: 'a.json', revision: REV_A },
        { id: 'gone', filename: 'b.json', revision: REV_B },
      ],
    });

    const { service, storage } = setup({ raw, workspace });

    expect([...service.bindings]).toEqual([[existing.id, { filename: 'a.json', revision: REV_A }]]);
    expect(service.storageError).toBe('');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  const record = (patch: object = {}) => ({
    id: 'x',
    filename: 'a.json',
    revision: REV_A,
    ...patch,
  });
  const wrap = (records: unknown[]) => JSON.stringify({ version: 1, records });

  it.each([
    ['invalid JSON', '{oops'],
    ['wrong version', JSON.stringify({ version: 2, records: [] })],
    ['extra record field', wrap([{ ...record(), text: SECRET }])],
    ['hidden filename', wrap([record({ filename: '.a.json' })])],
    ['path filename', wrap([record({ filename: '../a.json' })])],
    ['short revision', wrap([record({ revision: 'abc' })])],
    ['array revision', wrap([record({ revision: [REV_A] })])],
    ['half unknown marker', wrap([record({ filename: null })])],
    ['duplicate ids', wrap([record(), record()])],
    ['too many records', wrap(Array.from({ length: 31 }, (_v, i) => record({ id: `id-${i}` })))],
    ['empty string', ''],
    ['oversized', wrap([record({ id: 'x'.repeat(70 * 1024) })])],
  ])('keeps the key, warns and marks existing documents unknown for %s', async (_name, raw) => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const { service, storage, directory } = setup({ raw, workspace });
    const existing = workspace.documents[0];

    expect(service.storageError).toContain('损坏');
    expect(storage.map.get(STORAGE_KEY)).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(service.bindings.get(existing.id)).toEqual({ filename: null, revision: null });

    // 现有草稿不会被当作全新文件另存，新建的流程不受阻
    await expect(service.save({ id: existing.id, name: existing.name, text: 'x' })).rejects.toThrow(
      '来源不明',
    );
    expect(directory.save).not.toHaveBeenCalled();
    const created = workspace.create('新流程');
    directory.save.mockResolvedValueOnce({ filename: '新流程.json', revision: REV_A });
    await expect(service.save({ id: created.id, name: '新流程', text: 'x' })).resolves.toEqual({
      filename: '新流程.json',
      revision: REV_A,
    });
  });

  it('marks existing documents unknown when the key cannot be read', () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const storage = memoryStorage();
    storage.getItem.mockImplementation(() => {
      throw new Error('denied');
    });

    const service = new WorkflowFileService({ workspace, directory: {}, storage });

    expect(service.storageError).not.toBe('');
    expect(service.bindings.get(workspace.documents[0].id)).toEqual({
      filename: null,
      revision: null,
    });
  });

  it('keeps unknown markers across later persists and restores, and reopening makes a document savable', async () => {
    const workspace = new Core.Workspace({ registry: createRegistry() });
    const old = workspace.documents[0];
    const first = setup({ raw: '{oops', workspace });
    const created = workspace.create('新流程');
    first.directory.save.mockResolvedValueOnce({ filename: '新流程.json', revision: REV_A });
    await first.service.save({ id: created.id, name: '新流程', text: 'x' });

    expect(persisted(first.storage).records).toEqual([
      { id: old.id, filename: null, revision: null },
      { id: created.id, filename: '新流程.json', revision: REV_A },
    ]);

    const restored = new WorkflowFileService({
      workspace,
      directory: first.directory,
      storage: first.storage,
    });
    expect(restored.storageError).toBe('');
    expect(restored.bindings.get(old.id)).toEqual({ filename: null, revision: null });
    expect(restored.bindings.get(created.id)).toEqual({ filename: '新流程.json', revision: REV_A });
    await expect(restored.save({ id: old.id, name: old.name, text: 'x' })).rejects.toThrow(
      '来源不明',
    );

    // 从项目目录重新打开得到新的已关联流程，可连续两次按最新版本原位保存
    const reopened = restored.open({ filename: 'old.json', text: fileText(), revision: REV_B });
    first.directory.save
      .mockResolvedValueOnce({ filename: 'old.json', revision: REV_C })
      .mockResolvedValueOnce({ filename: 'old.json', revision: REV_A });
    await restored.save({ id: reopened.id, name: reopened.name, text: 'v1' });
    await restored.save({ id: reopened.id, name: reopened.name, text: 'v2' });
    const calls = first.directory.save.mock.calls.slice(-2).map((call) => call[0]);
    expect(calls).toEqual([
      { name: 'old.json', text: 'v1', expectedRevision: REV_B, metadata: true },
      { name: 'old.json', text: 'v2', expectedRevision: REV_C, metadata: true },
    ]);
  });
});

describe('destroy', () => {
  it('stops queued requests and ignores late results without touching the shared directory', async () => {
    const { workspace, service, directory, storage } = setup();
    const document = workspace.create('流程');
    const gate = deferred<{ filename: string; revision: string }>();
    directory.save.mockReturnValueOnce(gate.promise);

    const first = service.save({ id: document.id, name: '流程', text: 'v1' });
    const queued = service.save({ id: document.id, name: '流程', text: 'v2' });
    await flush();
    service.destroy();
    gate.resolve({ filename: '流程.json', revision: REV_A });
    await first;

    await expect(queued).rejects.toThrow('已取消');
    expect(directory.save).toHaveBeenCalledTimes(1);
    expect(service.bindings.size).toBe(0);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(directory.destroy).not.toHaveBeenCalled();
  });
});
