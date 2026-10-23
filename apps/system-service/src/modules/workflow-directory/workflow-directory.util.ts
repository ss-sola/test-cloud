import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  WORKFLOW_DIRECTORY_ERRORS,
  WORKFLOW_DIRECTORY_FILE_EXTENSION,
  WORKFLOW_DIRECTORY_LIMITS,
  WORKFLOW_DIRECTORY_SCRIPT_ROOTS,
} from '../../constants/workflow-directory.constants';
import { WorkflowDirectoryException } from './workflow-directory.exception';

interface WorkflowNode {
  type: string;
  version: number;
  config: object;
}

interface WorkflowDefinition {
  localConfig?: boolean;
  defaults: object;
}

interface WorkflowRegistry {
  get(type: string, version: number): WorkflowDefinition | undefined;
}

interface WorkflowScripts {
  parseDocument(raw: string, registry: WorkflowRegistry): { nodes: WorkflowNode[] };
  registry: WorkflowRegistry;
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const FORBIDDEN_FILENAME_CHARACTERS = /[\\/:*?"<>|\p{Cc}\p{Cf}\p{Cs}]/u;

let scripts: WorkflowScripts | undefined;

/** 无副作用的目录文件辅助：文件名规则、原始字节版本与工作流文档规范化。 */
export class WorkflowDirectoryUtil {
  /**
   * 判断是否为单段文件名：不以 . 开头（隐藏文件与临时/锁文件不可用），扩展名为大小写不敏感的 .json，长度受限，
   * 不含路径分隔、保留字符、控制/格式字符与 .tmp.，主干首尾无空白，且不是 Windows 保留名。
   */
  static isValidFilename(name: unknown): name is string {
    if (
      typeof name !== 'string' ||
      name.startsWith('.') ||
      !name.toLowerCase().endsWith(WORKFLOW_DIRECTORY_FILE_EXTENSION) ||
      name.length > WORKFLOW_DIRECTORY_LIMITS.maxFilenameLength ||
      Buffer.byteLength(name) > WORKFLOW_DIRECTORY_LIMITS.maxFilenameBytes ||
      FORBIDDEN_FILENAME_CHARACTERS.test(name) ||
      name.toLowerCase().includes('.tmp.')
    ) {
      return false;
    }
    const stem = name.slice(0, -WORKFLOW_DIRECTORY_FILE_EXTENSION.length);
    return (
      stem.trim().length > 0 &&
      stem === stem.trim() &&
      !WINDOWS_RESERVED_NAME.test(stem.split('.')[0])
    );
  }

  /** 按平台规则比较两个路径是否相同：先规范化，Windows 不区分大小写。 */
  static isSamePath(left: string, right: string): boolean {
    const normalize = (path: string) =>
      process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    return normalize(left) === normalize(right);
  }

  /** 以原始文件字节的 SHA-256 作为版本号。 */
  static computeRevision(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  /**
   * 复用前端 parseDocument 与节点注册表校验并规范化工作流，再次清除声明 localConfig 的节点配置，
   * 返回规范化后的 JSON 文本。内容非法抛出 400，超过 4 MiB 抛出 413；不暴露校验细节。
   */
  static normalizeDocument(bytes: Buffer): string {
    if (bytes.length > WORKFLOW_DIRECTORY_LIMITS.maxDocumentBytes) {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.tooLarge);
    }
    const { parseDocument, registry } = WorkflowDirectoryUtil.loadScripts();
    let document: { nodes: WorkflowNode[] };
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      document = parseDocument(text, registry);
    } catch {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.invalidDocument);
    }
    const nodes = document.nodes.map((node) => {
      const definition = registry.get(node.type, node.version);
      return definition?.localConfig
        ? { ...node, config: structuredClone(definition.defaults) }
        : node;
    });
    // 紧凑输出且不追加换行，与前端 4 MiB 导出预算（紧凑 JSON）一致
    const text = JSON.stringify({ ...document, nodes });
    if (Buffer.byteLength(text) > WORKFLOW_DIRECTORY_LIMITS.maxDocumentBytes) {
      throw new WorkflowDirectoryException(WORKFLOW_DIRECTORY_ERRORS.tooLarge);
    }
    return text;
  }

  /** 首次使用时从源码 public/js 或 dist/public/js 载入前端脚本，并创建不带渲染器的节点注册表。 */
  private static loadScripts(): WorkflowScripts {
    if (scripts) return scripts;
    const directory = WORKFLOW_DIRECTORY_SCRIPT_ROOTS.find((root) =>
      existsSync(join(root, 'workflow-nodes.js')),
    );
    if (!directory) throw new Error('未找到工作流前端脚本');
    const load = createRequire(__filename);
    const core = load(join(directory, 'workflow-core.js'));
    const nodes = load(join(directory, 'workflow-nodes.js'));
    scripts = { parseDocument: core.parseDocument, registry: nodes.createRegistry() };
    return scripts;
  }
}
