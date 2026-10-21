window.__workflowBrowserReport = null
window.__workflowBrowserCheck = (async () => {
  const root = document.querySelector('[data-view="workflow"]')
  const instance = window.NestCloudWorkflow.mount(root)
  const { workspace, graph } = instance
  const report = []
  const created = []
  const initialId = workspace.activeId
  const originalCompare = workspace.services.compare
  const requests = []
  const entryStatuses = []
  const addedDefinitions = []
  const originalQuery = root.querySelector('[data-wf="palette-search"]').value
  const originalFolders = new Map([...root.querySelectorAll('.wf-folder')].map((folder) => [folder.dataset.folderPath, folder.open]))
  let holdNext = false
  let release = null
  /** 请求发出瞬间记录每个运行中流程的开始节点状态，用于证明业务请求晚于开始节点成功。 */
  const runningEntryStatuses = () => workspace.documents
    .filter((flow) => workspace.getRuntime(flow.id).running)
    .map((flow) => {
      const start = flow.nodes.find((node) => node.type === 'start')
      return start ? workspace.getRuntime(flow.id).states.get(start.id)?.status : 'no-start'
    })
  workspace.services.compare = async (options) => {
    requests.push(options.format)
    entryStatuses.push(runningEntryStatuses())
    if (holdNext) {
      holdNext = false
      await new Promise((resolve) => { release = resolve })
    }
    return originalCompare(options)
  }
  const control = (name) => root.querySelector(`[data-wf="${name}"]`)
  const click = (name) => control(name).click()
  const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
  function assert(condition, message) { if (!condition) throw new Error(message) }
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 8000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message)
      await pause()
    }
  }
  function create(name) {
    click('doc-create')
    created.push(workspace.activeId)
    workspace.rename(workspace.activeId, name)
    return workspace.activeId
  }
  function mouse(element, type, point) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: point.button ?? 0, buttons: type === 'mouseup' || type === 'click' ? 0 : point.button === 2 ? 2 : point.button === 1 ? 4 : 1, ctrlKey: Boolean(point.ctrlKey), clientX: point.x, clientY: point.y }))
  }
  async function drag(element, offset) {
    const rect = element.getBoundingClientRect()
    const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    const end = { x: start.x + offset.x, y: start.y + offset.y }
    mouse(element, 'mousedown', start)
    mouse(document, 'mousemove', { x: start.x + offset.x / 2, y: start.y + offset.y / 2 })
    mouse(document, 'mousemove', end)
    mouse(document, 'mouseup', end)
    await pause(80)
  }
  function selectFlow(id) {
    control('doc-select').value = id
    control('doc-select').dispatchEvent(new Event('change', { bubbles: true }))
  }
  async function upload(text) {
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], 'workflow.json', { type: 'application/json' }))
    control('import-file').files = transfer.files
    control('import-file').dispatchEvent(new Event('change', { bubbles: true }))
    await pause(80)
  }
  function searchPalette(query) {
    control('palette-search').value = query
    control('palette-search').dispatchEvent(new Event('input', { bubbles: true }))
  }
  async function panBlank(ctrlKey, button = 0) {
    const svg = root.querySelector('.x6-graph-svg')
    const rect = svg.getBoundingClientRect()
    const start = { x: rect.left + 16, y: rect.top + 16, ctrlKey, button }
    const end = { ...start, x: start.x + 40, y: start.y + 24 }
    const before = graph.translate()
    const nodes = JSON.stringify(workspace.getDocument().nodes)
    const selection = JSON.stringify(graph.getSelectedCells().map((cell) => cell.id).sort())
    const undo = workspace.canUndo()
    mouse(svg, 'mousedown', start)
    mouse(document.body, 'mousemove', end)
    mouse(document.body, 'mouseup', end)
    if (button === 0) mouse(svg, 'click', end)
    await pause(80)
    const after = graph.translate()
    assert(Math.abs(after.tx - before.tx - 40) < 1 && Math.abs(after.ty - before.ty - 24) < 1, '画布平移没有按鼠标距离移动')
    assert(JSON.stringify(workspace.getDocument().nodes) === nodes, '平移画布意外修改了节点')
    assert(JSON.stringify(graph.getSelectedCells().map((cell) => cell.id).sort()) === selection, '平移与框选/点击冲突，丢失原选择')
    assert(workspace.canUndo() === undo, '平移改变了撤销可用性')
    assert(!root.classList.contains('wf-panning'), '鼠标释放后平移状态未清理')
  }
  /** 普通滚轮、触控板和方向键不能平移画布；鼠标拖动与工具栏缩放仍可用。 */
  async function verifyDragOnlyViewport() {
    await pause(80)
    const svg = root.querySelector('.x6-graph-svg')
    const before = { ...graph.translate(), zoom: graph.zoom() }
    const nodes = JSON.stringify(workspace.getDocument().nodes)
    const undo = workspace.canUndo()
    const page = { x: window.scrollX, y: window.scrollY }
    const targets = [control('stage'), svg, root.querySelector('.wf-node__head')].filter(Boolean)
    for (const target of targets) {
      const rect = target.getBoundingClientRect()
      for (const gesture of [
        { deltaY: 120 }, { deltaY: -120 }, { deltaX: 120 }, { deltaX: -120 },
        { deltaY: 120, shiftKey: true }, { deltaX: 30, deltaY: 20, deltaMode: 1 },
        { deltaX: 120, ctrlKey: true },
      ]) {
        const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.x + 8, clientY: rect.y + 8, ...gesture })
        target.dispatchEvent(event)
        assert(event.defaultPrevented, `画布未拦截滚轮默认行为：${JSON.stringify(gesture)}`)
        await pause()
        assert(JSON.stringify({ ...graph.translate(), zoom: graph.zoom() }) === JSON.stringify(before), `滚轮或触控板改变了画布视口：${target.className.baseVal ?? target.className} ${JSON.stringify(gesture)}，原 ${JSON.stringify(before)}，现 ${JSON.stringify({ ...graph.translate(), zoom: graph.zoom() })}`)
      }
    }
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      control('stage').dispatchEvent(event)
      assert(event.defaultPrevented, '画布方向键未阻止原生页面滚动')
      assert(JSON.stringify({ ...graph.translate(), zoom: graph.zoom() }) === JSON.stringify(before), '方向键移动了画布')
    }
    assert(window.scrollX === page.x && window.scrollY === page.y, '画布操作滚动了外层页面')
    for (const target of [control('stage'), control('graph')]) {
      target.scrollTop = 100
      target.scrollLeft = 100
      assert(target.scrollTop === 0 && target.scrollLeft === 0, '画布容器仍允许原生滚动')
    }
    await panBlank(true)
    await panBlank(false, 2)
    await panBlank(false, 1)
    click('zoom-in')
    assert(graph.zoom() > before.zoom, '工具栏放大失效')
    click('zoom-out')
    assert(Math.abs(graph.zoom() - before.zoom) < 0.001, '工具栏缩小没有恢复原比例')
    graph.translate(before.tx, before.ty)
    assert(JSON.stringify(workspace.getDocument().nodes) === nodes && workspace.canUndo() === undo, '视口操作污染了节点或编辑历史')
  }
  /** Ctrl/Command 滚轮按鼠标锚点缩放，比例受限且不改变业务状态。 */
  async function verifyWheelZoom() {
    const before = { ...graph.translate(), zoom: graph.zoom() }
    const nodes = JSON.stringify(workspace.getDocument().nodes)
    const selection = JSON.stringify(graph.getSelectedCells().map((cell) => cell.id).sort())
    const undo = workspace.canUndo()
    const page = { x: window.scrollX, y: window.scrollY }
    const targets = [root.querySelector('.x6-graph-svg'), root.querySelector('.wf-node__head'), root.querySelector('.wf-text'), root.querySelector('.wf-pane__code')]
      .filter((element) => element?.getBoundingClientRect().width > 0)
    const restore = () => { graph.scale(before.zoom, before.zoom); graph.translate(before.tx, before.ty) }
    const wheel = async (target, gesture) => {
      const rect = target.getBoundingClientRect()
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.x + 12, clientY: rect.y + 12, ...gesture })
      const anchor = graph.clientToLocal(event.clientX, event.clientY)
      const scale = graph.zoom()
      target.dispatchEvent(event)
      assert(event.defaultPrevented, '修饰键滚轮未阻止浏览器整页缩放')
      await pause(50)
      const after = graph.clientToLocal(event.clientX, event.clientY)
      assert(Math.abs(after.x - anchor.x) < 0.1 && Math.abs(after.y - anchor.y) < 0.1, '滚轮缩放没有固定鼠标所在位置')
      return { scale, after: graph.zoom() }
    }
    try {
      for (const target of targets) {
        for (const modifier of ['ctrlKey', 'metaKey']) {
          for (const deltaY of [-120, 120]) {
            graph.scale(1, 1)
            const changed = await wheel(target, { deltaY, [modifier]: true })
            assert(deltaY < 0 ? changed.after > changed.scale : changed.after < changed.scale, `${modifier}+滚轮未按方向缩放画布`)
            assert(control('zoom-label').textContent === `${Math.round(graph.zoom() * 100)}%`, '滚轮缩放后比例标签没有同步')
          }
        }
      }
      for (const [limit, deltaY] of [[0.2, 120], [2, -120]]) {
        graph.scale(limit, limit)
        const changed = await wheel(targets[0], { deltaY, ctrlKey: true })
        assert(Math.abs(changed.after - limit) < 0.001, '滚轮缩放越过 20%～200% 边界')
      }
      assert(window.scrollX === page.x && window.scrollY === page.y, '修饰键滚轮带动了外层页面')
      assert(JSON.stringify(workspace.getDocument().nodes) === nodes && workspace.canUndo() === undo, '滚轮缩放污染了节点或编辑历史')
      assert(JSON.stringify(graph.getSelectedCells().map((cell) => cell.id).sort()) === selection, '滚轮缩放丢失了原选择')
    } finally { restore() }
  }
  /** 节点内容保留原生滚动，滚到边缘时不能带动画布。 */
  function verifyNodeScrollBoundary() {
    const textarea = root.querySelector('.wf-text')
    const value = textarea.value
    const scroll = { top: textarea.scrollTop, left: textarea.scrollLeft }
    const viewport = JSON.stringify({ ...graph.translate(), zoom: graph.zoom() })
    try {
      textarea.value = Array.from({ length: 100 }, (_, index) => `${index} ${'x'.repeat(200)}`).join('\n')
      textarea.scrollTop = 0
      const wheel = (gesture) => {
        const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...gesture })
        textarea.dispatchEvent(event)
        return event.defaultPrevented
      }
      assert(!wheel({ deltaY: 120 }), '节点文本的内部滚动被禁止')
      assert(wheel({ deltaY: -120 }), '节点顶部没有阻止滚动穿透')
      textarea.scrollTop = textarea.scrollHeight
      assert(wheel({ deltaY: 120 }), '节点底部没有阻止滚动穿透')
      assert(!wheel({ deltaY: -120 }), '节点文本反向滚动被禁止')
      textarea.scrollLeft = 0
      assert(!wheel({ deltaY: 120, shiftKey: true }), '纵向到底时 Shift 滚轮不能横向滚动节点文本')
      assert(wheel({ deltaY: -120, shiftKey: true }), '节点左边缘未阻止 Shift 滚动穿透')
      textarea.scrollLeft = textarea.scrollWidth
      assert(wheel({ deltaY: 120, shiftKey: true }), '节点右边缘未阻止 Shift 滚动穿透')
      assert(!wheel({ deltaX: -120 }), '节点文本的横向滚动被禁止')
      assert(!wheel({ deltaX: -20, deltaY: 20 }), '双轴触控板的可用横向滚动被禁止')
      assert(getComputedStyle(textarea).overscrollBehaviorX === 'contain' && getComputedStyle(textarea).overscrollBehaviorY === 'contain', '节点内部双轴滚动缺少边缘隔离')
      assert(JSON.stringify({ ...graph.translate(), zoom: graph.zoom() }) === viewport, '节点滚动影响了画布视口')
    } finally {
      textarea.value = value
      textarea.scrollTop = scroll.top
      textarea.scrollLeft = scroll.left
    }
  }
  /** 独立渲染夹具覆盖换行边界、位置比例、长文本、重用和清除，不向服务发额外请求。 */
  async function verifyResultMarkers() {
    const fixture = document.createElement('div')
    fixture.className = 'wf-node'
    Object.assign(fixture.style, { position: 'fixed', left: '0', top: '0', width: '960px', height: '480px', zIndex: '300' })
    const body = document.createElement('div')
    body.className = 'wf-node__body'
    fixture.append(body)
    root.append(fixture)
    const renderer = workspace.registry.get('diff-result', 1).render({ body })
    const sample = [...workspace.getRuntime().states.values()].find((state) => state.outputs?.diff)?.outputs.diff
    const update = (data, status = 'succeeded') => renderer.update({ state: { status, outputs: data ? { diff: data } : null } })
    const columns = () => [...fixture.querySelectorAll('.wf-pane')]
    const bands = (side = 0) => [...columns()[side].querySelectorAll('.wf-pane__marker')]
    const tab = (name) => fixture.querySelector(`[data-tab="${name}"]`).click()
    try {
      const segments = [
        { text: '<img data-wf-marker-injected src=x>', status: 'added' },
        { text: '\r', status: null }, { text: '\nkeep\rkeep\n', status: null },
        { text: 'old', status: 'removed' }, { text: '\n', status: null },
        { text: 'new\nlast', status: 'modified' }, { text: '\r\n', status: null },
        { text: '', status: 'added' },
      ]
      const text = segments.map((segment) => segment.text).join('')
      update({ ...sample, leftText: text, rightText: 'unchanged\n', segments: { left: segments, right: [{ text: 'unchanged\n', status: null }] } })
      assert(bands().length === 3 && bands(1).length === 0, '差异概览错误显示未变化/空片段或重复标记')
      const expected = [['0', '0', 'added'], ['3', '3', 'removed'], ['4', '5', 'modified']]
      for (const [index, [line, endLine, status]] of expected.entries()) {
        const band = bands()[index]
        const track = band.parentElement
        assert(band.dataset.line === line && band.dataset.endLine === endLine && band.classList.contains(`wf-pane__marker--${status}`), '跨 segment 的 CRLF、CR/LF 或同类连续行合并不正确')
        assert(Math.abs(band.offsetTop - Number(line) / 7 * track.clientHeight) < 2, '差异标记未按全文行数定位')
        assert(getComputedStyle(band).backgroundColor !== 'rgba(0, 0, 0, 0)', '差异标记没有语义色')
        assert(track.getAttribute('aria-hidden') === 'true' && getComputedStyle(track).pointerEvents === 'none', '概览轨道遮挡交互或未对辅助技术隐藏')
      }
      assert(!fixture.querySelector('img') && columns()[0].querySelector('pre').textContent === text, '高亮内容未按安全原文渲染')
      const originalBands = bands()
      tab('tree'); tab('json'); tab('pairs')
      assert(bands().every((band, index) => band === originalBands[index]), '切换选项卡重建或重复添加了差异标记')
      const longSegments = Array.from({ length: 1000 }, (_, index) => ({ text: `LINE_${index}=${'x'.repeat(100)}\n`, status: ({ 0: 'added', 500: 'removed', 999: 'modified' })[index] ?? null }))
      const longText = longSegments.map((segment) => segment.text).join('')
      update({ ...sample, leftText: longText, rightText: longText, segments: { left: longSegments, right: longSegments } })
      assert(bands().length === 3 && bands(1).length === 3, '长文本两侧差异标记数量错误')
      const [left, right] = columns().map((column) => column.querySelector('pre'))
      const track = bands()[0].parentElement
      const positions = bands().map((band) => band.offsetTop)
      left.scrollTop = left.scrollHeight / 2
      left.dispatchEvent(new Event('scroll'))
      await pause()
      assert(right.scrollTop === left.scrollTop && left.scrollTop > 0, '概览轨道破坏了正文滚动或 A/B 同步')
      assert(bands().every((band, index) => band.offsetTop === positions[index]), '滚动正文带动了差异概览')
      fixture.style.height = '640px'
      await pause()
      assert(Math.abs(bands()[1].offsetTop / track.clientHeight - 500 / 1001) < 0.01, '结果节点尺寸变化后差异位置失准')
      assert(bands()[2].offsetTop + bands()[2].offsetHeight <= track.clientHeight + 1, '末尾标记超出了概览轨道')
      update({ ...sample, leftText: '', rightText: '', segments: { left: [], right: [] } })
      assert(bands().length === 0 && bands(1).length === 0, '新无差异结果残留旧标记')
      for (const status of ['idle', 'queued', 'running', 'failed', 'cancelled']) {
        update({ ...sample, segments: { left: segments, right: segments } })
        update(null, status)
        assert(fixture.querySelectorAll('.wf-pane__marker').length === 0, `${status} 状态残留旧结果标记`)
      }
    } finally {
      renderer.destroy?.()
      fixture.remove()
    }
  }
  function luminance(color) {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map((channel) => {
      const value = Number(channel) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  /* ---------------- 连线专项辅助 ---------------- */
  const MOTION_QUERY = '(prefers-reduced-motion: reduce)'
  const FLOW_PARTICLES = 3
  const FLOW_ANIMATION = 'wf-edge-flow-travel'
  const FLOW_DURATION_MS = 2800
  const ENDPOINT_TOLERANCE = 0.75
  const INTERACTIVE_SELECTOR = 'input, textarea, select, button, a, summary, [data-wf-interactive]'
  const nativeReducedMotion = window.matchMedia(MOTION_QUERY).matches
  let focusFallbacks = 0
  const documentEdges = () => workspace.getDocument().edges
  const edgeElement = (id) => root.querySelector(`.x6-edge[data-cell-id="${id}"]`)
  const strokeWidth = (element) => parseFloat(getComputedStyle(element).strokeWidth)
  const keydown = (target, key, options = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))
  /** 页面隐藏或系统要求减少动效时，全局暂停类与光点隐藏都应成立。 */
  const naturalPaused = () => document.hidden || nativeReducedMotion
  /** 取得光点组真实的 CSSAnimation；root.hidden 导致 display:none 时浏览器会取消动画，返回 undefined。 */
  const flowAnimation = (flow) => flow.getAnimations().find((animation) => animation.animationName === FLOW_ANIMATION)
  /** 结构快照：节点与按 id 排序的连线，用于判断删除/撤销是否精确恢复。 */
  function snapshot() {
    const flow = workspace.getDocument()
    return JSON.stringify({ nodes: flow.nodes, edges: [...flow.edges].sort((a, b) => (a.id < b.id ? -1 : 1)) })
  }
  /** 每次重新查询连线 DOM；删除/恢复/节点同步后旧引用会失效。 */
  function edgeParts(id) {
    const element = edgeElement(id)
    assert(element, `连线 ${id} 没有渲染`)
    return { element, hit: element.querySelector('.wf-edge-hit'), line: element.querySelector('.wf-edge-line'), flows: [...element.querySelectorAll('.wf-edge-flow')] }
  }
  /** 页面没有系统焦点时浏览器不派发 focus 事件，此时补发 focusin 以仍然覆盖产品监听。 */
  function focusEdge(hit) {
    hit.focus()
    if (!document.hasFocus()) {
      focusFallbacks += 1
      hit.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    }
  }
  /** 取路径上 ratio 位置沿法线偏移 offset 屏幕像素的真实屏幕坐标。 */
  function edgePoint(path, ratio, offset = 0) {
    const matrix = path.getScreenCTM()
    const length = path.getTotalLength()
    const at = length * ratio
    const center = path.getPointAtLength(at).matrixTransform(matrix)
    const before = path.getPointAtLength(Math.max(at - 1, 0)).matrixTransform(matrix)
    const after = path.getPointAtLength(Math.min(at + 1, length)).matrixTransform(matrix)
    const size = Math.hypot(after.x - before.x, after.y - before.y) || 1
    return { x: center.x - (after.y - before.y) / size * offset, y: center.y + (after.x - before.x) / size * offset }
  }
  /** 优先用路径中点；该点被节点遮挡时才依次尝试附近位置，仍要求最终由命中路径响应。 */
  function findHitRatio(hit) {
    const ratio = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65].find((value) => {
      const point = edgePoint(hit, value)
      return document.elementFromPoint(point.x, point.y) === hit
    })
    assert(ratio !== undefined, '连线中段没有被 .wf-edge-hit 命中（被遮挡或不在可视区域）')
    return ratio
  }
  function assertHitZone(hit) {
    const ratio = findHitRatio(hit)
    const hitsAt = (offset) => {
      const point = edgePoint(hit, ratio, offset)
      return document.elementFromPoint(point.x, point.y) === hit
    }
    assert(hitsAt(6) || hitsAt(-6), '命中带 16px 内偏移 6px 没有命中连线')
    assert(!hitsAt(12) && !hitsAt(-12), '命中带外偏移 12px 仍命中连线，命中区域过宽')
  }
  /** 模拟原生指针：mousedown 后才发生聚焦，再 mouseup/click，避免漏测 focus 与 mouseup 双重切换。 */
  async function clickEdge(id, ctrlKey = false) {
    const { hit } = edgeParts(id)
    const point = edgePoint(hit, findHitRatio(hit))
    const target = document.elementFromPoint(point.x, point.y)
    const at = { ...point, ctrlKey }
    mouse(target, 'mousedown', at)
    focusEdge(target)
    mouse(target, 'mouseup', at)
    mouse(target, 'click', at)
    await pause()
  }
  async function assertSelectedEdges(ids, message) {
    await pause(10)
    for (const edge of documentEdges()) {
      const wanted = ids.includes(edge.id)
      const { element, hit } = edgeParts(edge.id)
      assert(graph.isSelected(edge.id) === wanted && element.classList.contains('x6-edge-selected') === wanted && hit.getAttribute('aria-pressed') === String(wanted), `${message}（连线 ${edge.id} 应为${wanted ? '选中' : '未选中'}）`)
    }
  }
  function assertLegacyEdgeUiRemoved() {
    const legacy = root.querySelector('[data-wf="connect-panel"], [data-wf="connect-form"], [data-wf="edge-list"], [data-wf^="connect"], [data-wf^="edge"], [class*="connect-panel"], [class*="connect-form"], [class*="edge-list"]')
    assert(!legacy, '旧的连线面板/表单/连线列表仍然存在')
  }
  function assertEdgeAppearance(id) {
    const { element, hit, line, flows } = edgeParts(id)
    assert(!element.querySelector('text, tspan, foreignObject, .x6-edge-label, [marker-start], [marker-end]') && graph.getCellById(id).getLabels().length === 0, '连线上仍有文字/标签/箭头标记')
    const lineStyle = getComputedStyle(line)
    assert(lineStyle.markerStart === 'none' && lineStyle.markerEnd === 'none', '连线 computed marker 不是 none')
    const hitStyle = getComputedStyle(hit)
    assert(/^(transparent|rgba\(0, 0, 0, 0\))$/.test(hitStyle.stroke) && hitStyle.strokeWidth === '16px' && hitStyle.vectorEffect === 'non-scaling-stroke' && hitStyle.pointerEvents === 'stroke', '命中路径不是透明 16px non-scaling stroke 或不接收指针')
    assert(hit.tabIndex === 0 && hit.getAttribute('role') === 'button' && hit.getAttribute('aria-label')?.includes('连线') && hit.getAttribute('aria-pressed') !== null, '命中路径缺少键盘焦点、可访问名称或选择状态')
    assert(!hit.closest(INTERACTIVE_SELECTOR), '连线命中路径落入了交互元素选择器，会被画布手势守卫忽略')
    for (const layer of ['.wf-edge-halo', '.wf-edge-glow', '.wf-edge-line']) assert(getComputedStyle(element.querySelector(layer)).pointerEvents === 'none', `${layer} 不应接收指针`)
    assert(line.id === `wf-edge-path-${id}` && document.querySelectorAll(`[id="${line.id}"]`).length === 1 && line.tagName === 'path', '连线实际路径缺少唯一 ID')
    assert(flows.length === FLOW_PARTICLES, `连线应有 ${FLOW_PARTICLES} 组流光`)
    assert(!element.querySelector('animateMotion, animate, animateTransform, set, mpath'), '连线仍残留 SMIL 动画节点')
    const delays = new Set()
    for (const flow of flows) {
      const style = getComputedStyle(flow)
      assert(style.pointerEvents === 'none' && style.offsetPath.includes(`#${line.id}`), '流光 offset-path 没有引用实际连线路径或会接收指针')
      assert(style.animationName === FLOW_ANIMATION && style.animationDuration === '2.8s' && style.animationIterationCount === 'infinite', '流光没有使用 2.8s 无限循环的 CSS 关键帧')
      delays.add(style.animationDelay)
      const animation = flowAnimation(flow)
      assert(animation instanceof CSSAnimation && animation.effect.target === flow, '流光没有生成真实 CSSAnimation')
      const timing = animation.effect.getTiming()
      assert(timing.duration === FLOW_DURATION_MS && timing.iterations === Infinity && timing.easing === 'linear', '流光 CSSAnimation 的时长/循环/缓动不符')
    }
    assert(delays.size === FLOW_PARTICLES, '流光没有错开起始时间')
  }
  function assertNoVisualState() {
    const stored = String(localStorage.getItem(window.NestCloudWorkflowCore.STORAGE_KEY))
    for (const text of [workspace.exportDocument(), stored]) assert(!/wf-edge|animateMotion|mpath|offset-path|offsetPath|x6-|aria-pressed|"(attrs|markup|labels|connector|router)"/.test(text), '连线视觉/选中/动效状态进入了导出或持久化数据')
  }
  /** 端点必须落在端口圆心：同时比较 circle 的 cx/cy 屏幕投影与包围盒中心，覆盖 boundary 裁剪造成的约一个端口半径偏差。 */
  function assertEdgeEndpoints(edge, message) {
    const { line } = edgeParts(edge.id)
    const matrix = line.getScreenCTM()
    const ends = [
      { name: '源端', nodeId: edge.source.nodeId, port: `out:${edge.source.port}`, at: line.getPointAtLength(0).matrixTransform(matrix) },
      { name: '目标端', nodeId: edge.target.nodeId, port: `in:${edge.target.port}`, at: line.getPointAtLength(line.getTotalLength()).matrixTransform(matrix) },
    ]
    for (const end of ends) {
      const circle = root.querySelector(`[data-cell-id="${end.nodeId}"] circle[port="${end.port}"]`)
      assert(circle, `${message}：连线 ${edge.id} 的${end.name}端口 ${end.port} 没有渲染`)
      const rect = circle.getBoundingClientRect()
      const projected = new DOMPoint(circle.cx.baseVal.value, circle.cy.baseVal.value).matrixTransform(circle.getScreenCTM())
      for (const center of [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, projected]) {
        const distance = Math.hypot(end.at.x - center.x, end.at.y - center.y)
        assert(distance <= ENDPOINT_TOLERANCE, `${message}：连线 ${edge.id} 的${end.name}偏离端口圆心 ${distance.toFixed(2)}px（上限 ${ENDPOINT_TOLERANCE}px）`)
      }
    }
  }
  function assertAllEdgeEndpoints(message) {
    assert(documentEdges().length > 0, `${message}：没有正式连线可验证端点`)
    documentEdges().forEach((edge) => assertEdgeEndpoints(edge, message))
  }
  /** 依次切到不同缩放与平移，端点仍须与端口圆心重合且光点仍贴合曲线；结束后恢复原视口并确认没有污染业务历史。 */
  async function verifyEndpointsAcrossViewports() {
    const zoom = graph.zoom()
    const { tx, ty } = graph.translate()
    const beforeSnapshot = snapshot()
    const canUndo = workspace.canUndo()
    const views = [{ zoom: 0.35, x: 0, y: 0 }, { zoom: 1, x: 0, y: 0 }, { zoom: 1.6, x: 0, y: 0 }, { zoom: 1.6, x: 90, y: -60 }, { zoom: 0.35, x: -120, y: 80 }]
    try {
      for (const view of views) {
        graph.scale(view.zoom, view.zoom)
        graph.translate(tx + view.x, ty + view.y)
        await pause(30)
        const label = `缩放 ${view.zoom} 平移 (${view.x}, ${view.y})`
        assert(Math.abs(graph.zoom() - view.zoom) < 0.001, `${label}：画布没有应用目标缩放`)
        assertAllEdgeEndpoints(label)
        await verifyFlowMotion(documentEdges().map((edge) => edge.id))
      }
    } finally {
      graph.scale(zoom, zoom)
      graph.translate(tx, ty)
      await pause(30)
    }
    assert(Math.abs(graph.zoom() - zoom) < 0.001 && Math.abs(graph.translate().tx - tx) < 0.5 && Math.abs(graph.translate().ty - ty) < 0.5, '缩放/平移后没有恢复原视口')
    assert(snapshot() === beforeSnapshot && workspace.canUndo() === canUndo, '缩放/平移污染了业务结构或撤销历史')
    assertAllEdgeEndpoints('恢复原视口后')
  }
  /** 流光核心点的屏幕坐标与路径坐标；位移用路径坐标比较，避免字体/布局稳定带来的整体屏幕偏移造成误判。全局隐藏时仍有布局矩形，root.hidden（display:none）时为零矩形。 */
  const flowCenters = (id) => {
    const { line, flows } = edgeParts(id)
    const matrix = line.getScreenCTM()
    const inverse = matrix.inverse()
    return flows.map((flow) => {
      const rect = flow.querySelector('.wf-edge-flow-core').getBoundingClientRect()
      const x = rect.x + rect.width / 2
      const y = rect.y + rect.height / 2
      return { x, y, local: new DOMPoint(x, y).matrixTransform(inverse), scale: Math.hypot(matrix.a, matrix.b) }
    })
  }
  function distanceToPath(path, point) {
    const matrix = path.getScreenCTM()
    const length = path.getTotalLength()
    const steps = Math.min(4000, Math.max(200, Math.ceil(length * Math.hypot(matrix.a, matrix.b))))
    let best = Infinity
    for (let index = 0; index <= steps; index += 1) {
      const sample = path.getPointAtLength(length * index / steps).matrixTransform(matrix)
      best = Math.min(best, Math.hypot(sample.x - point.x, sample.y - point.y))
    }
    return best
  }
  /**
   * 页面可见、未全局暂停时，120ms 内未选中的光点必须沿实际曲线移动且 CSSAnimation 正在运行；
   * 选中连线的光点必须原地可见、位置不变且 CSSAnimation 为 paused。全局暂停/减少动效/隐藏时不做移动断言，返回 false。
   */
  async function verifyFlowMotion(ids) {
    if (naturalPaused() || root.hidden || root.classList.contains('wf-edge-motion-paused')) return false
    const animations = ids.flatMap((id) => edgeParts(id).flows).map(flowAnimation)
    await Promise.all(animations.filter(Boolean).map((animation) => animation.ready))
    const before = ids.map(flowCenters)
    await pause(120)
    ids.forEach((id, index) => {
      const { element, line, flows } = edgeParts(id)
      const frozen = element.classList.contains('x6-edge-selected')
      flowCenters(id).forEach((point, particle) => {
        const label = `连线 ${id} 的第 ${particle + 1} 个光点`
        const shift = Math.hypot(point.local.x - before[index][particle].local.x, point.local.y - before[index][particle].local.y) * point.scale
        assert(distanceToPath(line, point) <= 3, `${label}偏离实际曲线`)
        assert(frozen ? shift < 0.3 : shift > 0.5, frozen ? `${label}在选中后仍移动了 ${shift.toFixed(2)}px` : `${label} 120ms 内没有移动`)
        assert(!document.elementFromPoint(point.x, point.y)?.closest('.wf-edge-flow'), '流光元素拦截了指针命中')
      })
      flows.forEach((flow, particle) => {
        const animation = flowAnimation(flow)
        assert(animation instanceof CSSAnimation && animation.playState === (frozen ? 'paused' : 'running'), `连线 ${id} 的第 ${particle + 1} 个 CSSAnimation 状态不符（期望 ${frozen ? 'paused' : 'running'}）`)
        assert(getComputedStyle(flow).visibility === 'visible', `连线 ${id} 的第 ${particle + 1} 个光点不可见`)
      })
    })
    return true
  }
  /**
   * 校验全局暂停类、每组光点的 computed 可见性/播放状态与 CSSAnimation 时间。
   * 全局暂停或减少动效时全部隐藏并冻结；否则只有选中连线的光点冻结，其余继续推进。
   */
  async function assertMotionState(paused, message) {
    const flows = [...root.querySelectorAll('.wf-edge-flow')]
    assert(flows.length > 0, `${message}：没有流光元素可验证`)
    assert(root.classList.contains('wf-edge-motion-paused') === paused, `${message}：暂停类状态不符（期望 paused=${paused}）`)
    const hidden = paused || nativeReducedMotion
    const isFrozen = (flow) => hidden || Boolean(flow.closest('.x6-edge-selected'))
    const animations = flows.map(flowAnimation)
    await Promise.all(animations.filter(Boolean).map((animation) => animation.ready))
    flows.forEach((flow, index) => {
      const style = getComputedStyle(flow)
      const expected = isFrozen(flow) ? 'paused' : 'running'
      assert(style.visibility === (hidden ? 'hidden' : 'visible'), `${message}：光点可见性不符（期望 hidden=${hidden}）`)
      assert(style.animationPlayState === expected, `${message}：光点 computed animationPlayState 应为 ${expected}，实际 ${style.animationPlayState}`)
      if (root.hidden && !animations[index]) return // display:none 的父级会取消 CSSAnimation，返回可见后重建
      assert(animations[index] instanceof CSSAnimation && animations[index].playState === expected, `${message}：光点 CSSAnimation 状态应为 ${expected}`)
    })
    const times = animations.map((animation) => animation?.currentTime)
    await pause(60)
    flows.forEach((flow, index) => {
      const now = animations[index]?.currentTime
      if (typeof now !== 'number' || typeof times[index] !== 'number') return
      if (isFrozen(flow)) assert(Math.abs(now - times[index]) < 0.01, `${message}：应冻结的光点 currentTime 仍在推进`)
      else if (!document.hidden) assert(now - times[index] > 10, `${message}：应继续的光点 currentTime 没有推进`)
    })
  }
  async function verifyMenuMotionPause(ids) {
    window.location.hash = 'json-compare'
    await waitFor(() => root.hidden && root.classList.contains('wf-edge-motion-paused'), '切换到其他菜单后连线动画没有暂停')
    await assertMotionState(true, '切换菜单后')
    window.location.hash = 'workflow'
    await waitFor(() => !root.hidden && document.querySelector('.main-content').dataset.route === 'workflow', '无法返回工作流')
    const paused = naturalPaused()
    await waitFor(() => root.classList.contains('wf-edge-motion-paused') === paused, '返回工作流后连线动画没有按原生偏好恢复')
    await assertMotionState(paused, '返回工作流后')
    return verifyFlowMotion(ids)
  }
  async function verifyEdgeSelection([a, b]) {
    const widths = (id) => {
      const { element, line } = edgeParts(id)
      return { line: strokeWidth(line), glow: strokeWidth(element.querySelector('.wf-edge-glow')) }
    }
    graph.cleanSelection()
    await pause()
    assertHitZone(edgeParts(a).hit)
    const idle = widths(a)
    await clickEdge(a)
    await assertSelectedEdges([a], '真实点击命中路径没有选中连线')
    await waitFor(() => widths(a).line > idle.line + 0.5 && widths(a).glow > idle.glow, '选中连线的线宽/光晕没有增强')
    assert(widths(b).line < widths(a).line && !control('delete-selection').disabled, '选中反馈影响了其他连线或工具栏删除不可用')
    await clickEdge(b, true)
    await assertSelectedEdges([a, b], 'Ctrl 点击没有多选第二条连线')
    await clickEdge(b, true)
    await assertSelectedEdges([a], 'Ctrl 再次点击没有只取消一次（疑似双重切换）')
    await clickEdge(b, true)
    await assertSelectedEdges([a, b], 'Ctrl 点击重新多选失败')
  }
  /**
   * 选中连线只冻结自身光点：单选、Ctrl 多选、Ctrl 取消单条、清空选择；其余连线持续流动。
   * 恢复必须沿用原 CSSAnimation 的 currentTime，而不是重建后从 0 开始。结束时清空选择。
   */
  async function verifyEdgeSelectionMotion(ids) {
    const [a, b, c, d] = ids // d 是开始节点的控制连线，与数据线一样必须流动/冻结
    const natural = naturalPaused()
    const animationsOf = (id) => edgeParts(id).flows.map(flowAnimation)
    const tracked = new Map(ids.map((id) => [id, animationsOf(id)]))
    const timesOf = (id) => tracked.get(id).map((animation) => animation.currentTime)
    const settle = async (message) => {
      await pause(50) // 等待样式提交，避免在暂停生效前一帧采样
      await assertMotionState(natural, message)
      await verifyFlowMotion(ids)
      ids.forEach((id) => assert(animationsOf(id).every((animation, index) => animation === tracked.get(id)[index] && animation.playState !== 'idle'), `${message}：连线 ${id} 的 CSSAnimation 被重建或取消`))
    }
    const assertFrozen = (id, before, message) => timesOf(id).forEach((time, index) => assert(Math.abs(time - before[index]) < 0.01, `${message}：连线 ${id} 光点没有保持冻结`))
    const assertAdvanced = (id, before, message) => timesOf(id).forEach((time, index) => {
      if (natural) assert(Math.abs(time - before[index]) < 0.01, `${message}：全局暂停下连线 ${id} 的时间不应推进`)
      else assert(time > before[index] && time - before[index] < 10000, `${message}：连线 ${id} 的 CSSAnimation 没有从暂停处继续（${before[index]} -> ${time}）`)
    })
    graph.cleanSelection()
    await settle('无选中时')
    const idle = Object.fromEntries(ids.map((id) => [id, timesOf(id)]))
    await clickEdge(a)
    await assertSelectedEdges([a], '单选连线 a 失败')
    await settle('单选 a 后')
    const frozenA = timesOf(a)
    assertAdvanced(b, idle[b], '单选 a 后 b')
    assertAdvanced(c, idle[c], '单选 a 后 c')
    assertAdvanced(d, idle[d], '单选 a 后控制线 d')
    await clickEdge(b, true)
    await assertSelectedEdges([a, b], 'Ctrl 多选 a/b 失败')
    await settle('Ctrl 多选 a/b 后')
    assertFrozen(a, frozenA, 'Ctrl 多选 a/b 后 a')
    const frozenB = timesOf(b)
    const runningC = timesOf(c)
    const runningD = timesOf(d)
    await pause(60)
    assertFrozen(b, frozenB, 'a/b 同时选中时 b')
    assertAdvanced(c, runningC, 'a/b 同时选中时 c')
    assertAdvanced(d, runningD, 'a/b 同时选中时控制线 d')
    await clickEdge(b, true)
    await assertSelectedEdges([a], 'Ctrl 取消 b 失败')
    await settle('Ctrl 取消 b 后')
    assertFrozen(a, frozenA, 'Ctrl 取消 b 后 a')
    assertAdvanced(b, frozenB, 'Ctrl 取消 b 后 b')
    graph.cleanSelection()
    await assertSelectedEdges([], '清空选择失败')
    await settle('清空选择后')
    assertAdvanced(a, frozenA, '清空选择后 a')
    assertAdvanced(b, frozenB, '清空选择后 b')
    assertNoVisualState()
    return !natural
  }
  /** 沿用上一步的 Ctrl 多选状态：Delete 与工具栏删除只删线，撤销/重做精确恢复。 */
  async function verifyEdgeDeletion([a, b]) {
    const before = snapshot()
    const nodes = JSON.stringify(workspace.getDocument().nodes)
    const total = documentEdges().length
    const assertDeleted = (ids, message) => {
      assert(documentEdges().length === total - ids.length && ids.every((id) => !edgeElement(id) && !documentEdges().some((edge) => edge.id === id)), `${message}：连线没有被删除`)
      assert(JSON.stringify(workspace.getDocument().nodes) === nodes, `${message}：误删或改动了节点`)
    }
    const assertRestored = async (message) => {
      await pause(30)
      assert(snapshot() === before, `${message}：结构没有精确恢复`)
      documentEdges().forEach((edge) => assertEdgeAppearance(edge.id))
      assertAllEdgeEndpoints(`${message}后`)
    }
    assert(keydown(edgeParts(b).hit, 'Delete') === false, 'Delete 没有被连线焦点上的画布键盘处理')
    await pause()
    assertDeleted([a, b], 'Delete 删除两条连线')
    click('undo')
    await assertRestored('撤销 Delete')
    click('redo')
    await pause(30)
    assertDeleted([a, b], '重做 Delete')
    click('undo')
    await assertRestored('再次撤销 Delete')
    graph.cleanSelection()
    await clickEdge(a)
    click('delete-selection')
    await pause()
    assertDeleted([a], '工具栏删除所选')
    assert(edgeElement(b), '工具栏删除误删了未选中的连线')
    click('undo')
    await assertRestored('撤销工具栏删除')
  }
  async function verifyEdgeKeyboard([a, b]) {
    const focusByKeyboard = async (id) => {
      const { hit } = edgeParts(id)
      hit.blur()
      keydown(document, 'Tab') // document keydown 会把键盘模态切回键盘，之后聚焦才应选中
      focusEdge(hit)
      await pause(10)
      assert(document.activeElement === hit, '连线命中路径没有获得键盘焦点')
      assert(getComputedStyle(hit).outlineStyle === 'none', '连线聚焦出现了浏览器原生矩形边框，而非曲线高亮')
    }
    graph.cleanSelection()
    await pause()
    await focusByKeyboard(a)
    await assertSelectedEdges([a], 'Tab 聚焦连线没有选中')
    await focusByKeyboard(b)
    await assertSelectedEdges([b], 'Tab 聚焦另一条连线没有改为单选')
    assert(keydown(edgeParts(a).hit, 'Enter') === false, 'Enter 没有阻止默认行为')
    await assertSelectedEdges([a], 'Enter 没有选中连线')
    assert(keydown(edgeParts(b).hit, ' ') === false, 'Space 没有阻止默认行为')
    await assertSelectedEdges([b], 'Space 没有选中连线')
    keydown(edgeParts(a).hit, 'Enter', { ctrlKey: true })
    await assertSelectedEdges([a, b], 'Ctrl+Enter 没有加入多选')
    keydown(edgeParts(a).hit, ' ', { ctrlKey: true })
    await assertSelectedEdges([b], 'Ctrl+Space 没有取消选中')
    const before = snapshot()
    await focusByKeyboard(a)
    keydown(edgeParts(a).hit, 'Delete')
    await pause()
    assert(!edgeElement(a) && edgeElement(b) && documentEdges().length === JSON.parse(before).edges.length - 1, '键盘 Delete 没有只删除聚焦选中的连线')
    click('undo')
    await pause(30)
    assert(snapshot() === before, '撤销键盘 Delete 后结构没有精确恢复')
    graph.cleanSelection()
  }
  /** 节点移动后重新查询连线：d 必须变化，各描边层同步，端点仍在端口圆心，光点仍引用并跟随新路径。 */
  async function verifyEdgeFollowsNode(edge, nodeId) {
    const original = edgeParts(edge.id).line.getAttribute('d')
    await drag(root.querySelector(`[data-node-id="${nodeId}"] .wf-node__kind`), { x: 60, y: 40 })
    const moved = edgeParts(edge.id)
    const next = moved.line.getAttribute('d')
    assert(next && next !== original, '节点移动后连线路径没有变化')
    for (const layer of ['.wf-edge-halo', '.wf-edge-glow', '.wf-edge-hit']) assert(moved.element.querySelector(layer).getAttribute('d') === next, `${layer} 没有跟随连线路径`)
    assertEdgeAppearance(edge.id)
    assertAllEdgeEndpoints('节点移动后')
    await verifyFlowMotion([edge.id])
    click('undo')
    await pause(30)
    assert(edgeParts(edge.id).line.getAttribute('d') === original, '撤销节点移动后连线路径没有恢复')
    assertAllEdgeEndpoints('撤销节点移动后')
  }
  /** 运行锁：仍可选中查看连线，但删除按钮禁用、Delete 无效；Ctrl 平移保留选择，节点不可被拖动。 */
  async function verifyRunLockedEdges() {
    const [edge] = documentEdges()
    graph.cleanSelection()
    await pause()
    const before = snapshot()
    await clickEdge(edge.id)
    await assertSelectedEdges([edge.id], '运行中不能选中连线查看')
    await pause(50)
    await assertMotionState(naturalPaused(), '运行中选中连线后')
    await verifyFlowMotion(documentEdges().map((item) => item.id)) // 运行锁下选中的连线光点仍原地冻结，其余继续
    assert(control('delete-selection').disabled, '运行中删除所选没有禁用')
    keydown(edgeParts(edge.id).hit, 'Delete')
    control('delete-selection').click()
    await pause()
    assert(snapshot() === before && graph.getCellById(edge.id), '运行中 Delete 或工具栏删除了连线')
    await assertMotionState(naturalPaused(), '运行中尝试删除被拒绝后')
    await panBlank(true)
    await assertSelectedEdges([edge.id], '运行中 Ctrl 平移丢失了连线选择')
    const path = edgeParts(edge.id).line.getAttribute('d')
    await drag(root.querySelector(`[data-node-id="${edge.source.nodeId}"] .wf-node__kind`), { x: 40, y: 20 })
    assert(snapshot() === before && edgeParts(edge.id).line.getAttribute('d') === path, '运行中拖动节点改变了布局或连线')
    graph.cleanSelection()
    await pause(50)
    await assertMotionState(naturalPaused(), '运行中清空选择后')
  }
  /** 可控 MediaQueryList 与文档可见性：验证减少动效、页面隐藏、destroy 与重新挂载；放在所有原 case 之后。 */
  async function verifyMotionPreferenceLifecycle(flowId) {
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden')
    const originalMatchMedia = window.matchMedia
    const media = Object.assign(new EventTarget(), { matches: true, media: MOTION_QUERY })
    const restore = (target, name, descriptor) => {
      if (descriptor) Object.defineProperty(target, name, descriptor)
      else delete target[name]
    }
    const changeMedia = (matches) => {
      media.matches = matches
      media.dispatchEvent(new Event('change'))
    }
    const edgeIds = () => documentEdges().map((edge) => edge.id)
    const waitForFlows = () => waitFor(() => documentEdges().length > 0 && root.querySelectorAll('.wf-edge-flow').length === documentEdges().length * FLOW_PARTICLES, '重新挂载后没有渲染正式连线流光')
    let mock = null
    const oldFlows = [...root.querySelectorAll('.wf-edge-flow')]
    const oldAnimations = oldFlows.map(flowAnimation)
    instance.destroy()
    assert(oldFlows.every((flow) => !flow.isConnected) && oldAnimations.every((animation) => !animation || animation.playState === 'idle'), 'destroy 后旧光点 DOM 仍存活或 CSSAnimation 没有被取消')
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: (query) => (query === MOTION_QUERY ? media : originalMatchMedia.call(window, query)) })
    try {
      mock = window.NestCloudWorkflow.mount(root)
      assert(mock && mock !== instance && mock.graph !== graph, 'destroy 后同一容器不能重新挂载')
      workspace.select(flowId)
      await waitForFlows()
      await assertMotionState(true, 'reduce=true 初始')
      changeMedia(false)
      await assertMotionState(document.hidden, 'reduce 变为 false 后')
      await verifyFlowMotion(edgeIds())
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await assertMotionState(true, '文档隐藏后')
      restore(document, 'hidden', hiddenDescriptor)
      document.dispatchEvent(new Event('visibilitychange'))
      await assertMotionState(document.hidden, '文档恢复可见后')
      await verifyFlowMotion(edgeIds())
      changeMedia(true)
      await assertMotionState(true, 'reduce 再次变为 true 后')
      const mockFlows = [...root.querySelectorAll('.wf-edge-flow')]
      const mockAnimations = mockFlows.map(flowAnimation)
      mock.destroy()
      mock = null
      assert(mockFlows.every((flow) => !flow.isConnected) && mockAnimations.every((animation) => animation.playState === 'idle'), 'mock 控制器 destroy 后光点 DOM 仍存活或 CSSAnimation 没有被取消')
      restore(window, 'matchMedia', matchMediaDescriptor)
      window.NestCloudWorkflow.mount(root)
      await waitForFlows()
      await assertMotionState(naturalPaused(), '重挂真实控制器后')
      changeMedia(true) // 旧夹具监听若未移除，会把共享 root 误置为暂停
      await assertMotionState(naturalPaused(), '旧 MediaQueryList 变为 true 影响了新图')
      changeMedia(false)
      await assertMotionState(naturalPaused(), '旧 MediaQueryList 变为 false 影响了新图')
      const moved = await verifyFlowMotion(edgeIds())
      return moved
    } finally {
      mock?.destroy()
      restore(document, 'hidden', hiddenDescriptor)
      restore(window, 'matchMedia', matchMediaDescriptor)
      window.NestCloudWorkflow.mount(root) // 任何失败路径后容器仍保留存活控制器
    }
  }
  /* ---------------- 开始节点入口专项辅助 ---------------- */
  const typeNodes = (type) => workspace.getDocument().nodes.filter((node) => node.type === type)
  const errorText = () => (control('error').hidden ? '' : control('error').textContent)
  const startItem = () => root.querySelector('.wf-palette__item[data-type="start"]')
  /** 所有请求发出时，其所属运行流程的开始节点必须已经成功；失败时给出实际状态。 */
  function assertEntryBeforeRequests(from, message) {
    const recent = entryStatuses.slice(from)
    assert(recent.length === requests.length - from && recent.every((list) => list.length > 0 && list.every((status) => status === 'succeeded')), `${message}：业务请求没有全部晚于开始节点成功，开始节点状态记录为 ${JSON.stringify(recent)}`)
  }
  /** 等待当前流程达到终态；超时时把真实运行状态和界面错误写入异常，避免只剩笼统超时。 */
  async function waitForStatus(status, message) {
    try {
      await waitFor(() => workspace.getRuntime().status === status, message)
    } catch {
      throw new Error(`${message}（实际状态 ${workspace.getRuntime().status}，界面错误“${errorText()}”）`)
    }
  }
  /** 点击运行并要求界面给出匹配的错误；被拒绝的运行不得产生请求或运行状态。 */
  async function expectRunRejected(pattern, message) {
    const before = requests.length
    click('run')
    try {
      await waitFor(() => errorText() !== '', message)
    } catch {
      throw new Error(`${message}：运行没有显示错误（运行状态 ${workspace.getRuntime().status}，新增请求 ${requests.length - before}）`)
    }
    assert(pattern.test(errorText()), `${message}：错误文案不符，实际为“${errorText()}”`)
    assert(requests.length === before && !workspace.getRuntime().running && workspace.getRuntime().status === 'idle', `${message}：被拒绝的运行产生了 ${requests.length - before} 个请求或运行状态 ${workspace.getRuntime().status}`)
  }
  /** 执行应被原子拒绝的界面编辑：错误可见，节点/连线和开始节点数量保持原样。 */
  function expectEditRejected(action, message) {
    const before = snapshot()
    const starts = typeNodes('start').length
    action()
    assert(/一个开始节点/.test(errorText()), `${message}：没有显示“最多一个开始节点”，实际错误为“${errorText()}”`)
    assert(snapshot() === before && typeNodes('start').length === starts, `${message}：被拒绝的操作仍修改了流程（开始节点 ${starts} -> ${typeNodes('start').length}）`)
  }
  /** 取得插入后新节点：按样例节点原顺序对应旧标识，避免依赖固定节点位置。 */
  const insertedNode = (sampleNodes, inserted, oldId) => inserted[sampleNodes.findIndex((node) => node.id === oldId)]
  /** 开始节点入口规则：全部在专用流程内完成，样例只读，不影响原图。 */
  async function verifyEntryRules(sample) {
    const startId = sample.nodes.find((node) => node.type === 'start')?.id
    assert(startId && sample.nodes.filter((node) => node.type === 'start').length === 1, '入口专项使用的样例必须恰好包含一个开始节点')
    const legacy = structuredClone(sample)
    legacy.nodes = legacy.nodes.filter((node) => node.id !== startId)
    legacy.edges = legacy.edges.filter((edge) => edge.source.nodeId !== startId && edge.target.nodeId !== startId)
    const flows = workspace.documents.length
    await upload(JSON.stringify(legacy))
    assert(workspace.documents.length === flows + 1, `无开始节点的旧流程没有导入成功：${errorText()}`)
    created.push(workspace.activeId)
    assert(!typeNodes('start').length && workspace.getDocument().nodes.length === legacy.nodes.length && workspace.getDocument().edges.length === legacy.edges.length, '旧流程导入后被自动补充或改动了开始节点/连线')
    assert(legacy.nodes.every((node) => root.querySelector(`[data-node-id="${node.id}"]`)) && [...root.querySelectorAll('.wf-text')].every((element) => !element.readOnly) && !control('run').disabled, '旧流程导入后没有完整渲染或不可编辑')
    const requestsBefore = requests.length
    const textNode = typeNodes('text')[0]
    const textarea = root.querySelector(`[data-node-id="${textNode.id}"] textarea`)
    textarea.value = '{"legacy":true}'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await expectRunRejected(/开始节点/, '无开始节点的旧流程运行')
    assert(workspace.getDocument().nodes.find((node) => node.id === textNode.id).config.text === '{"legacy":true}', '被拒绝的运行丢失了旧流程中的编辑')

    searchPalette('')
    assert(startItem(), '节点库没有开始节点')
    startItem().click()
    assert(typeNodes('start').length === 1, `从节点库添加开始节点失败：${errorText()}`)
    await pause(30)
    await expectRunRejected(/开始节点未连接/, '开始节点没有连出的流程运行')
    expectEditRejected(() => startItem().click(), '已有开始节点时再次从节点库添加')
    graph.resetSelection(typeNodes('start')[0].id)
    await pause(30)
    assert(!control('copy-selection').disabled, '选中开始节点后复制按钮不可用，无法验证复制拒绝')
    expectEditRejected(() => click('copy-selection'), '复制已有开始节点')
    graph.cleanSelection()
    const multiple = JSON.parse(workspace.exportDocument())
    multiple.nodes.push({ ...structuredClone(multiple.nodes.find((node) => node.type === 'start')), id: 'qa-second-start' })
    const activeBefore = workspace.activeId
    const flowsBefore = workspace.documents.length
    await upload(JSON.stringify(multiple))
    assert(workspace.documents.length === flowsBefore && workspace.activeId === activeBefore && /开始节点/.test(errorText()), `包含两个开始节点的导入没有被原子拒绝（错误“${errorText()}”）`)

    workspace.connect({ source: { nodeId: typeNodes('start')[0].id, port: 'trigger' }, target: { nodeId: typeNodes('json-compare')[0].id, port: 'trigger' } })
    await pause(30)
    const entriesBefore = entryStatuses.length
    click('run')
    await waitForStatus('succeeded', '旧流程补充开始节点和启动线后运行失败')
    assert(requests.length === requestsBefore + 1 && workspace.getRuntime().states.get(typeNodes('start')[0].id).status === 'succeeded', '补充开始节点后应恰好发出 1 个请求且开始节点成功')
    assertEntryBeforeRequests(entriesBefore, '补充开始节点后的运行')
    const copiedFlows = workspace.documents.length
    click('doc-duplicate')
    assert(workspace.documents.length === copiedFlows + 1, `复制整份工作流失败：${errorText()}`)
    created.push(workspace.activeId)
    assert(typeNodes('start').length === 1, '复制整份工作流后开始节点数量不是 1')

    create('浏览器验收 共享文本未触发')
    const main = workspace.insertSubgraph({ nodes: sample.nodes, edges: sample.edges })
    const compare = sample.nodes.find((node) => node.type === 'json-compare')
    const result = sample.nodes.find((node) => node.type === 'diff-result')
    const diffEdge = sample.edges.find((edge) => edge.source.port === 'diff')
    const copies = [compare, result].map((node) => ({ ...structuredClone(node), position: { x: node.position.x, y: node.position.y + 900 } }))
    const extra = workspace.insertSubgraph({ nodes: copies, edges: [diffEdge] })
    const other = extra[0]
    for (const port of ['a', 'b']) {
      const sourceId = sample.edges.find((edge) => edge.target.port === port).source.nodeId
      workspace.connect({ source: { nodeId: insertedNode(sample.nodes, main, sourceId).id, port: 'text' }, target: { nodeId: other.id, port } })
    }
    assert(typeNodes('start').length === 1 && workspace.getDocument().edges.filter((edge) => edge.target.port === 'trigger').length === 1, '共享文本流程应只有一个开始节点和一条启动线')
    const sharedBefore = requests.length
    const sharedEntries = entryStatuses.length
    click('run')
    await waitForStatus('succeeded', '未触发的第二个比较不应使主流程失败')
    const { states } = workspace.getRuntime()
    assert(requests.length === sharedBefore + 1, `共享文本的未触发比较发出了请求，主图成功请求应只新增 1 个，实际新增 ${requests.length - sharedBefore} 个`)
    assertEntryBeforeRequests(sharedEntries, '共享文本流程')
    for (const node of main) assert(states.get(node.id).status === 'succeeded', `主图节点 ${node.name} 应成功，实际 ${states.get(node.id).status}`)
    for (const node of extra) assert(states.get(node.id).status === 'skipped' && states.get(node.id).message.includes('开始'), `未触发节点 ${node.name} 应跳过并说明未从开始触发，实际 ${states.get(node.id).status}“${states.get(node.id).message}”`)
    await pause(60)
    assert(root.querySelectorAll('.wf-node[data-status="skipped"]').length === extra.length, '画布没有把未触发比较及其结果显示为跳过')
  }
  /** 样例保持原文本/数据连线顺序，仅追加开始节点与末位控制连线；开始、处理、结果同排，文本在开始节点下方且互不重叠。 */
  function assertSampleLayout(kind) {
    const flow = workspace.getDocument()
    const types = flow.nodes.map((node) => node.type).join()
    assert(types === `text,text,${kind}-compare,diff-result,start`, `${kind} 样例节点顺序不符，实际为 ${types}`)
    const ports = flow.edges.map((edge) => `${edge.source.port}>${edge.target.port}`).join()
    assert(ports === 'text>a,text>b,diff>diff,trigger>trigger', `${kind} 样例连线顺序不符，实际为 ${ports}`)
    const [textA, textB, compare, result, start] = flow.nodes
    assert(start.position.y === compare.position.y && compare.position.y === result.position.y, `${kind} 样例的开始/处理/结果没有同排`)
    assert(textA.position.y >= start.position.y + start.size.height && textB.position.y >= textA.position.y + textA.size.height, `${kind} 样例文本没有位于开始节点下方或互相重叠`)
    for (const [index, node] of flow.nodes.entries()) {
      for (const other of flow.nodes.slice(index + 1)) {
        const apart = node.position.x + node.size.width <= other.position.x || other.position.x + other.size.width <= node.position.x
          || node.position.y + node.size.height <= other.position.y || other.position.y + other.size.height <= node.position.y
        assert(apart, `${kind} 样例节点“${node.name}”与“${other.name}”重叠`)
      }
    }
  }
  try {
    await document.fonts?.ready // 字体加载会整体移动屏幕坐标，先等布局稳定再采样
    const jsonId = create('浏览器验收 JSON')
    click('undo')
    searchPalette('')
    const paletteDocument = workspace.exportDocument()
    const processing = [...root.querySelectorAll('.wf-folder')].find((folder) => folder.dataset.folderPath === '内容处理')
    assert(processing, '注册分类没有生成文件夹')
    processing.open = false
    await pause()
    control('palette-search').focus()
    searchPalette('JSON')
    assert(root.querySelectorAll('.wf-palette__item').length === 1 && root.querySelector('.wf-palette__item').dataset.type === 'json-compare', '搜索没有过滤节点类型')
    assert(root.querySelector('.wf-folder').open, '搜索没有展开匹配文件夹')
    assert(document.activeElement === control('palette-search'), '搜索重绘丢失了输入焦点')
    click('palette-clear')
    assert(![...root.querySelectorAll('.wf-folder')].find((folder) => folder.dataset.folderPath === '内容处理').open, '清除搜索后未恢复文件夹折叠')
    for (const [query, expected] of [['trigger', 'start,json-compare,env-compare'], ['开始', 'start']]) {
      searchPalette(query)
      const found = [...root.querySelectorAll('.wf-palette__item')].map((item) => item.dataset.type).join()
      assert(found === expected, `搜索“${query}”应匹配 ${expected}，实际为 ${found}`)
    }
    searchPalette('没有任何匹配的节点')
    assert(root.querySelectorAll('.wf-palette__item').length === 0 && !control('palette-empty').hidden, '无匹配提示不正确')
    control('palette-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    assert(control('palette-search').value === '' && root.querySelectorAll('.wf-palette__item').length === 5, 'Escape 没有清空搜索')
    assert(workspace.exportDocument() === paletteDocument && !workspace.canUndo() && requests.length === 0, '搜索或折叠修改了流程/历史或发起请求')
    const literalType = 'qa-palette-literal'
    workspace.registry.register({ type: literalType, version: 1, label: '<img data-wf-palette-injected src=x onerror="window.__wfPaletteInjected=1">', category: '扩展测试/转换', inputs: [], outputs: [], defaults: {}, size: { width: 280, height: 180 }, execute: () => ({}) })
    addedDefinitions.push(`${literalType}@1`)
    searchPalette(literalType)
    assert(root.querySelectorAll('.wf-folder').length === 2 && [...root.querySelectorAll('.wf-folder')].every((folder) => folder.open), '多层分类没有展开完整路径')
    assert(control('palette').textContent.includes('<img') && !root.querySelector('img[data-wf-palette-injected]') && window.__wfPaletteInjected !== 1, '目录标签被当作 HTML 执行')
    workspace.registry.definitions.delete(addedDefinitions.pop())
    searchPalette('JSON')
    root.querySelector('.wf-palette__item').click()
    assert(workspace.getDocument().nodes[0]?.type === 'json-compare', '过滤后点击节点不能添加')
    assert(workspace.getDocument().nodes.length === 1 && !control('run').disabled && workspace.getRuntime().status === 'idle', '过滤后新增的比较节点应可编辑且可点击运行')
    await expectRunRejected(/开始节点/, '只有比较节点、没有开始节点的流程运行')
    click('undo')
    assert(workspace.getDocument().nodes.length === 0, '过滤后添加节点不能撤销')
    click('palette-clear')
    await panBlank(true)
    assert(!workspace.canUndo(), 'Ctrl 平移进入了编辑历史')
    report.push('分类文件夹、多层搜索、折叠恢复、空态、焦点、安全文本和过滤后添加通过')
    report.push('Ctrl 左键空白平移、选择保留和视口不入编辑历史通过')
    click('template-json')
    assert(workspace.getDocument().nodes.length === 5 && workspace.getDocument().edges.length === 4, '样例节点或连接不完整')
    assert(typeNodes('start').length === 1, '样例没有恰好包含一个开始节点')
    assertSampleLayout('json')
    await verifyDragOnlyViewport()
    verifyNodeScrollBoundary()
    report.push('普通/横向/Shift 滚轮与无修饰键触控板不改变视口，节点内部滚动及边缘隔离、方向键不平移、Ctrl/右键/中键拖动与工具栏缩放通过')
    click('undo')
    assert(workspace.getDocument().nodes.length === 0, '样例载入不是单次撤销')
    click('redo')
    assert(workspace.getDocument().nodes.length === 5, '样例重做失败')
    assert(requests.length === 0, '编辑或样例载入自动发出了请求')
    click('run')
    await waitFor(() => workspace.getRuntime().status === 'succeeded', 'JSON 真实接口运行失败')
    const startState = workspace.getRuntime().states.get(typeNodes('start')[0].id)
    assert(startState.status === 'succeeded' && requests.length === 1, `样例运行应先让开始节点成功再发 1 个请求，实际开始节点 ${startState.status}，请求 ${requests.length}`)
    assertEntryBeforeRequests(0, 'JSON 样例运行')
    const resultNode = workspace.getDocument().nodes.find((node) => node.type === 'diff-result')
    const resultHost = root.querySelector(`[data-node-id="${resultNode.id}"]`)
    assert(resultHost.querySelector('.wf-result__summary')?.textContent === '发现变化', '节点内没有展示真实差异')
    resultHost.querySelector('[data-tab="tree"]').click()
    assert(resultHost.querySelectorAll('.wf-tree__row').length > 1, '差异树没有可见明细')
    resultHost.querySelector('[data-tab="json"]').click()
    assert(JSON.parse(resultHost.querySelector('.wf-pane__code--json').textContent).stats.added > 0, '结构化输出与可视化结果不一致')
    resultHost.querySelector('[data-tab="pairs"]').click()
    assert(resultHost.querySelectorAll('.wf-pane__markers').length === 2 && resultHost.querySelectorAll('.wf-pane__marker').length > 0, '真实 JSON 对比结果未显示两侧差异位置轨道')
    await verifyWheelZoom()
    report.push('Ctrl/Command+滚轮在空白、节点、文本和结果区域按鼠标锚点放大缩小，20%～200% 上下限、比例标签、选择保持与历史隔离通过')
    await verifyResultMarkers()
    report.push('结果滚动条差异概览：真实 JSON 标记、三类语义色、CR/LF/跨片段 CRLF、连续行合并、长文本位置、A/B 同步、节点尺寸变化、标签缓存和重跑/失败/取消清除通过')
    report.push('真实 JSON 接口、单步模板撤销重做、A/B 高亮、差异树和结构化输出通过')
    const stageStyle = getComputedStyle(control('stage'))
    assert(luminance(stageStyle.backgroundColor) < 0.1, '工作流画布未采用暗黑背景')
    const textStyle = getComputedStyle(root.querySelector('.wf-text'))
    assert((luminance(textStyle.color) + 0.05) / (luminance(textStyle.backgroundColor) + 0.05) >= 4.5, '暗色文本编辑器对比度不足')
    assert(luminance(getComputedStyle(root.querySelector('.wf-pane__code')).backgroundColor) < 0.1, '结果节点仍有浅色背景')
    window.location.hash = 'json-compare'
    await waitFor(() => document.querySelector('.main-content').dataset.route === 'json-compare', '无法切换回原有对比页')
    assert(luminance(getComputedStyle(document.body).backgroundColor) > 0.5, '工作流暗色污染了其他页面')
    window.location.hash = 'workflow'
    await waitFor(() => document.querySelector('.main-content').dataset.route === 'workflow', '无法返回工作流')
    assert(luminance(getComputedStyle(document.body).backgroundColor) < 0.1, '返回工作流没有恢复暗色壳层')
    report.push('暗色画布/结果、文本对比度和其他路由浅色隔离通过')

    assertLegacyEdgeUiRemoved()
    const initialEdges = documentEdges().map((edge) => edge.id)
    assert(initialEdges.length === 4 && root.querySelectorAll('.x6-edge').length === 4 && !root.querySelector('.wf-edge-line--preview'), '样例连线没有渲染为 4 条正式连线（3 条数据线 + 1 条开始控制线）')
    initialEdges.forEach(assertEdgeAppearance)
    assertAllEdgeEndpoints('样例载入后')
    const controlEdge = documentEdges().find((edge) => edge.source.port === 'trigger')
    assert(controlEdge && controlEdge.id === initialEdges[3] && controlEdge.target.port === 'trigger', '样例第四条连线不是开始节点的控制线')
    assertEdgeEndpoints(controlEdge, '开始控制线')
    assertNoVisualState()
    const movedBeforeMenu = await verifyFlowMotion(initialEdges)
    const movedAfterMenu = await verifyMenuMotionPause(initialEdges)
    report.push('旧连线面板/表单/列表移除；连线无文字/标签/marker，16px 透明命中路径与流光 pointer-events 通过')
    report.push(`流光 3 组 CSS offset-path 引用实际路径并生成 2.8s 错位 CSSAnimation（无 SMIL）、root 暂停类/computed 状态/currentTime 冻结、菜单切换暂停与返回恢复通过；${movedBeforeMenu && movedAfterMenu ? '光点位移与贴合曲线已验证' : '当前原生减少动效或页面隐藏，仅验证暂停/隐藏而未要求移动'}`)

    const svg = root.querySelector('.x6-graph-svg')
    assert(svg.getBoundingClientRect().width > 100, '主 SVG 被全局图标尺寸覆盖')
    const first = workspace.getDocument().nodes.find((node) => node.type === 'text')
    const firstHost = root.querySelector(`[data-node-id="${first.id}"]`)
    assert(Math.abs(firstHost.getBoundingClientRect().height - first.size.height * graph.zoom()) < 3, 'foreignObject body 被全局页面高度覆盖')
    const initialPosition = { ...first.position }
    const nodePosition = () => workspace.getDocument().nodes.find((node) => node.id === first.id).position
    await drag(firstHost.querySelector('.wf-node__kind'), { x: 48, y: 24 })
    assert(nodePosition().x !== initialPosition.x, '真实鼠标拖动没有写回节点位置')
    assertAllEdgeEndpoints('节点拖动后')
    click('undo')
    assert(nodePosition().x === initialPosition.x, '节点移动撤销失败')
    assert(workspace.getRuntime().status === 'succeeded', '布局撤销错误清除了结果')
    await pause(30)
    assertAllEdgeEndpoints('撤销节点拖动后')
    click('redo')
    await pause(30)
    assert(nodePosition().x !== initialPosition.x, '节点移动重做失败')
    assertAllEdgeEndpoints('重做节点拖动后')
    click('undo')
    await pause(30)
    assert(nodePosition().x === initialPosition.x, '重做后再次撤销节点移动失败')
    assertAllEdgeEndpoints('再次撤销节点拖动后')
    graph.resetSelection(first.id)
    const handle = root.querySelector('.x6-widget-transform-resize[data-position="bottom-right"]')
    assert(handle, '选中节点后没有调整尺寸手柄')
    await drag(handle, { x: 40, y: 30 })
    assert(workspace.getDocument().nodes.find((node) => node.id === first.id).size.width > first.size.width, '尺寸手柄没有写回节点尺寸')
    assertAllEdgeEndpoints('调整节点尺寸后')
    click('undo')
    await pause(30)
    assertAllEdgeEndpoints('撤销调整尺寸后')
    report.push('SVG/body 样式隔离、鼠标拖动、尺寸手柄及布局撤销保留结果通过；拖动/调整尺寸/撤销/重做后连线端点与端口圆心重合（误差 <= 0.75px）')

    const sourceEdge = workspace.getDocument().edges.find((edge) => edge.source.nodeId === first.id)
    workspace.disconnect(sourceEdge.id)
    const sourcePort = root.querySelector(`[data-cell-id="${first.id}"] [port="out:text"]`)
    const targetPort = root.querySelector(`[data-cell-id="${sourceEdge.target.nodeId}"] [port="in:${sourceEdge.target.port}"]`)
    const s = sourcePort.getBoundingClientRect(), t = targetPort.getBoundingClientRect()
    mouse(sourcePort, 'mousedown', { x: s.x + s.width / 2, y: s.y + s.height / 2 })
    mouse(document, 'mousemove', { x: t.x + t.width / 2, y: t.y + t.height / 2 })
    mouse(targetPort, 'mousemove', { x: t.x + t.width / 2, y: t.y + t.height / 2 })
    mouse(targetPort, 'mouseup', { x: t.x + t.width / 2, y: t.y + t.height / 2 })
    await waitFor(() => workspace.getDocument().edges.length === 4, '拖线没有创建正式连接')
    await pause(30)
    assertAllEdgeEndpoints('真实拖线创建后')
    report.push('真实端口鼠标拖拽连线通过，新建连线端点与端口圆心重合')

    const interactionEdges = documentEdges()
    assert(interactionEdges.length === 4 && root.querySelectorAll('.x6-edge').length === 4 && !root.querySelector('.wf-edge-line--preview'), '拖线后临时线残留或正式连线数量不符')
    interactionEdges.forEach((edge) => assertEdgeAppearance(edge.id))
    const interactionIds = interactionEdges.map((edge) => edge.id)
    await verifyEndpointsAcrossViewports()
    const selectionMoved = await verifyEdgeSelectionMotion(interactionIds)
    await verifyEdgeSelection(interactionIds)
    assertNoVisualState()
    await verifyEdgeDeletion(interactionIds)
    await verifyEdgeKeyboard(interactionIds)
    await verifyEdgeFollowsNode(interactionEdges.find((edge) => edge.source.nodeId === first.id), first.id)
    graph.cleanSelection()
    assertNoVisualState()
    report.push('真实屏幕点命中连线、选中类/aria-pressed/线宽、Ctrl 单次切换多选、Delete/工具栏仅删线与撤销重做通过；撤销/重做后端点仍与端口圆心重合')
    report.push(`选中连线停止流向：单选冻结且其他线继续、Ctrl 多选同时冻结、Ctrl 取消后仅该线恢复、清空选择全部恢复，恢复沿用原 CSSAnimation 时间通过；${selectionMoved ? '位置冻结/继续已按屏幕实际位移验证' : '当前原生减少动效或页面隐藏，仅验证暂停状态与动画时间'}`)
    report.push('缩放 0.35/1/1.6 与平移后端点与端口圆心重合、光点贴合曲线，恢复原视口且不污染业务历史通过')
    report.push(`键盘 Tab 聚焦选中、Enter/Space/Ctrl 切换、Delete 通过${focusFallbacks ? `（页面无系统焦点，${focusFallbacks} 次补发 focusin）` : ''}；节点移动后连线与光点跟随并可撤销通过`)

    const textNodes = workspace.getDocument().nodes.filter((node) => node.type === 'text')
    const positions = textNodes.map((node) => ({ id: node.id, ...node.position }))
    graph.cleanSelection()
    const beforeCtrlClick = JSON.stringify(graph.translate())
    for (const [index, node] of textNodes.entries()) {
      const header = root.querySelector(`[data-node-id="${node.id}"] .wf-node__kind`)
      const rect = header.getBoundingClientRect()
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, ctrlKey: index > 0 }
      mouse(header, 'mousedown', point)
      mouse(document, 'mouseup', point)
      mouse(header, 'click', point)
    }
    assert(textNodes.every((node) => graph.isSelected(node.id)), 'Ctrl 点击节点没有保留多选')
    assert(JSON.stringify(graph.translate()) === beforeCtrlClick, 'Ctrl 点击节点错误触发画布平移')
    const input = root.querySelector(`[data-node-id="${first.id}"] textarea`)
    const inputRect = input.getBoundingClientRect()
    mouse(input, 'mousedown', { x: inputRect.x + 8, y: inputRect.y + 8, ctrlKey: true })
    mouse(document, 'mousemove', { x: inputRect.x + 40, y: inputRect.y + 20, ctrlKey: true })
    mouse(document, 'mouseup', { x: inputRect.x + 40, y: inputRect.y + 20, ctrlKey: true })
    assert(JSON.stringify(graph.translate()) === beforeCtrlClick, 'Ctrl 在文本框内操作被画布劫持')
    graph.resetSelection(textNodes.map((node) => node.id))
    await drag(root.querySelector(`[data-node-id="${first.id}"] .wf-node__kind`), { x: 40, y: 20 })
    assert(positions.every((position) => workspace.getDocument().nodes.find((node) => node.id === position.id).position.x !== position.x), '多选拖动未同时移动节点')
    click('undo')
    assert(positions.every((position) => workspace.getDocument().nodes.find((node) => node.id === position.id).position.x === position.x), '多选拖动不是单次撤销')
    graph.cleanSelection()
    const boxes = textNodes.map((node) => root.querySelector(`[data-node-id="${node.id}"]`).getBoundingClientRect())
    const start = { x: Math.min(...boxes.map((box) => box.left)) - 12, y: Math.min(...boxes.map((box) => box.top)) - 12 }
    const end = { x: Math.max(...boxes.map((box) => box.right)) + 12, y: Math.max(...boxes.map((box) => box.bottom)) + 12 }
    mouse(svg, 'mousedown', start)
    mouse(document, 'mousemove', end)
    mouse(document, 'mouseup', end)
    await pause(80)
    assert(textNodes.every((node) => graph.isSelected(node.id)), '空白处鼠标框选失败')
    graph.resetSelection(first.id)
    control('stage').focus()
    const key = (name, ctrl = false) => control('stage').dispatchEvent(new KeyboardEvent('keydown', { key: name, ctrlKey: ctrl, bubbles: true, cancelable: true }))
    const nodeCount = workspace.getDocument().nodes.length
    key('d', true)
    assert(workspace.getDocument().nodes.length === nodeCount + 1, 'Ctrl+D 没有复制选中节点')
    key('Delete')
    assert(workspace.getDocument().nodes.length === nodeCount, 'Delete 没有删除选中节点')
    key('z', true)
    assert(workspace.getDocument().nodes.length === nodeCount + 1, '快捷键删除无法撤销')
    key('z', true)
    assert(workspace.getDocument().nodes.length === nodeCount, '快捷键复制无法撤销')
    report.push('鼠标框选、多选拖动单步撤销、Ctrl+D、Delete 与 Ctrl+Z 通过')

    const textarea = root.querySelector(`[data-node-id="${first.id}"] textarea`)
    textarea.value = '{"edited":true}'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    holdNext = true
    release = null
    click('run')
    await waitFor(() => typeof release === 'function', '运行前未刷新待保存输入或处理节点未启动')
    assert(workspace.getDocument().nodes.find((node) => node.id === first.id).config.text === '{"edited":true}', '立即点击运行遗漏防抖输入')
    assert([...root.querySelectorAll('.wf-text')].every((element) => element.readOnly), '运行期间文本未锁定')
    assert(control('doc-remove').disabled && control('doc-duplicate').disabled && control('undo').disabled, '运行期间结构操作未锁定')
    await verifyWheelZoom()
    await panBlank(true)
    await panBlank(false, 2)
    searchPalette('JSON')
    const lockedItem = root.querySelector('.wf-palette__item')
    assert(lockedItem.disabled && !lockedItem.draggable && !control('palette-search').readOnly && !control('palette-clear').disabled, '运行锁错误影响搜索或没有锁定过滤结果')
    const dragEvent = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
    lockedItem.dispatchEvent(dragEvent)
    assert(dragEvent.defaultPrevented, '运行中仍可拖出过滤后的节点')
    click('palette-clear')
    await verifyRunLockedEdges()
    report.push('运行中 Ctrl/右键平移、搜索可用与节点拖入锁定通过')
    report.push('运行锁期间可选中连线（光点仍冻结、其余线继续）、删除按钮禁用且 Delete 无效、Ctrl 平移保留选择、节点不可拖动通过')
    const envId = create('浏览器验收 ENV')
    assert(workspace.getRuntime(jsonId).running, '切换工作流取消了旧流程')
    click('template-env')
    assertSampleLayout('env')
    click('run')
    await waitFor(() => workspace.getRuntime(envId).status === 'succeeded', '独立 ENV 工作流真实执行失败')
    assert(root.querySelectorAll('.wf-pane__markers').length === 2 && root.querySelector('.wf-pane__marker'), '真实 ENV 结果没有复用差异位置轨道')
    assert(workspace.getRuntime(jsonId).running, '独立流程状态互相覆盖')
    release()
    await waitFor(() => workspace.getRuntime(jsonId).status === 'succeeded', '切换后原流程没有继续完成')
    selectFlow(jsonId)
    assert(root.querySelector('.wf-result__summary'), '返回原流程没有恢复内存结果')
    report.push('防抖输入强制提交、运行锁、多流程同时执行、ENV 真实接口和切换后结果恢复通过')

    holdNext = true
    release = null
    click('run')
    await waitFor(() => typeof release === 'function', '停止用例未进入执行')
    click('stop')
    assert(workspace.getRuntime().status === 'cancelled' && !root.querySelector('.wf-text').readOnly, '停止未立即解锁')
    release()
    await pause(80)
    assert(workspace.getRuntime().status === 'cancelled', '迟到执行覆盖了停止状态')
    click('run')
    await waitFor(() => workspace.getRuntime().status === 'succeeded', '停止后重新运行失败')
    report.push('停止解锁、迟到结果隔离和重新运行通过')

    const good = JSON.parse(workspace.exportDocument())
    create('浏览器验收分支失败')
    const goodNodes = workspace.insertSubgraph({ nodes: good.nodes, edges: good.edges })
    const sharedStart = goodNodes.find((node) => node.type === 'start')
    const bad = structuredClone(good)
    const badStartId = bad.nodes.find((node) => node.type === 'start').id
    bad.nodes = bad.nodes.filter((node) => node.id !== badStartId) // 两个分支共用同一个开始节点，第二套子图不能再带入口
    bad.edges = bad.edges.filter((edge) => edge.source.nodeId !== badStartId && edge.target.nodeId !== badStartId)
    bad.nodes.find((node) => node.type === 'text').config.text = '{broken'
    for (const node of bad.nodes) node.position.y += 800
    const badNodes = workspace.insertSubgraph({ nodes: bad.nodes, edges: bad.edges })
    workspace.connect({ source: { nodeId: sharedStart.id, port: 'trigger' }, target: { nodeId: badNodes.find((node) => node.type === 'json-compare').id, port: 'trigger' } })
    assert(typeNodes('start').length === 1 && workspace.getDocument().edges.filter((edge) => edge.source.nodeId === sharedStart.id).length === 2, '失败隔离流程应由一个开始节点启动两个独立分支')
    const branchBefore = requests.length
    const branchEntries = entryStatuses.length
    click('run')
    await waitForStatus('partial', '失败分支影响了独立分支')
    const states = [...workspace.getRuntime().states.values()]
    assert(states.filter((state) => state.status === 'failed').length === 1 && states.filter((state) => state.status === 'skipped').length === 1, `失败或下游跳过状态不正确：${JSON.stringify(states.map((state) => state.status))}`)
    assert(workspace.getRuntime().states.get(sharedStart.id).status === 'succeeded' && requests.length === branchBefore + 2, `共享开始节点应成功并触发两个比较请求，实际请求新增 ${requests.length - branchBefore}`)
    assertEntryBeforeRequests(branchEntries, '失败隔离流程')
    assert(root.querySelector('.wf-node[data-status="failed"] .wf-node__message').textContent, '节点没有展示接口错误')
    report.push('单个开始节点启动两个分支：实际后端输入错误、仅阻断下游、独立分支成功和内联错误提示通过')

    const beforeImport = workspace.documents.length
    const beforeActive = workspace.activeId
    await upload('{broken')
    assert(workspace.documents.length === beforeImport && workspace.activeId === beforeActive && !control('error').hidden, '失败导入修改了当前工作区')
    const unknown = structuredClone(good)
    unknown.nodes[0].version = 99
    const beforeRequests = requests.length
    await upload(JSON.stringify(unknown))
    created.push(workspace.activeId)
    assert(root.querySelector('.wf-node--unknown'), '未知版本节点没有保留占位')
    click('run')
    await waitFor(() => !control('error').hidden, '未知节点没有阻止运行')
    assert(requests.length === beforeRequests, '未知节点或导入自动执行了请求')
    report.push('真实文件导入的失败原子性、未知版本保留和不自动请求通过')

    await verifyEntryRules(good)
    report.push('入口规则通过：无开始节点旧图可导入编辑但运行不发请求、补开始节点与启动线后成功；开始节点未连出拒绝；已有开始节点时新增/复制/多入口导入原子拒绝而整流程复制有效；共享文本的未触发比较与结果跳过且主图请求只增加 1；所有请求晚于开始节点成功')
    const saved = JSON.parse(localStorage.getItem(window.NestCloudWorkflowCore.STORAGE_KEY))
    assert(saved.documents.every((flow) => !('runtime' in flow) && flow.nodes.every((node) => !('outputs' in node) && !('state' in node))), '运行结果进入了持久化文档')
    report.push('localStorage 只保存流程定义和输入，不保存运行结果通过')
    const lifecycleMoved = await verifyMotionPreferenceLifecycle(jsonId)
    assertNoVisualState()
    report.push(`减少动效 MediaQueryList 变化、文档隐藏（root 暂停类 + 光点 hidden/paused、不再依赖 SVG 时间轴）、destroy 取消旧 CSSAnimation、同一 root 重新挂载与旧监听移除通过；${lifecycleMoved ? '恢复后光点位移已验证' : '原生减少动效或页面隐藏，未要求恢复后位移'}`)
    return JSON.stringify({ passed: report.length, checks: report, requests })
  } finally {
    release?.()
    workspace.services.compare = originalCompare
    for (const id of created.reverse()) {
      if (workspace.getRuntime(id).running) workspace.stop(id)
      workspace.remove(id)
    }
    workspace.select(initialId)
    for (const key of addedDefinitions) workspace.registry.definitions.delete(key)
    searchPalette(originalQuery)
    for (const folder of root.querySelectorAll('.wf-folder')) {
      if (originalFolders.has(folder.dataset.folderPath)) folder.open = originalFolders.get(folder.dataset.folderPath)
    }
  }
})().then((result) => {
  window.__workflowBrowserReport = result
  return result
}, (error) => {
  window.__workflowBrowserReport = { error: error.message }
  throw error
})
