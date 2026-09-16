(() => {
  if (typeof window === 'undefined') return

  const MAX_TEXT_LENGTH = 10000
  const DEFAULT_THRESHOLD = 0.6
  const DEFAULT_EDIT_DISTANCE = 2
  const STORAGE_KEY = 'nestcloud:plagiarism:v1'

  function createElement(tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  function readDraft() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      const value = raw ? JSON.parse(raw) : null
      if (!value || typeof value !== 'object') return null
      return {
        source: typeof value.source === 'string' && value.source.length <= MAX_TEXT_LENGTH ? value.source : '',
        target: typeof value.target === 'string' && value.target.length <= MAX_TEXT_LENGTH ? value.target : '',
        threshold: Number.isFinite(Number(value.threshold)) ? Math.min(1, Math.max(0, Number(value.threshold))) : DEFAULT_THRESHOLD,
        editDistance: Number.isInteger(Number(value.editDistance))
          ? Math.max(0, Number(value.editDistance))
          : DEFAULT_EDIT_DISTANCE,
      }
    } catch {
      return null
    }
  }

  function saveDraft(source, target, threshold, editDistance) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        source,
        target,
        threshold,
        editDistance,
        updatedAt: Date.now(),
      }))
    } catch {
      // localStorage is optional; keep the current page usable.
    }
  }

  function formatPercent(value) {
    const number = Number(value)
    return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : '—'
  }

  function formatValue(value, key, stepKey) {
    if (typeof value === 'number') {
      const percent = key.toLowerCase().includes('similarity')
        || key.toLowerCase().includes('rate')
        || key.toLowerCase().includes('density')
        || key.toLowerCase().includes('score')
        || key.toLowerCase().includes('threshold')
        || (key === 'value' && (stepKey === 'jaccard' || stepKey === 'simhash'))
      return percent ? formatPercent(value) : (Number.isInteger(value) ? String(value) : value.toFixed(6))
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return '—'
      return value.some((item) => item && typeof item === 'object')
        ? JSON.stringify(value)
        : value.join('、')
    }
    if (value && typeof value === 'object') return JSON.stringify(value)
    if (value === undefined || value === null || value === '') return '—'
    return String(value)
  }

  function isStructuredValue(value) {
    return Boolean(value && typeof value === 'object')
      || (Array.isArray(value) && value.some((item) => item && typeof item === 'object'))
  }

  function getErrorMessage(payload, status) {
    if (Array.isArray(payload?.message)) return payload.message.join('；')
    if (typeof payload?.message === 'string' && payload.message) return payload.message
    return `查重请求失败（${status}）。`
  }

  function scrollMatchIntoView(matchIndex) {
    document.querySelectorAll(`[data-plagiarism-match="${matchIndex}"]`).forEach((element) => {
      const container = element.closest('.plagiarism-editor__highlight')
      if (!(container instanceof HTMLElement) || !(element instanceof HTMLElement)) return
      const targetTop = element.offsetTop - (container.clientHeight - element.offsetHeight) / 2
      container.scrollTop = Math.max(0, targetTop)
    })
  }

  function renderOriginalText(codeElement, textarea, text, matches, side) {
    codeElement.replaceChildren()
    textarea.value = text
    textarea.classList.add('plagiarism-editor__textarea--highlighted')
    let cursor = 0
    const ordered = (Array.isArray(matches) ? matches : [])
      .map((match, index) => ({
        ...match,
        colorIndex: index,
        start: Number(side === 'source' ? match.sourceStart : match.targetStart),
        end: Number(side === 'source' ? match.sourceEnd : match.targetEnd),
      }))
      .filter((match) => Number.isInteger(match.start) && Number.isInteger(match.end)
        && match.start >= 0 && match.end > match.start && match.start < text.length)
      .sort((left, right) => left.start - right.start)

    ordered.forEach((match) => {
      const start = Math.max(cursor, match.start)
      const end = Math.min(text.length, match.end)
      if (end <= start) return
      if (start > cursor) codeElement.append(document.createTextNode(text.slice(cursor, start)))
      const colorClass = `plagiarism-highlight--${(match.colorIndex % 4) + 1}`
      const highlight = createElement('span', `plagiarism-highlight ${colorClass}`, text.slice(start, end))
      const details = `局部相似度 ${formatPercent(match.similarity)} · 密度 ${formatPercent(match.density)} · 评分 ${formatPercent(match.score)} · ${match.length} 个规范化字符 · 原文位置 ${start + 1}～${end}`
      highlight.dataset.tooltip = details
      highlight.dataset.plagiarismMatch = String(match.colorIndex)
      highlight.title = details
      highlight.tabIndex = 0
      highlight.addEventListener('mouseenter', () => scrollMatchIntoView(match.colorIndex))
      highlight.addEventListener('focus', () => scrollMatchIntoView(match.colorIndex))
      highlight.setAttribute('aria-label', `重复片段：${details}`)
      codeElement.append(highlight)
      cursor = end
    })
    if (cursor < text.length) codeElement.append(document.createTextNode(text.slice(cursor)))
    if (!codeElement.childNodes.length) codeElement.textContent = text
  }

  function renderSummary(container, result) {
    container.replaceChildren()
    const forward = result.sourceToTarget || result
    const reverse = result.targetToSource || null
    const values = [
      ['综合相似度', formatPercent(result.overallSimilarity ?? result.similarity), 'plagiarism-summary-card--blue'],
      ['A → B 重复率', formatPercent(forward.duplicateRate), 'plagiarism-summary-card--orange'],
      ['B → A 重复率', formatPercent(reverse?.duplicateRate ?? forward.duplicateRate), 'plagiarism-summary-card--orange'],
      ['重复片段', `${Number(forward.matches?.length || 0)} 段`, 'plagiarism-summary-card--green'],
      ['重复字符', `${Number(forward.duplicateLength || 0)} 字`, 'plagiarism-summary-card--dark'],
    ]
    values.forEach(([label, value, className]) => {
      const card = createElement('div', `plagiarism-summary-card ${className}`)
      card.append(createElement('span', '', label), createElement('strong', '', value))
      container.append(card)
    })
  }

  function renderStepList(container, steps) {
    container.replaceChildren()
    ;(Array.isArray(steps) ? steps : []).forEach((step, index) => {
      if (!step || typeof step !== 'object') return
      const article = createElement('article', 'plagiarism-step')
      const header = createElement('div', 'plagiarism-step__header')
      const title = createElement('h3', '', `${String(index + 1).padStart(2, '0')} · ${step.label || step.key || '处理步骤'}`)
      const similarity = step.similarity === undefined ? '' : `相似度 ${formatPercent(step.similarity)}`
      header.append(title, createElement('span', 'plagiarism-step__similarity', similarity))
      article.append(header)

      const data = step.data && typeof step.data === 'object' ? step.data : {}
      const metrics = createElement('dl', 'plagiarism-step__metrics')
      Object.entries(data).forEach(([key, value]) => {
        if (key === 'matches' || key === 'commonPreview' || key === 'rule') return
        const term = createElement('dt', '', key)
        const detail = createElement('dd')
        if (isStructuredValue(value)) {
          detail.append(createElement('pre', 'plagiarism-step__json', JSON.stringify(value, null, 2)))
        } else {
          detail.textContent = formatValue(value, key, step.key)
        }
        metrics.append(term, detail)
      })
      if (metrics.children.length) article.append(metrics)
      if (typeof data.rule === 'string') article.append(createElement('p', 'plagiarism-step__rule', data.rule))

      if (Array.isArray(data.matches) && data.matches.length) {
        const list = createElement('ul', 'plagiarism-step__matches')
        data.matches.forEach((match) => {
          if (!match || typeof match !== 'object') return
          const item = createElement('li')
          const text = typeof match.text === 'string' ? match.text.replace(/\s+/g, ' ').trim() : '未命名片段'
          item.title = `答案 A ${match.sourceStart + 1}～${match.sourceEnd}；答案 B ${match.targetStart + 1}～${match.targetEnd}`
          item.append(
            createElement('span', 'plagiarism-step__match-text', text || '空片段'),
            createElement('span', 'plagiarism-step__match-data', `${formatPercent(match.similarity)} · 密度 ${formatPercent(match.density)} · 评分 ${formatPercent(match.score)} · A ${match.sourceStart + 1}～${match.sourceEnd} · B ${match.targetStart + 1}～${match.targetEnd}`),
          )
          list.append(item)
        })
        article.append(list)
      }
      container.append(article)
    })
  }

  function mount(root) {
    if (!(root instanceof HTMLElement)) return
    const form = root.querySelector('#plagiarism-form')
    const source = root.querySelector('#plagiarism-source')
    const target = root.querySelector('#plagiarism-target')
    const threshold = root.querySelector('#plagiarism-threshold')
    const editDistance = root.querySelector('#plagiarism-edit-distance')
    const sourceCount = root.querySelector('#plagiarism-source-count')
    const targetCount = root.querySelector('#plagiarism-target-count')
    const submit = root.querySelector('#plagiarism-submit')
    const error = root.querySelector('#plagiarism-error')
    const resultRoot = root.querySelector('#plagiarism-result')
    const resultNote = root.querySelector('#plagiarism-result-note')
    const status = root.querySelector('#plagiarism-status')
    const statusLabel = root.querySelector('#plagiarism-status-label')
    const summary = root.querySelector('#plagiarism-summary')
    const sourceHighlight = root.querySelector('#plagiarism-source-highlight code')
    const targetHighlight = root.querySelector('#plagiarism-target-highlight code')
    const sourceOriginal = root.querySelector('#plagiarism-source-original')
    const targetOriginal = root.querySelector('#plagiarism-target-original')
    const stepList = root.querySelector('#plagiarism-step-list')
    const stepCount = root.querySelector('#plagiarism-step-count')
    if (!(form instanceof HTMLFormElement) || !(source instanceof HTMLTextAreaElement)
      || !(target instanceof HTMLTextAreaElement) || !(threshold instanceof HTMLInputElement)
      || !(editDistance instanceof HTMLInputElement)
      || !(sourceCount instanceof HTMLElement) || !(targetCount instanceof HTMLElement)
      || !(submit instanceof HTMLButtonElement) || !(error instanceof HTMLElement)
      || !(resultRoot instanceof HTMLElement) || !(resultNote instanceof HTMLElement)
      || !(status instanceof HTMLElement) || !(statusLabel instanceof HTMLElement)
      || !(summary instanceof HTMLElement) || !(sourceHighlight instanceof HTMLElement)
      || !(targetHighlight instanceof HTMLElement) || !(sourceOriginal instanceof HTMLTextAreaElement)
      || !(targetOriginal instanceof HTMLTextAreaElement) || !(stepList instanceof HTMLElement)
      || !(stepCount instanceof HTMLElement)) return

    let controller = null
    const draft = readDraft()
    if (draft) {
      source.value = draft.source
      target.value = draft.target
      threshold.value = String(draft.threshold)
      editDistance.value = String(draft.editDistance)
    }

    function saveCurrentDraft() {
      saveDraft(source.value, target.value, Number(threshold.value), Number(editDistance.value))
    }

    function updateCounts() {
      sourceCount.textContent = `${source.value.length.toLocaleString()} / ${MAX_TEXT_LENGTH} 字`
      targetCount.textContent = `${target.value.length.toLocaleString()} / ${MAX_TEXT_LENGTH} 字`
    }

    function setError(message) {
      error.textContent = message || ''
      error.hidden = !message
    }

    function setStatus(value, label) {
      status.className = `status-badge status-badge--${value}`
      status.dataset.status = value
      statusLabel.textContent = label
    }

    function clearResult() {
      resultRoot.hidden = true
      resultRoot.setAttribute('aria-busy', 'false')
      sourceHighlight.replaceChildren()
      targetHighlight.replaceChildren()
      sourceOriginal.value = ''
      targetOriginal.value = ''
      sourceOriginal.classList.remove('plagiarism-editor__textarea--highlighted')
      targetOriginal.classList.remove('plagiarism-editor__textarea--highlighted')
      stepList.replaceChildren()
      stepCount.textContent = '0 STEPS'
    }

    async function compare(event) {
      event.preventDefault()
      if (!form.reportValidity()) return
      const thresholdValue = Number(threshold.value || DEFAULT_THRESHOLD)
      const editDistanceValue = Number(editDistance.value || DEFAULT_EDIT_DISTANCE)
      if (!Number.isFinite(thresholdValue) || thresholdValue < 0 || thresholdValue > 1) {
        setError('相似阈值必须是 0 到 1 之间的数字。')
        threshold.focus()
        return
      }
      if (!Number.isInteger(editDistanceValue) || editDistanceValue < 0) {
        setError('编辑距离必须是非负整数。')
        editDistance.focus()
        return
      }
      saveCurrentDraft()
      controller?.abort()
      const requestController = new AbortController()
      controller = requestController
      submit.disabled = true
      setError('')
      setStatus('loading', '计算中')
      resultRoot.hidden = false
      resultRoot.setAttribute('aria-busy', 'true')
      resultNote.textContent = '正在执行文本清洗、特征计算和重复片段定位…'
      try {
        const response = await fetch('/api/plagiarism/compare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          signal: requestController.signal,
          body: JSON.stringify({
            source: source.value,
            target: target.value,
            threshold: thresholdValue,
            editDistance: editDistanceValue,
          }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload?.data) throw new Error(getErrorMessage(payload, response.status))
        const result = payload.data
        const direction = result.sourceToTarget || result
        renderSummary(summary, result)
        renderOriginalText(sourceHighlight, sourceOriginal, source.value, direction.matches, 'source')
        renderOriginalText(targetHighlight, targetOriginal, target.value, direction.matches, 'target')
        renderStepList(stepList, direction.steps)
        stepCount.textContent = `${Array.isArray(direction.steps) ? direction.steps.length : 0} STEPS`
        const reverseRate = result.targetToSource
          ? ` · B → A ${formatPercent(result.targetToSource.duplicateRate)}`
          : ''
        resultNote.textContent = `高亮阈值 ${formatPercent(direction.threshold)} · 编辑距离 ${direction.editDistance} · A → B ${formatPercent(direction.duplicateRate)}${reverseRate} · 位置为输入原文下标 · 将鼠标悬浮或聚焦高亮片段查看查重数据。`
        setStatus('ready', '已完成')
      } catch (requestError) {
        if (requestError?.name === 'AbortError' || controller !== requestController) return
        clearResult()
        setError(requestError instanceof Error ? requestError.message : '查重失败，请稍后重试。')
        setStatus('error', '错误')
      } finally {
        if (controller === requestController) {
          submit.disabled = false
          controller = null
        }
      }
    }

    source.addEventListener('input', updateCounts)
    target.addEventListener('input', updateCounts)
    ;[source, target, threshold, editDistance].forEach((element) => {
      element.addEventListener('input', saveCurrentDraft)
      element.addEventListener('change', saveCurrentDraft)
    })
    sourceOriginal.addEventListener('scroll', () => {
      sourceHighlight.parentElement.scrollTop = sourceOriginal.scrollTop
      sourceHighlight.parentElement.scrollLeft = sourceOriginal.scrollLeft
    })
    sourceHighlight.parentElement.addEventListener('scroll', () => {
      sourceOriginal.scrollTop = sourceHighlight.parentElement.scrollTop
      sourceOriginal.scrollLeft = sourceHighlight.parentElement.scrollLeft
    })
    targetOriginal.addEventListener('scroll', () => {
      targetHighlight.parentElement.scrollTop = targetOriginal.scrollTop
      targetHighlight.parentElement.scrollLeft = targetOriginal.scrollLeft
    })
    targetHighlight.parentElement.addEventListener('scroll', () => {
      targetOriginal.scrollTop = targetHighlight.parentElement.scrollTop
      targetOriginal.scrollLeft = targetHighlight.parentElement.scrollLeft
    })
    form.addEventListener('submit', compare)
    updateCounts()
    setStatus('idle', '等待')
  }

  window.NestCloudPlagiarism = { mount }
})()
