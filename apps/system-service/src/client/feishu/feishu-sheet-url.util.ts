import { FEISHU_DOCUMENT_DOMAINS } from '../../constants/workflow-capability.constants';
import { WorkflowCapabilityException } from '../../modules/workflow-capabilities/workflow-capability.exception';

export interface FeishuSheetLocator {
  type: 'wiki' | 'sheets';
  token: string;
  sheetId: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHEET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 解析飞书 Wiki 或 Sheet 的 HTTPS 地址，必须带非空 sheet 参数，且不含凭据、片段和非默认端口；仅解析，不会向该地址发起请求。 */
export function parseFeishuSheetUrl(value: string): FeishuSheetLocator {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new WorkflowCapabilityException('飞书表格地址格式无效。', 400);
  }
  const hostname = url.hostname.toLowerCase();
  const supported = FEISHU_DOCUMENT_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
  const segments = url.pathname.split('/').filter(Boolean);
  const type = segments[0]?.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !supported ||
    (type !== 'wiki' && type !== 'sheets') ||
    segments.length !== 2 ||
    !TOKEN_PATTERN.test(segments[1])
  ) {
    throw new WorkflowCapabilityException('飞书表格地址域名或路径不受支持。', 400);
  }
  const sheetId = url.searchParams.get('sheet')?.trim() ?? '';
  if (!SHEET_ID_PATTERN.test(sheetId)) {
    throw new WorkflowCapabilityException('飞书表格地址缺少有效的 sheet 参数。', 400);
  }
  return { type, token: segments[1], sheetId };
}
