(() => {
  if (typeof document === 'undefined') return

  const PORT_PREFIX = Object.freeze({ in: 'in:', out: 'out:' })
  const LAYOUT = Object.freeze({ headHeight: 40, portRow: 26, grid: 20, shape: 'nestcloud-workflow-node', minZoom: Number.EPSILON, maxZoom: 2 })
  const INTERACTIVE_SELECTOR = 'input, textarea, select, button, a, summary, [data-wf-interactive]'
  const PALETTE_MIME = 'application/x-nestcloud-workflow-node'
  const PALETTE_ICON_PATHS = Object.freeze({ folder: 'M3 7h6l2-3h10v16H3z', chevron: 'm5 9 7 7 7-7' })
  const GRAPH_COLOR_PROPERTIES = Object.freeze({
    accent: '--wf-graph-accent', grid: '--wf-graph-grid', portFill: '--wf-graph-port-fill',
    edge: '--wf-graph-edge',
  })
  // 画布层级：连线 0 < 区域 < 节点；拖线预览固定为 10，始终在最上层
  const LAYER = Object.freeze({ annotation: 1, node: 2 })
  const EDGE_EFFECT = Object.freeze({ duration: 2.8, particles: 3, hitWidth: 16 })
  // 运行中节点流星：节点边框是盒外 1px 的 box-shadow 环，轨道铺在其中线（-0.5px）上；tailRatio 为尾迹占所在边长的比例。
  const NODE_METEOR = Object.freeze({ inset: -0.5, edges: 4, tailRatio: 0.4 })
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const COORDINATE_LIMIT = 100_000
  const VIEWPORT_SAVE_MS = 300
  const HINT_MS = 6000
  const JSON_PREVIEW_LIMIT = 200_000
  const TREE_ROW_BUDGET = 400
  const TREE_EXPAND_LIMIT = 5000
  const NODE_STATUS_LABELS = Object.freeze({ idle: '待运行', queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', skipped: '已跳过', cancelled: '已取消' })
  const RUN_STATUS_LABELS = Object.freeze({ idle: '尚未运行', running: '运行中', succeeded: '全部成功', partial: '部分成功', failed: '运行失败', cancelled: '已停止', stale: '结果部分过期' })
  const DIFF_LABELS = Object.freeze({ added: '新增', removed: '删除', modified: '修改', unchanged: '未变化' })
  const IDLE_STATE =Object.freeze({ status: 'idle', message: '', outputs: null })
  const COMPARE_COPY = Object.freeze({
    'json-compare': '按 JSON 解析 A、B 并规范化对象键顺序，输出结构化差异。运行时两侧原文会发送到本服务计算，不在后端保存。',
    'env-compare': '按 KEY=VALUE 逐项对比 A、B 环境变量文本，输出结构化差异。运行时两侧原文会发送到本服务计算，不在后端保存。',
  })
  const SAMPLES = Object.freeze({
    json: {
      label: 'JSON',
      left: '{\n  "service": "gateway",\n  "version": "1.4.0",\n  "replicas": 2,\n  "features": ["auth", "cache"]\n}',
      right: '{\n  "service": "gateway",\n  "version": "1.5.0",\n  "replicas": 3,\n  "timeoutMs": 3000,\n  "features": ["auth", "cache", "audit"]\n}',
    },
    env: {
      label: 'ENV',
      left: 'NODE_ENV=production\nPORT=3000\nREDIS_HOST=127.0.0.1\nLOG_LEVEL=info',
      right: 'NODE_ENV=production\nPORT=8080\nREDIS_HOST=127.0.0.1\nREDIS_DB=2',
    },
  })

  /** 节点视图与工具栏共用的错误出口，由挂载后的画布接管。 */
  const feedback = { error: () => {}, hint: () => {} }

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

  function createPaletteIcon(name) {
    const icon = document.createElementNS(SVG_NS, 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('aria-hidden', 'true')
    icon.setAttribute('focusable', 'false')
    icon.classList.add(name === 'folder' ? 'wf-folder__icon' : 'wf-folder__chevron')
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', PALETTE_ICON_PATHS[name])
    icon.append(path)
    return icon
  }

  /** 创建运行中节点的流星层：四条边各一条轨道，轨道内一颗流星，形态由样式绘制，轨道在运行时按节点尺寸布局。 */
  function createNodeMeteor() {
    const meteor = createElement('div', 'wf-node__meteor')
    meteor.setAttribute('aria-hidden', 'true')
    for (let edge = 0; edge < NODE_METEOR.edges; edge += 1) {
      const track = createElement('span', 'wf-node__meteor-track')
      track.append(createElement('span', 'wf-node__meteor-star'))
      meteor.append(track)
    }
    return meteor
  }

  /** 按节点尺寸把四条轨道铺在边框中线上（左上→右上→右下→左下→左上，顺时针），轨道两端止于角点，宽度方向允许光晕溢出边框。 */
  function layoutNodeMeteor(meteor, size) {
    const { inset, tailRatio } = NODE_METEOR
    const right = size.width - inset
    const bottom = size.height - inset
    const corners = [[inset, inset], [right, inset], [right, bottom], [inset, bottom]]
    for (const [index, track] of [...meteor.children].entries()) {
      const [x1, y1] = corners[index]
      const [x2, y2] = corners[(index + 1) % corners.length]
      const length = Math.hypot(x2 - x1, y2 - y1)
      track.style.left = `${x1}px`
      track.style.top = `${y1}px`
      track.style.setProperty('--wf-meteor-angle', `${Math.atan2(y2 - y1, x2 - x1)}rad`)
      track.style.setProperty('--wf-meteor-length', `${length}px`)
      track.style.setProperty('--wf-meteor-tail', `${length * tailRatio}px`) // 尾迹与边长等比，四颗同步出发、同步抵达
    }
  }

  function messageOf(error, fallback = '操作失败，请重试。') {
    return error instanceof Error && error.message ? error.message : fallback
  }

  /** 以 Blob 触发本地下载，内容只写入用户浏览器。 */
  function downloadText(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }))
    const link = createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /** 判断节点内容在当前方向是否仍可滚动，画布本身不参与原生滚动。 */
  function canScrollInside(start, boundary, event) {
    const deltaX = event.deltaX || (event.shiftKey ? event.deltaY : 0)
    const deltaY = event.shiftKey ? 0 : event.deltaY
    for (let element = start; element instanceof Element && element !== boundary; element = element.parentElement) {
      const style = window.getComputedStyle(element)
      const scrollsY = /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight
      const scrollsX = /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth
      if (scrollsY && ((deltaY < 0 && element.scrollTop > 0) || (deltaY > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1))) return true
      if (scrollsX && ((deltaX < 0 && element.scrollLeft > 0) || (deltaX > 0 && element.scrollLeft + element.clientWidth < element.scrollWidth - 1))) return true
    }
    return false
  }

  /* ------------------------------------------------------------------ */
  /* 节点内容渲染器：由内置注册表按节点定义调用，视图只做展示和提交命令。 */
  /* ------------------------------------------------------------------ */

  /** 对比节点：简要说明、状态和统计；完整结果由下游结果节点展示。 */
  function renderCompareNode({ node, body }) {
    const description = createElement('p', 'wf-compare__description', COMPARE_COPY[node.type] ?? '对比 A、B 两个文本输入，输出结构化差异。')
    const status = createElement('p', 'wf-compare__status')
    body.classList.add('wf-node__body--scroll')
    body.append(status, description)
    return {
      update({ state }) {
        const stats = state.outputs?.diff?.stats
        if (state.status === 'succeeded' && stats) {
          status.textContent = stats.added + stats.removed + stats.modified === 0
            ? '运行完成：A、B 无差异。'
            : `运行完成：新增 ${stats.added}，删除 ${stats.removed}，修改 ${stats.modified}。`
        } else if (state.status === 'running') status.textContent = '正在计算差异…'
        else if (state.status === 'queued') status.textContent = '等待上游输入。'
        else if (state.status === 'idle') status.textContent = '尚未运行，连接开始节点的启动线与 A、B 文本后运行。'
        else status.textContent = ''
        status.hidden = !status.textContent
      },
    }
  }

  /** 把带状态的片段写入代码窗格；未变化片段使用文本节点，减少 DOM 数量。 */
  function fillSegments(code, segments) {
    const fragment = document.createDocumentFragment()
    for (const segment of segments) {
      if (segment.status) fragment.append(createElement('span', `wf-hl wf-hl--${segment.status}`, segment.text))
      else fragment.append(document.createTextNode(segment.text))
    }
    code.replaceChildren(fragment)
  }

  /** 按原文行号合并连续同类差异，生成固定在滚动区域旁的位置概览。 */
  function fillDiffMarkers(markers, segments) {
    const statusByLine = new Map()
    let line = 0
    let afterCR = false
    for (const segment of segments) {
      for (const character of segment.text) {
        if (character === '\r') { line += 1; afterCR = true }
        else if (character === '\n') { if (!afterCR) line += 1; afterCR = false }
        else {
          afterCR = false
          if (segment.status) statusByLine.set(line, segment.status)
        }
      }
    }
    const totalLines = line + 1
    const ranges = []
    for (const [index, status] of statusByLine) {
      const previous = ranges[ranges.length - 1]
      if (previous && previous.status === status && previous.end + 1 === index) previous.end = index
      else ranges.push({ start: index, end: index, status })
    }
    const fragment = document.createDocumentFragment()
    for (const range of ranges) {
      const marker = createElement('span', `wf-pane__marker wf-pane__marker--${range.status}`)
      marker.dataset.line = String(range.start)
      marker.dataset.endLine = String(range.end)
      marker.style.top = `min(${range.start / totalLines * 100}%, calc(100% - 2px))`
      marker.style.height = `${(range.end - range.start + 1) / totalLines * 100}%`
      fragment.append(marker)
    }
    markers.replaceChildren(fragment)
  }

  /** 结果节点：A/B 高亮对照、统计、可折叠差异树以及结构化 JSON 查看与下载。 */
  function renderResultNode({ body }) {
    const TABS = [['pairs', 'A / B 对照'], ['tree', '差异树'], ['json', 'JSON 输出']]
    const root = createElement('div', 'wf-result')
    const bar = createElement('div', 'wf-result__bar')
    const stats = createElement('div', 'wf-result__stats')
    const tablist = createElement('div', 'wf-result__tabs')
    tablist.setAttribute('role', 'tablist')
    tablist.setAttribute('aria-label', '结果视图')
    const actions = createElement('div', 'wf-result__actions')
    const expandButton = createButton('wf-mini-button', '展开全部')
    const collapseButton = createButton('wf-mini-button', '全部收起')
    const downloadButton = createButton('wf-mini-button', '下载 JSON')
    actions.append(expandButton, collapseButton, downloadButton)
    const empty = createElement('p', 'wf-result__empty')
    const panels = {}
    const tabButtons = {}
    for (const [key, label] of TABS) {
      const tab = createButton('wf-result__tab', label)
      tab.setAttribute('role', 'tab')
      tab.dataset.tab = key
      const panel = createElement('div', `wf-result__panel wf-result__panel--${key}`)
      panel.setAttribute('role', 'tabpanel')
      panel.setAttribute('aria-label', label)
      panel.hidden = true
      tabButtons[key] = tab
      panels[key] = panel
      tablist.append(tab)
    }
    bar.append(stats, tablist, actions)
    body.classList.add('wf-node__body--fill')
    root.append(bar, empty, ...Object.values(panels))
    body.append(root)

    const pairColumns = {}
    for (const side of ['A', 'B']) {
      const column = createElement('section', 'wf-pane')
      column.setAttribute('aria-label', `内容 ${side}`)
      const title = createElement('h3', 'wf-pane__title', side)
      const content = createElement('div', 'wf-pane__content')
      const code = createElement('pre', 'wf-pane__code')
      code.tabIndex = 0
      code.dataset.wfInteractive = ''
      code.setAttribute('aria-label', `内容 ${side} 高亮`)
      const markers = createElement('div', 'wf-pane__markers')
      markers.setAttribute('aria-hidden', 'true')
      content.append(code, markers)
      column.append(title, content)
      pairColumns[side] = { column, title, code, markers }
    }
    panels.pairs.append(pairColumns.A.column, pairColumns.B.column)
    const tree = createElement('div', 'wf-tree')
    tree.setAttribute('role', 'tree')
    tree.setAttribute('aria-label', '差异树')
    tree.dataset.wfInteractive = ''
    panels.tree.append(tree)
    const jsonNote = createElement('p', 'wf-json-note')
    const jsonCode = createElement('pre', 'wf-pane__code wf-pane__code--json')
    jsonCode.tabIndex = 0
    jsonCode.dataset.wfInteractive = ''
    jsonCode.setAttribute('aria-label', '结构化差异 JSON')
    panels.json.append(jsonNote, jsonCode)

    let diff = null
    let activeTab = 'pairs'
    let expanded = new Set()
    let jsonText = ''
    let rendered = {}
    let syncingScroll = false

    const pathsOf = (nodeItem, collect = []) => {
      if (nodeItem.children.length) collect.push(nodeItem)
      nodeItem.children.forEach((child) => pathsOf(child, collect))
      return collect
    }

    /** 初始展开根节点和含变更的容器，以行预算限制首次渲染量。 */
    const initialExpansion = () => {
      const open = new Set()
      let rows = 1
      const queue = [diff.tree]
      while (queue.length && rows < TREE_ROW_BUDGET) {
        const item = queue.shift()
        if (!item.children.length || (item !== diff.tree && item.status === 'unchanged')) continue
        open.add(item.path)
        rows += item.children.length
        queue.push(...item.children)
      }
      return open
    }

    const renderRow = (item, depth, fragment) => {
      const isContainer = item.children.length > 0
      const isOpen = expanded.has(item.path)
      const row = createElement('div', `wf-tree__row wf-tree__row--${item.status}`)
      row.setAttribute('role', 'treeitem')
      row.setAttribute('aria-level', String(depth + 1))
      if (isContainer) row.setAttribute('aria-expanded', String(isOpen))
      const key = createElement('div', 'wf-tree__key')
      key.style.paddingLeft = `${depth * 14 + 6}px`
      if (isContainer) {
        const toggle = createButton('wf-tree__toggle', isOpen ? '−' : '+', `${isOpen ? '收起' : '展开'} ${item.path}`)
        toggle.addEventListener('click', () => {
          if (isOpen) expanded.delete(item.path)
          else expanded.add(item.path)
          renderTree()
        })
        key.append(toggle)
      } else key.append(createElement('span', 'wf-tree__spacer'))
      key.append(createElement('span', 'wf-tree__label', String(item.key)), createElement('span', `wf-tree__status wf-tree__status--${item.status}`, DIFF_LABELS[item.status]))
      const left = createElement('div', `wf-tree__cell wf-tree__cell--${item.status === 'added' ? 'missing' : item.status}`, item.hasLeft ? item.leftDisplay : '—')
      const right = createElement('div', `wf-tree__cell wf-tree__cell--${item.status === 'removed' ? 'missing' : item.status}`, item.hasRight ? item.rightDisplay : '—')
      row.append(key, left, right)
      fragment.append(row)
      if (isContainer && isOpen) item.children.forEach((child) => renderRow(child, depth + 1, fragment))
    }

    function renderTree() {
      const head = createElement('div', 'wf-tree__head')
      head.append(createElement('span', '', '路径'), createElement('span', '', 'A'), createElement('span', '', 'B'))
      const fragment = document.createDocumentFragment()
      renderRow(diff.tree, 0, fragment)
      tree.replaceChildren(head, fragment)
    }

    /** 首次显示某个视图时才生成 DOM，切换标签保持已有滚动与展开状态。 */
    function ensureRendered(key) {
      if (!diff || rendered[key]) return
      rendered[key] = true
      if (key === 'pairs') {
        const format = diff.format.toUpperCase()
        for (const [side, text, segments] of [['A', diff.leftText, diff.segments.left], ['B', diff.rightText, diff.segments.right]]) {
          pairColumns[side].title.textContent = `${side}（${format}）`
          fillSegments(pairColumns[side].code, segments.length ? segments : [{ text, status: null }])
          fillDiffMarkers(pairColumns[side].markers, segments)
        }
      } else if (key === 'tree') renderTree()
      else {
        jsonText = JSON.stringify(diff, null, 2)
        const truncated = jsonText.length > JSON_PREVIEW_LIMIT
        jsonCode.textContent = truncated ? jsonText.slice(0, JSON_PREVIEW_LIMIT) : jsonText
        jsonNote.textContent = truncated ? `仅显示前 ${JSON_PREVIEW_LIMIT.toLocaleString('zh-CN')} 个字符，点击“下载 JSON”获取完整内容。` : ''
        jsonNote.hidden = !truncated
      }
    }

    function selectTab(key, focus = false) {
      activeTab = key
      for (const [name] of TABS) {
        const selected = name === key
        tabButtons[name].setAttribute('aria-selected', String(selected))
        tabButtons[name].tabIndex = selected ? 0 : -1
        panels[name].hidden = !selected || !diff
      }
      expandButton.hidden = collapseButton.hidden = key !== 'tree'
      ensureRendered(key)
      if (focus) tabButtons[key].focus()
    }

    function showDiff(next, state) {
      if (diff !== next) {
        diff = next
        rendered = {}
        for (const { code, markers } of Object.values(pairColumns)) {
          code.replaceChildren()
          markers.replaceChildren()
        }
        tree.replaceChildren()
        jsonCode.textContent = ''
        jsonText = ''
        stats.replaceChildren()
        if (diff) {
          expanded = initialExpansion()
          const summary = diff.stats.added + diff.stats.removed + diff.stats.modified === 0 ? '无变化' : '发现变化'
          stats.append(createElement('strong', 'wf-result__summary', summary))
          for (const key of ['added', 'removed', 'modified']) stats.append(createElement('span', `wf-stat wf-stat--${key}`, `${DIFF_LABELS[key]} ${diff.stats[key]}`))
        }
      }
      bar.hidden = !diff
      if (diff) empty.hidden = true
      else {
        empty.hidden = false
        const idle = { idle: '运行整图后在此查看完整差异：A/B 高亮、统计、差异树和 JSON 输出。', queued: '等待上游节点完成。', running: '正在计算差异…' }
        empty.textContent = idle[state.status] ?? (state.status === 'succeeded' ? '上游没有提供差异数据。' : '没有可显示的结果，详见节点上方的状态信息。')
      }
      selectTab(activeTab)
    }

    for (const [key] of TABS) {
      tabButtons[key].addEventListener('click', () => selectTab(key))
      tabButtons[key].addEventListener('keydown', (event) => {
        const index = TABS.findIndex(([name]) => name === key)
        const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }[event.key]
        if (target === undefined) return
        event.preventDefault()
        selectTab(TABS[(target + TABS.length) % TABS.length][0], true)
      })
    }
    expandButton.addEventListener('click', () => {
      const containers = pathsOf(diff.tree)
      expanded = new Set(containers.slice(0, TREE_EXPAND_LIMIT).map((item) => item.path))
      if (containers.length > TREE_EXPAND_LIMIT) feedback.hint(`差异树节点较多，已展开前 ${TREE_EXPAND_LIMIT} 个容器。`)
      renderTree()
    })
    collapseButton.addEventListener('click', () => {
      expanded = new Set([diff.tree.path])
      renderTree()
    })
    downloadButton.addEventListener('click', () => {
      ensureRendered('json')
      downloadText(`diff-${diff.format}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, jsonText, 'application/json')
    })
    for (const [from, to] of [['A', 'B'], ['B', 'A']]) {
      pairColumns[from].code.addEventListener('scroll', () => {
        if (syncingScroll) return
        syncingScroll = true
        pairColumns[to].code.scrollTop = pairColumns[from].code.scrollTop
        pairColumns[to].code.scrollLeft = pairColumns[from].code.scrollLeft
        window.requestAnimationFrame(() => { syncingScroll = false })
      })
    }

    return {
      update({ state }) {
        showDiff(state.outputs?.diff ?? null, state)
      },
    }
  }

  const renderers = Object.freeze({ compare: renderCompareNode, result: renderResultNode })

  /* ------------------------------------------------------------------ */
  /* 工作区单例：任务与视图分离，重复挂载或切换菜单不会销毁运行中的任务。 */
  /* ------------------------------------------------------------------ */

  let engine = null
  let storageListener = () => {}

  function getEngine() {
    if (engine) return engine
    const Core = window.NestCloudWorkflowCore
    const Nodes = window.NestCloudWorkflowNodes
    const capabilityView = window.NestCloudWorkflowCapabilityView
    const registry = Nodes.createRegistry({ ...renderers, capability: capabilityView.capability, textResult: capabilityView.textResult })
    let storage = null
    try { storage = window.localStorage } catch { storage = null }
    const workspace = new Core.Workspace({ registry, storage, services: Nodes.createServices({ confirmWrite: capabilityView.confirmWrite }), onStorageError: (message) => storageListener(message) })
    engine = { Core, registry, workspace, storage }
    return engine
  }

  const mounted = new WeakMap()

  /** 挂载工作流画布；同一容器重复调用返回既有实例，缺少文档环境时直接返回。 */
  function mount(root) {
    if (typeof document === 'undefined' || !(root instanceof HTMLElement)) return null
    if (mounted.has(root)) return mounted.get(root)
    const refs = {}
    root.querySelectorAll('[data-wf]').forEach((element) => { refs[element.dataset.wf] = element })
    const X6 = window.NestCloudWorkflowGraph
    if (!window.NestCloudWorkflowCore?.Workspace || !window.NestCloudWorkflowNodes?.createRegistry
      || !window.NestCloudWorkflowPalette?.createPaletteTree || !window.NestCloudWorkflowDirectory?.mount
      || !window.NestCloudWorkflowFiles?.WorkflowFileService
      || !window.NestCloudWorkflowCapabilities?.register
      || !window.NestCloudWorkflowCapabilityView?.capability || !window.NestCloudWorkflowCapabilityView?.textResult
      || !window.NestCloudWorkflowCapabilityView?.confirmWrite
      || !X6?.Graph || !X6.Shape?.HTML || !X6.Selection || !X6.Transform) {
      refs.error.textContent = '工作流依赖脚本未能加载，请刷新页面重试。'
      refs.error.hidden = false
      return null
    }
    const instance = createCanvas(root, refs, X6)
    mounted.set(root, instance)
    return instance
  }

  function createCanvas(root, refs, X6) {
    const listeners = []
    const listen = (target, event, handler, options) => {
      target.addEventListener(event, handler, options)
      listeners.push(() => target.removeEventListener(event, handler, options))
    }

    const showStorage = (message) => {
      refs['storage-alert'].textContent = message
      refs['storage-alert'].hidden = !message
    }
    storageListener = showStorage
    const { Core, registry, workspace, storage } = getEngine()
    showStorage(workspace.storageError)

    const ui = { docId: null, locked: false, syncing: false, committingLayout: false, sized: false }
    const hosts = new Map()
    const nodeViews = new Map()
    let hintTimer = null
    let viewportTimer = null
    let viewportDirty = false
    let paletteCount = 0
    let destroyed = false
    const folderExpanded = new Map()
    let paletteSearching = false
    let paletteRootWasOpen = refs['palette-folder'].open

    /* ---------------- 反馈 ---------------- */

    function showError(message) {
      refs.error.textContent = message
      refs.error.hidden = !message
    }
    function setHint(message) {
      window.clearTimeout(hintTimer)
      if (refs.hint.textContent !== message) refs.hint.textContent = message
      if (message) hintTimer = window.setTimeout(() => { refs.hint.textContent = '' }, HINT_MS)
    }
    feedback.error = showError
    feedback.hint = setHint

    /** 提交节点输入及未失焦的流程名称，失败由当前操作中止处理。 */
    function flushInputs() {
      const documentId = ui.docId
      const name = documentId ? refs['doc-name'].value.trim() : null
      for (const view of nodeViews.values()) view.flush()
      if (documentId && name !== workspace.getDocument(documentId).name) workspace.rename(documentId, name)
    }

    /** 执行工作区命令；失败统一以 alert 呈现，工作区已保证原子性。 */
    function command(action) {
      showError('')
      try {
        flushInputs()
        return action()
      } catch (error) {
        showError(messageOf(error))
        return undefined
      }
    }

    const currentDocument = () => workspace.getDocument(ui.docId)
    const clampCoordinate = (value) => Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, Math.round(value)))
    const snap = (value) => Math.round(value / LAYOUT.grid) * LAYOUT.grid

    /* ---------------- 节点视图 ---------------- */

    /** 已知节点使用定义端口；未知节点按已保留的连线推导通用端口，保证连线仍可显示。 */
    function portsOf(node, definition, flow) {
      if (definition) return { inputs: definition.inputs, outputs: definition.outputs }
      const unknown = (ids) => [...new Set(ids)].map((id) => ({ id, label: id, dataType: '未知', required: false }))
      return {
        inputs: unknown(flow.edges.filter((edge) => edge.target.nodeId === node.id).map((edge) => edge.target.port)),
        outputs: unknown(flow.edges.filter((edge) => edge.source.nodeId === node.id).map((edge) => edge.source.port)),
      }
    }

    function createPortLabel(port, side) {
      const label = createElement('span', `wf-port wf-port--${side}`)
      label.title = `${port.label}（${port.dataType}${port.required ? '，必填' : ''}${port.multiple ? '，可接多个来源' : ''}）`
      label.append(createElement('b', 'wf-port__name', port.label))
      if (port.required) label.append(createElement('span', 'wf-port__required', '*'))
      label.append(createElement('small', 'wf-port__type', port.multiple ? `${port.dataType} · 多来源` : port.dataType))
      return label
    }

    /** 创建一个持久的节点 DOM；类型相关内容全部由定义自带的 render 生成。 */
    function createNodeView(node, flow) {
      const definition = registry.get(node.type, node.version)
      const { inputs, outputs } = portsOf(node, definition, flow)
      const host = createElement('div', 'wf-node')
      host.style.setProperty('--wf-head-h', `${LAYOUT.headHeight}px`)
      host.style.setProperty('--wf-port-h', `${LAYOUT.portRow}px`)
      host.dataset.nodeId = node.id
      host.dataset.status = 'idle'
      if (definition?.credentialGroup) host.dataset.credentialGroup = definition.credentialGroup
      if (!definition) host.classList.add('wf-node--unknown')
      // 区域等画布标注不参与运行：不显示状态、端口和“从此节点运行”，方框颜色取自配置
      const annotation = definition?.execution === Core.NODE_EXECUTION.annotation
      if (annotation) {
        host.classList.add('wf-node--annotation')
        host.style.setProperty('--wf-annotation-color', node.config.color)
      }

      const head = createElement('div', 'wf-node__head')
      if (annotation) {
        // 区域名称放在画布上方的独立图层，始终压在节点之上；data-cell-id 让 X6 仍把在标签上的拖动与点击识别为该区域
        head.classList.add('wf-region-label')
        head.setAttribute('data-cell-id', node.id)
        head.style.setProperty('--wf-annotation-color', node.config.color)
      }
      const nameInput = createElement('input', 'wf-node__name')
      nameInput.type = 'text'
      nameInput.maxLength = 120
      nameInput.spellcheck = false
      nameInput.autocomplete = 'off'
      nameInput.setAttribute('aria-label', `节点名称（${definition?.label ?? node.type}）`)
      const kind = createElement('span', 'wf-node__kind', definition?.label ?? '未知节点')
      kind.tabIndex = 0
      kind.setAttribute('role', 'button')
      kind.setAttribute('aria-label', `选择节点 ${node.name}`)
      kind.title = `拖动移动节点，点击选择（${definition?.label ?? node.type}）`
      kind.setAttribute('aria-pressed', 'false')
      const status = createElement('span', 'wf-node__status', NODE_STATUS_LABELS.idle)
      const remove = createButton('wf-node__remove', '×', `删除节点 ${node.name}`)
      // 开始节点由工具栏“运行”触发；其他已安装节点可复用上游结果从本节点重跑。
      const runFrom = definition && definition.execution !== Core.NODE_EXECUTION.entry && !annotation
        ? createButton('wf-node__run', '▶', `从此节点运行 ${node.name}`)
        : null
      if (runFrom) runFrom.title = '从此节点运行：复用上游已成功的结果，只重跑本节点及下游'
      head.append(kind, nameInput, ...(annotation ? [] : [status]), ...(runFrom ? [runFrom] : []), remove)

      const portsElement = createElement('div', 'wf-node__ports')
      for (let index = 0; index < Math.max(inputs.length, outputs.length); index += 1) {
        const row = createElement('div', 'wf-node__port-row')
        row.append(inputs[index] ? createPortLabel(inputs[index], 'in') : createElement('span'), outputs[index] ? createPortLabel(outputs[index], 'out') : createElement('span'))
        portsElement.append(row)
      }
      const message = createElement('p', 'wf-node__message')
      message.hidden = true
      const body = createElement('div', 'wf-node__body')
      const latest = definition ? registry.list().find((item) => item.type === node.type) : null
      let upgrade = null
      if (latest && latest.version > node.version) {
        upgrade = createButton('wf-mini-button', `升级到 v${latest.version}`, `将节点 ${node.name} 升级到版本 ${latest.version}`)
        const notice = createElement('div', 'wf-node__upgrade')
        notice.append(createElement('span', '', `旧版本 v${node.version}，配置按原规则继续可用。`), upgrade)
        host.append(...(annotation ? [] : [head, portsElement]), notice, message, body)
      } else host.append(...(annotation ? [] : [head, portsElement]), message, body)
      if (annotation) annotationLayer.append(head)
      const meteor = createNodeMeteor()
      host.append(meteor)

      let controller = null
      if (!definition) body.append(createElement('p', 'wf-node__notice', `节点类型 ${node.type}（版本 ${node.version}）尚未安装，配置已原样保留，此流程不能运行。`))
      else if (typeof definition.render !== 'function') {
        if (!annotation) body.append(createElement('p', 'wf-node__notice', '该节点类型没有提供自定义视图。')) // 区域等标注只有标题栏，内容区保持空白
      }
      else {
        try {
          controller = definition.render({ node, body, workspace, runtime: workspace.getRuntime(ui.docId), documentId: ui.docId })
        } catch (error) {
          body.replaceChildren(createElement('p', 'wf-node__notice', `节点视图加载失败：${messageOf(error, '未知错误')}`))
        }
      }

      let current = node
      nameInput.addEventListener('change', () => {
        const name = nameInput.value
        const updated = command(() => workspace.updateNode(current.id, { name }, ui.docId))
        if (!updated) nameInput.value = current.name
      })
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') nameInput.blur()
        else if (event.key === 'Escape') {
          nameInput.value = current.name
          nameInput.blur()
        }
      })
      remove.addEventListener('click', () => command(() => workspace.deleteSelection({ nodeIds: [current.id] }, ui.docId)))
      runFrom?.addEventListener('click', async () => {
        showError('')
        try {
          flushInputs()
          await workspace.runFrom(current.id, ui.docId)
        } catch (error) {
          showError(messageOf(error, '运行失败，请重试。'))
        }
      })
      upgrade?.addEventListener('click', () => {
        if (command(() => workspace.upgradeNode(current.id, ui.docId))) setHint(`已将节点“${current.name}”升级到 v${latest.version}，可撤销。`)
      })
      kind.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) selectCell(current.id, event.ctrlKey || event.metaKey)
      })

      return {
        host,
        label: annotation ? head : null,
        key: `${node.type}@${node.version}`,
        flush() { controller?.flush?.() },
        update(nextNode, state, locked) {
          current = nextNode
          if (nameInput.value !== nextNode.name && window.document.activeElement !== nameInput) nameInput.value = nextNode.name
          nameInput.readOnly = locked
          kind.setAttribute('aria-label', `选择节点 ${nextNode.name}`)
          kind.setAttribute('aria-pressed', String(graph.isSelected(nextNode.id)))
          remove.disabled = locked
          remove.setAttribute('aria-label', `删除节点 ${nextNode.name}`)
          if (runFrom) {
            runFrom.disabled = locked
            runFrom.setAttribute('aria-label', `从此节点运行 ${nextNode.name}`)
          }
          if (upgrade) upgrade.disabled = locked
          if (annotation) {
            host.style.setProperty('--wf-annotation-color', nextNode.config.color)
            head.style.setProperty('--wf-annotation-color', nextNode.config.color)
          }
          host.dataset.status = state.status
          if (state.status === 'running') layoutNodeMeteor(meteor, nextNode.size)
          status.textContent = NODE_STATUS_LABELS[state.status] ?? state.status
          message.textContent = state.message
          message.hidden = !state.message
          message.setAttribute('role', state.status === 'failed' ? 'alert' : 'status')
          try {
            controller?.update?.({ node: nextNode, state, locked })
          } catch (error) {
            message.textContent = `节点视图更新失败：${messageOf(error, '未知错误')}`
            message.hidden = false
          }
        },
        destroy() {
          try { controller?.destroy?.() } catch { /* 扩展节点销毁失败不影响画布清理 */ }
          host.remove()
          if (annotation) head.remove()
        },
      }
    }

    function portItems(inputs, outputs) {
      const y = (index) => LAYOUT.headHeight + LAYOUT.portRow * (index + 0.5)
      return [
        ...inputs.map((port, index) => ({ id: PORT_PREFIX.in + port.id, group: 'in', args: { x: 0, y: y(index) } })),
        ...outputs.map((port, index) => ({ id: PORT_PREFIX.out + port.id, group: 'out', args: { x: '100%', y: y(index) } })),
      ]
    }

    /* ---------------- 画布 ---------------- */

    X6.Shape.HTML.register({ shape: LAYOUT.shape, width: 320, height: 240, effect: [], html: (cell) => hosts.get(cell.id) ?? '' })
    const graphStyles = window.getComputedStyle(root)
    const graphColors = Object.fromEntries(Object.entries(GRAPH_COLOR_PROPERTIES).map(([key, property]) => [key, graphStyles.getPropertyValue(property).trim()]))
    const portGroup = (magnet) => ({ position: 'absolute', attrs: { circle: { r: 6, magnet, stroke: graphColors.accent, strokeWidth: 2, fill: graphColors.portFill } } })
    const PORT_GROUPS = { in: portGroup('passive'), out: portGroup(true) }

    /** 视觉层不接收指针；独立宽命中路径负责选择，光点引用实际连线几何。 */
    function createFlowEdge({ temporary = false, description = '选择连线', ...metadata } = {}) {
      const edge = new X6.Shape.Edge({ ...metadata, labels: [], router: 'normal', connector: { name: 'smooth' }, zIndex: temporary ? 10 : 0, data: { wf: !temporary } })
      const pathId = `wf-edge-path-${edge.id}`
      const markup = temporary ? [] : [
        { tagName: 'path', selector: 'halo', className: 'wf-edge-halo' },
        { tagName: 'path', selector: 'glow', className: 'wf-edge-glow' },
      ]
      markup.push({ tagName: 'path', selector: 'line', className: temporary ? 'wf-edge-line wf-edge-line--preview' : 'wf-edge-line' })
      if (!temporary) {
        for (let index = 0; index < EDGE_EFFECT.particles; index += 1) {
          markup.push({ tagName: 'g', className: 'wf-edge-flow', attrs: { pointerEvents: 'none', 'aria-hidden': 'true' }, style: { offsetPath: `url("#${pathId}")`, animationDuration: `${EDGE_EFFECT.duration}s`, animationDelay: `${-index * EDGE_EFFECT.duration / EDGE_EFFECT.particles}s` }, children: [
            { tagName: 'ellipse', className: 'wf-edge-flow-halo', attrs: { cx: -6, cy: 0, rx: 14, ry: 4 } },
            { tagName: 'ellipse', className: 'wf-edge-flow-trail', attrs: { cx: -6, cy: 0, rx: 9, ry: 1.8 } },
            { tagName: 'circle', className: 'wf-edge-flow-core', attrs: { r: 2.2 } },
          ] })
        }
      }
      markup.push({ tagName: 'path', selector: 'wrap', className: 'wf-edge-hit' })
      edge.setMarkup(markup)
      edge.setAttrs({
        line: { id: pathId, connection: true, fill: 'none', stroke: graphColors.edge, strokeWidth: 1.8, strokeLinecap: 'round', sourceMarker: null, targetMarker: null, pointerEvents: 'none', vectorEffect: 'non-scaling-stroke' },
        wrap: { connection: true, fill: 'none', stroke: 'transparent', strokeWidth: EDGE_EFFECT.hitWidth, strokeLinecap: 'round', pointerEvents: temporary ? 'none' : 'stroke', vectorEffect: 'non-scaling-stroke', cursor: 'pointer', tabindex: temporary ? -1 : 0, role: 'button', 'aria-label': description, 'aria-pressed': 'false', 'aria-hidden': String(temporary) },
        ...(temporary ? {} : {
          halo: { connection: true, fill: 'none', stroke: graphColors.accent, pointerEvents: 'none', vectorEffect: 'non-scaling-stroke' },
          glow: { connection: true, fill: 'none', stroke: graphColors.accent, pointerEvents: 'none', vectorEffect: 'non-scaling-stroke' },
        }),
      })
      return edge
    }

    const graph = new X6.Graph({
      container: refs.graph,
      width: 1,
      height: 1,
      async: false,
      grid: { size: LAYOUT.grid, visible: true, type: 'dot', args: { color: graphColors.grid, thickness: 1 } },
      scaling: { min: LAYOUT.minZoom, max: LAYOUT.maxZoom },
      panning: { enabled: true, eventTypes: ['rightMouseDown', 'mouseWheelDown'] },
      mousewheel: { enabled: true, modifiers: ['ctrl', 'meta'], factor: 1.1, maxScale: LAYOUT.maxZoom, zoomAtMousePosition: true, guard: (event) => event.deltaY !== 0 },
      // 节点只能从左上角类型标签拖动和选择，其余内容交给浏览器原生文本选择与复制
      guard: (event) => event.target instanceof Element && (Boolean(event.target.closest(INTERACTIVE_SELECTOR))
        || (Boolean(event.target.closest('.wf-node, .wf-region-label')) && !event.target.closest('.wf-node__kind'))),
      interacting: () => ({
        nodeMovable: !ui.locked, magnetConnectable: !ui.locked, edgeMovable: false, edgeLabelMovable: false,
        arrowheadMovable: false, vertexMovable: false, vertexAddable: false, vertexDeletable: false, useEdgeTools: false,
      }),
      highlighting: { magnetAvailable: { name: 'className', args: { className: 'wf-magnet-available' } } },
      connecting: {
        snap: { radius: 28 },
        allowBlank: false,
        allowNode: false,
        allowEdge: false,
        allowPort: true,
        allowMulti: true,
        highlight: true,
        anchor: 'center',
        connectionPoint: 'anchor',
        router: 'normal',
        connector: { name: 'smooth' },
        createEdge: () => createFlowEdge({ temporary: true }),
        validateMagnet: () => !ui.locked,
        validateConnection({ sourceCell, targetCell, sourcePort, targetPort }) {
          if (!sourceCell || !targetCell || !sourcePort || !targetPort) return false
          if (!sourcePort.startsWith(PORT_PREFIX.out) || !targetPort.startsWith(PORT_PREFIX.in)) return false
          const error = Core.validateConnection(currentDocument(), registry, {
            source: { nodeId: sourceCell.id, port: sourcePort.slice(PORT_PREFIX.out.length) },
            target: { nodeId: targetCell.id, port: targetPort.slice(PORT_PREFIX.in.length) },
          })
          setHint(error ? `无法连接：${error}` : '')
          return !error
        },
      },
    })
    /** 节点仅由类型标签显式选择，连线保留 X6 的鼠标选择行为。 */
    class WorkflowSelection extends X6.Selection {
      onCellMouseUp(args) {
        if (args.cell.isEdge()) super.onCellMouseUp(args)
      }
    }
    const selection = new WorkflowSelection({
      enabled: true, multiple: true, rubberband: true, rubberEdge: true, movable: true,
      showNodeSelectionBox: false, showEdgeSelectionBox: false,
      eventTypes: ['leftMouseDown'], multipleSelectionModifiers: ['ctrl', 'meta'],
    })
    /** 缩放手柄的尺寸上限随节点类型变化：区域可比普通节点大得多。 */
    const resizeLimit = (node) => {
      const flowNode = currentDocument().nodes.find((item) => item.id === node.id)
      return Core.maxSizeOf(flowNode && registry.get(flowNode.type, flowNode.version))
    }
    const transform = new X6.Transform({
      rotating: false,
      resizing: {
        enabled: () => !ui.locked, orthogonal: true, restrict: false, preserveAspectRatio: false,
        minWidth: Core.LIMITS.minSize, minHeight: Core.LIMITS.minSize, maxWidth: resizeLimit, maxHeight: resizeLimit,
      },
    })
    graph.use(selection).use(transform)
    // 区域名称图层：叠在画布 SVG 之上，图层本身不接收指针，只有标签可操作
    const annotationLayer = createElement('div', 'wf-annotation-layer')
    refs.graph.append(annotationLayer)
    // 区域常覆盖成片节点：框选只在完整包含区域时选中它，避免框选区域内的节点时连同区域一起拖动
    const selectionArea = selection.selectionImpl.getCellViewsInArea.bind(selection.selectionImpl)
    selection.selectionImpl.getCellViewsInArea = (rect) => selectionArea(rect).filter((view) => !nodeViews.get(view.cell.id)?.host.classList.contains('wf-node--annotation') || rect.containsRect(view.cell.getBBox()))

    listen(refs.stage, 'wheel', (event) => {
      event.stopPropagation()
      if (event.ctrlKey || event.metaKey || !canScrollInside(event.target, refs.stage, event)) event.preventDefault()
    }, { passive: false })

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    function syncEdgeMotion() {
      const paused = root.hidden || document.hidden || motionPreference.matches
      root.classList.toggle('wf-edge-motion-paused', paused)
    }
    listen(motionPreference, 'change', syncEdgeMotion)
    listen(document, 'visibilitychange', syncEdgeMotion)
    const motionVisibilityObserver = new MutationObserver(syncEdgeMotion)
    motionVisibilityObserver.observe(root, { attributes: true, attributeFilter: ['hidden'] })
    syncEdgeMotion()

    /** 程序化修改 X6 时屏蔽事件回写，避免文档与画布互相触发。 */
    function withoutEcho(action) {
      const previous = ui.syncing
      ui.syncing = true
      try { return action() } finally { ui.syncing = previous }
    }

    function addEdgeToGraph(edge, flow) {
      const sourceName = flow.nodes.find((node) => node.id === edge.source.nodeId).name
      const targetName = flow.nodes.find((node) => node.id === edge.target.nodeId).name
      graph.addEdge(createFlowEdge({
        id: edge.id,
        source: { cell: edge.source.nodeId, port: PORT_PREFIX.out + edge.source.port },
        target: { cell: edge.target.nodeId, port: PORT_PREFIX.in + edge.target.port },
        description: `选择 ${sourceName} 到 ${targetName} 的连线`,
      }))
    }

    function addNodeToGraph(node, flow) {
      const view = createNodeView(node, flow)
      nodeViews.set(node.id, view)
      hosts.set(node.id, view.host)
      const definition = registry.get(node.type, node.version)
      const { inputs, outputs } = portsOf(node, definition, flow)
      graph.addNode({
        id: node.id,
        shape: LAYOUT.shape,
        zIndex: definition?.execution === Core.NODE_EXECUTION.annotation ? LAYER.annotation : LAYER.node, // 区域盖在连线上方、节点下方
        x: node.position.x,
        y: node.position.y,
        width: node.size.width,
        height: node.size.height,
        ports: { groups: PORT_GROUPS, items: portItems(inputs, outputs) },
      })
    }

    function removeNodeFromGraph(id) {
      graph.removeNode(id)
      nodeViews.get(id)?.destroy()
      nodeViews.delete(id)
      hosts.delete(id)
    }

    /** 按文档增删 patch 画布；已存在的节点 DOM 保持不变，因此输入焦点和滚动不会丢失。 */
    function syncGraph() {
      const flow = currentDocument()
      withoutEcho(() => {
        const nodeIds = new Set(flow.nodes.map((node) => node.id))
        const edgeIds = new Set(flow.edges.map((edge) => edge.id))
        for (const edge of graph.getEdges()) if (edge.getData()?.wf && !edgeIds.has(edge.id)) graph.removeEdge(edge.id)
        for (const id of nodeViews.keys()) if (!nodeIds.has(id)) removeNodeFromGraph(id)
        for (const node of flow.nodes) {
          let cell = graph.getCellById(node.id)
          if (cell && nodeViews.get(node.id)?.key !== `${node.type}@${node.version}`) {
            removeNodeFromGraph(node.id) // 版本升级后端口与视图可能变化，整体重建
            cell = null
          }
          if (!cell) {
            addNodeToGraph(node, flow)
            continue
          }
          const { x, y } = cell.getPosition()
          const { width, height } = cell.getSize()
          if (x !== node.position.x || y !== node.position.y) cell.setPosition(node.position.x, node.position.y)
          if (width !== node.size.width || height !== node.size.height) cell.resize(node.size.width, node.size.height)
        }
        for (const edge of flow.edges) if (!graph.getCellById(edge.id)) addEdgeToGraph(edge, flow)
      })
      placeRegionLabels()
    }

    function applyViewport(viewport) {
      withoutEcho(() => {
        graph.scale(viewport.zoom, viewport.zoom)
        graph.translate(viewport.x, viewport.y)
      })
    }

    /** 切换流程时重建画布，运行状态仍由工作区按流程保留。 */
    function showDocument(id) {
      showError('')
      flushViewport()
      transform.clearWidgets()
      ui.docId = id
      withoutEcho(() => {
        for (const nodeId of nodeViews.keys()) {
          nodeViews.get(nodeId).destroy()
          nodeViews.delete(nodeId)
          hosts.delete(nodeId)
        }
        graph.clearCells()
      })
      syncGraph()
      applyViewport(currentDocument().viewport)
      refreshNodes()
    }

    /** 把最新文档与运行快照推送给节点视图；渲染器内部自行比较，避免无谓重绘。 */
    function refreshNodes(nodeIds) {
      const flow = currentDocument()
      const runtime = workspace.getRuntime(ui.docId)
      if (runtime.running && !ui.locked) transform.clearWidgets() // 运行开始后收起缩放手柄
      ui.locked = runtime.running
      for (const node of flow.nodes) {
        if (nodeIds && !nodeIds.includes(node.id)) continue
        nodeViews.get(node.id)?.update(node, runtime.states.get(node.id) ?? IDLE_STATE, runtime.running)
      }
    }

    /* ---------------- 视口 ---------------- */

    /** 提交当前视口；文件保存要求提交失败时中止写入。 */
    function flushViewport(strict = false) {
      window.clearTimeout(viewportTimer)
      viewportTimer = null
      if (!viewportDirty || !ui.docId) return
      viewportDirty = false
      const { tx, ty } = graph.translate()
      if (!workspace.documents.some((item) => item.id === ui.docId)) return
      try {
        workspace.setViewport({ x: clampCoordinate(tx), y: clampCoordinate(ty), zoom: Math.min(LAYOUT.maxZoom, graph.zoom()) }, ui.docId)
      } catch (error) {
        viewportDirty = true
        if (strict) throw error
        showError(messageOf(error))
      }
    }

    function onViewportChanged() {
      if (ui.syncing) return
      viewportDirty = true
      window.clearTimeout(viewportTimer)
      viewportTimer = window.setTimeout(flushViewport, VIEWPORT_SAVE_MS)
    }
    graph.on('translate', onViewportChanged)
    graph.on('scale', onViewportChanged)
    /**
     * 把区域名称标签贴到各区域方框左上角外侧（屏幕坐标）。标签在画布之上，缩小画布时保持原屏幕尺寸，
     * 放大画布时随之放大；视口变化、区域移动或缩放时重新定位。
     */
    function placeRegionLabels() {
      const scale = Math.max(1, graph.zoom())
      for (const [id, view] of nodeViews) {
        const cell = view.label && graph.getCellById(id)
        if (!cell) continue
        const { x, y } = graph.localToGraph(cell.getPosition())
        view.label.style.transform = `translate(${x}px, ${y}px) translateY(-100%) scale(${scale})`
      }
    }
    for (const event of ['scale', 'translate', 'resize', 'node:change:position', 'node:change:size']) graph.on(event, placeRegionLabels)

    let ctrlPan = null
    let suppressPanClick = false
    let panClickTimer = null
    function finishCtrlPan() {
      if (!ctrlPan) return
      ctrlPan = null
      root.classList.remove('wf-panning')
      window.clearTimeout(panClickTimer)
      panClickTimer = window.setTimeout(() => { suppressPanClick = false }, 0)
      flushViewport()
    }
    // 仅接管空白处 Ctrl 左键，避免与 X6 框选、节点拖动及输入控件争用事件。
    listen(refs.graph, 'mousedown', (event) => {
      if (event.button !== 0 || !event.ctrlKey || !(event.target instanceof Element)
        || event.target.closest(`.x6-cell, .wf-region-label, .x6-widget-transform, .x6-widget-selection-box, ${INTERACTIVE_SELECTOR}`)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      window.clearTimeout(panClickTimer)
      ctrlPan = { x: event.clientX, y: event.clientY }
      suppressPanClick = true
      root.classList.add('wf-panning')
      refs.stage.focus({ preventScroll: true })
    }, true)
    listen(window, 'mousemove', (event) => {
      if (!ctrlPan) return
      if (!event.buttons) { finishCtrlPan(); return }
      event.preventDefault()
      graph.translateBy(event.clientX - ctrlPan.x, event.clientY - ctrlPan.y)
      ctrlPan = { x: event.clientX, y: event.clientY }
    }, true)
    listen(window, 'mouseup', finishCtrlPan, true)
    listen(window, 'blur', finishCtrlPan)
    listen(refs.graph, 'click', (event) => {
      if (!suppressPanClick) return
      event.preventDefault()
      event.stopImmediatePropagation()
      suppressPanClick = false
    }, true)

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width < 1 || height < 1) return
      graph.resize(Math.round(width), Math.round(height))
      if (!ui.sized) {
        ui.sized = true // 隐藏片段首次可见后恢复保存的视口
        applyViewport(currentDocument().viewport)
      }
    })
    observer.observe(refs.stage)

    /* ---------------- 选择与编辑命令 ---------------- */

    function selectedIds() {
      const cells = graph.getSelectedCells()
      return { nodeIds: cells.filter((cell) => cell.isNode()).map((cell) => cell.id), edgeIds: cells.filter((cell) => cell.isEdge()).map((cell) => cell.id) }
    }

    /** 显式选择对象；普通激活已选对象时保持多选不变。 */
    function selectCell(id, additive) {
      if (additive) {
        if (graph.isSelected(id)) graph.unselect(id)
        else graph.select(id)
      } else if (!graph.isSelected(id)) graph.resetSelection(id)
    }

    function deleteSelected() {
      const { nodeIds, edgeIds } = selectedIds()
      if (!nodeIds.length && !edgeIds.length) return
      command(() => workspace.deleteSelection({ nodeIds, edgeIds }, ui.docId))
    }

    function copySelected() {
      const { nodeIds } = selectedIds()
      if (!nodeIds.length) return
      const copies = command(() => workspace.copySelection(nodeIds, ui.docId))
      if (copies?.length) {
        graph.resetSelection(copies.map((node) => node.id))
        setHint(`已复制 ${copies.length} 个节点及其内部连线。`)
      }
    }

    graph.on('node:click', ({ node, e }) => {
      if (e.target instanceof Element && e.target.closest('.wf-node__kind')) selectCell(node.id, e.ctrlKey || e.metaKey)
    })
    graph.on('selection:changed', () => {
      const { nodeIds, edgeIds } = selectedIds()
      transform.clearWidgets()
      if (nodeIds.length === 1 && !edgeIds.length && !ui.locked) transform.createWidget(graph.getCellById(nodeIds[0]))
      for (const [id, view] of nodeViews) (view.label ?? view.host).querySelector('.wf-node__kind').setAttribute('aria-pressed', String(graph.isSelected(id))) // 区域的类型字样在名称图层中
      for (const edge of graph.getEdges()) {
        if (!edge.getData()?.wf) continue
        const selected = String(graph.isSelected(edge.id))
        if (edge.attr('wrap/aria-pressed') !== selected) edge.attr('wrap/aria-pressed', selected)
      }
      // 选中远程节点时高亮开始节点里该节点所用的凭据组
      const groups = new Set(nodeIds.map((id) => nodeViews.get(id)?.host.dataset.credentialGroup).filter(Boolean))
      for (const field of refs.graph.querySelectorAll('.wf-cap__field[data-credential-group]')) field.classList.toggle('wf-cap__field--linked', groups.has(field.dataset.credentialGroup))
      updateToolbar()
    })
    /** 聚焦开始节点的凭据字段时高亮使用该凭据组的节点，离开字段后取消。 */
    function linkCredentialNodes(group) {
      for (const view of nodeViews.values()) view.host.classList.toggle('wf-node--credential-linked', Boolean(group) && view.host.dataset.credentialGroup === group)
    }
    listen(refs.graph, 'focusin', (event) => linkCredentialNodes(event.target.closest?.('.wf-cap__field[data-credential-group]')?.dataset.credentialGroup))
    listen(refs.graph, 'focusout', (event) => {
      if (!event.relatedTarget?.closest?.('.wf-cap__field[data-credential-group]')) linkCredentialNodes(null)
    })
    // 鼠标聚焦不能抢在 Selection 的 mouseup 前改选中状态，否则 Ctrl 点击会双重切换。
    let edgePointerFocus = false
    listen(refs.graph, 'mousedown', () => { edgePointerFocus = true }, true)
    listen(document, 'keydown', () => { edgePointerFocus = false }, true)
    listen(refs.graph, 'focusin', (event) => {
      if (edgePointerFocus || !(event.target instanceof Element) || !event.target.classList.contains('wf-edge-hit')) return
      const id = event.target.closest('.x6-edge')?.getAttribute('data-cell-id')
      if (id && graph.getCellById(id)?.isEdge()) selectCell(id, false)
    })

    graph.on('node:moved', () => {
      if (ui.syncing) return
      if (ui.locked) {
        syncGraph() // 运行期间不接受位置变化，恢复为文档位置
        return
      }
      ui.committingLayout = true
      try {
        const updates = []
        for (const node of currentDocument().nodes) {
          const cell = graph.getCellById(node.id)
          if (!cell) continue
          const position = { x: clampCoordinate(cell.getPosition().x), y: clampCoordinate(cell.getPosition().y) }
          if (position.x !== node.position.x || position.y !== node.position.y) updates.push({ id: node.id, position })
        }
        if (updates.length) command(() => workspace.updateLayout(updates, ui.docId))
      } finally {
        ui.committingLayout = false
        syncGraph() // 回写失败或被取整时以文档为准
      }
    })

    graph.on('node:resized', ({ node: cell }) => {
      if (ui.syncing) return
      if (ui.locked) {
        syncGraph()
        return
      }
      const { x, y } = cell.getPosition()
      const { width, height } = cell.getSize()
      ui.committingLayout = true
      try {
        command(() => workspace.updateNode(cell.id, { position: { x: clampCoordinate(x), y: clampCoordinate(y) }, size: { width: Math.round(width), height: Math.round(height) } }, ui.docId))
      } finally {
        ui.committingLayout = false
        syncGraph()
      }
    })

    graph.on('edge:connected', ({ edge, isNew }) => {
      if (!isNew || edge.getData()?.wf) return
      const source = edge.getSource()
      const target = edge.getTarget()
      window.setTimeout(() => {
        withoutEcho(() => graph.removeEdge(edge.id)) // 临时拖拽线由文档中的正式连线取代
        if (!source.port || !target.port || !target.cell) return
        const connected = command(() => workspace.connect({
          source: { nodeId: source.cell, port: source.port.slice(PORT_PREFIX.out.length) },
          target: { nodeId: target.cell, port: target.port.slice(PORT_PREFIX.in.length) },
        }, ui.docId))
        if (connected) setHint('已创建连线。')
      }, 0)
    })

    /* ---------------- 节点库 ---------------- */

    function nodeCenterPosition(definition) {
      const rect = refs.stage.getBoundingClientRect()
      const center = graph.clientToLocal(rect.left + rect.width / 2, rect.top + rect.height / 2)
      const offset = (paletteCount % 6) * LAYOUT.grid
      paletteCount += 1
      return { x: clampCoordinate(snap(center.x - definition.size.width / 2 + offset)), y: clampCoordinate(snap(center.y - definition.size.height / 2 + offset)) }
    }

    function addNodeFromPalette(type, position) {
      const node = command(() => workspace.addNode(type, position))
      if (node) {
        graph.resetSelection(node.id)
        setHint(`已添加节点“${node.name}”。`)
      }
    }

    function renderPaletteItem(definition) {
      const item = createButton('wf-palette__item')
      item.draggable = !ui.locked
      item.disabled = ui.locked
      item.dataset.type = definition.type
      item.append(createElement('span', 'wf-palette__name', definition.label))
      item.addEventListener('click', () => addNodeFromPalette(definition.type, nodeCenterPosition(definition)))
      item.addEventListener('dragstart', (event) => {
        if (ui.locked) { event.preventDefault(); return }
        event.dataTransfer.setData(PALETTE_MIME, definition.type)
        event.dataTransfer.effectAllowed = 'copy'
      })
      return item
    }

    /** 搜索临时展开匹配路径，不覆盖用户原来的目录折叠状态。 */
    function renderPaletteFolder(folder, searching) {
      const details = createElement('details', 'wf-folder')
      details.dataset.folderPath = folder.path
      details.open = searching || (folderExpanded.get(folder.path) ?? true)
      const summary = createElement('summary', 'wf-folder__summary')
      summary.append(createPaletteIcon('chevron'), createPaletteIcon('folder'), createElement('span', 'wf-folder__name', folder.name))
      const contents = createElement('div', 'wf-folder__content')
      for (const child of folder.folders) contents.append(renderPaletteFolder(child, searching))
      for (const definition of folder.items) contents.append(renderPaletteItem(definition))
      details.append(summary, contents)
      details.addEventListener('toggle', () => {
        if (!searching && details.isConnected) folderExpanded.set(folder.path, details.open)
      })
      return details
    }

    /** 搜索只改变节点树，临时展开根目录并在清空后恢复折叠状态。 */
    function buildPalette() {
      const definitions = registry.list()
      const query = refs['palette-search'].value.trim()
      const searching = Boolean(query)
      if (searching && !paletteSearching) paletteRootWasOpen = refs['palette-folder'].open
      if (searching) refs['palette-folder'].open = true
      else if (paletteSearching) refs['palette-folder'].open = paletteRootWasOpen
      paletteSearching = searching
      const tree = window.NestCloudWorkflowPalette.createPaletteTree(definitions, query)
      const fragment = document.createDocumentFragment()
      for (const folder of tree.folders) fragment.append(renderPaletteFolder(folder, searching))
      refs.palette.replaceChildren(fragment)
    }
    listen(refs['palette-search'], 'input', buildPalette)
    listen(refs['palette-search'], 'keydown', (event) => {
      if (event.key !== 'Escape' || !refs['palette-search'].value) return
      event.preventDefault()
      refs['palette-search'].value = ''
      buildPalette()
    })
    buildPalette()

    listen(refs.stage, 'dragover', (event) => {
      if (ui.locked || !event.dataTransfer?.types.includes(PALETTE_MIME)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    })
    listen(refs.stage, 'drop', (event) => {
      const type = event.dataTransfer?.getData(PALETTE_MIME)
      if (!type || ui.locked) return
      event.preventDefault()
      const definition = registry.list().find((item) => item.type === type)
      if (!definition) return
      const point = graph.clientToLocal(event.clientX, event.clientY)
      addNodeFromPalette(type, { x: clampCoordinate(snap(point.x - definition.size.width / 2)), y: clampCoordinate(snap(point.y - LAYOUT.headHeight / 2)) })
    })

    /** 样例包含一个开始节点、被动文本、对比与结果，不自动运行。 */
    function loadTemplate(kind) {
      const sample = SAMPLES[kind]
      const sizeOf = (type) => registry.list().find((definition) => definition.type === type).size
      const textSize = sizeOf('text')
      const compareSize = sizeOf(`${kind}-compare`)
      const startSize = sizeOf('start')
      const gap = 80
      const textY = 40 + startSize.height + gap
      command(() => {
        const compareX = 40 + textSize.width + gap
        const specs = [
          { id: 'a', type: 'text', name: `${sample.label} A（原始）`, position: { x: 40, y: textY }, config: { text: sample.left } },
          { id: 'b', type: 'text', name: `${sample.label} B（新版）`, position: { x: 40, y: textY + textSize.height + 40 }, config: { text: sample.right } },
          { id: 'compare', type: `${kind}-compare`, position: { x: compareX, y: 40 } },
          { id: 'result', type: 'diff-result', position: { x: compareX + compareSize.width + gap, y: 40 } },
          { id: 'start', type: 'start', position: { x: 40, y: 40 } },
        ]
        const nodes = specs.map((spec) => {
          const definition = registry.list().find((item) => item.type === spec.type)
          return { ...spec, version: definition.version, size: definition.size, name: spec.name ?? definition.label, config: spec.config ?? definition.defaults }
        })
        workspace.insertSubgraph({ nodes, edges: [
          { id: 'a-compare', source: { nodeId: 'a', port: 'text' }, target: { nodeId: 'compare', port: 'a' } },
          { id: 'b-compare', source: { nodeId: 'b', port: 'text' }, target: { nodeId: 'compare', port: 'b' } },
          { id: 'compare-result', source: { nodeId: 'compare', port: 'diff' }, target: { nodeId: 'result', port: 'diff' } },
          { id: 'start-compare', source: { nodeId: 'start', port: 'trigger' }, target: { nodeId: 'compare', port: 'trigger' } },
        ] })
        setHint(`已载入 ${sample.label} 对比样例，点击“运行”查看差异。`)
        window.requestAnimationFrame(fitView)
      })
    }

    /** 周报仅是原子能力的组合，提示词可编辑，默认不包含任何发布步骤。 */
    function loadWeeklyTemplate() {
      command(() => {
        const definitions = new Map(registry.list().map((definition) => [definition.type, definition]))
        const sizeOf = (type) => definitions.get(type).size
        const gap = 80
        const sourceX = 40
        const githubX = sourceX + Math.max(sizeOf('start').width, sizeOf('date-range').width) + gap
        const mergeX = githubX + sizeOf('github-commits').width + gap
        const promptX = mergeX + sizeOf('json-merge').width + gap
        const aiX = promptX + sizeOf('text-template').width + gap
        const outputX = aiX + sizeOf('ai-text').width + gap
        const template = [
          '请根据以下 GitHub 提交生成中文工作周报。',
          '周期：{{context.周报时间范围.startDate}} 至 {{context.周报时间范围.endDate}}。',
          '', '提交数据：', '{{context.提交记录}}', '',
          '要求：只根据真实提交总结，不编造工作事项；合并同类内容但不遗漏独立事项。',
          '按完成事项、改进和问题组织，输出 Markdown；没有可用提交时明确说明。',
        ].join('\n')
        // JSON 合并以上游节点名称为键，模板按“周报时间范围”“提交记录”引用，改名时需同步修改模板
        const specs = [
          { id: 'start', type: 'start', position: { x: sourceX, y: 40 } },
          { id: 'range', type: 'date-range', name: '周报时间范围', position: { x: sourceX, y: 40 + sizeOf('start').height + gap } },
          { id: 'github', type: 'github-commits', name: '提交记录', position: { x: githubX, y: 40 } },
          { id: 'merge', type: 'json-merge', name: '组合提交记录与周报时间范围', position: { x: mergeX, y: 40 }, config: { mode: 'object' } },
          { id: 'prompt', type: 'text-template', name: '周报提示词模板（可替换）', position: { x: promptX, y: 40 }, config: { template } },
          { id: 'ai', type: 'ai-text', name: 'AI 文本生成', position: { x: aiX, y: 40 } },
          { id: 'output', type: 'text-result', name: '周报 Markdown', position: { x: outputX, y: 40 }, config: { format: 'markdown' } },
        ]
        const nodes = specs.map((spec) => {
          const definition = definitions.get(spec.type)
          return { ...spec, version: definition.version, size: definition.size, name: spec.name ?? definition.label, config: spec.config ?? definition.defaults }
        })
        workspace.insertSubgraph({ nodes, edges: [
          { id: 'start-github', source: { nodeId: 'start', port: 'trigger' }, target: { nodeId: 'github', port: 'trigger' } },
          { id: 'range-github', source: { nodeId: 'range', port: 'range' }, target: { nodeId: 'github', port: 'range' } },
          { id: 'github-merge', source: { nodeId: 'github', port: 'data' }, target: { nodeId: 'merge', port: 'items' } },
          { id: 'range-merge', source: { nodeId: 'range', port: 'range' }, target: { nodeId: 'merge', port: 'items' } },
          { id: 'merge-prompt', source: { nodeId: 'merge', port: 'data' }, target: { nodeId: 'prompt', port: 'context' } },
          { id: 'prompt-ai', source: { nodeId: 'prompt', port: 'text' }, target: { nodeId: 'ai', port: 'prompt' } },
          { id: 'ai-output', source: { nodeId: 'ai', port: 'text' }, target: { nodeId: 'output', port: 'text' } },
        ] })
        setHint('已载入独立能力组成的周报样例。请在“提交记录”节点填写仓库和人员，并在 Token 配置填写 GitHub 与 AI 凭据；运行时提交数据会发给所配置的 AI。样例不发布飞书。')
        window.requestAnimationFrame(fitView)
      })
    }

    /* ---------------- 视图控制 ---------------- */

    function fitView() {
      if (!currentDocument().nodes.length) return
      graph.zoomToFit({ padding: 48, maxScale: 1 })
    }

    /* ---------------- 工具栏 ---------------- */

    const directory = new window.NestCloudWorkflowDirectory.ProjectDirectoryService({ maxBytes: Core.LIMITS.documentBytes })
    const files = new window.NestCloudWorkflowFiles.WorkflowFileService({
      workspace,
      directory,
      storage,
      confirmOverwrite: (filename) => window.confirm(`“${filename}”已存在，确定用当前流程覆盖吗？此操作无法撤销。`),
    })
    const sidebar = window.NestCloudWorkflowDirectory.mount({
      root,
      refs,
      host: document.querySelector('#workflow-sidebar-host'),
      client: directory,
      maxBytes: Core.LIMITS.documentBytes,
      importDocument: (_text, file) => {
        flushInputs()
        files.open(file)
        updateToolbar()
      },
    })
    let toolbarDocumentId = null
    /** 更新名称与运行锁；文件关联错误和草稿存储错误均明确呈现。 */
    function updateToolbar() {
      const flow = currentDocument()
      const runtime = workspace.getRuntime(ui.docId)
      const running = runtime.running
      if (toolbarDocumentId !== ui.docId || window.document.activeElement !== refs['doc-name']) refs['doc-name'].value = flow.name
      toolbarDocumentId = ui.docId
      refs['doc-name'].readOnly = running
      refs.run.disabled = running || !flow.nodes.length
      refs.stop.disabled = !running
      refs['template-json'].disabled = running
      refs['template-env'].disabled = running
      refs['template-weekly'].disabled = running
      refs['add-region'].disabled = running
      refs.palette.querySelectorAll('.wf-palette__item').forEach((button) => {
        button.disabled = running
        button.draggable = !running
      })
      refs.empty.hidden = flow.nodes.length > 0
      root.classList.toggle('wf-locked', running)
      showStorage(workspace.storageError || files.storageError)

      const states = [...runtime.states.values()]
      const count = (status) => states.filter((state) => state.status === status).length
      const duration = runtime.finishedAt && runtime.startedAt ? `，用时 ${((runtime.finishedAt - runtime.startedAt) / 1000).toFixed(1)} 秒` : ''
      if (running) refs['run-status'].textContent = '运行中，画布已锁定编辑，可平移缩放和查看结果'
      else if (runtime.status === 'idle') refs['run-status'].textContent = RUN_STATUS_LABELS.idle
      else refs['run-status'].textContent = `${RUN_STATUS_LABELS[runtime.status]}：成功 ${count('succeeded')}，失败 ${count('failed')}，跳过 ${count('skipped')}${duration}`
      refs['run-status'].dataset.status = runtime.status
    }

    listen(refs['doc-name'], 'change', () => {
      const ok = command(() => currentDocument())
      if (!ok) refs['doc-name'].value = currentDocument().name
    })
    listen(refs['doc-name'], 'keydown', (event) => { if (event.key === 'Enter') refs['doc-name'].blur() })
    listen(refs['doc-create'], 'click', () => command(() => workspace.create()))
    listen(refs['doc-import'], 'click', () => refs['import-file'].click())
    listen(refs['import-file'], 'change', async () => {
      const file = refs['import-file'].files?.[0]
      refs['import-file'].value = ''
      if (!file) return
      showError('')
      if (file.size > Core.LIMITS.documentBytes) {
        showError('工作流文件超过 4 MiB 限制，未导入，当前流程未被修改。')
        return
      }
      try {
        const text = await file.text()
        if (destroyed) return
        flushInputs()
        workspace.importDocument(text, { preserveName: true })
        setHint('已导入为新流程。')
      } catch (error) {
        showError(`导入失败：${messageOf(error)}未创建新流程。`)
      }
    })
    listen(refs['doc-export'], 'click', () => command(() => {
      downloadText(window.NestCloudWorkflowDirectory.filenameOf(currentDocument().name), workspace.exportDocument(ui.docId), 'application/json')
      setHint('已导出 JSON，文件包含输入的原文，请妥善保管。')
    }))
    listen(refs.run, 'click', async () => {
      showError('')
      try {
        flushInputs()
        await workspace.run(ui.docId)
      } catch (error) {
        showError(messageOf(error, '运行失败，请重试。'))
      }
    })
    listen(refs.stop, 'click', () => command(() => workspace.stop(ui.docId)))
    listen(refs['template-json'], 'click', () => loadTemplate('json'))
    listen(refs['template-env'], 'click', () => loadTemplate('env'))
    listen(refs['template-weekly'], 'click', loadWeeklyTemplate)
    listen(refs['add-region'], 'click', () => addNodeFromPalette('region', nodeCenterPosition(registry.list().find((item) => item.type === 'region'))))

    /** 固定当前文档快照并保存项目文件，输入或视口校验失败时不发请求。 */
    async function saveCurrentDocument() {
      showError('')
      let savingName = ''
      try {
        flushInputs()
        flushViewport(true)
        const flow = currentDocument()
        savingName = flow.name
        const saved = await files.save({ id: flow.id, name: flow.name, text: workspace.exportDocument(flow.id) })
        if (!saved || destroyed) return
        if (!root.hidden) setHint(`已保存“${saved.filename}”。`)
        await sidebar.refreshDirectory()
        if (!destroyed) updateToolbar()
      } catch (error) {
        if (!destroyed) showError(`${savingName ? `保存“${savingName}”失败：` : ''}${messageOf(error, '文件保存失败，请重试。')}`)
      }
    }

    /* ---------------- 键盘 ---------------- */

    listen(document, 'keydown', (event) => {
      if (destroyed || root.hidden || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (!event.repeat && !event.isComposing) void saveCurrentDocument()
    }, true)

    listen(refs.stage, 'pointerdown', (event) => {
      if (event.target instanceof Element && !event.target.closest(INTERACTIVE_SELECTOR)) refs.stage.focus({ preventScroll: true })
    })
    listen(refs.stage, 'keydown', (event) => {
      if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if ((key === 'enter' || key === ' ') && event.target instanceof Element && event.target.classList.contains('wf-edge-hit')) {
        const id = event.target.closest('.x6-edge')?.getAttribute('data-cell-id')
        if (id && graph.getCellById(id)?.isEdge()) selectCell(id, modifier)
        event.preventDefault()
        return
      }
      let handled = true
      if (key === 'delete' || key === 'backspace') { if (!ui.locked) deleteSelected() }
      else if (modifier && key === 'z') {
        if (event.shiftKey ? workspace.canRedo(ui.docId) : workspace.canUndo(ui.docId)) command(() => (event.shiftKey ? workspace.redo(ui.docId) : workspace.undo(ui.docId)))
      } else if (modifier && key === 'y') { if (workspace.canRedo(ui.docId)) command(() => workspace.redo(ui.docId)) }
      else if (modifier && key === 'd') { if (!ui.locked) copySelected() }
      else if (modifier && key === 'a') graph.resetSelection(graph.getCells())
      else if (key === 'escape') graph.cleanSelection()
      else handled = key.startsWith('arrow')
      if (handled) event.preventDefault()
    })

    /* ---------------- 工作区事件 ---------------- */

    const unsubscribe = workspace.subscribe((documentId, event) => {
      if (event.kind === 'viewport') return
      if (event.message) setHint(event.message)
      if (workspace.activeId !== ui.docId) showDocument(workspace.activeId) // 切换、新建、导入或删除后的当前流程
      else if (documentId === ui.docId) {
        if (event.kind === 'structure' || (event.kind === 'layout' && !ui.committingLayout)) syncGraph()
        refreshNodes(event.kind === 'runtime' ? event.nodeIds : undefined)
      }
      updateToolbar()
    })

    listen(window, 'pagehide', () => {
      try { flushInputs() } catch (error) { showError(messageOf(error)) }
      flushViewport()
    })

    showDocument(workspace.activeId)
    updateToolbar()

    return Object.freeze({
      workspace,
      graph,
      destroy() {
        destroyed = true
        files.destroy()
        finishCtrlPan()
        window.clearTimeout(panClickTimer)
        flushViewport()
        unsubscribe()
        observer.disconnect()
        sidebar.destroy()
        motionVisibilityObserver.disconnect()
        listeners.forEach((remove) => remove())
        window.clearTimeout(hintTimer)
        feedback.error = () => {}
        feedback.hint = () => {}
        storageListener = () => {}
        for (const view of nodeViews.values()) view.destroy()
        nodeViews.clear()
        hosts.clear()
        root.classList.add('wf-edge-motion-paused')
        graph.dispose()
        mounted.delete(root)
      },
    })
  }

  window.NestCloudWorkflow = Object.freeze({ mount, renderers })
})()
