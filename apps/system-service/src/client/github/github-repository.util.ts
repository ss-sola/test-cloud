import { WorkflowCapabilityException } from '../../modules/workflow-capabilities/workflow-capability.exception';

export interface GithubRepository {
  owner: string;
  name: string;
}

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** 解析 owner/name 或标准 HTTPS GitHub 仓库地址；其他 Git 地址、带凭据或查询参数的地址一律拒绝。 */
export function parseGithubRepository(value: string): GithubRepository {
  const text = value.trim();
  let owner: string;
  let name: string;
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new WorkflowCapabilityException('GitHub 仓库地址格式无效。', 400);
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== '443')
    ) {
      throw new WorkflowCapabilityException('仅支持无凭据的 GitHub HTTPS 仓库地址。', 400);
    }
    [owner, name] = splitSegments(url.pathname);
  } else {
    [owner, name] = splitSegments(text);
  }
  name = name.replace(/\.git$/i, '');
  if (!SEGMENT_PATTERN.test(owner) || !SEGMENT_PATTERN.test(name)) {
    throw new WorkflowCapabilityException('GitHub 仓库地址格式无效。', 400);
  }
  return { owner, name };
}

function splitSegments(path: string): [string, string] {
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 2) {
    throw new WorkflowCapabilityException('GitHub 仓库地址格式无效。', 400);
  }
  try {
    return [decodeURIComponent(segments[0]), decodeURIComponent(segments[1])];
  } catch {
    throw new WorkflowCapabilityException('GitHub 仓库地址格式无效。', 400);
  }
}
