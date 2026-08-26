(function attachJsonDiff(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else if (root) {
    root.NestCloudJsonDiff = api
  }
})(typeof globalThis === 'object' ? globalThis : null, function createJsonDiff() {
  function canonical(value) {
    return JSON.stringify(value)
  }

  function normalizeJson(value) {
    if (Array.isArray(value)) {
      const normalized = value.map(normalizeJson)
      const identityArray = identitySortedArray(normalized)
      if (identityArray) return identityArray.values
      return normalized.sort((left, right) => {
        const leftCanonical = canonical(left)
        const rightCanonical = canonical(right)
        if (leftCanonical < rightCanonical) return -1
        if (leftCanonical > rightCanonical) return 1
        return 0
      })
    }

    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((result, key) => {
          Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            value: normalizeJson(value[key]),
            writable: true,
          })
          return result
        }, {})
    }

    return value
  }

  function getType(value) {
    if (Array.isArray(value)) return 'array'
    if (value && typeof value === 'object') return 'object'
    return 'value'
  }

  function isIdentityField(name) {
    return name === 'id' || /^[A-Za-z_][A-Za-z0-9]*Id$/.test(name)
  }

  function isValidIdentity(value) {
    return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value))
  }

  function typedIdentityKey(value) {
    return `${typeof value}:${canonical(value)}`
  }

  function uniqueIdentityFields(array) {
    if (!array.length || !array.every((item) => item && typeof item === 'object' && !Array.isArray(item))) return []
    const keys = Object.keys(array[0]).filter(isIdentityField)
    return keys.filter((key) => {
      if (!array.every((item) => Object.prototype.hasOwnProperty.call(item, key) && isValidIdentity(item[key]))) return false
      const ids = array.map((item) => typedIdentityKey(item[key]))
      return new Set(ids).size === ids.length
    }).sort((left, right) => {
      if (left === 'id') return -1
      if (right === 'id') return 1
      return left < right ? -1 : left > right ? 1 : 0
    })
  }

  function findCommonIdentityField(left, right) {
    const leftFields = uniqueIdentityFields(left)
    const rightFields = uniqueIdentityFields(right)
    const common = leftFields.filter((field) => rightFields.includes(field))
    return common.length === 1 || common.includes('id') ? (common.includes('id') ? 'id' : common[0]) : null
  }

  function identityPath(path, field, value) {
    return `${path}[${field}=${encodeURIComponent(canonical(value))}]`
  }

  function identitySortedArray(array) {
    const fields = uniqueIdentityFields(array)
    if (!fields.length) return null
    const field = fields[0]
    return {
      field,
      values: [...array].sort((left, right) => {
        const leftKey = typedIdentityKey(left[field])
        const rightKey = typedIdentityKey(right[field])
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
      }),
    }
  }

  function getChildPath(path, key, type) {
    if (type === 'array') return `${path}[${key}]`
    if (path === '$') return `$.${key}`
    return `${path}.${key}`
  }

  function makeNode({ key, path, left, right, hasLeft, hasRight, status, type, children = [], identityField = null }) {
    return { key, path, left, right, hasLeft, hasRight, status, type, children, identityField }
  }

  function compareJson(left, right) {
    const stats = { added: 0, removed: 0, modified: 0 }

    const compareNode = (key, path, leftValue, rightValue, hasLeft, hasRight) => {
      if (!hasLeft || !hasRight) {
        const status = hasRight ? 'added' : 'removed'
        stats[status] += 1
        return makeNode({ key, path, left: leftValue, right: rightValue, hasLeft, hasRight, status, type: getType(hasRight ? rightValue : leftValue) })
      }

      const leftType = getType(leftValue)
      const rightType = getType(rightValue)
      if (leftType !== rightType) {
        stats.modified += 1
        return makeNode({ key, path, left: leftValue, right: rightValue, hasLeft, hasRight, status: 'modified', type: 'value' })
      }

      if (leftType === 'object') {
        const keys = [...new Set([...Object.keys(leftValue), ...Object.keys(rightValue)])].sort()
        const children = keys.map((childKey) => compareNode(
          childKey,
          getChildPath(path, childKey, 'object'),
          leftValue[childKey],
          rightValue[childKey],
          Object.prototype.hasOwnProperty.call(leftValue, childKey),
          Object.prototype.hasOwnProperty.call(rightValue, childKey),
        ))
        return makeNode({
          key,
          path,
          left: leftValue,
          right: rightValue,
          hasLeft,
          hasRight,
          status: children.some((child) => child.status !== 'unchanged') ? 'modified' : 'unchanged',
          type: 'object',
          children,
        })
      }

      if (leftType === 'array') {
        const identityField = findCommonIdentityField(leftValue, rightValue)
        let children

        if (identityField) {
          const leftMap = new Map(leftValue.map((item) => [typedIdentityKey(item[identityField]), item]))
          const rightMap = new Map(rightValue.map((item) => [typedIdentityKey(item[identityField]), item]))
          const identityKeys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort()
          children = identityKeys.map((identityKey) => {
            const leftItem = leftMap.get(identityKey)
            const rightItem = rightMap.get(identityKey)
            const item = leftItem || rightItem
            const identityValue = item[identityField]
            return compareNode(
              identityValue,
              identityPath(path, identityField, identityValue),
              leftItem,
              rightItem,
              Boolean(leftItem),
              Boolean(rightItem),
            )
          })
        } else {
          const length = Math.max(leftValue.length, rightValue.length)
          children = Array.from({ length }, (_, index) => compareNode(
            index,
            getChildPath(path, index, 'array'),
            leftValue[index],
            rightValue[index],
            index < leftValue.length,
            index < rightValue.length,
          ))
        }

        return makeNode({
          key,
          path,
          left: leftValue,
          right: rightValue,
          hasLeft,
          hasRight,
          status: children.some((child) => child.status !== 'unchanged') ? 'modified' : 'unchanged',
          type: 'array',
          children,
          identityField,
        })
      }

      const same = Object.is(leftValue, rightValue)
      if (!same) stats.modified += 1
      return makeNode({ key, path, left: leftValue, right: rightValue, hasLeft, hasRight, status: same ? 'unchanged' : 'modified', type: 'value' })
    }

    const normalizedLeft = normalizeJson(left)
    const normalizedRight = normalizeJson(right)
    return {
      tree: compareNode('$', '$', normalizedLeft, normalizedRight, true, true),
      stats,
      left: normalizedLeft,
      right: normalizedRight,
    }
  }

  function segmentStatus(node, side) {
    if (node.status === 'added') return side === 'right' ? 'added' : null
    if (node.status === 'removed') return side === 'left' ? 'removed' : null
    if (node.status === 'modified' && !node.children.length) return 'modified'
    return null
  }

  function serializeDiffSegments(tree, side) {
    const segments = []
    const add = (text, status = null) => {
      if (text) segments.push({ text, status })
    }

    const renderRaw = (value, depth, status) => {
      if (Array.isArray(value)) {
        add('[', status)
        value.forEach((item, index) => {
          add(`${index === 0 ? '' : ','}\n${'  '.repeat(depth + 1)}`, status)
          renderRaw(item, depth + 1, status)
        })
        if (value.length) add(`\n${'  '.repeat(depth)}`, status)
        add(']', status)
        return
      }

      if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort()
        add('{', status)
        keys.forEach((key, index) => {
          add(`${index === 0 ? '' : ','}\n${'  '.repeat(depth + 1)}`, status)
          add(JSON.stringify(key), status)
          add(': ', status)
          renderRaw(value[key], depth + 1, status)
        })
        if (keys.length) add(`\n${'  '.repeat(depth)}`, status)
        add('}', status)
        return
      }

      add(JSON.stringify(value), status)
    }

    const renderNode = (node, depth) => {
      const hasValue = side === 'left' ? node.hasLeft : node.hasRight
      if (!hasValue) return
      const value = side === 'left' ? node.left : node.right
      const status = segmentStatus(node, side)

      if (!node.children.length || node.status === 'added' || node.status === 'removed') {
        renderRaw(value, depth, status)
        return
      }

      const isArray = node.type === 'array'
      const sideChildren = node.children.filter((child) => side === 'left' ? child.hasLeft : child.hasRight)
      const sideOrder = node.identityField
        ? new Map(value.map((item, index) => [typedIdentityKey(item[node.identityField]), index]))
        : null
      const children = sideOrder
        ? sideChildren.sort((leftChild, rightChild) => sideOrder.get(typedIdentityKey(leftChild.key)) - sideOrder.get(typedIdentityKey(rightChild.key)))
        : sideChildren
      add(isArray ? '[' : '{')
      children.forEach((child, index) => {
        add(`${index === 0 ? '' : ','}\n${'  '.repeat(depth + 1)}`)
        if (!isArray) {
          const keyStatus = segmentStatus(child, side)
          add(JSON.stringify(String(child.key)), keyStatus)
          add(': ')
        }
        renderNode(child, depth + 1)
      })
      if (children.length) add(`\n${'  '.repeat(depth)}`)
      add(isArray ? ']' : '}')
    }

    renderNode(tree, 0)
    return segments
  }

  return { normalizeJson, compareJson, serializeDiffSegments }
})
