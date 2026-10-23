import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import {
  WORKFLOW_DIRECTORY_BUSY_CODES,
  WORKFLOW_DIRECTORY_DISPLAY_PATH,
  WORKFLOW_DIRECTORY_ERRORS,
  WORKFLOW_DIRECTORY_LIMITS,
  WORKFLOW_DIRECTORY_LOCK_NAME,
  WORKFLOW_DIRECTORY_ROOT,
  WORKFLOW_DIRECTORY_TEMP_PREFIX,
} from '../../constants/workflow-directory.constants';
import { WorkflowDirectorySaveDto } from './dto/workflow-directory.dto';
import { WorkflowDirectoryException } from './workflow-directory.exception';
import { WorkflowDirectoryUtil } from './workflow-directory.util';

interface FileSnapshot {
  bytes: Buffer;
  revision: string;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * 固定目录 public/workflow 的工作流 JSON 读写：只操作当前层的单个 .json 文件，
 * 不跟随链接、拒绝硬链接，以原始字节 SHA-256 做乐观并发，保存经临时文件原子提交。
 */
@Injectable()
export class WorkflowDirectoryService {
  private readonly logger = new Logger(WorkflowDirectoryService.name);
  private readonly root: string = WORKFLOW_DIRECTORY_ROOT;
  /** 仅串行化本进程内保存的任务队尾，不是业务状态。 */
  private tail: Promise<unknown> = Promise.resolve();

  /** 列出当前层可安全读取的 JSON 文件名；目录尚未创建视为空，条目数超过上限明确拒绝。 */
  async list(): Promise<{ directory: string; list: { name: string }[] }> {
    return this.run(async () => {
      const root = await this.resolveRoot();
      const list: { name: string }[] = [];
      if (!root) return { directory: WORKFLOW_DIRECTORY_DISPLAY_PATH, list };
      const names: string[] = [];
      let count = 0;
      for await (const entry of await fs.opendir(root)) {
        if (++count > WORKFLOW_DIRECTORY_LIMITS.maxListEntries) {
          throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.tooManyEntries);
        }
        if (entry.isFile() && WorkflowDirectoryUtil.isValidFilename(entry.name)) {
          names.push(entry.name);
        }
      }
      for (const name of names.sort()) {
        const info = await fs.lstat(join(root, name)).catch(() => undefined);
        if (info?.isFile() && info.nlink === 1) list.push({ name });
      }
      return { directory: WORKFLOW_DIRECTORY_DISPLAY_PATH, list };
    });
  }

  /** 读取并规范化指定工作流，返回文本与原始文件版本；目录或文件不存在抛出 404。 */
  async read(filename: string): Promise<{ filename: string; text: string; revision: string }> {
    this.assertFilename(filename);
    return this.run(async () => {
      const root = await this.resolveRoot();
      const snapshot = root && (await this.readSnapshot(root, filename));
      if (!snapshot) throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.notFound);
      const text = WorkflowDirectoryUtil.normalizeDocument(snapshot.bytes);
      return { filename, text, revision: snapshot.revision };
    });
  }

  /**
   * 保存规范化后的工作流：expectedRevision 为 null 表示新建（link 无覆盖提交），
   * 否则须与当前版本一致并持写锁后 rename 覆盖。版本不一致抛出带 revision 的 409，目录被占用抛出不带 revision 的 409。
   * 新建时目录不存在会在验证固定 public 父目录后创建；覆盖不会创建目录。
   */
  async save(input: WorkflowDirectorySaveDto): Promise<{ filename: string; revision: string }> {
    const { filename, text, expectedRevision } = input;
    this.assertFilename(filename);
    const bytes = Buffer.from(
      WorkflowDirectoryUtil.normalizeDocument(Buffer.from(text, 'utf8')),
      'utf8',
    );
    return this.run(() =>
      this.enqueue(async () => {
        let root = await this.resolveRoot();
        if (!root) {
          if (expectedRevision !== null) {
            throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.conflict, null);
          }
          root = await this.createRoot();
        }
        this.assertRevision(await this.readSnapshot(root, filename), expectedRevision);
        const temp = join(root, `${WORKFLOW_DIRECTORY_TEMP_PREFIX}${randomUUID()}`);
        const lock = join(root, WORKFLOW_DIRECTORY_LOCK_NAME);
        let locked = false;
        try {
          if (expectedRevision !== null) {
            await this.acquireLock(lock); // 覆盖保存跨进程互斥
            locked = true;
          }
          const handle = await fs.open(temp, 'wx');
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await this.commit({ root, filename, temp, expectedRevision });
        } finally {
          await this.removeOwned(temp);
          if (locked) await this.removeOwned(lock);
        }
        return { filename, revision: WorkflowDirectoryUtil.computeRevision(bytes) };
      }),
    );
  }

  /** 把内部错误转换为固定安全异常，日志只保留错误码。 */
  private async run<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof WorkflowDirectoryException) throw error;
      this.logger.error(`工作流目录操作失败：code=${errorCode(error) ?? 'unknown'}`);
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.internal);
    }
  }

  /** 让保存任务在本进程内依次执行，前一个失败不阻塞后续。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private assertFilename(filename: string): void {
    if (!WorkflowDirectoryUtil.isValidFilename(filename)) {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.invalidFilename);
    }
  }

  /**
   * 校验固定根目录：不存在返回 null；存在则必须是未被替换为链接的真实目录，
   * 且 realpath 等于预期固定路径（防止 public 祖先链接逃逸），返回该真实路径。
   */
  private async resolveRoot(): Promise<string | null> {
    const info = await fs.lstat(this.root).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (!info) return null;
    const real = info.isDirectory() && !info.isSymbolicLink() ? await fs.realpath(this.root) : '';
    if (!real || !WorkflowDirectoryUtil.isSamePath(real, this.root)) {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.directoryUnavailable);
    }
    return real;
  }

  /** 显式保存时创建数据目录：其父目录（public）必须存在且真实位置等于预期路径，不递归创建。 */
  private async createRoot(): Promise<string> {
    const parent = dirname(this.root);
    const info = await fs.lstat(parent).catch(() => undefined);
    const real = info?.isDirectory() && !info.isSymbolicLink() ? await fs.realpath(parent) : '';
    if (!real || !WorkflowDirectoryUtil.isSamePath(real, parent)) {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.directoryUnavailable);
    }
    await fs.mkdir(this.root).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    const root = await this.resolveRoot();
    if (!root) throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.directoryUnavailable);
    return root;
  }

  /** 读取常规单链接文件并计算原始字节版本；不存在返回 null，链接、硬链接、超限则拒绝。 */
  private async readSnapshot(root: string, filename: string): Promise<FileSnapshot | null> {
    const path = join(root, filename);
    const info = await fs.lstat(path).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (!info) return null;
    if (!info.isFile() || info.nlink !== 1) {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.unsafeFile);
    }
    if (info.size > WORKFLOW_DIRECTORY_LIMITS.maxDocumentBytes) {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.tooLarge);
    }
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      // 打开的必须仍是 lstat 时的同一个文件，防止检查后被替换为链接
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.ino !== info.ino ||
        opened.dev !== info.dev
      ) {
        throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.unsafeFile);
      }
      const bytes = await handle.readFile();
      if (bytes.length > WORKFLOW_DIRECTORY_LIMITS.maxDocumentBytes) {
        throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.tooLarge);
      }
      return { bytes, revision: WorkflowDirectoryUtil.computeRevision(bytes) };
    } finally {
      await handle.close();
    }
  }

  /** 当前版本（不存在为 null）必须等于期望版本，否则抛出携带当前版本的 409。 */
  private assertRevision(current: FileSnapshot | null, expectedRevision: string | null): void {
    const revision = current?.revision ?? null;
    if (revision !== expectedRevision) {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.conflict, revision);
    }
  }

  /** 以 wx 创建写锁文件；已存在（其他进程持有或崩溃遗留）时返回可重试的占用 409，不自动抢占。 */
  private async acquireLock(lock: string): Promise<void> {
    try {
      await (await fs.open(lock, 'wx')).close();
    } catch (error) {
      const code = errorCode(error) ?? '';
      if (code === 'EEXIST' || WORKFLOW_DIRECTORY_BUSY_CODES.has(code)) {
        throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.busy);
      }
      throw error;
    }
  }

  /**
   * 原子提交临时文件：新建用 link 实现无覆盖（EEXIST 转为带当前版本的 409），
   * 覆盖在提交前再次核对目录与版本后 rename。Windows 占用类错误转为可重试 409，旧文件保持不变。
   */
  private async commit(options: {
    root: string;
    filename: string;
    temp: string;
    expectedRevision: string | null;
  }): Promise<void> {
    const { root, filename, temp, expectedRevision } = options;
    const target = join(root, filename);
    if ((await this.resolveRoot()) !== root) {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.directoryUnavailable);
    }
    if (expectedRevision !== null) {
      this.assertRevision(await this.readSnapshot(root, filename), expectedRevision);
    }
    try {
      if (expectedRevision === null) await fs.link(temp, target);
      else await fs.rename(temp, target);
    } catch (error) {
      const code = errorCode(error) ?? '';
      if (code === 'EEXIST') {
        const current = await this.readSnapshot(root, filename);
        throw new WorkflowDirectoryException(
          WORKFLOW_DIRECTORY_ERRORS.conflict,
          current?.revision ?? null,
        );
      }
      if (WORKFLOW_DIRECTORY_BUSY_CODES.has(code)) {
        throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.busy);
      }
      throw error;
    }
  }

  /** 删除本次保存自己创建的文件，清理失败只记录错误码。 */
  private async removeOwned(path: string): Promise<void> {
    await fs.rm(path, { force: true }).catch((error: unknown) => {
      this.logger.warn(`清理工作流临时文件失败：code=${errorCode(error) ?? 'unknown'}`);
    });
  }
}
