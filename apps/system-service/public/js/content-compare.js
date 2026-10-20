(() => {
  if (typeof document === 'undefined') return

  const ENDPOINTS = Object.freeze({ json: '/api/content-compare/json', env: '/api/content-compare/env' })
  const STORAGE_KEYS = Object.freeze({ json: 'nestcloud:compare:json:v1', env: 'nestcloud:compare:env:v1' })
  const STORAGE_VERSION = 1
  const MAX_DRAFT_LENGTH = 500_000
  const REQUEST_TIMEOUT_MS = 30_000
  const DIFF_LABELS = { added: '新增', removed: '删除', modified: '修改', unchanged: '未变化' }

  function createElement(tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  function readDraft(mode) {
    try {
      const value = JSON.parse(window.localStorage.getItem(STORAGE_KEYS[mode]) || 'null')
      if (value?.version !== STORAGE_VERSION || typeof value.left !== 'string' || typeof value.right !== 'string'
        || value.left.length > MAX_DRAFT_LENGTH || value.right.length > MAX_DRAFT_LENGTH) return null
      return value
    } catch { return null }
  }

  function saveDraft(mode, left, right) {
    if (left.length > MAX_DRAFT_LENGTH || right.length > MAX_DRAFT_LENGTH) return
    try {
      window.localStorage.setItem(STORAGE_KEYS[mode], JSON.stringify({ version: STORAGE_VERSION, left, right, updatedAt: Date.now() }))
    } catch { /* Storage is optional; the editors remain usable. */ }
  }

  function formatErrors(label, side, errors) {
    return errors.map((error) => {
      const location = error.line ? `第 ${error.line} 行${error.column ? `第 ${error.column} 列` : ''}：` : ''
      return `${label} ${side} ${location}${error.message}`
    }).join('\n')
  }

  function collectExpandedPaths(node, paths = new Set()) {
    if (node.children.length) {
      paths.add(node.path)
      node.children.forEach((child) => collectExpandedPaths(child, paths))
    }
    return paths
  }

  function renderSegments(codeElement, textarea, segments) {
    codeElement.replaceChildren()
    textarea.classList.toggle('compare-editor__textarea--highlighted', Boolean(segments))
    if (!segments) return
    segments.forEach((segment, index) => {
      const span = createElement('span', segment.status ? `compare-highlight--${segment.status}` : '')
      span.textContent = segment.text
      span.dataset.segment = String(index)
      codeElement.append(span)
    })
  }

  function renderMarkers(markerElement, segments) {
    markerElement.replaceChildren()
    if (!segments) return
    const statusByLine = new Map()
    let line = 0
    segments.forEach((segment) => {
      segment.text.split(/\r\n?|\n/).forEach((text, index) => {
        if (index > 0) line += 1
        if (segment.status && text.length) statusByLine.set(line, segment.status)
      })
    })
    const totalLines = Math.max(line + 1, 1)
    statusByLine.forEach((status, lineIndex) => {
      const element = createElement('span', `compare-marker compare-marker--${status}`)
      element.style.top = `${lineIndex / totalLines * 100}%`
      element.style.height = `${Math.max(1.4, 100 / totalLines)}%`
      element.dataset.marker = String(lineIndex)
      markerElement.append(element)
    })
  }

  function renderDiffRow(node, options) {
    const { depth, expandedPaths, onToggle, label } = options
    const row = createElement('div', `compare-tree-row compare-tree-row--${node.status}`)
    row.setAttribute('role', 'treeitem')
    row.setAttribute('aria-level', String(depth + 1))
    const isContainer = node.children.length > 0
    const isExpanded = expandedPaths.has(node.path)
    if (isContainer) row.setAttribute('aria-expanded', String(isExpanded))
    const key = createElement('div', 'compare-tree-key')
    key.style.paddingLeft = `${depth * 16 + 8}px`
    if (isContainer) {
      const toggle = createElement('button', 'compare-tree-toggle', isExpanded ? '−' : '+')
      toggle.type = 'button'
      toggle.setAttribute('aria-label', `${isExpanded ? '收起' : '展开'} ${node.path}`)
      toggle.addEventListener('click', () => onToggle(node.path))
      key.append(toggle)
    } else key.append(createElement('span', 'compare-tree-spacer'))
    key.append(createElement('span', 'compare-tree-label', String(node.key)))
    key.append(createElement('span', `compare-status compare-status--${node.status}`, DIFF_LABELS[node.status]))
    const leftCell = createElement('div', `compare-cell compare-cell--${node.status === 'added' ? 'missing' : node.status}`)
    leftCell.dataset.label = `${label} A`
    leftCell.textContent = node.hasLeft ? node.leftDisplay : '—'
    const rightCell = createElement('div', `compare-cell compare-cell--${node.status === 'removed' ? 'missing' : node.status}`)
    rightCell.dataset.label = `${label} B`
    rightCell.textContent = node.hasRight ? node.rightDisplay : '—'
    row.append(key, leftCell, rightCell)
    const fragment = document.createDocumentFragment()
    fragment.append(row)
    if (isContainer && isExpanded) {
      node.children.forEach((child) => fragment.append(renderDiffRow(child, { ...options, depth: depth + 1 })))
    }
    return fragment
  }

  function mount(root) {
    if (!(root instanceof HTMLElement)) return
    const prefix = root.dataset.view === 'json-compare' ? 'json' : root.dataset.view === 'env-compare' ? 'env' : ''
    if (!prefix) return
    const label = prefix === 'json' ? 'JSON' : 'ENV'
    const left = root.querySelector(`#${prefix}-a`)
    const right = root.querySelector(`#${prefix}-b`)
    const leftHighlight = root.querySelector(`#${prefix}-a-highlight code`)
    const rightHighlight = root.querySelector(`#${prefix}-b-highlight code`)
    const leftMarkers = root.querySelector(`#${prefix}-a-markers`)
    const rightMarkers = root.querySelector(`#${prefix}-b-markers`)
    const leftCount = root.querySelector(`#${prefix}-a-count`)
    const rightCount = root.querySelector(`#${prefix}-b-count`)
    const leftError = root.querySelector(`#${prefix}-a-error`)
    const rightError = root.querySelector(`#${prefix}-b-error`)
    const resultRoot = root.querySelector(`#${prefix}-result`)
    const resultTitle = root.querySelector(`#${prefix}-result-title`)
    const tree = root.querySelector(`#${prefix}-tree`)
    const compareButton = root.querySelector(`[data-compare-action="${prefix}"]`)
    const swapButton = root.querySelector(`[data-compare-swap="${prefix}"]`)
    if (!(left instanceof HTMLTextAreaElement) || !(right instanceof HTMLTextAreaElement)
      || !(leftHighlight instanceof HTMLElement) || !(rightHighlight instanceof HTMLElement)
      || !(leftMarkers instanceof HTMLElement) || !(rightMarkers instanceof HTMLElement)
      || !(leftError instanceof HTMLElement) || !(rightError instanceof HTMLElement)
      || !(resultRoot instanceof HTMLElement) || !(resultTitle instanceof HTMLElement)
      || !(tree instanceof HTMLElement) || !(compareButton instanceof HTMLButtonElement)
      || !(swapButton instanceof HTMLButtonElement)) return

    const draft = readDraft(prefix)
    if (draft) {
      left.value = draft.left
      right.value = draft.right
    }
    const compareLabel = compareButton.textContent
    const listeners = []
    let result = null
    let expandedPaths = new Set(['$'])
    let requestController = null
    let requestGeneration = 0
    let requestTimer = null
    let syncingScroll = false
    const editorRefs = { A: left, B: right }

    function listen(element, event, handler) {
      element.addEventListener(event, handler)
      listeners.push({ element, event, handler })
    }

    function persistDraft() {
      saveDraft(prefix, left.value, right.value)
    }

    function updateCounts() {
      if (leftCount) leftCount.textContent = `${left.value.length.toLocaleString()} 字符`
      if (rightCount) rightCount.textContent = `${right.value.length.toLocaleString()} 字符`
    }

    function setError(element, message) {
      element.textContent = message
      element.hidden = !message
      element.closest('.compare-input-panel')?.classList.toggle('compare-input-panel--error', Boolean(message))
    }

    function setBusy(busy) {
      compareButton.disabled = busy
      compareButton.textContent = busy ? '正在对比…' : compareLabel
      root.setAttribute('aria-busy', String(busy))
    }

    function cancelRequest() {
      requestGeneration += 1
      requestController?.abort()
      requestController = null
      window.clearTimeout(requestTimer)
      requestTimer = null
      setBusy(false)
    }

    function clearResult() {
      result = null
      resultRoot.hidden = true
      renderSegments(leftHighlight, left, null)
      renderSegments(rightHighlight, right, null)
      renderMarkers(leftMarkers, null)
      renderMarkers(rightMarkers, null)
    }

    function renderTree() {
      tree.replaceChildren()
      const header = createElement('div', 'compare-tree-head')
      header.append(createElement('span', 'compare-tree-head__path', '路径'), createElement('span', '', `${label} A`), createElement('span', '', `${label} B`))
      tree.append(header, renderDiffRow(result.tree, { depth: 0, expandedPaths, onToggle: togglePath, label }))
    }

    function renderResult() {
      renderSegments(leftHighlight, left, result.segments.left)
      renderSegments(rightHighlight, right, result.segments.right)
      renderMarkers(leftMarkers, result.segments.left)
      renderMarkers(rightMarkers, result.segments.right)
      resultTitle.textContent = result.stats.added + result.stats.removed + result.stats.modified === 0 ? '无变化。' : '发现变化。'
      root.querySelector(`#${prefix}-added-count`).textContent = String(result.stats.added)
      root.querySelector(`#${prefix}-removed-count`).textContent = String(result.stats.removed)
      root.querySelector(`#${prefix}-modified-count`).textContent = String(result.stats.modified)
      renderTree()
      resultRoot.hidden = false
    }

    function togglePath(path) {
      if (expandedPaths.has(path)) expandedPaths.delete(path)
      else expandedPaths.add(path)
      if (result) renderTree()
    }

    function handleTextChange() {
      cancelRequest()
      setError(leftError, '')
      setError(rightError, '')
      updateCounts()
      persistDraft()
      expandedPaths = new Set(['$'])
      clearResult()
    }

    async function compare() {
      cancelRequest()
      clearResult()
      setError(leftError, '')
      setError(rightError, '')
      const generation = requestGeneration
      const controller = new AbortController()
      requestController = controller
      let timedOut = false
      setBusy(true)
      requestTimer = window.setTimeout(() => {
        timedOut = true
        controller.abort()
      }, REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(ENDPOINTS[prefix], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({ left: left.value, right: right.value }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null)
        if (generation !== requestGeneration) return
        if (timedOut) throw new Error(`${label} 对比请求超时，请重试。`)
        if (!response.ok || payload?.code !== 200) {
          const errors = payload?.errors
          const leftErrors = Array.isArray(errors?.left) ? errors.left : []
          const rightErrors = Array.isArray(errors?.right) ? errors.right : []
          if (leftErrors.length || rightErrors.length) {
            setError(leftError, formatErrors(label, 'A', leftErrors))
            setError(rightError, formatErrors(label, 'B', rightErrors))
          } else {
            const message = payload?.message || `${label} 对比请求失败（${response.status}），请稍后重试。`
            setError(leftError, message)
            setError(rightError, message)
          }
          return
        }
        const nextResult = payload.data
        if (!nextResult?.tree || !nextResult.stats || !Array.isArray(nextResult.segments?.left)
          || !Array.isArray(nextResult.segments?.right) || typeof nextResult.leftText !== 'string'
          || typeof nextResult.rightText !== 'string') throw new Error('对比服务返回了无效结果，请稍后重试。')
        result = nextResult
        if (prefix === 'json') {
          left.value = result.leftText
          right.value = result.rightText
        }
        persistDraft()
        updateCounts()
        expandedPaths = collectExpandedPaths(result.tree)
        renderResult()
      } catch (error) {
        if (generation !== requestGeneration) return
        if (error?.name === 'AbortError' && !timedOut) return
        clearResult()
        const message = timedOut ? `${label} 对比请求超时，请重试。` : error instanceof Error ? error.message : `${label} 对比服务暂不可用，请重试。`
        setError(leftError, message)
        setError(rightError, message)
      } finally {
        if (generation === requestGeneration) {
          window.clearTimeout(requestTimer)
          requestTimer = null
          requestController = null
          setBusy(false)
        }
      }
    }

    function swap() {
      const leftValue = left.value
      left.value = right.value
      right.value = leftValue
      persistDraft()
      updateCounts()
      void compare()
    }

    function syncScroll(side) {
      if (syncingScroll) return
      const source = editorRefs[side]
      const highlight = root.querySelector(`#${prefix}-${side === 'A' ? 'a' : 'b'}-highlight`)
      if (highlight) { highlight.scrollTop = source.scrollTop; highlight.scrollLeft = source.scrollLeft }
      const target = editorRefs[side === 'A' ? 'B' : 'A']
      syncingScroll = true
      target.scrollTop = source.scrollTop
      target.scrollLeft = source.scrollLeft
      requestAnimationFrame(() => { syncingScroll = false })
    }

    listen(left, 'input', handleTextChange)
    listen(right, 'input', handleTextChange)
    listen(left, 'scroll', () => syncScroll('A'))
    listen(right, 'scroll', () => syncScroll('B'))
    listen(compareButton, 'click', compare)
    listen(swapButton, 'click', swap)
    updateCounts()
    setBusy(false)
    return {
      destroy() {
        cancelRequest()
        listeners.forEach(({ element, event, handler }) => element.removeEventListener(event, handler))
      },
    }
  }

  window.NestCloudContentCompare = Object.freeze({ mount })
})()
