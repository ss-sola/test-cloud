/** 比较算法内部使用的错误码、固定文案和输出预算系数；资源上限见 src/constants/content-compare.constants.ts。 */
export const COMPARE_ERROR_CODES = Object.freeze({
  invalidType: 'INVALID_TYPE',
  empty: 'EMPTY',
  textTooLong: 'TEXT_TOO_LONG',
  invalidJson: 'INVALID_JSON',
  depthLimit: 'DEPTH_LIMIT_EXCEEDED',
  nodeLimit: 'NODE_LIMIT_EXCEEDED',
  pathLimit: 'PATH_TOO_LONG',
  missingEquals: 'MISSING_EQUALS',
  emptyKey: 'EMPTY_KEY',
  invalidKey: 'INVALID_KEY',
  duplicateKey: 'DUPLICATE_KEY',
  unterminatedQuote: 'UNTERMINATED_QUOTE',
  trailingContent: 'TRAILING_CONTENT',
});

export const COMPARE_MESSAGES = Object.freeze({
  invalidInput: '输入内容无效。',
  resultTooLarge: '比较结果超过大小限制。',
  normalizedTooLarge: '规范化后的 JSON 超过单侧字符数限制，无法回填。',
  invalidType: '内容必须是字符串。',
  empty: '内容不能为空。',
  invalidJson: 'JSON 格式无效，请检查逗号、引号和括号。',
  invalidEnvJson: '规范化 JSON 格式无效，请检查括号、逗号和引号。',
});

/** 输出预算：每个差异树节点的 JSON 字段名、括号等固定开销（字节）。 */
export const NODE_OVERHEAD_BYTES = 220;
/** 输出预算：每个合并后分段的 JSON 字段名、括号等固定开销（字节）。 */
export const SEGMENT_OVERHEAD_BYTES = 48;
/** 输出预算：文本同时出现在回填文本与分段中的份数。 */
export const TEXT_ECHO_COPIES = 2;

export const ROOT_KEY = '$';
export const JSON_INDENT = '  ';
export const UTF8_BOM = '\uFEFF';
