((root) => {
  const LIMITS = Object.freeze({
    textLength: 500_000, jsonBytes: 1024 * 1024, jsonDepth: 16, jsonNodes: 50_000,
    maxCommits: 500, defaultCommits: 100, dateRangeDays: 366,
    promptChars: 200_000, systemPromptChars: 20_000,
    aiDefaultContextWindowTokens: 100_000, aiMinContextWindowTokens: 4096, aiMaxContextWindowTokens: 1_000_000,
    sheetRows: 1_000_000, sheetColumns: 702, lookupRows: 500, lookupColumns: 50, lookupMatches: 5, readCells: 10_000,
    rows: 200, columns: 50, cells: 2000, cellLength: 8000, valuesBytes: 512 * 1024,
    responseBytes: 2 * 1024 * 1024, errorMessageChars: 200,
  })
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
  const TEMPLATE_REFERENCE = /\{\{([\s\S]*?)\}\}/g
  const TEMPLATE_ROOTS = Object.freeze(['data', 'context', 'text'])
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

  /** 校验有界纯 JSON；拒绝循环、访问器和不安全数值，原型键仅作普通数据。 */
  function assertJsonValue(value) {
    const ancestors = new Set()
    let count = 0
    const visit = (item, depth) => {
      if (++count > LIMITS.jsonNodes || depth > LIMITS.jsonDepth) throw new Error('JSON 数据超过节点数量或嵌套深度限制。')
      if (item === null || typeof item === 'boolean') return
      if (typeof item === 'string') {
        if (item.length > LIMITS.textLength) throw new Error('JSON 文本超过长度限制。')
        return
      }
      if (typeof item === 'number') {
        if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error('JSON 数值必须有限且整数不能超出安全范围。')
        return
      }
      if (typeof item !== 'object' || ancestors.has(item)) throw new Error('数据必须是无循环的纯 JSON。')
      const array = Array.isArray(item)
      if (array ? Object.getPrototypeOf(item) !== Array.prototype : Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('数据必须是纯 JSON 对象或数组。')
      if (Object.getOwnPropertySymbols(item).length) throw new Error('JSON 数据不能包含符号属性。')
      const descriptors = Object.getOwnPropertyDescriptors(item)
      const keys = Object.keys(descriptors).filter((key) => !array || key !== 'length')
      if (array && (keys.length !== item.length || keys.some((key, index) => String(index) !== key))) throw new Error('JSON 数组不能包含空位或额外属性。')
      ancestors.add(item)
      for (const key of keys) {
        const descriptor = descriptors[key]
        if (!has(descriptor, 'value') || !descriptor.enumerable) throw new Error('JSON 数据包含不安全字段。')
        visit(descriptor.value, depth + 1)
      }
      ancestors.delete(item)
    }
    visit(value, 0)
    const text = JSON.stringify(value)
    if (new TextEncoder().encode(text).length > LIMITS.jsonBytes) throw new Error('JSON 数据超过大小限制。')
    return value
  }

  /** 将 JSON 安全校验作为注册表的数据类型谓词。 */
  function isJsonValue(value) {
    try { assertJsonValue(value); return true } catch { return false }
  }

  /** 只在执行时解析草稿，解析错误不回显用户原文。 */
  function parseJson(text) {
    if (typeof text !== 'string' || text.length > LIMITS.textLength || new TextEncoder().encode(text).length > LIMITS.jsonBytes) throw new Error('JSON 原文超过大小限制或不是文本。')
    let value
    try { value = JSON.parse(text) } catch { throw new Error('JSON 原文不是有效 JSON，请检查输入。') }
    return assertJsonValue(value)
  }

  /** 解析安全自有字段路径，支持点分隔和数字数组下标。 */
  function parsePath(path) {
    if (typeof path !== 'string' || path.length > 1000) throw new Error('字段路径无效或过长。')
    if (!path) return []
    const normalized = path.replace(/\[(0|[1-9]\d*)\]/g, '.$1').replace(/^\./, path.startsWith('[') ? '' : '.')
    if (!/^[A-Za-z0-9_$\u0080-￿-]+(?:\.[A-Za-z0-9_$\u0080-￿-]+)*$/.test(normalized)) throw new Error('字段路径只支持自有字段和数字数组下标。')
    const parts = normalized.split('.')
    if (parts.length > LIMITS.jsonDepth || parts.some((part) => FORBIDDEN_KEYS.has(part))) throw new Error('字段路径包含禁止访问的原型字段。')
    return parts
  }

  /** 读取自有数据属性；缺失返回 undefined，不调用 getter 或原型。 */
  function readPath(value, path) {
    const parts = parsePath(path)
    let current = value
    for (const key of parts) {
      if (current === null || typeof current !== 'object') return undefined
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor) return undefined
      if (!has(descriptor, 'value')) throw new Error('字段路径不能访问动态属性。')
      current = descriptor.value
    }
    return current
  }

  /** 安全填充允许根（默认 data/context/text）的自有字段占位符，缺字段和超长输出立即失败。 */
  function renderTemplate(template, inputs = {}, roots = TEMPLATE_ROOTS) {
    if (typeof template !== 'string' || template.length > LIMITS.textLength) throw new Error('模板必须是有界文本。')
    for (const key of ['data', 'context']) if (has(inputs, key)) assertJsonValue(inputs[key])
    if (has(inputs, 'text') && (typeof inputs.text !== 'string' || inputs.text.length > LIMITS.textLength)) throw new Error('模板文本输入无效。')
    let length = 0
    let previous = 0
    const parts = []
    for (const match of template.matchAll(TEMPLATE_REFERENCE)) {
      const reference = match[1].trim()
      const asJson = reference.startsWith('json:')
      const field = asJson ? reference.slice(5).trim() : reference
      const path = parsePath(field)
      if (!roots.includes(path[0]) || (path[0] === 'text' && path.length !== 1)) throw new Error(`模板只支持 ${roots.join('、')} 字段引用，不支持表达式。`)
      const value = readPath(inputs, field)
      if (value === undefined) throw new Error('模板引用的输入或字段不存在。')
      const replacement = asJson || typeof value !== 'string' ? JSON.stringify(value) : value
      const literal = template.slice(previous, match.index)
      length += literal.length + replacement.length
      if (length > LIMITS.textLength) throw new Error('模板输出超过 500000 字符限制。')
      parts.push(literal, replacement)
      previous = match.index + match[0].length
    }
    length += template.length - previous
    if (length > LIMITS.textLength) throw new Error('模板输出超过 500000 字符限制。')
    parts.push(template.slice(previous))
    return parts.join('')
  }

  /** 把模板中以 from 为根的引用改写为以 to 为根，其余文字与 json: 前缀保持不变；用于节点版本迁移。 */
  function renameTemplateRoot(template, from, to) {
    return template.replace(TEMPLATE_REFERENCE, (whole, body) => {
      const reference = body.trim()
      const asJson = reference.startsWith('json:')
      const field = asJson ? reference.slice(5).trim() : reference
      if (parsePath(field)[0] !== from) return whole
      return `{{${asJson ? 'json:' : ''}${to}${field.slice(from.length)}}}`
    })
  }

  /** 列出模板实际引用的根名称，非法引用直接报错。 */
  function templateRoots(template) {
    const roots = new Set()
    for (const match of template.matchAll(TEMPLATE_REFERENCE)) {
      const reference = match[1].trim()
      roots.add(parsePath(reference.startsWith('json:') ? reference.slice(5).trim() : reference)[0])
    }
    return roots
  }

  /** 解析明确日期或带时区时间，拒绝日期自动溢出和隐式时区。 */
  function parseDate(value, endOfDay = false) {
    if (typeof value !== 'string') throw new Error('请提供明确的日期或带时区 ISO 时间。')
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-').map(Number)
      const date = new Date(0)
      date.setFullYear(year, month - 1, day)
      date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('日期不存在。')
      return date
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('时间必须包含明确时区。')
    const calendar = value.slice(0, 10).split('-').map(Number)
    const check = new Date(0)
    check.setUTCFullYear(calendar[0], calendar[1] - 1, calendar[2])
    if (check.getUTCFullYear() !== calendar[0] || check.getUTCMonth() !== calendar[1] - 1 || check.getUTCDate() !== calendar[2]) throw new Error('日期不存在。')
    const date = new Date(value)
    if (!Number.isFinite(date.getTime()) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw new Error('日期时间无效。')
    return date
  }

  /** 按本地周一生成执行时范围；自定义范围显式转换为完整 ISO。 */
  function createDateRange(config, now = new Date()) {
    if (!['last-week', 'this-week', 'custom'].includes(config?.period)) throw new Error('日期范围周期无效。')
    let since
    let until
    if (config.period === 'custom') {
      since = parseDate(config.since)
      until = parseDate(config.until, true)
    } else {
      const clock = new Date(now)
      if (!Number.isFinite(clock.getTime())) throw new Error('当前日期无效。')
      since = new Date(clock)
      since.setHours(0, 0, 0, 0)
      since.setDate(since.getDate() - (since.getDay() + 6) % 7 - (config.period === 'last-week' ? 7 : 0))
      until = new Date(since)
      until.setDate(until.getDate() + 6)
      until.setHours(23, 59, 59, 999)
    }
    if (since >= until) throw new Error('开始时间必须早于结束时间。')
    const dateText = (date) => `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    // 年月日数字供模板自由拼接表格中的周标签，如 {{context.start.month}}.{{context.start.day}}
    const parts = (date) => ({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() })
    return { since: since.toISOString(), until: until.toISOString(), startDate: dateText(since), endDate: dateText(until), start: parts(since), end: parts(until) }
  }

  /** 将绝对列名转换成有预算的 1 基列号。 */
  function columnNumber(column) {
    if (typeof column !== 'string' || !/^[A-Z]{1,3}$/.test(column)) throw new Error('起始列必须是 A、B、AA 等大写绝对列名。')
    const number = [...column].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0)
    if (number > LIMITS.sheetColumns) throw new Error('单元格列超出范围。')
    return number
  }

  /** 解析不带工作表标识的 A1 矩形坐标并验证规模。 */
  function parseCellRange(range) {
    const match = typeof range === 'string' && /^([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/.exec(range)
    if (!match) throw new Error('范围必须是 A1:B200 形式的绝对矩形，不含工作表标识。')
    const startColumn = columnNumber(match[1])
    const endColumn = columnNumber(match[3])
    const startRow = Number(match[2])
    const endRow = Number(match[4])
    if (startColumn > endColumn || startRow > endRow || endRow > LIMITS.sheetRows) throw new Error('单元格范围顺序或坐标无效。')
    return { startColumn, endColumn, startRow, endRow }
  }

  /** 校验矩形二维基础单元格数据，不截断、不执行公式。 */
  function validateCellValues(values) {
    assertJsonValue(values)
    if (!Array.isArray(values) || !values.length || values.length > LIMITS.rows || !Array.isArray(values[0]) || !values[0].length || values[0].length > LIMITS.columns) throw new Error('写入值必须是有界非空二维矩阵。')
    const columns = values[0].length
    if (new TextEncoder().encode(JSON.stringify(values)).length > LIMITS.valuesBytes) throw new Error('写入矩阵超过 512 KiB 大小限制。')
    if (columns * values.length > LIMITS.cells) throw new Error('写入单元格数量超过限制。')
    for (const row of values) {
      if (!Array.isArray(row) || row.length !== columns) throw new Error('写入矩阵每一行的列数必须相同。')
      for (const cell of row) {
        if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) throw new Error('单元格仅支持文本、数字、布尔值或 null。')
        if (typeof cell === 'string' && cell.length > LIMITS.cellLength) throw new Error('单元格文本超过长度限制。')
      }
    }
    return { rows: values.length, columns, cells: columns * values.length }
  }

  /** 按显式起始列、绝对行和矩阵计算一次写入范围。 */
  function createCellRange(options) {
    const start = columnNumber(options?.startColumn)
    if (!Number.isSafeInteger(options.row) || options.row < 1 || options.row > LIMITS.sheetRows) throw new Error('写入目标必须包含有效的绝对行号。')
    const dimensions = validateCellValues(options.values)
    let end = start + dimensions.columns - 1
    const endRow = options.row + dimensions.rows - 1
    if (end > LIMITS.sheetColumns || endRow > LIMITS.sheetRows) throw new Error('写入矩阵超出工作表坐标范围。')
    let endColumn = ''
    while (end) {
      endColumn = String.fromCharCode(65 + (end - 1) % 26) + endColumn
      end = Math.floor((end - 1) / 26)
    }
    return `${options.startColumn}${options.row}:${endColumn}${endRow}`
  }

  const api = Object.freeze({ LIMITS, isJsonValue, assertJsonValue, parseJson, parsePath, readPath, renderTemplate, renameTemplateRoot, templateRoots, createDateRange, columnNumber, parseCellRange, validateCellValues, createCellRange })
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.NestCloudWorkflowData = api
})(typeof window === 'undefined' ? globalThis : window)
