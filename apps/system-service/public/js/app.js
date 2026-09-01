(() => {
  if (typeof document === 'undefined') return

  const MAX_FILE_SIZE = 15 * 1024 * 1024
  const ROUTES = {
    overview: { title: '工作台总览', documentTitle: '工作台总览 · NestCloud' },
    particle: { title: '粒子动画', documentTitle: '粒子动画 · NestCloud' },
    'json-compare': { title: 'JSON 对比', documentTitle: 'JSON 对比 · NestCloud' },
    'env-compare': { title: 'ENV 对比', documentTitle: 'ENV 对比 · NestCloud' },
    'weekly-report': { title: '周报生成', documentTitle: '周报生成 · NestCloud' },
    'config-file-preview': { title: '配置版本预览', documentTitle: '配置版本预览 · NestCloud' },
  }
  const FRAGMENT_PATHS = Object.freeze({
    overview: '/public/html/overview.html',
    particle: '/public/html/particle.html',
    'json-compare': '/public/html/json-compare.html',
    'env-compare': '/public/html/env-compare.html',
    'weekly-report': '/public/html/weekly-report.html',
    'config-file-preview': '/public/html/config-file-preview.html',
  })
  const STATUS_LABELS = { empty: '等待', loading: '处理中', ready: '就绪', error: '错误' }
  const DIFF_LABELS = { added: '新增', removed: '删除', modified: '修改', unchanged: '未变化' }
  const STORAGE_KEYS = Object.freeze({
    json: 'nestcloud:compare:json:v1',
    env: 'nestcloud:compare:env:v1',
    weekly: 'nestcloud:weekly-report:v1',
  })
  const STORAGE_VERSION = 1
  const MAX_COMPARE_DRAFT_LENGTH = 500_000

  const appShell = document.querySelector('.app-shell')
  const sidebar = document.querySelector('#sidebar')
  const sidebarScrim = document.querySelector('[data-sidebar-close]')
  const mobileMenuButton = document.querySelector('#mobile-menu-button')
  const sidebarCollapseButton = document.querySelector('#sidebar-collapse-button')
  const breadcrumbCurrent = document.querySelector('#breadcrumb-current')
  const mainContent = document.querySelector('#main-content')
  const viewHost = document.querySelector('#view-host')
  const navLinks = [...document.querySelectorAll('.nav-link[data-route]')]
  let views = []

  if (!(appShell instanceof HTMLElement) || !(sidebar instanceof HTMLElement) || !(sidebarScrim instanceof HTMLElement)
    || !(mobileMenuButton instanceof HTMLButtonElement) || !(breadcrumbCurrent instanceof HTMLElement)
    || !(mainContent instanceof HTMLElement) || !(viewHost instanceof HTMLElement)) return

  let menuTrigger = null

  function setSidebarOpen(open, restoreFocus = false) {
    sidebar.classList.toggle('is-open', open)
    sidebarScrim.classList.toggle('is-visible', open)
    mobileMenuButton.setAttribute('aria-expanded', String(open))
    mobileMenuButton.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单')
    if (open) {
      menuTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : mobileMenuButton
      navLinks[0]?.focus()
    } else if (restoreFocus && menuTrigger instanceof HTMLElement) {
      menuTrigger.focus()
      menuTrigger = null
    }
  }

  function setSidebarCollapsed(collapsed) {
    appShell.classList.toggle('app-shell--sidebar-collapsed', collapsed)
    if (sidebarCollapseButton instanceof HTMLButtonElement) {
      sidebarCollapseButton.setAttribute('aria-expanded', String(!collapsed))
      sidebarCollapseButton.setAttribute('aria-label', collapsed ? '展开导航' : '收起导航')
      sidebarCollapseButton.title = collapsed ? '展开导航' : '收起导航'
    }
  }

  function normalizeRoute() {
    const candidate = window.location.hash.slice(1)
    if (Object.prototype.hasOwnProperty.call(ROUTES, candidate)) return candidate
    window.history.replaceState(null, '', '#overview')
    return 'overview'
  }

  function renderRoute(routeName, moveFocus = false) {
    const route = ROUTES[routeName] || ROUTES.overview
    views.forEach((view) => { view.hidden = view.dataset.view !== routeName })
    navLinks.forEach((link) => {
      const active = link.dataset.route === routeName
      link.dataset.active = String(active)
      if (active) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    })
    breadcrumbCurrent.textContent = route.title
    document.title = route.documentTitle
    mainContent.dataset.route = routeName
    setSidebarOpen(false)
    if (moveFocus) {
      const heading = document.querySelector(`[data-view="${routeName}"] h1`)
      if (heading instanceof HTMLElement) {
        heading.tabIndex = -1
        heading.focus()
      }
    }
  }

  const fragmentCache = new Map()
  let fragmentGeneration = 0

  async function loadFragment(routeName, path) {
    let source = fragmentCache.get(routeName)
    if (!source) {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`页面片段加载失败（${response.status}）。`)
      source = await response.text()
      fragmentCache.set(routeName, source)
    }
    const parsed = new DOMParser().parseFromString(source, 'text/html')
    const roots = [...parsed.body.children]
    if (roots.length !== 1 || roots[0].tagName !== 'SECTION' || roots[0].dataset.view !== routeName) {
      throw new Error(`页面片段 ${routeName} 格式无效。`)
    }
    return document.importNode(roots[0], true)
  }

  async function loadViews() {
    const generation = ++fragmentGeneration
    viewHost.replaceChildren(createElement('p', 'view-loader', '正在加载页面内容…'))
    try {
      const fragments = await Promise.all(
        Object.entries(FRAGMENT_PATHS).map(([routeName, path]) => loadFragment(routeName, path)),
      )
      if (generation !== fragmentGeneration) return
      viewHost.replaceChildren(...fragments)
      views = [...viewHost.querySelectorAll('[data-view]')]
      mountCompare('json-compare')
      mountCompare('env-compare')
      mountParticleLab()
      mountWeeklyReport()
      if (typeof window.NestCloudConfigFilePreview?.mount === 'function') {
        const configView = viewHost.querySelector('[data-view="config-file-preview"]')
        if (configView instanceof HTMLElement) window.NestCloudConfigFilePreview.mount(configView)
      }
      renderRoute(normalizeRoute())
    } catch (error) {
      if (generation !== fragmentGeneration) return
      viewHost.replaceChildren(createElement('p', 'view-loader view-loader--error', error instanceof Error ? error.message : '页面加载失败，请刷新重试。'))
    }
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  function readStoredValue(key) {
    try {
      const raw = window.localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  function writeStoredValue(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage is optional; keep the current in-memory state usable.
    }
  }

  function createClientId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID()
    return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }

  function readCompareDraft(mode) {
    const draft = readStoredValue(STORAGE_KEYS[mode])
    if (draft?.version !== STORAGE_VERSION
      || typeof draft.left !== 'string' || typeof draft.right !== 'string'
      || draft.left.length > MAX_COMPARE_DRAFT_LENGTH || draft.right.length > MAX_COMPARE_DRAFT_LENGTH) return null
    return { left: draft.left, right: draft.right }
  }

  function saveCompareDraft(mode, left, right) {
    if (left.length > MAX_COMPARE_DRAFT_LENGTH || right.length > MAX_COMPARE_DRAFT_LENGTH) return
    writeStoredValue(STORAGE_KEYS[mode], {
      version: STORAGE_VERSION,
      left,
      right,
      updatedAt: Date.now(),
    })
  }

  function readWeeklyDraft() {
    const draft = readStoredValue(STORAGE_KEYS.weekly)
    if (draft?.version !== STORAGE_VERSION || !Array.isArray(draft.projects)
      || draft.projects.length < 1 || draft.projects.length > 10) return null
    const projects = draft.projects.map((project) => {
      if (!project || typeof project !== 'object'
        || typeof project.repo !== 'string' || typeof project.person !== 'string'
        || (project.branch !== undefined && typeof project.branch !== 'string')) return null
      if (project.repo.length > 2048 || project.person.length > 128 || (project.branch || '').length > 256) return null
      return {
        id: typeof project.id === 'string' && project.id ? project.id : createClientId(),
        repo: project.repo,
        person: project.person,
        branch: project.branch || '',
      }
    })
    return projects.every(Boolean)
      ? { period: draft.period === 'this-week' ? 'this-week' : 'last-week', projects }
      : null
  }

  function saveWeeklyDraft(period, projects) {
    writeStoredValue(STORAGE_KEYS.weekly, {
      version: STORAGE_VERSION,
      period,
      projects: projects.map((project) => ({
        id: project.id,
        repo: project.repo,
        person: project.person,
        branch: project.branch,
      })),
      updatedAt: Date.now(),
    })
  }

  function formatJsonValue(value, type) {
    if (type === 'object') return `{ ${Object.keys(value || {}).length} 个键 }`
    if (type === 'array') return `[ ${Array.isArray(value) ? value.length : 0} 项 ]`
    const result = JSON.stringify(value)
    return result === undefined ? String(value) : result
  }

  function formatCompareErrors(label, side, errors) {
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

  function buildDiffMarkers(segments) {
    if (!segments) return []
    const statusByLine = new Map()
    let line = 0
    segments.forEach((segment) => {
      const lines = segment.text.split('\n')
      lines.forEach((lineText, index) => {
        if (segment.status && lineText.length) statusByLine.set(line, segment.status)
        if (index < lines.length - 1) line += 1
      })
    })
    const totalLines = Math.max(line + 1, 1)
    return Array.from(statusByLine, ([lineIndex, status]) => ({
      status,
      top: `${(lineIndex / totalLines) * 100}%`,
      height: `${Math.max(1.4, 100 / totalLines)}%`,
    }))
  }

  function parseJsonInput(value) {
    if (!value.trim()) return { ok: false, value: null, errors: [{ code: 'EMPTY', message: '不能为空。' }] }
    try {
      return { ok: true, value: JSON.parse(value), errors: [] }
    } catch {
      return { ok: false, value: null, errors: [{ code: 'INVALID_JSON', message: 'JSON 格式无效，请检查逗号、引号和括号。' }] }
    }
  }

  function parseEnvInput(value) {
    if (value.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed, errors: [] }
      } catch {
        return { ok: false, value: null, errors: [{ code: 'INVALID_JSON', message: '规范化 JSON 格式无效，请检查括号、逗号和引号。' }] }
      }
    }
    return window.NestCloudEnvParser.parseEnv(value)
  }

  function renderSegments(codeElement, textarea, segments) {
    codeElement.replaceChildren()
    if (!segments) {
      textarea.classList.remove('compare-editor__textarea--highlighted')
      return
    }
    textarea.classList.add('compare-editor__textarea--highlighted')
    segments.forEach((segment, index) => {
      const span = createElement('span', segment.status ? `compare-highlight--${segment.status}` : '')
      span.textContent = segment.text
      span.dataset.segment = String(index)
      codeElement.append(span)
    })
  }

  function renderMarkers(markerElement, segments) {
    markerElement.replaceChildren()
    buildDiffMarkers(segments).forEach((marker, index) => {
      const element = createElement('span', `compare-marker compare-marker--${marker.status}`)
      element.style.top = marker.top
      element.style.height = marker.height
      element.dataset.marker = String(index)
      markerElement.append(element)
    })
  }

  function buildEnvSegments(text, result, side) {
    const statuses = new Map(result.tree.children.map((node) => [String(node.key), node.status]))
    const lines = text.split('\n')
    const segments = []
    lines.forEach((line, index) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
      const status = match ? statuses.get(match[1]) || null : null
      segments.push({ text: line, status: side === 'left' && status === 'added' ? null : side === 'right' && status === 'removed' ? null : status })
      if (index < lines.length - 1) segments.push({ text: '\n', status: null })
    })
    return segments
  }

  function renderDiffRow(node, depth, expandedPaths, onToggle, label) {
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
    } else {
      key.append(createElement('span', 'compare-tree-spacer'))
    }
    key.append(createElement('span', 'compare-tree-label', node.key === '$' ? '$' : String(node.key)))
    key.append(createElement('span', `compare-status compare-status--${node.status}`, DIFF_LABELS[node.status]))

    const leftCell = createElement('div', `compare-cell compare-cell--${node.status === 'added' ? 'missing' : node.status}`)
    leftCell.dataset.label = `${label} A`
    leftCell.textContent = node.hasLeft ? formatJsonValue(node.left, node.type) : '—'
    const rightCell = createElement('div', `compare-cell compare-cell--${node.status === 'removed' ? 'missing' : node.status}`)
    rightCell.dataset.label = `${label} B`
    rightCell.textContent = node.hasRight ? formatJsonValue(node.right, node.type) : '—'
    row.append(key, leftCell, rightCell)

    const fragment = document.createDocumentFragment()
    fragment.append(row)
    if (isContainer && isExpanded) {
      node.children.forEach((child) => fragment.append(renderDiffRow(child, depth + 1, expandedPaths, onToggle, label)))
    }
    return fragment
  }

  function mountCompare(mode) {
    const root = document.querySelector(`[data-view="${mode}"]`)
    if (!(root instanceof HTMLElement)) return
    const label = mode === 'json-compare' ? 'JSON' : 'ENV'
    const parser = mode === 'json-compare' ? parseJsonInput : parseEnvInput
    const prefix = mode === 'json-compare' ? 'json' : 'env'
    const copy = mode === 'json-compare'
      ? { changed: '发现变化。', unchanged: '无变化。' }
      : { changed: '发现变化。', unchanged: '无变化。' }
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
      || !(resultRoot instanceof HTMLElement) || !(resultTitle instanceof HTMLElement)
      || !(tree instanceof HTMLElement) || !(compareButton instanceof HTMLButtonElement)
      || !(swapButton instanceof HTMLButtonElement)) return

    const placeholder = mode === 'json-compare'
      ? '{\n  "name": "particle",\n  "items": [1, 2, 3]\n}'
      : '# 示例\nexport APP_NAME="particle"\nPORT=3000\nDEBUG=true\nEMPTY='
    left.placeholder = placeholder
    right.placeholder = placeholder
    const draft = readCompareDraft(prefix)
    if (draft) {
      left.value = draft.left
      right.value = draft.right
    }

    let result = null
    let expandedPaths = new Set(['$'])
    const editorRefs = { A: left, B: right }
    let syncingScroll = false

    function saveDraft() {
      saveCompareDraft(prefix, left.value, right.value)
    }

    function updateCounts() {
      if (leftCount) leftCount.textContent = `${left.value.length.toLocaleString()} 字符`
      if (rightCount) rightCount.textContent = `${right.value.length.toLocaleString()} 字符`
    }

    function setError(element, message) {
      element.textContent = message
      element.hidden = !message
      const panel = element.closest('.compare-input-panel')
      panel?.classList.toggle('compare-input-panel--error', Boolean(message))
    }

    function clearResult() {
      result = null
      resultRoot.hidden = true
      renderSegments(leftHighlight, left, null)
      renderSegments(rightHighlight, right, null)
      renderMarkers(leftMarkers, null)
      renderMarkers(rightMarkers, null)
    }

    function renderResult() {
      const diff = window.NestCloudJsonDiff
      const leftSegments = mode === 'env-compare'
        ? buildEnvSegments(left.value, result, 'left')
        : diff.serializeDiffSegments(result.tree, 'left')
      const rightSegments = mode === 'env-compare'
        ? buildEnvSegments(right.value, result, 'right')
        : diff.serializeDiffSegments(result.tree, 'right')
      renderSegments(leftHighlight, left, leftSegments)
      renderSegments(rightHighlight, right, rightSegments)
      renderMarkers(leftMarkers, leftSegments)
      renderMarkers(rightMarkers, rightSegments)
      resultTitle.textContent = result.stats.added + result.stats.removed + result.stats.modified === 0 ? copy.unchanged : copy.changed
      root.querySelector(`#${prefix}-added-count`).textContent = String(result.stats.added)
      root.querySelector(`#${prefix}-removed-count`).textContent = String(result.stats.removed)
      root.querySelector(`#${prefix}-modified-count`).textContent = String(result.stats.modified)
      tree.replaceChildren()
      const header = createElement('div', 'compare-tree-head')
      header.append(createElement('span', 'compare-tree-head__path', '路径'), createElement('span', '', `${label} A`), createElement('span', '', `${label} B`))
      tree.append(header, renderDiffRow(result.tree, 0, expandedPaths, togglePath, label))
      resultRoot.hidden = false
    }

    function togglePath(path) {
      const next = new Set(expandedPaths)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      expandedPaths = next
      if (result) renderResult()
    }

    function handleTextChange(side, value) {
      if (side === 'left') left.value = value
      else right.value = value
      if (side === 'left') setError(leftError, '')
      else setError(rightError, '')
      updateCounts()
      saveDraft()
      expandedPaths = new Set(['$'])
      clearResult()
    }

    function compare() {
      const leftResult = parser(left.value)
      const rightResult = parser(right.value)
      setError(leftError, leftResult.ok ? '' : formatCompareErrors(label, 'A', leftResult.errors))
      setError(rightError, rightResult.ok ? '' : formatCompareErrors(label, 'B', rightResult.errors))
      if (!leftResult.ok || !rightResult.ok) {
        clearResult()
        return
      }
      let nextResult
      try {
        nextResult = window.NestCloudJsonDiff.compareJson(leftResult.value, rightResult.value)
      } catch {
        const message = `${label} 内容层级过深，无法完成比较。`
        setError(leftError, message)
        setError(rightError, message)
        clearResult()
        return
      }
      result = nextResult
      if (mode === 'json-compare') {
        left.value = JSON.stringify(result.left, null, 2)
        right.value = JSON.stringify(result.right, null, 2)
      }
      saveDraft()
      updateCounts()
      expandedPaths = collectExpandedPaths(result.tree)
      renderResult()
    }

    function swap() {
      const leftValue = left.value
      left.value = right.value
      right.value = leftValue
      saveDraft()
      updateCounts()
      expandedPaths = new Set(['$'])
      compare()
    }

    function syncScroll(side) {
      if (syncingScroll) return
      const target = editorRefs[side === 'A' ? 'B' : 'A']
      syncingScroll = true
      target.scrollTop = editorRefs[side].scrollTop
      target.scrollLeft = editorRefs[side].scrollLeft
      requestAnimationFrame(() => { syncingScroll = false })
    }

    left.addEventListener('input', () => handleTextChange('left', left.value))
    right.addEventListener('input', () => handleTextChange('right', right.value))
    left.addEventListener('scroll', () => {
      const highlight = root.querySelector(`#${prefix}-a-highlight`)
      if (highlight) { highlight.scrollTop = left.scrollTop; highlight.scrollLeft = left.scrollLeft }
      syncScroll('A')
    })
    right.addEventListener('scroll', () => {
      const highlight = root.querySelector(`#${prefix}-b-highlight`)
      if (highlight) { highlight.scrollTop = right.scrollTop; highlight.scrollLeft = right.scrollLeft }
      syncScroll('B')
    })
    compareButton.addEventListener('click', compare)
    swapButton.addEventListener('click', swap)
    updateCounts()
  }

  function formatFileSize(bytes) {
    if (!bytes) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function mountParticleLab() {
    const root = document.querySelector('[data-view="particle"]')
    if (!(root instanceof HTMLElement)) return
    const fileInput = root.querySelector('#particle-file-input')
    const browseButton = root.querySelector('#particle-browse-button')
    const uploadZone = root.querySelector('#particle-upload-zone')
    const sourceList = root.querySelector('#particle-source-list')
    const fieldStage = root.querySelector('#particle-field')
    const errorElement = root.querySelector('#particle-error')
    const statusBadge = root.querySelector('#particle-status')
    const statusLabel = root.querySelector('#particle-status-label')
    const uploadTitle = root.querySelector('#particle-upload-title-text')
    const countElement = root.querySelector('#particle-count')
    const density = root.querySelector('#particle-density')
    const densityValue = root.querySelector('#particle-density-value')
    const effect = root.querySelector('#particle-effect')
    const morphButton = root.querySelector('#particle-morph-button')
    if (!(fileInput instanceof HTMLInputElement) || !(browseButton instanceof HTMLButtonElement)
      || !(uploadZone instanceof HTMLElement) || !(sourceList instanceof HTMLElement)
      || !(fieldStage instanceof HTMLElement) || !(errorElement instanceof HTMLElement)
      || !(statusBadge instanceof HTMLElement) || !(statusLabel instanceof HTMLElement)
      || !(uploadTitle instanceof HTMLElement) || !(countElement instanceof HTMLElement)
      || !(density instanceof HTMLInputElement) || !(densityValue instanceof HTMLElement)
      || !(effect instanceof HTMLSelectElement) || !(morphButton instanceof HTMLButtonElement)) return

    const state = {
      activeTarget: 0,
      error: '',
      fileInfos: [null, null],
      field: null,
      images: [null, null],
      isDragging: false,
      pendingSlot: null,
      slotStatuses: ['empty', 'empty'],
      status: 'idle',
      targetReady: false,
      objectUrls: [null, null],
    }

    function renderEmptyStage() {
      fieldStage.replaceChildren()
      const empty = createElement('div', 'empty-stage')
      const crosshair = createElement('div', 'empty-crosshair')
      crosshair.setAttribute('aria-hidden', 'true')
      crosshair.append(createElement('span'), createElement('span'))
      empty.append(crosshair, createElement('p', '', state.images[0] ? '正在处理素材 A' : '等待上传素材 A'), createElement('span', '', state.images[0] ? '正在生成粒子场' : '上传素材 A + B'))
      fieldStage.append(empty)
    }

    function setError(message) {
      state.error = message || ''
      errorElement.textContent = state.error
      errorElement.hidden = !state.error
    }

    function setSlotStatus(slot, status) {
      state.slotStatuses[slot] = status
      updateSourceList()
    }

    function handleStatus(status, message, slot) {
      setSlotStatus(slot, status)
      if (status === 'error') state.status = status
      else if (status === 'loading') state.status = 'loading'
      else if (state.slotStatuses[0] === 'ready') state.status = 'ready'
      if (status === 'error') setError(message || `素材 ${slot === 0 ? 'A' : 'B'} 处理失败。`)
      if (status === 'ready' && slot === 0) setError('')
      updateParticleUi()
    }

    function handleTargetReady(ready) {
      state.targetReady = ready
      if (ready && state.slotStatuses[0] !== 'error') setError('')
      updateParticleUi()
    }

    function handleActiveTarget(target) {
      state.activeTarget = target
      updateSourceList()
      updateParticleUi()
    }

    function updateSourceList() {
      ;[0, 1].forEach((slot) => {
        const chip = sourceList.querySelector(`[data-slot="${slot}"]`)
        if (!(chip instanceof HTMLElement)) return
        const info = state.fileInfos[slot]
        const status = state.slotStatuses[slot]
        chip.classList.toggle('source-chip--active', state.activeTarget === slot && status === 'ready')
        const dot = chip.querySelector(`[data-status-dot="${slot}"]`)
        dot?.classList.toggle('file-chip-status--loading', status === 'loading')
        dot?.classList.toggle('file-chip-status--ready', status === 'ready')
        dot?.classList.toggle('file-chip-status--error', status === 'error')
        const name = chip.querySelector('.file-chip-name')
        if (name) name.textContent = info ? info.name : `素材 ${slot === 0 ? 'A' : 'B'} — 等待上传`
        const size = chip.querySelector('.file-chip-size') || createElement('span', 'file-chip-size')
        if (info) {
          size.textContent = formatFileSize(info.size)
          if (!size.parentElement) chip.insertBefore(size, chip.querySelector('.source-chip-state'))
        } else if (size.parentElement) size.remove()
        const chipState = chip.querySelector('.source-chip-state')
        if (chipState) chipState.textContent = info ? STATUS_LABELS[status] : '等待'
        const action = chip.querySelector(`[data-slot-action="${slot}"]`)
        if (action) action.textContent = info ? '替换' : '添加'
        let remove = chip.querySelector(`[data-slot-remove="${slot}"]`)
        if (info && !remove) {
          remove = createElement('button', 'source-chip-remove', '移除')
          remove.type = 'button'
          remove.dataset.slotRemove = String(slot)
          remove.setAttribute('aria-label', `移除素材 ${slot === 0 ? 'A' : 'B'}`)
          chip.append(remove)
        }
        if (remove) remove.hidden = !info
      })
    }

    function updateParticleUi() {
      const sourceReady = state.slotStatuses[0] === 'ready' && Boolean(state.images[0])
      statusBadge.dataset.status = state.status
      statusBadge.className = `status-badge status-badge--${state.status}`
      let label = '等待'
      if (state.images[0]) {
        label = state.status === 'loading' ? '处理中' : state.status === 'error' && !sourceReady ? '错误' : state.targetReady ? `素材 ${state.activeTarget === 0 ? 'A' : 'B'}` : '添加素材 B'
      }
      statusLabel.textContent = label
      uploadTitle.textContent = state.images[0] ? '添加或替换图片' : '上传两张图片'
      density.disabled = !sourceReady
      densityValue.textContent = Number(density.value).toLocaleString()
      morphButton.disabled = !state.targetReady || !sourceReady
      morphButton.firstChild.textContent = state.targetReady ? `切换至素材 ${state.activeTarget === 0 ? 'B' : 'A'} ` : '添加图片 2 '
      countElement.textContent = state.particleCount ? state.particleCount.toLocaleString() : '—'
    }

    function ensureField() {
      if (state.field) return state.field
      state.field = window.NestCloudParticleField.createParticleField(fieldStage, {
        particleLimit: Number(density.value),
        transitionEffect: effect.value,
        onParticleCountChange: (count) => { state.particleCount = count; updateParticleUi() },
        onStatusChange: handleStatus,
        onTargetReady: handleTargetReady,
        onActiveTargetChange: handleActiveTarget,
      })
      return state.field
    }

    function handleFile(file, slot) {
      if (!file) return
      if (!file.type.startsWith('image/')) {
        setError(`${file.name} 不是支持的图片格式。`)
        setSlotStatus(slot, 'error')
        return
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`${file.name} 超过 15 MB。`)
        setSlotStatus(slot, 'error')
        return
      }
      const url = URL.createObjectURL(file)
      if (state.objectUrls[slot]) URL.revokeObjectURL(state.objectUrls[slot])
      state.objectUrls[slot] = url
      state.images[slot] = url
      state.fileInfos[slot] = { name: file.name, size: file.size }
      setSlotStatus(slot, 'loading')
      setError('')
      if (slot === 0) {
        state.activeTarget = 0
        state.particleCount = 0
        state.status = 'loading'
        if (!state.field) renderEmptyStage()
        const field = ensureField()
        field.setSourceImage(url)
        if (state.images[1]) field.setTargetImage(state.images[1])
      } else if (state.images[0]) {
        ensureField().setTargetImage(url)
        state.targetReady = false
      }
      updateSourceList()
      updateParticleUi()
    }

    function openPicker(slot = null) {
      state.pendingSlot = slot
      fileInput.click()
    }

    function handleSelectedFiles(files) {
      const selected = Array.from(files || []).slice(0, 2)
      const requested = state.pendingSlot
      const firstEmpty = state.images.findIndex((image) => !image)
      const startSlot = requested ?? (firstEmpty >= 0 ? firstEmpty : 1)
      selected.forEach((file, index) => handleFile(file, selected.length > 1 ? index : Math.min(1, startSlot)))
      state.pendingSlot = null
      fileInput.value = ''
    }

    function clearSlot(slot) {
      if (slot === 0) {
        state.objectUrls.forEach((url) => { if (url) URL.revokeObjectURL(url) })
        state.objectUrls = [null, null]
        state.images = [null, null]
        state.fileInfos = [null, null]
        state.slotStatuses = ['empty', 'empty']
        state.activeTarget = 0
        state.targetReady = false
        state.particleCount = 0
        state.status = 'idle'
        state.field?.destroy()
        state.field = null
        setError('')
        renderEmptyStage()
      } else {
        if (state.objectUrls[1]) URL.revokeObjectURL(state.objectUrls[1])
        state.objectUrls[1] = null
        state.images[1] = null
        state.fileInfos[1] = null
        state.slotStatuses[1] = 'empty'
        state.targetReady = false
        state.activeTarget = 0
        state.field?.setTargetImage(null)
      }
      updateSourceList()
      updateParticleUi()
    }

    browseButton.addEventListener('click', () => openPicker())
    fileInput.addEventListener('change', () => handleSelectedFiles(fileInput.files))
    uploadZone.addEventListener('dragover', (event) => { event.preventDefault(); state.isDragging = true; uploadZone.classList.add('upload-zone--dragging') })
    uploadZone.addEventListener('dragleave', () => { state.isDragging = false; uploadZone.classList.remove('upload-zone--dragging') })
    uploadZone.addEventListener('drop', (event) => {
      event.preventDefault()
      state.isDragging = false
      uploadZone.classList.remove('upload-zone--dragging')
      handleSelectedFiles(event.dataTransfer.files)
    })
    sourceList.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const action = target.closest('[data-slot-action]')
      const remove = target.closest('[data-slot-remove]')
      if (action) openPicker(Number(action.dataset.slotAction))
      if (remove) clearSlot(Number(remove.dataset.slotRemove))
    })
    density.addEventListener('input', () => {
      densityValue.textContent = Number(density.value).toLocaleString()
      state.field?.setParticleLimit(Number(density.value))
    })
    effect.addEventListener('change', () => state.field?.setTransitionEffect(effect.value))
    morphButton.addEventListener('click', () => state.field?.requestMorph())
    renderEmptyStage()
    updateSourceList()
    updateParticleUi()
  }

  function mountWeeklyReport() {
    const root = document.querySelector('[data-view="weekly-report"]')
    if (!(root instanceof HTMLElement)) return
    const form = root.querySelector('#weekly-report-form')
    const submitButton = root.querySelector('#weekly-report-submit')
    const errorElement = root.querySelector('#weekly-report-error')
    const projectErrorsElement = root.querySelector('#weekly-report-project-errors')
    const statusBadge = root.querySelector('#weekly-report-status')
    const statusLabel = root.querySelector('#weekly-report-status-label')
    const meta = root.querySelector('#weekly-report-meta')
    const progress = root.querySelector('#weekly-report-progress')
    const progressLabel = root.querySelector('#weekly-report-progress-label')
    const progressbar = root.querySelector('.weekly-report-progress__track')
    const output = root.querySelector('#weekly-report-output')
    const actions = root.querySelector('#weekly-report-actions')
    const copyButton = root.querySelector('#weekly-report-copy')
    const downloadButton = root.querySelector('#weekly-report-download')
    const projectList = root.querySelector('#weekly-project-list')
    const projectTemplate = root.querySelector('#weekly-project-template')
    const projectCount = root.querySelector('#weekly-project-count')
    const projectAdd = root.querySelector('#weekly-project-add')
    if (!(form instanceof HTMLFormElement) || !(submitButton instanceof HTMLButtonElement)
      || !(errorElement instanceof HTMLElement) || !(projectErrorsElement instanceof HTMLElement)
      || !(statusBadge instanceof HTMLElement) || !(statusLabel instanceof HTMLElement)
      || !(meta instanceof HTMLElement) || !(progress instanceof HTMLElement)
      || !(progressLabel instanceof HTMLElement) || !(progressbar instanceof HTMLElement)
      || !(output instanceof HTMLElement) || !(actions instanceof HTMLElement)
      || !(copyButton instanceof HTMLButtonElement) || !(downloadButton instanceof HTMLButtonElement)
      || !(projectList instanceof HTMLElement) || !(projectTemplate instanceof HTMLTemplateElement)
      || !(projectCount instanceof HTMLElement) || !(projectAdd instanceof HTMLButtonElement)) return

    const phaseLabels = {
      queued: '排队中',
      validating: '校验配置',
      collecting: '读取 GitHub 提交',
      summarizing: '生成摘要',
      finalizing: '整理 Markdown',
      publishing: '写入飞书',
      completed: '已完成',
      failed: '任务失败',
    }
    let latestMarkdown = ''
    let latestResult = null
    let submitting = false
    let pollTimer = null
    let pollController = null
    let requestGeneration = 0

    function setStatus(status, label) {
      statusBadge.className = `status-badge status-badge--${status}`
      statusBadge.dataset.status = status
      statusLabel.textContent = label
    }

    function setError(message) {
      errorElement.textContent = message
      errorElement.hidden = !message
    }

    function renderProjectErrors(errors) {
      projectErrorsElement.replaceChildren()
      if (!Array.isArray(errors) || errors.length === 0) {
        projectErrorsElement.hidden = true
        return 0
      }
      const title = createElement('strong', '', '项目读取异常')
      const list = createElement('ul')
      errors.forEach((error) => {
        if (!error || typeof error !== 'object') return
        const label = typeof error.repoLabel === 'string' && error.repoLabel
          ? error.repoLabel
          : typeof error.repo === 'string' ? error.repo : '未知项目'
        const code = Number.isInteger(error.code) ? error.code : 500
        const message = typeof error.message === 'string' && error.message
          ? error.message
          : '项目提交信息读取失败。'
        list.append(createElement('li', '', `${label}（${code}）：${message}`))
      })
      projectErrorsElement.append(title, list)
      projectErrorsElement.hidden = list.children.length === 0
      return list.children.length
    }

    function renderProgress(value) {
      if (!value || typeof value !== 'object') return
      const phase = typeof value.phase === 'string' ? value.phase : 'queued'
      const phaseLabel = phaseLabels[phase] || phase
      const percent = Number.isFinite(Number(value.percent))
        ? Math.max(0, Math.min(100, Number(value.percent)))
        : 0
      const current = typeof value.currentProject === 'string' && value.currentProject
        ? ` · ${value.currentProject}`
        : ''
      const message = typeof value.message === 'string' && value.message ? ` · ${value.message}` : ''
      const label = `${phaseLabel}${current}${message}`
      progress.hidden = false
      progressLabel.textContent = label
      progressbar.setAttribute('aria-valuenow', String(percent))
      progressbar.setAttribute('aria-valuetext', `${label}（${percent}%）`)
      progressbar.dataset.stage = phase
      const bar = progressbar.querySelector('span')
      if (bar instanceof HTMLElement) {
        bar.style.left = '0'
        bar.style.width = `${percent}%`
        bar.style.animation = 'none'
      }
    }

    function clearPolling() {
      if (pollTimer !== null) window.clearTimeout(pollTimer)
      pollTimer = null
      pollController?.abort()
      pollController = null
    }

    function waitForPoll() {
      return new Promise((resolve) => {
        pollTimer = window.setTimeout(() => {
          pollTimer = null
          resolve()
        }, 800)
      })
    }

    async function pollJob(jobId, generation) {
      while (generation === requestGeneration) {
        const controller = new AbortController()
        pollController = controller
        let response
        try {
          response = await fetch(`/api/weekly-commit-reports/jobs/status?jobId=${encodeURIComponent(jobId)}`, {
            credentials: 'same-origin',
            signal: controller.signal,
          })
        } finally {
          if (pollController === controller) pollController = null
        }
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload?.data) throw new Error(payload?.message || `任务查询失败（${response.status}）。`)
        const job = payload.data
        renderProgress(job.progress)
        if (job.status === 'succeeded') return { result: job.result, publication: job.publication }
        if (job.status === 'failed') throw new Error(job.error?.message || '周报任务执行失败。')
        await waitForPoll()
      }
      return null
    }

    function readProjectsFromDom() {
      return [...projectList.querySelectorAll('[data-weekly-project]')].map((card) => ({
        id: card.dataset.weeklyProjectId || createClientId(),
        repo: card.querySelector('[data-weekly-field="repo"]')?.value.trim() || '',
        person: card.querySelector('[data-weekly-field="person"]')?.value.trim() || '',
        branch: card.querySelector('[data-weekly-field="branch"]')?.value.trim() || '',
      }))
    }

    function updateProjectCard(card, index) {
      const repo = card.querySelector('[data-weekly-field="repo"]')?.value.trim() || ''
      const label = card.querySelector('[data-weekly-project-label]')
      const remove = card.querySelector('[data-weekly-project-remove]')
      const indexElement = card.querySelector('[data-weekly-project-index]')
      if (indexElement instanceof HTMLElement) indexElement.textContent = String(index + 1).padStart(2, '0')
      if (label instanceof HTMLElement) label.textContent = repo ? repo.replace(/^https?:\/\//i, '').replace(/\.git$/i, '').split('/').at(-1) || '新项目' : '新项目'
      if (remove instanceof HTMLButtonElement) {
        remove.disabled = projectList.querySelectorAll('[data-weekly-project]').length <= 1
        remove.setAttribute('aria-label', `移除 ${repo || '新项目'}`)
      }
    }

    function updateProjectMeta() {
      const cards = [...projectList.querySelectorAll('[data-weekly-project]')]
      cards.forEach((card, index) => updateProjectCard(card, index))
      projectCount.textContent = `${cards.length} 项`
      projectAdd.disabled = cards.length >= 10 || submitting
    }

    function saveProjects() {
      saveWeeklyDraft(root.querySelector('input[name="weekly-period"]:checked')?.value || 'last-week', readProjectsFromDom())
    }

    function renderProjects(projects) {
      projectList.replaceChildren()
      projects.slice(0, 10).forEach((project) => {
        const card = projectTemplate.content.firstElementChild.cloneNode(true)
        card.dataset.weeklyProjectId = project.id || createClientId()
        const repo = card.querySelector('[data-weekly-field="repo"]')
        const person = card.querySelector('[data-weekly-field="person"]')
        const branch = card.querySelector('[data-weekly-field="branch"]')
        if (repo instanceof HTMLInputElement) repo.value = project.repo || ''
        if (person instanceof HTMLInputElement) person.value = project.person || ''
        if (branch instanceof HTMLInputElement) branch.value = project.branch || ''
        projectList.append(card)
      })
      updateProjectMeta()
    }

    function collectConfigs() {
      return readProjectsFromDom().map(({ repo, person, branch }) => ({
        repo,
        person,
        ...(branch ? { branch } : {}),
      }))
    }

    async function generate(event) {
      event.preventDefault()
      if (submitting || !form.reportValidity()) return
      submitting = true
      const generation = ++requestGeneration
      clearPolling()
      saveProjects()
      submitButton.disabled = true
      projectAdd.disabled = true
      projectList.querySelectorAll('[data-weekly-project-remove]').forEach((element) => { element.disabled = true })
      setError('')
      renderProjectErrors([])
      setStatus('loading', '排队中')
      meta.textContent = '正在创建周报任务，请稍候。'
      output.hidden = true
      actions.hidden = true
      latestMarkdown = ''
      latestResult = null
      renderProgress({ phase: 'queued', percent: 0, message: '任务已排队。' })
      try {
        const period = root.querySelector('input[name="weekly-period"]:checked')?.value
        const response = await fetch('/api/weekly-commit-reports/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ period, configs: collectConfigs() }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload?.data?.jobId) throw new Error(payload?.message || '周报任务创建失败，请稍后重试。')
        renderProgress(payload.data.progress)
        const outcome = await pollJob(payload.data.jobId, generation)
        if (generation !== requestGeneration || !outcome?.result) return
        const result = outcome.result
        const publication = outcome.publication
        latestResult = result
        latestMarkdown = typeof result.markdown === 'string' ? result.markdown : ''
        if (!latestMarkdown) throw new Error('周报任务未返回 Markdown 内容。')
        output.textContent = latestMarkdown
        output.hidden = false
        actions.hidden = false
        const projectErrorCount = renderProjectErrors(result.projectErrors)
        const modeLabel = result.degraded ? '本地规则摘要' : 'AI 摘要'
        const errorLabel = projectErrorCount > 0 ? ` · ${projectErrorCount} 个项目失败` : ''
        const publicationStatus = publication?.status
        const publicationLabel = publicationStatus === 'succeeded'
          ? ' · 飞书已写入'
          : publicationStatus === 'skipped'
            ? ' · 飞书内容未变化'
            : publicationStatus === 'failed'
              ? ` · 飞书发布失败${publication.message ? `：${publication.message}` : ''}`
              : ''
        meta.textContent = `${result.weekStart} ~ ${result.weekEnd} · ${result.commitCount} 条提交 · ${modeLabel}${errorLabel}${publicationLabel}`
        const finalMessage = publicationStatus === 'failed'
          ? '周报已生成，但飞书发布失败。'
          : projectErrorCount > 0 ? '周报已生成，部分项目失败。' : '周报已生成。'
        renderProgress({ phase: 'completed', percent: 100, message: finalMessage })
        setStatus('ready', publicationStatus === 'failed' ? '已生成但发布失败' : projectErrorCount > 0 ? '部分完成' : '已生成')
      } catch (error) {
        if (generation !== requestGeneration) return
        latestResult = null
        latestMarkdown = ''
        output.textContent = ''
        output.hidden = true
        actions.hidden = true
        renderProjectErrors([])
        setError(error instanceof Error ? error.message : '周报生成失败，请稍后重试。')
        meta.textContent = '未生成报告。'
        setStatus('error', '错误')
      } finally {
        if (generation === requestGeneration) {
          clearPolling()
          submitting = false
          submitButton.disabled = false
          updateProjectMeta()
        }
      }
    }

    async function copyMarkdown() {
      if (!latestMarkdown) return
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(latestMarkdown)
        else {
          const helper = document.createElement('textarea')
          helper.value = latestMarkdown
          helper.setAttribute('readonly', '')
          helper.style.position = 'fixed'
          helper.style.opacity = '0'
          document.body.append(helper)
          helper.select()
          document.execCommand('copy')
          helper.remove()
        }
        meta.textContent = `${meta.textContent.split(' · ')[0]} · Markdown 已复制`
      } catch {
        setError('无法访问剪贴板，请直接选择并复制报告内容。')
      }
    }

    function downloadMarkdown() {
      if (!latestMarkdown || !latestResult) return
      const blob = new Blob([latestMarkdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `weekly-report-${latestResult.period}-${latestResult.weekEnd}.md`
      link.click()
      URL.revokeObjectURL(url)
    }

    const initialProjects = readProjectsFromDom()
    const savedDraft = readWeeklyDraft()
    if (savedDraft) {
      form.querySelectorAll('input[name="weekly-period"]').forEach((element) => {
        if (element instanceof HTMLInputElement) element.checked = element.value === savedDraft.period
      })
    }
    renderProjects(savedDraft?.projects || initialProjects)
    projectList.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const remove = target.closest('[data-weekly-project-remove]')
      if (!(remove instanceof HTMLButtonElement) || projectList.querySelectorAll('[data-weekly-project]').length <= 1) return
      remove.closest('[data-weekly-project]')?.remove()
      updateProjectMeta()
      saveProjects()
    })
    projectList.addEventListener('input', (event) => {
      if (!(event.target instanceof HTMLInputElement) || !event.target.matches('[data-weekly-field]')) return
      updateProjectMeta()
      saveProjects()
    })
    projectAdd.addEventListener('click', () => {
      const projects = readProjectsFromDom()
      if (projects.length >= 10) return
      projects.push({ id: createClientId(), repo: '', person: '', branch: '' })
      renderProjects(projects)
      saveProjects()
      projectList.querySelector('[data-weekly-project]:last-child [data-weekly-field="repo"]')?.focus()
    })
    form.querySelectorAll('input[name="weekly-period"]').forEach((element) => element.addEventListener('change', saveProjects))
    form.addEventListener('submit', generate)
    copyButton.addEventListener('click', copyMarkdown)
    downloadButton.addEventListener('click', downloadMarkdown)
  }

  mobileMenuButton.addEventListener('click', () => {
    const open = mobileMenuButton.getAttribute('aria-expanded') === 'true'
    setSidebarOpen(!open)
  })
  sidebarScrim.addEventListener('click', () => setSidebarOpen(false, true))
  sidebarCollapseButton?.addEventListener('click', () => setSidebarCollapsed(!appShell.classList.contains('app-shell--sidebar-collapsed')))
  navLinks.forEach((link) => link.addEventListener('click', () => setSidebarOpen(false, true)))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSidebarOpen(false, true)
  })
  window.addEventListener('hashchange', () => renderRoute(normalizeRoute(), true))

  void loadViews()
})()
