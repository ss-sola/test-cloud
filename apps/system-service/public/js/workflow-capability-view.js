((root) => {
  /** 展示预算：原文始终完整保存在节点输出和下载中，界面只按预算建立 DOM。 */
  const LIMITS = Object.freeze({
    inputSaveMs: 200,
    fieldTextLength: 4096,
    fallbackTextLength: 500_000,
    rawChars: 100_000,
    markdownChars: 30_000,
    markdownBlocks: 600,
    markdownInlineNodes: 4000,
    markdownSpan: 2000,
    urlChars: 2048,
    previewChars: 4000,
    previewDepth: 6,
    previewOptions: 50,
    writeRows: 200,
    writeColumns: 50,
    writeCells: 2000,
    writeCellChars: 8000,
    writeBytes: 512 * 1024,
    sheetRows: 1_000_000,
    sheetColumns: 702,
    feedbackMs: 3000,
    revokeMs: 1000,
  })
  const FIELD_TYPES = Object.freeze(['text', 'textarea', 'number', 'select', 'checkbox', 'date'])
  const CALENDAR_ICON_PATH = 'M7 2v3M17 2v3M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'
  const CHEVRON_PATHS = Object.freeze({ previous: 'm15 6-6 6 6 6', next: 'm9 6 6 6-6 6' })
  const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/
  const WEEKDAY_LABELS = Object.freeze(['一', '二', '三', '四', '五', '六', '日'])
  /** 当前打开的日历浮层关闭函数；同一时刻只保留一个浮层。 */
  let closeOpenCalendar = null
  const UNSAFE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype'])
  const SECRET_WORDS = Object.freeze(['token', 'secret', 'password', 'passwd', 'apikey', 'credential', 'credentials', 'authorization'])
  const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
  const TOKEN_CONFIG_HASH = '#token-config'
  const SPECIAL_ESCAPES = '\\`*_[]()#!-+.>~'
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
  const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+)$/
  const LIST_ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
  const RANGE_ADDRESS = /^([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/
  const CELL_TYPES = Object.freeze(['string', 'number', 'boolean'])
  const STATUS_TEXT = Object.freeze({
    idle: '尚未运行。', queued: '等待上游节点完成。', running: '正在运行…', succeeded: '运行完成。',
    failed: '运行失败，详见上方错误信息。', skipped: '已跳过，没有输出。', cancelled: '运行已停止，没有输出。',
  })
  const RESULT_EMPTY_TEXT = Object.freeze({
    idle: '运行流程后在此查看文本结果。', queued: '等待上游节点完成。', running: '正在生成结果…',
  })
  const RESULT_FORMATS = Object.freeze([['markdown', 'Markdown'], ['text', '纯文本'], ['json', 'JSON']])
  const RESULT_DOWNLOADS = Object.freeze({
    markdown: { name: 'workflow-result.md', type: 'text/markdown;charset=utf-8' },
    text: { name: 'workflow-result.txt', type: 'text/plain;charset=utf-8' },
    json: { name: 'workflow-result.json', type: 'application/json;charset=utf-8' },
  })
  const RESULT_TABS = Object.freeze([['preview', 'Markdown 预览'], ['raw', '原文']])
  const WRITE_WARNING = '覆盖不可撤销：确认后会直接覆盖目标范围内已有内容，本工具无法撤销或回滚。请逐项核对下列目标、范围和数据。'
  let sequence = 0

  /* ------------------------------------------------------------------ */
  /* 无 DOM 的纯逻辑：字段规范化、值解析、有界预览、Markdown、写入矩阵。 */
  /* ------------------------------------------------------------------ */

  const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

  /** 判断字段键是否像凭据；按驼峰和下划线拆词，避免误伤 maxTokens 这类普通数值。 */
  function isSecretKey(key) {
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/)
    return words.some((word) => SECRET_WORDS.includes(word)) || /api key/.test(words.join(' '))
  }

  /** 把声明式字段整理为可渲染集合：丢弃重复键、原型键、凭据键和未知类型，不信任注册元数据。 */
  function normalizeFields(fields) {
    if (!Array.isArray(fields)) return []
    const seen = new Set()
    const result = []
    for (const field of fields) {
      if (!field || typeof field !== 'object') continue
      const { key, type } = field
      if (typeof key !== 'string' || !FIELD_KEY.test(key) || UNSAFE_KEYS.includes(key) || isSecretKey(key)
        || seen.has(key) || !FIELD_TYPES.includes(type)) continue
      let options = null
      if (type === 'select') {
        options = (Array.isArray(field.options) ? field.options : [])
          .filter((option) => option && typeof option === 'object' && CELL_TYPES.includes(typeof option.value))
          .slice(0, LIMITS.previewOptions)
          .map((option) => ({ value: option.value, label: typeof option.label === 'string' && option.label ? option.label : String(option.value) }))
        if (!options.length) continue
      }
      seen.add(key)
      result.push({
        key,
        type,
        label: typeof field.label === 'string' && field.label ? field.label : key,
        options,
        min: finiteOrNull(field.min),
        max: finiteOrNull(field.max),
        rows: Math.min(20, Math.max(2, Math.trunc(finiteOrNull(field.rows) ?? 4))),
        help: typeof field.help === 'string' ? field.help : '',
        placeholder: typeof field.placeholder === 'string' ? field.placeholder : '',
        fill: type === 'textarea' && field.fill === true,
        counter: (type === 'textarea' || type === 'text') && field.counter === true,
      })
    }
    return result
  }

  /** 把控件原始输入解析为配置值；数字必须有限并落在声明范围内，选项必须是声明过的值。 */
  function readFieldInput(field, raw) {
    if (field.type === 'checkbox') return { ok: true, value: raw === true }
    const text = typeof raw === 'string' ? raw : ''
    if (field.type === 'select') {
      const option = field.options.find((item) => String(item.value) === text)
      return option ? { ok: true, value: option.value } : { ok: false, message: '请选择有效选项。' }
    }
    if (field.type === 'number') {
      const trimmed = text.trim()
      const value = trimmed ? Number(trimmed) : Number.NaN
      if (!Number.isFinite(value)) return { ok: false, message: '请输入有效数字。' }
      if ((field.min !== null && value < field.min) || (field.max !== null && value > field.max)) {
        return { ok: false, message: `数值须在 ${field.min ?? '不限'} 到 ${field.max ?? '不限'} 之间。` }
      }
      return { ok: true, value }
    }
    return { ok: true, value: text }
  }

  /** 配置值转为控件显示文本；对象等非标量不显示。 */
  function displayFieldValue(value) {
    return value === null || value === undefined || typeof value === 'object' ? '' : String(value)
  }

  /** 以字符预算输出缩进 JSON 文本，超过预算立即停止，避免对大型数据整体序列化。 */
  function boundedPreview(value, limit = LIMITS.previewChars) {
    const parts = []
    let size = 0
    let truncated = false
    const stop = Symbol('preview-budget')
    const push = (text) => {
      if (size + text.length > limit) {
        parts.push(text.slice(0, Math.max(0, limit - size)))
        size = limit
        truncated = true
        throw stop
      }
      parts.push(text)
      size += text.length
    }
    const walk = (item, depth) => {
      if (item === null || typeof item === 'number' || typeof item === 'boolean') push(String(item))
      else if (typeof item === 'string') push(JSON.stringify(item.length > limit ? item.slice(0, limit) : item))
      else if (typeof item === 'object') {
        const isArray = Array.isArray(item)
        const entries = isArray ? item : Object.keys(item)
        const [open, close] = isArray ? ['[', ']'] : ['{', '}']
        if (!entries.length) push(open + close)
        else if (depth >= LIMITS.previewDepth) push(`${open}…${entries.length} 项${close}`)
        else {
          push(open)
          entries.forEach((entry, index) => {
            push(`${index ? ',' : ''}\n${'  '.repeat(depth + 1)}`)
            if (isArray) walk(entry, depth + 1)
            else {
              push(`${JSON.stringify(entry)}: `)
              walk(item[entry], depth + 1)
            }
          })
          push(`\n${'  '.repeat(depth)}${close}`)
        }
      } else push(String(typeof item))
    }
    try { walk(value, 0) } catch (error) { if (error !== stop) throw error }
    return { text: parts.join(''), truncated }
  }

  /** 输出值的一句话概览，供预览标题展示。 */
  function summarizeValue(value) {
    if (typeof value === 'string') return `文本，${value.length.toLocaleString('zh-CN')} 字符`
    if (Array.isArray(value)) return `数组，${value.length.toLocaleString('zh-CN')} 项`
    if (value && typeof value === 'object') return `对象，${Object.keys(value).length.toLocaleString('zh-CN')} 个字段`
    return typeof value
  }

  /** 只接受 http/https 绝对地址；拒绝空白控制字符、内嵌账号密码、javascript/data 等协议。 */
  function safeLinkUrl(raw) {
    const value = String(raw ?? '').trim()
    if (!value || value.length > LIMITS.urlChars || !/^https?:\/\//i.test(value)
      || /[\p{Cc}\s<>"`\\]/u.test(value)) return null
    let url
    try { url = new URL(value) } catch { return null }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname) return null
    return url.href
  }

  /** 在有限窗口内查找闭合标记，单次扫描成本与整体文本长度无关。 */
  function findClose(text, marker, from) {
    const found = text.slice(from, from + LIMITS.markdownSpan + marker.length).indexOf(marker)
    return found === -1 ? -1 : from + found
  }

  /** 解析行内强调、代码和安全链接；图片、HTML 与未闭合标记按普通文本保留。 */
  function parseInline(text, budget, depth = 0) {
    const nodes = []
    let plain = ''
    let index = 0
    const flush = () => {
      if (plain) nodes.push({ type: 'text', text: plain })
      plain = ''
    }
    const take = (node) => {
      flush()
      budget.nodes -= 1
      nodes.push(node)
    }
    while (index < text.length) {
      if (budget.nodes <= 0) {
        plain += text.slice(index)
        break
      }
      const char = text[index]
      if (char === '\\' && index + 1 < text.length && SPECIAL_ESCAPES.includes(text[index + 1])) {
        plain += text[index + 1]
        index += 2
        continue
      }
      if (char === '`') {
        const end = findClose(text, '`', index + 1)
        if (end > index + 1) {
          take({ type: 'code', text: text.slice(index + 1, end) })
          index = end + 1
          continue
        }
      } else if (char === '!' && text[index + 1] === '[') { // 图片整体按字面文本显示，不建立 img
        plain += '!['
        index += 2
        continue
      } else if (char === '[') {
        const labelEnd = findClose(text, ']', index + 1)
        if (labelEnd !== -1 && text[labelEnd + 1] === '(') {
          const urlEnd = findClose(text, ')', labelEnd + 2)
          const href = urlEnd === -1 ? null : safeLinkUrl(text.slice(labelEnd + 2, urlEnd))
          if (href) {
            take({ type: 'link', href, text: text.slice(index + 1, labelEnd) || href })
            index = urlEnd + 1
            continue
          }
        }
      } else if (depth < 2 && char === '*' && text[index + 1] === '*') {
        const end = findClose(text, '**', index + 2)
        if (end > index + 2) {
          take({ type: 'strong', children: parseInline(text.slice(index + 2, end), budget, depth + 1) })
          index = end + 2
          continue
        }
      } else if (depth < 2 && (char === '*' || char === '_') && index + 1 < text.length && !/\s/.test(text[index + 1])) {
        const wordBefore = char === '_' && index > 0 && /[A-Za-z0-9]/.test(text[index - 1])
        const end = wordBefore ? -1 : findClose(text, char, index + 1)
        const wordAfter = char === '_' && end !== -1 && /[A-Za-z0-9]/.test(text[end + 1] ?? '')
        if (end > index + 1 && !/\s/.test(text[end - 1]) && !wordAfter) {
          take({ type: 'em', children: parseInline(text.slice(index + 1, end), budget, depth + 1) })
          index = end + 1
          continue
        }
      }
      plain += char
      index += 1
    }
    flush()
    return nodes
  }

  /** 把 Markdown 解析成块级结构：标题、列表、围栏代码和段落；超出字符或块预算时标记截断。 */
  function parseMarkdown(source, options = {}) {
    const charLimit = options.maxChars ?? LIMITS.markdownChars
    const blockLimit = options.maxBlocks ?? LIMITS.markdownBlocks
    const text = String(source)
    let truncated = text.length > charLimit
    const lines = (truncated ? text.slice(0, charLimit) : text).split(/\r\n|\r|\n/)
    const budget = { nodes: LIMITS.markdownInlineNodes }
    const blocks = []
    let index = 0
    const startsBlock = (line) => FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line)
    while (index < lines.length) {
      if (blocks.length >= blockLimit) {
        truncated = true
        break
      }
      const line = lines[index]
      if (!line.trim()) {
        index += 1
        continue
      }
      const fence = FENCE.exec(line)
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        const marker = fence[1]
        const code = []
        index += 1
        while (index < lines.length) {
          const closing = lines[index].trim()
          if (closing.length >= marker.length && closing === marker[0].repeat(closing.length)) break
          code.push(lines[index])
          index += 1
        }
        index += 1
        blocks.push({ type: 'code', text: code.join('\n') })
        continue
      }
      const heading = HEADING.exec(line)
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2].replace(/[ \t]+#+[ \t]*$/, '').trim(), budget) })
        index += 1
        continue
      }
      const first = LIST_ITEM.exec(line)
      if (first) {
        const ordered = /\d/.test(first[2][0])
        const items = []
        while (index < lines.length) {
          const item = LIST_ITEM.exec(lines[index])
          if (item) {
            const depth = Math.min(4, Math.floor(item[1].length / 2))
            if (depth === 0 && items.length && /\d/.test(item[2][0]) !== ordered) break
            items.push({ depth, text: item[3] })
          } else if (/^ {2,}\S/.test(lines[index]) && !FENCE.test(lines[index])) items[items.length - 1].text += `\n${lines[index].trim()}`
          else break
          index += 1
        }
        blocks.push({
          type: 'list',
          ordered,
          start: ordered ? Number.parseInt(first[2], 10) : 1,
          items: items.map((item) => ({ depth: item.depth, children: parseInline(item.text, budget) })),
        })
        continue
      }
      const paragraph = []
      while (index < lines.length && lines[index].trim() && (!paragraph.length || !startsBlock(lines[index]))) {
        paragraph.push(lines[index])
        index += 1
      }
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n'), budget) })
    }
    return { blocks, truncated }
  }

  /** 本地日期格式化为 YYYY-MM-DD。 */
  function formatDate(date) {
    return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  /** 解析值开头的真实日历日期（兼容手输的含时区 ISO 时间），无效时返回 null。 */
  function parseDatePrefix(value) {
    const match = DATE_PREFIX.exec(String(value ?? '').trim())
    if (!match) return null
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return formatDate(date) === match[0] ? date : null
  }

  /** 生成以周一开头的 6 周月历，含前后月补位日期，供日历浮层渲染。 */
  function calendarDays(year, month) {
    const first = new Date(year, month, 1)
    const start = new Date(year, month, 1 - (first.getDay() + 6) % 7)
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
      return { date: formatDate(date), day: date.getDate(), inMonth: date.getMonth() === month }
    })
  }

  /** 列序号转字母（0 为 A）。 */
  function columnName(index) {
    let value = index + 1
    let name = ''
    while (value > 0) {
      name = String.fromCharCode(65 + ((value - 1) % 26)) + name
      value = Math.floor((value - 1) / 26)
    }
    return name
  }

  /** 解析不含工作表标识的 A1:B2 绝对矩形（与适配器 parseCellRange 同一规则）；无效返回 null。列号为 0 基。 */
  function parseRangeAddress(range) {
    const match = typeof range === 'string' ? RANGE_ADDRESS.exec(range) : null
    if (!match) return null
    const toColumn = (letters) => [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1
    const result = { startColumn: toColumn(match[1]), startRow: Number(match[2]), endColumn: toColumn(match[3]), endRow: Number(match[4]) }
    const valid = result.endColumn < LIMITS.sheetColumns && result.startColumn <= result.endColumn
      && result.startRow <= result.endRow && result.endRow <= LIMITS.sheetRows
    return valid ? result : null
  }

  /**
   * 复制待确认矩阵并核对可展示性；预算与适配器校验完全一致（行列数、单元格数、单格长度、UTF-8 字节、
   * 范围坐标），因此所有能通过适配器的矩阵都能完整展示。任何问题写入 issues，对话框据此禁用确认。
   */
  function describeMatrix(range, values) {
    const rangeInfo = parseRangeAddress(range)
    const fail = (rows, columns, cells, issue) => ({ rows, columns, cells, rangeInfo, matrix: [], issues: [issue] })
    if (!Array.isArray(values) || !values.length || !Array.isArray(values[0]) || !values[0].length) return fail(0, 0, 0, '写入数据必须是非空的二维数组。')
    const rows = values.length
    const columns = values[0].length
    const cells = columns * rows
    if (rows > LIMITS.writeRows || columns > LIMITS.writeColumns || cells > LIMITS.writeCells) {
      return fail(rows, columns, cells, `写入矩阵 ${rows} 行 × ${columns} 列超过上限（${LIMITS.writeRows} 行、${LIMITS.writeColumns} 列、${LIMITS.writeCells} 个单元格），已拒绝写入。`)
    }
    const issues = []
    if (!rangeInfo) issues.push('写入范围必须是 A1:B2 形式的绝对矩形且在工作表坐标内，已拒绝写入。')
    else if (rangeInfo.endRow - rangeInfo.startRow + 1 !== rows || rangeInfo.endColumn - rangeInfo.startColumn + 1 !== columns) {
      issues.push(`范围 ${range} 与数据矩阵 ${rows} 行 × ${columns} 列大小不一致，已拒绝写入。`)
    }
    if (!values.every((row) => Array.isArray(row) && row.length === columns)) {
      return { rows, columns, cells, rangeInfo, matrix: [], issues: [...issues, '写入数据必须是每行列数一致的矩形矩阵。'] }
    }
    let unsupported = false
    let tooLong = false
    let nonFinite = false
    const matrix = values.map((row) => row.map((cell) => {
      if (cell !== null && !CELL_TYPES.includes(typeof cell)) unsupported = true
      else if (typeof cell === 'string' && cell.length > LIMITS.writeCellChars) tooLong = true
      else if (typeof cell === 'number' && !Number.isFinite(cell)) nonFinite = true
      else return cell
      return null
    }))
    if (unsupported) issues.push('写入数据包含不支持的单元格类型，已拒绝写入。')
    if (nonFinite) issues.push('写入数据包含非有限数字，已拒绝写入。')
    if (tooLong) issues.push(`存在超过 ${LIMITS.writeCellChars} 字符的单元格，已拒绝写入。`)
    if (!unsupported && !nonFinite && !tooLong && new TextEncoder().encode(JSON.stringify(matrix)).length > LIMITS.writeBytes) {
      issues.push('写入矩阵超过 512 KiB 大小限制，已拒绝写入。')
    }
    return { rows, columns, cells, rangeInfo, matrix, issues }
  }

  /* ------------------------------------------------------------------ */
  /* 浏览器 DOM 辅助。                                                  */
  /* ------------------------------------------------------------------ */

  function assertBrowser() {
    if (typeof document === 'undefined') throw new Error('节点视图只能在浏览器中渲染。')
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  function createButton(className, text, label) {
    const button = createElement('button', className, text)
    button.type = 'button'
    if (label) button.setAttribute('aria-label', label)
    return button
  }

  /** 生成指向既有 Token 配置页的真实站内链接。 */
  function createTokenLink() {
    const link = createElement('a', 'wf-cap__link', '前往 Token 配置')
    link.href = TOKEN_CONFIG_HASH
    return link
  }

  /* ------------------------------------------------------------------ */
  /* 通用能力节点：声明式表单、保存失败可恢复、只读运行结果预览。       */
  /* ------------------------------------------------------------------ */

  /** 创建单个字段控件；控件只负责展示和读取，保存时机由表单统一管理。fill 文本域占满节点剩余高度。 */
  function createFieldControl(field, id) {
    const wrapper = createElement('div', `wf-cap__field wf-cap__field--${field.type}${field.fill ? ' wf-cap__field--fill' : ''}`)
    wrapper.dataset.fieldKey = field.key
    const label = createElement('label', 'wf-cap__label', field.label)
    label.htmlFor = id
    let input
    if (field.type === 'textarea') {
      input = createElement('textarea', field.fill ? 'wf-text' : 'wf-cap__control wf-cap__control--textarea')
      input.rows = field.rows
      input.maxLength = root.NestCloudWorkflowCore?.LIMITS?.textLength ?? LIMITS.fallbackTextLength
    } else if (field.type === 'select') {
      input = createElement('select', 'wf-cap__control')
      for (const option of field.options) {
        const element = createElement('option', '', option.label)
        element.value = String(option.value)
        input.append(element)
      }
    } else {
      input = createElement('input', field.type === 'checkbox' ? 'wf-cap__checkbox' : 'wf-cap__control')
      input.type = field.type === 'number' || field.type === 'checkbox' ? field.type : 'text'
      if (field.type === 'number') {
        input.step = 'any'
        if (field.min !== null) input.min = String(field.min)
        if (field.max !== null) input.max = String(field.max)
      } else if (field.type === 'text' || field.type === 'date') input.maxLength = LIMITS.fieldTextLength
    }
    if (field.type === 'textarea' || field.type === 'text' || field.type === 'date') input.spellcheck = false
    if (field.placeholder && field.type !== 'select' && field.type !== 'checkbox') input.placeholder = field.placeholder
    input.id = id
    input.dataset.wfField = field.key
    input.autocomplete = 'off'
    const error = createElement('p', 'wf-cap__field-error')
    error.id = `${id}-error`
    error.hidden = true
    const describedBy = []
    let picker = null
    if (field.type === 'checkbox') wrapper.append(input, label)
    else if (field.type === 'date') {
      picker = createDatePicker(field, input)
      wrapper.append(label, picker.row)
    } else wrapper.append(label, input)
    let counter = null
    if (field.counter) {
      counter = createElement('span', 'wf-text__count')
      counter.id = `${id}-count`
      describedBy.push(counter.id)
      wrapper.append(counter)
    }
    if (field.help) {
      const help = createElement('p', 'wf-cap__help', field.help)
      help.id = `${id}-help`
      describedBy.push(help.id)
      wrapper.append(help)
    }
    wrapper.append(error)
    if (describedBy.length) input.setAttribute('aria-describedby', describedBy.join(' '))
    return { field, wrapper, input, error, counter, picker, helpIds: describedBy, unknown: null }
  }

  /** 创建 24px 视框的描线 SVG 图标。 */
  function createStrokeIcon(pathData) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('aria-hidden', 'true')
    icon.setAttribute('focusable', 'false')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', pathData)
    icon.append(path)
    return icon
  }

  /**
   * 日期字段：文本框可手输日期或含时区的 ISO 时间；日历按钮打开按工作流暗色令牌绘制的月历浮层，
   * 选中后写回 YYYY-MM-DD，并按普通输入走同一套保存与校验流程。
   */
  function createDatePicker(field, input) {
    const row = createElement('div', 'wf-cap__date')
    const button = createButton('wf-cap__date-button', '', `从日历选择${field.label}`)
    button.title = '从日历选择日期'
    button.setAttribute('aria-haspopup', 'dialog')
    button.setAttribute('aria-expanded', 'false')
    button.append(createStrokeIcon(CALENDAR_ICON_PATH))
    row.append(input, button)
    let close = null

    /** 打开浮层：定位在输入框下方（空间不足时在上方），点击外部、滚轮、Esc 或选择后关闭。 */
    function open() {
      closeOpenCalendar?.()
      const selected = parseDatePrefix(input.value)
      const today = formatDate(new Date())
      let view = selected ?? new Date()
      let focused = selected ? formatDate(selected) : today
      const panel = createElement('div', 'workflow-view wf-cap-calendar')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', `选择${field.label}`)
      const head = createElement('div', 'wf-cap-calendar__head')
      const previous = createButton('wf-cap-calendar__nav', '', '上个月')
      previous.append(createStrokeIcon(CHEVRON_PATHS.previous))
      const title = createElement('strong', 'wf-cap-calendar__title')
      title.setAttribute('aria-live', 'polite')
      const next = createButton('wf-cap-calendar__nav', '', '下个月')
      next.append(createStrokeIcon(CHEVRON_PATHS.next))
      head.append(previous, title, next)
      const weekdays = createElement('div', 'wf-cap-calendar__weekdays')
      for (const label of WEEKDAY_LABELS) weekdays.append(createElement('span', '', label))
      const grid = createElement('div', 'wf-cap-calendar__grid')
      const footer = createElement('div', 'wf-cap-calendar__footer')
      const todayButton = createButton('wf-mini-button', '今天')
      footer.append(todayButton)
      panel.append(head, weekdays, grid, footer)

      const render = (focus = false) => {
        title.textContent = `${view.getFullYear()} 年 ${view.getMonth() + 1} 月`
        const value = parseDatePrefix(input.value)
        const chosen = value ? formatDate(value) : ''
        grid.replaceChildren(...calendarDays(view.getFullYear(), view.getMonth()).map((cell) => {
          const day = createButton(`wf-cap-calendar__day${cell.inMonth ? '' : ' wf-cap-calendar__day--outside'}`, String(cell.day))
          day.dataset.date = cell.date
          day.tabIndex = cell.date === focused ? 0 : -1
          const [year, month, date] = cell.date.split('-').map(Number)
          day.setAttribute('aria-label', `${year}年${month}月${date}日`)
          day.setAttribute('aria-pressed', String(cell.date === chosen))
          if (cell.date === today) day.setAttribute('aria-current', 'date')
          return day
        }))
        if (focus) grid.querySelector(`[data-date="${focused}"]`)?.focus()
      }
      const moveTo = (date, focus = true) => {
        focused = formatDate(date)
        view = date
        render(focus)
      }
      const choose = (value) => {
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('blur'))
        close()
        button.focus({ preventScroll: true })
      }

      const lifecycle = new AbortController()
      const options = { signal: lifecycle.signal }
      previous.addEventListener('click', () => moveTo(new Date(view.getFullYear(), view.getMonth() - 1, 1), false), options)
      next.addEventListener('click', () => moveTo(new Date(view.getFullYear(), view.getMonth() + 1, 1), false), options)
      todayButton.addEventListener('click', () => choose(today), options)
      grid.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-date]') : null
        if (target) choose(target.dataset.date)
      }, options)
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
          button.focus({ preventScroll: true })
          return
        }
        const [year, month, date] = focused.split('-').map(Number)
        const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
        if (offset !== undefined) moveTo(new Date(year, month - 1, date + offset))
        else if (event.key === 'PageUp' || event.key === 'PageDown') moveTo(new Date(year, month - 1 + (event.key === 'PageUp' ? -1 : 1), date))
        else return
        event.preventDefault()
      }, options)
      // 画布缩放/平移会移动输入框，外部滚轮与指针按下都直接关闭浮层
      const outside = (event) => { if (!(event.target instanceof Node) || (!panel.contains(event.target) && !button.contains(event.target))) close() }
      document.addEventListener('pointerdown', outside, { ...options, capture: true })
      document.addEventListener('wheel', outside, { ...options, capture: true, passive: true })
      window.addEventListener('resize', () => close(), options)
      window.addEventListener('blur', () => close(), options)

      close = () => {
        lifecycle.abort()
        panel.remove()
        button.setAttribute('aria-expanded', 'false')
        if (closeOpenCalendar === close) closeOpenCalendar = null
        close = null
      }
      closeOpenCalendar = close
      render()
      document.body.append(panel)
      const anchor = input.getBoundingClientRect()
      const size = panel.getBoundingClientRect()
      const below = anchor.bottom + 4 + size.height <= window.innerHeight
      panel.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - size.width - 8))}px`
      panel.style.top = `${below ? anchor.bottom + 4 : Math.max(8, anchor.top - size.height - 4)}px`
      button.setAttribute('aria-expanded', 'true')
      render(true)
    }

    button.addEventListener('click', () => (close ? close() : open()))
    return { row, button, close: () => close?.() }
  }

  /** 刷新字数提示，字符上限与控件 maxLength 一致。 */
  function refreshCounter(control) {
    if (!control.counter) return
    control.counter.textContent = `${control.input.value.length.toLocaleString('zh-CN')} / ${control.input.maxLength.toLocaleString('zh-CN')} 字符`
  }

  /** 把配置值写回控件；选项集合之外的旧值以明确的“无效”项显示，不静默改成第一项。 */
  function writeControl(control, value) {
    const { field, input } = control
    if (field.type === 'checkbox') {
      input.checked = value === true
      return
    }
    if (field.type === 'select') {
      const text = String(value)
      if (field.options.some((option) => String(option.value) === text)) {
        control.unknown?.remove()
        control.unknown = null
      } else {
        if (!control.unknown) {
          control.unknown = createElement('option')
          input.prepend(control.unknown)
        }
        control.unknown.value = text
        control.unknown.textContent = `${text || '未设置'}（当前值无效，请重新选择）`
      }
      input.value = text
      return
    }
    const text = displayFieldValue(value)
    if (input.value === text) return
    if (field.type === 'number' && input.value !== '' && Number(input.value) === Number(value)) return
    input.value = text
  }

  /** 通用节点视图：按注册定义的 fields 渲染表单，输出端口以有界只读预览展示。 */
  function capability({ node, body, workspace, documentId }) {
    assertBrowser()
    const definition = workspace.registry.get(node.type, node.version)
    const fields = normalizeFields(definition?.fields)
    const lifecycle = new AbortController()
    const listenerOptions = { signal: lifecycle.signal }
    const controls = new Map()
    const drafts = new Set()
    let current = node
    let timer = null
    let lastStatus = null
    let lastOutputs = null

    const view = createElement('div', 'wf-cap')
    view.dataset.wfCapability = node.type
    const fill = fields.some((field) => field.fill)
    view.classList.toggle('wf-cap--fill', fill)
    body.classList.add(fill ? 'wf-node__body--fill' : 'wf-node__body--scroll')
    body.append(view)

    const remote = definition?.remote === true || node.config?.credentialRef !== undefined
    if (remote) {
      const notice = createElement('p', 'wf-cap__notice', '此节点复用 Token 配置中的凭据；凭据不会写入节点配置、导出文件或运行结果。')
      notice.dataset.wfNotice = 'credentials'
      notice.append(' ', createTokenLink())
      view.append(notice)
    }
    if (node.type === 'feishu-write-cells') {
      const notice = createElement('p', 'wf-cap__notice wf-cap__notice--warning', '执行时逐次确认：每次写入前都会显示目标、范围和完整数据，确认只对当次执行有效，不会保存或导出。')
      notice.dataset.wfNotice = 'write-confirm'
      view.append(notice)
    }

    const form = createElement('div', 'wf-cap__form')
    form.setAttribute('role', 'group')
    form.setAttribute('aria-label', `${node.name} 配置`)
    const formError = createElement('div', 'wf-cap__form-error')
    formError.hidden = true
    formError.setAttribute('role', 'alert')
    const formErrorText = createElement('p', 'wf-cap__form-error-text')
    const restore = createButton('wf-mini-button', '放弃未保存修改')
    restore.dataset.wfCapabilityAction = 'restore'
    formError.append(formErrorText, restore)
    if (!fields.length) form.append(createElement('p', 'wf-cap__empty', '该节点没有可配置项。'))
    for (const field of fields) {
      const control = createFieldControl(field, `wf-cap-${++sequence}-${field.key}`)
      controls.set(field.key, control)
      form.append(control.wrapper)
    }

    const preview = createElement('section', 'wf-cap__preview')
    preview.setAttribute('aria-label', '运行结果预览')
    preview.dataset.wfInteractive = ''
    preview.hidden = definition?.preview === false
    view.append(form, formError, preview)

    const readControl = (control) => readFieldInput(control.field, control.field.type === 'checkbox' ? control.input.checked : control.input.value)

    /** 标记出错字段并汇总提示；传入空数组表示全部恢复正常。 */
    function showErrors(errors) {
      const byKey = new Map(errors.map((error) => [error.key, error.message]))
      for (const [key, control] of controls) {
        const message = byKey.get(key)
        control.error.hidden = !message
        control.error.textContent = message ?? ''
        if (message) control.input.setAttribute('aria-invalid', 'true')
        else control.input.removeAttribute('aria-invalid')
        const ids = message ? [...control.helpIds, control.error.id] : control.helpIds
        if (ids.length) control.input.setAttribute('aria-describedby', ids.join(' '))
        else control.input.removeAttribute('aria-describedby')
      }
      formError.hidden = !errors.length
      formErrorText.textContent = errors.length
        ? `配置未保存：${errors.map((error) => `${controls.get(error.key)?.field.label ?? error.key}：${error.message}`).join('；')}。运行前请修正，或放弃未保存修改。`
        : ''
    }

    /** 提交所有待保存字段；失败时保留用户输入、可见提示并抛出，阻止运行继续使用旧值。 */
    function flush() {
      window.clearTimeout(timer)
      timer = null
      if (!drafts.size) return
      const pending = [...drafts]
      const patch = {}
      const errors = []
      for (const key of pending) {
        const result = readControl(controls.get(key))
        if (result.ok) patch[key] = result.value
        else errors.push({ key, message: result.message })
      }
      if (errors.length) {
        showErrors(errors)
        throw new Error(`节点“${current.name}”配置未保存：${errors.map((error) => `${controls.get(error.key).field.label}${error.message}`).join('；')}`)
      }
      drafts.clear()
      try {
        workspace.updateNode(current.id, { config: { ...current.config, ...patch } }, documentId)
      } catch (error) {
        pending.forEach((key) => drafts.add(key))
        const message = error instanceof Error && error.message ? error.message : '配置校验失败。'
        showErrors(pending.map((key) => ({ key, message })))
        throw new Error(`节点“${current.name}”配置未保存：${message}`)
      }
      showErrors([])
    }
    const commit = () => {
      try { flush() } catch { /* 错误已在表单内显示，保留草稿等待修正 */ }
    }

    /** 丢弃草稿并恢复为已保存配置。 */
    function restoreSaved() {
      window.clearTimeout(timer)
      drafts.clear()
      for (const [key, control] of controls) writeControl(control, Object.hasOwn(current.config, key) ? current.config[key] : definition?.defaults?.[key])
      showErrors([])
    }

    for (const [key, control] of controls) {
      const instant = control.field.type === 'select' || control.field.type === 'checkbox'
      control.input.addEventListener(instant ? 'change' : 'input', () => {
        drafts.add(key)
        refreshCounter(control)
        window.clearTimeout(timer)
        if (instant) commit()
        else timer = window.setTimeout(commit, LIMITS.inputSaveMs)
      }, listenerOptions)
      if (!instant) control.input.addEventListener('blur', commit, listenerOptions)
    }
    restore.addEventListener('click', restoreSaved, listenerOptions)

    /** 重建运行结果预览；仅在状态或输出对象变化时执行，避免打断预览区滚动。 */
    function renderPreview(state) {
      if (preview.hidden || (state.status === lastStatus && state.outputs === lastOutputs)) return
      lastStatus = state.status
      lastOutputs = state.outputs
      const status = createElement('p', 'wf-cap__status', STATUS_TEXT[state.status] ?? state.status)
      status.dataset.status = state.status
      const sections = [status]
      if (state.status === 'succeeded' && state.outputs) {
        for (const port of definition?.outputs ?? []) {
          if (port.kind === 'control' || !Object.hasOwn(state.outputs, port.id)) continue
          const value = state.outputs[port.id]
          const section = createElement('div', 'wf-cap__output')
          section.dataset.port = port.id
          const title = createElement('p', 'wf-cap__output-title', port.label)
          title.append(createElement('small', '', `${port.dataType} · ${summarizeValue(value)}`))
          const shown = typeof value === 'string'
            ? { text: value.slice(0, LIMITS.previewChars), truncated: value.length > LIMITS.previewChars }
            : boundedPreview(value)
          const pre = createElement('pre', 'wf-cap__pre', shown.text)
          pre.tabIndex = 0
          pre.setAttribute('aria-label', `${port.label} 输出预览`)
          section.append(title, pre)
          if (shown.truncated) section.append(createElement('p', 'wf-cap__help', `仅预览前 ${LIMITS.previewChars.toLocaleString('zh-CN')} 个字符。`))
          sections.push(section)
        }
      }
      preview.replaceChildren(...sections)
    }

    function sync(next, state, locked) {
      current = next
      view.classList.toggle('wf-cap--locked', locked)
      for (const [key, control] of controls) {
        if (control.picker) {
          control.picker.button.disabled = locked
          if (locked) control.picker.close()
        }
        if (control.field.type === 'select' || control.field.type === 'checkbox') control.input.disabled = locked
        else control.input.readOnly = locked
        // 缺字段只显示定义默认值；没有输入事件不进入 drafts，也不改写旧草稿。
        if (!drafts.has(key)) writeControl(control, Object.hasOwn(next.config, key) ? next.config[key] : definition?.defaults?.[key])
        refreshCounter(control)
      }
      renderPreview(state)
    }
    sync(node, { status: 'idle', outputs: null }, false)

    return {
      flush,
      update({ node: next, state, locked }) { sync(next, state, locked) },
      destroy() {
        window.clearTimeout(timer)
        lifecycle.abort()
        for (const control of controls.values()) control.picker?.close()
      },
    }
  }

  /* ------------------------------------------------------------------ */
  /* 文本结果节点：原文与安全 Markdown 预览、复制、下载。               */
  /* ------------------------------------------------------------------ */

  /** 把行内节点写入父元素；链接只来自 safeLinkUrl 白名单，文本一律走 textContent。 */
  function appendInline(parent, nodes) {
    for (const item of nodes) {
      if (item.type === 'text') parent.append(document.createTextNode(item.text))
      else if (item.type === 'code') parent.append(createElement('code', 'wf-md__code', item.text))
      else if (item.type === 'link') {
        const link = createElement('a', 'wf-md__link', item.text)
        link.href = item.href
        link.target = '_blank'
        link.rel = 'noopener noreferrer nofollow'
        link.title = item.href
        parent.append(link)
      } else {
        const element = createElement(item.type)
        appendInline(element, item.children)
        parent.append(element)
      }
    }
  }

  /** 把 parseMarkdown 的块结构转成 DOM 片段。 */
  function buildMarkdown(blocks) {
    const fragment = document.createDocumentFragment()
    for (const block of blocks) {
      if (block.type === 'heading') {
        const heading = createElement(`h${Math.min(block.level + 2, 6)}`, `wf-md__heading wf-md__heading--${block.level}`)
        appendInline(heading, block.children)
        fragment.append(heading)
      } else if (block.type === 'list') {
        const list = createElement(block.ordered ? 'ol' : 'ul', 'wf-md__list')
        if (block.ordered && block.start !== 1) list.start = block.start
        for (const item of block.items) {
          const element = createElement('li', 'wf-md__item')
          if (item.depth) element.style.marginInlineStart = `${item.depth}rem`
          appendInline(element, item.children)
          list.append(element)
        }
        fragment.append(list)
      } else if (block.type === 'code') {
        const pre = createElement('pre', 'wf-md__pre')
        pre.tabIndex = 0
        pre.append(createElement('code', '', block.text))
        fragment.append(pre)
      } else {
        const paragraph = createElement('p', 'wf-md__paragraph')
        appendInline(paragraph, block.children)
        fragment.append(paragraph)
      }
    }
    return fragment
  }

  /** 写入剪贴板：优先异步剪贴板，非安全上下文退回临时 textarea 与 execCommand。 */
  async function writeClipboard(value) {
    if (root.navigator?.clipboard?.writeText) {
      await root.navigator.clipboard.writeText(value)
      return
    }
    const previous = document.activeElement
    const area = createElement('textarea')
    area.value = value
    area.readOnly = true
    area.setAttribute('aria-hidden', 'true')
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;'
    document.body.append(area)
    try {
      area.select()
      if (!document.execCommand('copy')) throw new Error('复制命令被浏览器拒绝。')
    } finally {
      area.remove()
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true })
    }
  }

  /** 文本结果节点：展示上游文本或格式化 JSON，format 决定是否提供 Markdown 预览及下载类型。 */
  function textResult({ node, body, workspace, documentId }) {
    assertBrowser()
    const lifecycle = new AbortController()
    const listenerOptions = { signal: lifecycle.signal }
    const urls = new Map()
    const rendered = { raw: false, preview: false }
    const notes = { raw: '', preview: '' }
    const formatOf = (item) => (Object.hasOwn(RESULT_DOWNLOADS, item.config?.format) ? item.config.format : 'text')
    let current = node
    let format = formatOf(node)
    let tab = 'preview'
    let text = null
    let feedbackTimer = null

    const view = createElement('div', 'wf-cap-result')
    view.dataset.wfResult = ''
    const bar = createElement('div', 'wf-cap-result__bar')
    const formatLabel = createElement('label', 'wf-cap-result__format')
    const formatText = createElement('span', '', '格式')
    const formatSelect = createElement('select', 'wf-cap__control wf-cap-result__select')
    formatSelect.dataset.wfResultAction = 'format'
    for (const [value, label] of RESULT_FORMATS) {
      const option = createElement('option', '', label)
      option.value = value
      formatSelect.append(option)
    }
    formatLabel.append(formatText, formatSelect)
    const tablist = createElement('div', 'wf-cap-result__tabs')
    tablist.setAttribute('role', 'tablist')
    tablist.setAttribute('aria-label', '结果显示方式')
    const tabButtons = {}
    for (const [key, label] of RESULT_TABS) {
      const button = createButton('wf-cap-result__tab', label)
      button.setAttribute('role', 'tab')
      button.dataset.tab = key
      tabButtons[key] = button
      tablist.append(button)
    }
    const stats = createElement('span', 'wf-cap-result__stats')
    const actions = createElement('div', 'wf-cap-result__actions')
    const copyButton = createButton('wf-mini-button', '复制')
    copyButton.dataset.wfResultAction = 'copy'
    const downloadButton = createButton('wf-mini-button', '下载')
    downloadButton.dataset.wfResultAction = 'download'
    actions.append(copyButton, downloadButton)
    bar.append(formatLabel, tablist, stats, actions)

    const feedback = createElement('p', 'wf-cap-result__feedback')
    feedback.setAttribute('role', 'status')
    feedback.hidden = true
    const note = createElement('p', 'wf-cap-result__note')
    note.hidden = true
    const empty = createElement('p', 'wf-cap-result__empty')
    const panels = {
      raw: createElement('pre', 'wf-cap-result__panel wf-cap-result__raw'),
      preview: createElement('div', 'wf-cap-result__panel wf-cap-result__preview wf-md'),
    }
    panels.raw.setAttribute('aria-label', '结果原文')
    panels.preview.setAttribute('aria-label', 'Markdown 预览')
    for (const [key, panel] of Object.entries(panels)) {
      panel.tabIndex = 0
      panel.dataset.wfInteractive = ''
      panel.dataset.wfResultMode = key === 'raw' ? 'text' : 'markdown'
      panel.hidden = true
    }
    view.append(bar, feedback, note, empty, panels.preview, panels.raw)
    body.append(view)

    function announce(message, isError = false) {
      window.clearTimeout(feedbackTimer)
      feedback.textContent = message
      feedback.classList.toggle('wf-cap-result__feedback--error', isError)
      feedback.hidden = !message
      if (message && !isError) feedbackTimer = window.setTimeout(() => announce(''), LIMITS.feedbackMs)
    }

    /** 首次显示某个视图时才建立 DOM，并按预算截断；复制与下载始终使用完整原文。 */
    function ensureRendered(mode) {
      if (text === null || rendered[mode]) return
      rendered[mode] = true
      if (mode === 'raw') {
        const clipped = text.length > LIMITS.rawChars
        panels.raw.textContent = clipped ? text.slice(0, LIMITS.rawChars) : text
        notes.raw = clipped ? `原文仅显示前 ${LIMITS.rawChars.toLocaleString('zh-CN')} 个字符，复制和下载包含完整 ${text.length.toLocaleString('zh-CN')} 个字符。` : ''
      } else {
        const parsed = parseMarkdown(text)
        panels.preview.replaceChildren(buildMarkdown(parsed.blocks))
        notes.preview = parsed.truncated ? '预览已按渲染预算截断，请查看原文或下载完整内容。' : ''
      }
    }

    function syncPanels() {
      const hasText = text !== null
      const markdown = format === 'markdown'
      const mode = markdown ? tab : 'raw'
      tablist.hidden = !markdown
      for (const [key] of RESULT_TABS) {
        tabButtons[key].setAttribute('aria-selected', String(key === mode))
        tabButtons[key].tabIndex = key === mode ? 0 : -1
      }
      panels.raw.hidden = !hasText || mode !== 'raw'
      panels.preview.hidden = !hasText || mode !== 'preview'
      empty.hidden = hasText
      stats.hidden = !hasText
      copyButton.disabled = downloadButton.disabled = !text
      if (hasText) {
        stats.textContent = `${text.length.toLocaleString('zh-CN')} 字符`
        ensureRendered(mode)
        note.textContent = notes[mode]
      }
      note.hidden = !hasText || !notes[mode]
    }

    function selectTab(key, focus = false) {
      tab = key
      syncPanels()
      if (focus) tabButtons[key].focus()
    }
    for (const [key] of RESULT_TABS) {
      tabButtons[key].addEventListener('click', () => selectTab(key), listenerOptions)
      tabButtons[key].addEventListener('keydown', (event) => {
        const index = RESULT_TABS.findIndex(([name]) => name === key)
        const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: RESULT_TABS.length - 1 }[event.key]
        if (target === undefined) return
        event.preventDefault()
        selectTab(RESULT_TABS[(target + RESULT_TABS.length) % RESULT_TABS.length][0], true)
      }, listenerOptions)
    }

    formatSelect.addEventListener('change', () => {
      try {
        workspace.updateNode(current.id, { config: { ...current.config, format: formatSelect.value } }, documentId)
        announce('')
      } catch (error) {
        formatSelect.value = format
        announce(error instanceof Error && error.message ? error.message : '格式保存失败。', true)
      }
    }, listenerOptions)

    copyButton.addEventListener('click', async () => {
      const value = text
      if (!value) return
      try {
        await writeClipboard(value)
        if (!lifecycle.signal.aborted) announce(`已复制 ${value.length.toLocaleString('zh-CN')} 个字符。`)
      } catch {
        if (!lifecycle.signal.aborted) announce('复制失败：浏览器拒绝访问剪贴板，请改用下载。', true)
      }
    }, listenerOptions)

    downloadButton.addEventListener('click', () => {
      if (!text) return
      const target = RESULT_DOWNLOADS[format]
      const url = URL.createObjectURL(new Blob([text], { type: target.type }))
      const link = createElement('a')
      link.href = url
      link.download = target.name
      link.hidden = true
      document.body.append(link)
      link.click()
      link.remove()
      urls.set(url, window.setTimeout(() => {
        urls.delete(url)
        URL.revokeObjectURL(url)
      }, LIMITS.revokeMs))
    }, listenerOptions)

    /** 切换到新结果时清空旧 DOM 和滚动位置；相同文本不重建。 */
    function showText(value) {
      if (value !== text) {
        text = value
        rendered.raw = rendered.preview = false
        notes.raw = notes.preview = ''
        panels.raw.replaceChildren()
        panels.preview.replaceChildren()
        panels.raw.scrollTop = panels.preview.scrollTop = 0
        announce('')
      }
      syncPanels()
    }

    function update({ node: next, state, locked }) {
      current = next
      format = formatOf(next)
      if (formatSelect.value !== format) formatSelect.value = format
      formatSelect.disabled = locked
      empty.textContent = RESULT_EMPTY_TEXT[state.status] ?? '没有可显示的结果，详见节点上方的状态信息。'
      showText(state.status === 'succeeded' && typeof state.outputs?.text === 'string' ? state.outputs.text : null)
    }
    update({ node, state: { status: 'idle', outputs: null }, locked: false })

    return {
      update,
      destroy() {
        window.clearTimeout(feedbackTimer)
        lifecycle.abort()
        for (const [url, timer] of urls) {
          window.clearTimeout(timer)
          URL.revokeObjectURL(url)
        }
        urls.clear()
      },
    }
  }

  /* ------------------------------------------------------------------ */
  /* 飞书写入确认：每次调用独立对话框，排队显示，不保存任何确认状态。   */
  /* ------------------------------------------------------------------ */

  const confirmQueue = []
  let confirmActive = false

  function cellContent(cell) {
    if (cell === null) return createElement('span', 'wf-cap-matrix__null', 'null')
    if (cell === '') return createElement('span', 'wf-cap-matrix__null', '（空字符串）')
    return document.createTextNode(String(cell))
  }

  /** 构造并以模态方式显示确认框，返回销毁函数；确认或取消都通过 settle 回传。 */
  function showConfirmDialog(request, settle) {
    const opener = document.activeElement
    const lifecycle = new AbortController()
    const listenerOptions = { signal: lifecycle.signal }
    const id = ++sequence
    const dialog = createElement('dialog', 'workflow-view wf-cap-dialog')
    dialog.dataset.wfWriteConfirm = ''
    dialog.setAttribute('aria-labelledby', `wf-cap-dialog-title-${id}`)
    dialog.setAttribute('aria-describedby', `wf-cap-dialog-warning-${id}`)

    const head = createElement('header', 'wf-cap-dialog__head')
    const title = createElement('h2', 'wf-cap-dialog__title', '确认写入飞书表格')
    title.id = `wf-cap-dialog-title-${id}`
    const close = createButton('wf-button wf-button--icon', '×', '关闭并取消写入')
    close.dataset.wfWriteAction = 'close'
    head.append(title, close)

    const warning = createElement('p', 'wf-cap-dialog__warning', WRITE_WARNING)
    warning.id = `wf-cap-dialog-warning-${id}`

    const facts = createElement('dl', 'wf-cap-dialog__facts')
    const rows = [['目标', request.wikiUrl], ['实际写入范围', request.range],
      ['数据规模', `${request.analysis.rows} 行 × ${request.analysis.columns} 列，共 ${request.analysis.cells.toLocaleString('zh-CN')} 个单元格`]]
    if (request.nodeName) rows.unshift(['节点', request.nodeName])
    for (const [name, value] of rows) {
      const term = createElement('dt', '', name)
      const detail = createElement('dd', '', value)
      detail.dataset.fact = name
      facts.append(term, detail)
    }

    const content = [head, warning, facts]
    if (request.analysis.issues.length) {
      const issues = createElement('ul', 'wf-cap-dialog__issues')
      issues.setAttribute('role', 'alert')
      for (const issue of request.analysis.issues) issues.append(createElement('li', '', issue))
      content.push(issues)
    }
    if (request.analysis.matrix.length) {
      const { startColumn = 0, startRow = 1 } = request.analysis.rangeInfo ?? {}
      const named = Boolean(request.analysis.rangeInfo)
      const wrap = createElement('div', 'wf-cap-dialog__matrix')
      wrap.tabIndex = 0
      wrap.setAttribute('role', 'region')
      wrap.setAttribute('aria-label', '写入数据矩阵')
      const table = createElement('table', 'wf-cap-matrix')
      const headRow = createElement('tr')
      headRow.append(createElement('th', '', named ? '行' : '#'))
      for (let column = 0; column < request.analysis.columns; column += 1) {
        const header = createElement('th', '', named ? columnName(startColumn + column) : String(column + 1))
        header.scope = 'col'
        headRow.append(header)
      }
      const tbody = createElement('tbody')
      request.analysis.matrix.forEach((row, rowIndex) => {
        const line = createElement('tr')
        const header = createElement('th', '', String((named ? startRow : 1) + rowIndex))
        header.scope = 'row'
        line.append(header)
        for (const cell of row) {
          const data = createElement('td')
          data.append(cellContent(cell))
          line.append(data)
        }
        tbody.append(line)
      })
      const thead = createElement('thead')
      thead.append(headRow)
      table.append(thead, tbody)
      wrap.append(table)
      content.push(wrap)
    }

    const footer = createElement('footer', 'wf-cap-dialog__footer')
    const cancel = createButton('wf-button', '取消，不写入')
    cancel.dataset.wfWriteAction = 'cancel'
    cancel.autofocus = true
    const confirm = createButton('wf-button wf-cap-button--danger', '确认覆盖写入')
    confirm.dataset.wfWriteAction = 'confirm'
    confirm.disabled = request.analysis.issues.length > 0
    footer.append(cancel, confirm)
    dialog.append(...content, footer)

    close.addEventListener('click', () => settle(false), listenerOptions)
    cancel.addEventListener('click', () => settle(false), listenerOptions)
    confirm.addEventListener('click', () => settle(true), listenerOptions)
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      settle(false)
    }, listenerOptions)
    dialog.addEventListener('close', () => settle(false), listenerOptions)

    const destroy = () => {
      lifecycle.abort()
      if (dialog.open) dialog.close()
      dialog.remove()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
    document.body.append(dialog)
    try {
      dialog.showModal()
    } catch (error) {
      destroy()
      throw error
    }
    return destroy
  }

  /** 依次显示排队的确认框，同一时刻只有一个对话框，避免覆盖其他确认。 */
  function pumpConfirmations() {
    if (confirmActive) return
    const entry = confirmQueue.shift()
    if (!entry) return
    confirmActive = true
    entry.active = true
    try {
      entry.cleanup = showConfirmDialog(entry.request, entry.settle)
    } catch {
      entry.settle(false)
    }
  }

  /**
   * 写入前的即时确认：展示目标、实际范围和完整有界矩阵，覆盖不可撤销警告。
   * 每次调用都是新的确认，参数在调用时复制；取消信号、Escape、关闭或拒绝均返回 false，无 UI 能力时默认 false。
   */
  function confirmWrite(options) {
    return new Promise((resolve) => {
      const { wikiUrl, range, values, signal, nodeName } = options && typeof options === 'object' ? options : {}
      if (typeof document === 'undefined' || typeof HTMLDialogElement !== 'function' || !options || signal?.aborted
        || (signal && typeof signal.addEventListener !== 'function')) {
        resolve(false)
        return
      }
      const entry = {
        active: false,
        done: false,
        cleanup: null,
        request: {
          wikiUrl: typeof wikiUrl === 'string' ? wikiUrl : '（无效目标）',
          range: typeof range === 'string' ? range : '（无效范围）',
          nodeName: typeof nodeName === 'string' ? nodeName : '',
          analysis: describeMatrix(range, values),
        },
      }
      if (typeof wikiUrl !== 'string' || typeof range !== 'string') entry.request.analysis.issues.unshift('写入目标或范围无效，已拒绝写入。')
      const onAbort = () => entry.settle(false)
      entry.settle = (confirmed) => {
        if (entry.done) return
        entry.done = true
        signal?.removeEventListener('abort', onAbort)
        const index = confirmQueue.indexOf(entry)
        if (index !== -1) confirmQueue.splice(index, 1)
        entry.cleanup?.()
        resolve(confirmed === true && !signal?.aborted)
        if (entry.active) {
          confirmActive = false
          pumpConfirmations()
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      confirmQueue.push(entry)
      pumpConfirmations()
    })
  }

  const api = Object.freeze({ capability, textResult, confirmWrite })
  if (typeof module !== 'undefined' && module.exports) {
    // Node 仅额外导出无 DOM 的纯逻辑，供行为测试使用；浏览器全局只暴露三个入口。
    module.exports = Object.freeze({
      ...api,
      LIMITS,
      normalizeFields,
      readFieldInput,
      boundedPreview,
      summarizeValue,
      safeLinkUrl,
      parseMarkdown,
      describeMatrix,
      parseRangeAddress,
      columnName,
      parseDatePrefix,
      calendarDays,
    })
  } else root.NestCloudWorkflowCapabilityView = api
})(typeof window === 'undefined' ? globalThis : window)
