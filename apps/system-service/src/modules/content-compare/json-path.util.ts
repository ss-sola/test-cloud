const IDENTIFIER_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 差异树路径片段：普通标识符键保留点号，其余键使用 JSON 字符串括号，保证路径唯一。 */
export class JsonPathUtil {
  /** 返回对象键的路径片段，如 `.name` 或 `["a.b"]`；括号形式不会与数组下标 `[0]` 冲突。 */
  static keySegment(key: string): string {
    return IDENTIFIER_KEY_PATTERN.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
}
