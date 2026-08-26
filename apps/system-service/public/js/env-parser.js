(function attachEnvParser(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else if (root) {
    root.NestCloudEnvParser = api
  }
})(typeof globalThis === 'object' ? globalThis : null, function createEnvParser() {
  const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

  function createError(code, line, message, extra = {}) {
    return { code, line, column: 1, message, ...extra }
  }

  function defineValue(target, key, value) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }

  function decodeQuotedValue(value, quote) {
    let decoded = ''
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]
      if (character !== '\\' || index === value.length - 1) {
        decoded += character
        continue
      }

      const next = value[index + 1]
      index += 1
      if (quote === '"') {
        decoded += {
          '\\': '\\',
          '"': '"',
          n: '\n',
          r: '\r',
          t: '\t',
        }[next] ?? `\\${next}`
      } else if (next === '\\' || next === "'") {
        decoded += next
      } else {
        decoded += `\\${next}`
      }
    }
    return decoded
  }

  function stripInlineComment(value) {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === '#' && /[ \t]/.test(value[index - 1])) {
        return value.slice(0, index).replace(/[ \t]+$/, '')
      }
    }
    return value.replace(/[ \t]+$/, '')
  }

  function parseValue(rawValue, line, errors) {
    const value = rawValue.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
    if (!value) return ''

    const quote = value[0]
    if (quote !== '"' && quote !== "'") return stripInlineComment(value)

    let closingIndex = -1
    let escaped = false
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index]
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === quote) {
        closingIndex = index
        break
      }
    }

    if (closingIndex < 0) {
      errors.push(createError('UNTERMINATED_QUOTE', line, '引号未闭合。'))
      return null
    }

    const trailing = value.slice(closingIndex + 1)
    if (trailing && !/^[ \t]+(?:#.*)?$/.test(trailing)) {
      errors.push(createError('TRAILING_CONTENT', line, '闭合引号后存在无效内容。'))
      return null
    }

    return decodeQuotedValue(value.slice(1, closingIndex), quote)
  }

  function parseEnv(text) {
    const source = String(text ?? '').replace(/^﻿/, '')
    if (!source.trim()) {
      return {
        ok: false,
        value: null,
        errors: [createError('EMPTY', 1, '内容不能为空。')],
      }
    }

    const value = Object.create(null)
    const keyLines = new Map()
    const errors = []
    const lines = source.split(/\r\n?|\n/)

    lines.forEach((rawLine, lineIndex) => {
      const line = lineIndex + 1
      const withoutLeadingSpace = rawLine.replace(/^[ \t]+/, '')
      if (!withoutLeadingSpace || withoutLeadingSpace[0] === '#') return

      const equalsIndex = rawLine.indexOf('=')
      if (equalsIndex < 0) {
        errors.push(createError('MISSING_EQUALS', line, '缺少“键=值”中的等号。'))
        return
      }

      let rawKey = rawLine.slice(0, equalsIndex).trim()
      const exportMatch = rawKey.match(/^export[ \t]+(.+)$/)
      if (exportMatch) rawKey = exportMatch[1].trim()

      if (!rawKey) {
        errors.push(createError('EMPTY_KEY', line, '键名不能为空。'))
        return
      }
      if (!KEY_PATTERN.test(rawKey)) {
        errors.push(createError('INVALID_KEY', line, `键名 ${rawKey} 无效。`, { key: rawKey }))
        return
      }
      if (keyLines.has(rawKey)) {
        errors.push(createError('DUPLICATE_KEY', line, `键 ${rawKey} 重复；首次出现在第 ${keyLines.get(rawKey)} 行。`, {
          key: rawKey,
          previousLine: keyLines.get(rawKey),
        }))
        return
      }

      const parsedValue = parseValue(rawLine.slice(equalsIndex + 1), line, errors)
      if (parsedValue === null) return

      keyLines.set(rawKey, line)
      defineValue(value, rawKey, parsedValue)
    })

    if (errors.length) return { ok: false, value: null, errors }
    return { ok: true, value, errors: [] }
  }

  return { parseEnv }
})
