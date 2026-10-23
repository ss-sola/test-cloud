window.__workflowDirectoryBrowserCheck = (async () => {
  const root = document.querySelector('[data-view="workflow"]')
  const host = document.querySelector('#workflow-sidebar-host')
  let instance = window.NestCloudWorkflow.mount(root)
  const { workspace } = instance
  const initialId = workspace.activeId
  const initialIds = new Set(workspace.documents.map((flow) => flow.id))
  const bindingKey = window.NestCloudWorkflowFiles.STORAGE_KEY
  const originalBindings = window.localStorage.getItem(bindingKey)
  const originalFetch = window.fetch
  const pickerDescriptor = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker')
  const report = []
  const requests = []
  const files = new Map()
  const pickerCalls = []
  let revisionCounter = 0
  let failList = false
  let delayedRead = null
  const revision = () => (++revisionCounter).toString(16).padStart(64, '0')
  /** 工作流导航与面板已移入系统侧栏宿主；只在工作流 root 与宿主内联合查询，不扫描其他页面。 */
  const control = (name) => root.querySelector(`[data-wf="${name}"]`) ?? host.querySelector(`[data-wf="${name}"]`)
  const sideAll = (selector) => [...root.querySelectorAll(selector), ...host.querySelectorAll(selector)]
  const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const fileButtons = () => [...control('directory-list').querySelectorAll('button')]
  const fileNames = () => fileButtons().map((button) => button.dataset.directoryName)
  const listRequests = () => requests.filter((entry) => entry.url.endsWith('/list')).length
  const leaves = () => [...control('palette').querySelectorAll('.wf-palette__item')]
  const categories = () => [...control('palette').querySelectorAll('.wf-folder[data-folder-path]')]
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message)
      await pause()
    }
  }
  /** 等待目录操作完成：aria-busy 回到 false 且不再有新请求。 */
  async function settle(message) {
    await pause()
    await waitFor(() => control('directory-panel').getAttribute('aria-busy') === 'false', message)
  }
  function type(name, value) {
    control(name).value = value
    control(name).dispatchEvent(new Event('input', { bubbles: true }))
  }
  const escape = (name) => control(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  function response(status, data, extra = {}) {
    return new Response(JSON.stringify({ code: status, message: status === 200 ? '成功' : '目录操作失败', data, ...extra }), { status, headers: { 'Content-Type': 'application/json' } })
  }
  window.fetch = async (url, options = {}) => {
    const address = new URL(url, window.location.origin)
    if (!address.pathname.startsWith('/api/workflow-directory/')) return originalFetch(url, options)
    assert(options.credentials === 'same-origin' && options.cache === 'no-store', '目录请求未使用同源凭据或 no-store')
    assert(options.method === 'GET' && !options.body, '项目目录面板不应发起写入请求')
    requests.push({ url: address.pathname + address.search, method: options.method })
    if (address.pathname.endsWith('/list')) {
      if (failList) return response(503, null)
      return response(200, { directory: 'public/workflow', list: [...files.keys()].map((name) => ({ name })) })
    }
    if (delayedRead) await delayedRead
    const name = address.searchParams.get('filename')
    const file = files.get(name)
    return file ? response(200, { filename: name, ...file }) : response(404, null)
  }
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: (...args) => { pickerCalls.push(args) } })
  instance.destroy()
  assert(!root.hidden, '请先进入工作流路由再执行目录验收')
  instance = window.NestCloudWorkflow.mount(root)
  try {
    const panel = control('directory-panel')
    const folder = control('directory-folder')
    const summary = folder.querySelector(':scope > summary')

    /* ---------------- 侧栏 portal ---------------- */
    const sidebarAside = document.querySelector('#sidebar')
    assert(host && sidebarAside.contains(host) && host.previousElementSibling?.classList.contains('brand-block') && host.nextElementSibling?.classList.contains('primary-nav'), '工作流入口宿主应位于品牌区之后、主导航之前')
    assert(host.querySelectorAll('[data-wf="sidebar"]').length === 1 && !root.querySelector('[data-wf="nav-directory"]') && !root.querySelector('[data-wf="nav-palette"]') && host.contains(control('nav-directory')) && host.contains(control('nav-palette')), '导航与面板应整体移入侧栏宿主且只有一份')
    assert(!host.hidden && panel.hidden && control('palette-panel').hidden && requests.length === 0, '挂载时应只显示两个入口，不能提前请求目录')
    for (const removed of ['directory-save', 'directory-refresh', 'directory-filename', 'directory-status', 'directory-path', 'directory-empty', 'directory-close', 'directory-error', 'directory-choose', 'directory-up', 'directory-support', 'palette-close', 'palette-clear', 'palette-count', 'palette-empty']) {
      assert(!control(removed), `侧栏仍保留已移除控件 ${removed}`)
    }
    const stage = control('stage').getBoundingClientRect()
    assert(stage.width > 0 && stage.height > 0 && document.documentElement.scrollWidth <= window.innerWidth + 1, '画布没有可用尺寸或页面出现横向溢出')
    report.push(`入口移入品牌区后、主导航前的 #workflow-sidebar-host，仅一份 sidebar；已移除说明/计数/清除/关闭控件；画布 ${Math.round(stage.width)}x${Math.round(stage.height)}，视口 ${window.innerWidth}x${window.innerHeight}`)

    /* ---------------- 目录：结构与纯文本 ---------------- */
    const flow = workspace.create('固定目录回归')
    const originalText = workspace.exportDocument()
    files.set('read.json', { text: originalText, revision: revision() })
    files.set('bad.json', { text: '{bad', revision: revision() })
    files.set('Weekly Report.json', { text: originalText, revision: revision() })
    files.set('ＡＢＣ.json', { text: originalText, revision: revision() })
    files.set('<img data-directory-injected src=x>.json', { text: originalText, revision: revision() })
    assert(folder instanceof HTMLDetailsElement && folder.open && summary && panel.querySelectorAll('details').length === 1, '项目目录应只有一个默认展开的原生 details 文件夹')
    assert(panel.querySelectorAll('input').length === 1 && panel.querySelector('input[type="search"]') && !panel.querySelector('p, h1, h2, h3, textarea, select, small, button'), '项目目录面板应只有搜索框与文件夹')
    control('nav-directory').click()
    await settle('首次打开目录未结束')
    assert(!panel.hidden && control('palette-panel').hidden && listRequests() === 1, '首次打开未读取目录或未与节点库互斥')
    const everyName = fileNames()
    assert(everyName.length === 5 && panel.querySelectorAll('button').length === 5, '目录内应只有文件按钮')
    assert(fileButtons().every((button) => button.textContent === button.dataset.directoryName) && !panel.querySelector('img') && !panel.querySelector('[data-directory-injected]'), '文件名应作为纯文本渲染')
    report.push('项目目录面板仅含搜索框、一个原生 details 与纯文本文件按钮')

    /* ---------------- 目录：本地搜索 ---------------- */
    const documentBefore = workspace.exportDocument()
    const flowCount = workspace.documents.length
    const requestsBefore = requests.length
    type('directory-search', 'ＲＥＡＤ')
    assert(JSON.stringify(fileNames()) === JSON.stringify(['read.json']), 'NFKC/大小写不敏感搜索未匹配 read.json')
    type('directory-search', 'abc')
    assert(JSON.stringify(fileNames()) === JSON.stringify(['ＡＢＣ.json']), '全角文件名未按 NFKC 匹配')
    type('directory-search', 'weekly   REPORT')
    assert(JSON.stringify(fileNames()) === JSON.stringify(['Weekly Report.json']), '多词搜索未要求全部词匹配')
    type('directory-search', 'weekly bad')
    assert(fileButtons().length === 0, '多词搜索应要求每个词都出现')
    type('directory-search', '<img')
    assert(fileButtons().length === 1 && !panel.querySelector('img'), '按字面搜索 HTML 文件名失败')
    type('directory-search', '')
    assert(fileButtons().length === 5, '清空查询未恢复完整列表')
    await pause(60)
    assert(requests.length === requestsBefore && workspace.exportDocument() === documentBefore && workspace.documents.length === flowCount, '文件搜索不应请求网络或改变工作区')
    report.push('文件搜索：NFKC、大小写不敏感、多词全匹配、HTML 字面匹配；无网络请求且工作区不变')

    /* ---------------- 目录：折叠与搜索临时展开 ---------------- */
    summary.click()
    await pause(60)
    assert(!folder.open && listRequests() === 1, '收起文件夹不应请求目录')
    type('directory-search', 'read')
    assert(folder.open && fileNames().length === 1, '搜索未临时展开文件夹')
    await pause(80)
    assert(listRequests() === 1, '搜索引发的 toggle 不应请求目录')
    type('directory-search', '')
    await pause(80)
    assert(!folder.open && listRequests() === 1, '清空搜索未恢复折叠状态，或恢复时请求了目录')
    summary.click()
    await waitFor(() => listRequests() === 2, '手动展开文件夹未刷新目录')
    await settle('展开刷新未结束')
    const beforeReopen = listRequests()
    control('nav-directory').click()
    assert(panel.hidden, '再次点击导航应收起目录')
    control('nav-directory').click()
    await settle('重新打开目录未结束')
    assert(listRequests() === beforeReopen + 1 && folder.open, '重新打开导航且展开时应刷新目录')
    report.push('折叠状态：搜索临时展开且清空恢复、搜索引发的 toggle 不请求，手动展开与重新打开导航才刷新')

    /* ---------------- Esc 两步与面板间保持 ---------------- */
    type('directory-search', 'read')
    control('directory-search').focus()
    escape('directory-search')
    assert(control('directory-search').value === '' && fileButtons().length === 5 && !panel.hidden, 'Esc 第一步应清空查询而不关闭面板')
    escape('directory-search')
    assert(panel.hidden && document.activeElement === control('nav-directory'), 'Esc 第二步应收起面板并恢复焦点')
    control('nav-directory').click()
    await settle('Esc 后重新打开未结束')
    type('directory-search', 'read')
    control('nav-palette').click()
    assert(!control('palette-panel').hidden && panel.hidden, '导航切换未互斥')
    type('palette-search', 'json')
    control('nav-directory').click()
    await settle('切换回目录未结束')
    assert(control('directory-search').value === 'read' && control('palette-search').value === 'json' && JSON.stringify(fileNames()) === JSON.stringify(['read.json']), '切换面板丢失文件或节点搜索')
    assert(workspace.exportDocument() === documentBefore && workspace.documents.length === flowCount, '搜索词进入了流程草稿')
    type('directory-search', '')
    type('palette-search', '')
    control('nav-directory').click()
    report.push('Esc 先清空查询、再收起并恢复焦点；两个面板互斥且各自保持搜索，不进入流程草稿')

    /* ---------------- 节点库：同款结构与搜索 ---------------- */
    control('nav-palette').click()
    const palettePanel = control('palette-panel')
    const paletteRoot = control('palette-folder')
    assert(!palettePanel.hidden && panel.hidden && paletteRoot instanceof HTMLDetailsElement && paletteRoot.open, '节点库根文件夹应为默认展开的 details')
    assert(palettePanel.querySelectorAll('input').length === 1 && palettePanel.querySelector('input[type="search"]') && !palettePanel.querySelector('p, h1, h2, h3, textarea, select, small'), '节点库应只有搜索框与文件夹，无说明、计数或端口小字')
    assert(palettePanel.querySelectorAll('button').length === leaves().length && leaves().length === workspace.registry.list().length && categories().length > 0, '节点库叶子应是纯按钮且数量等于已注册节点')
    assert(leaves().every((leaf) => leaf.children.length === 1 && leaf.children[0].tagName === 'SPAN' && leaf.textContent === workspace.registry.list().find((definition) => definition.type === leaf.dataset.type)?.label), '节点叶子应只显示名称')
    const category = categories()[0]
    category.open = false
    await pause(30)
    control('palette-search').focus()
    type('palette-search', 'json-compare')
    assert(leaves().length === 1 && leaves()[0].dataset.type === 'json-compare', '类型搜索没有精确过滤节点')
    assert(paletteRoot.open && categories().every((item) => item.open), '搜索应临时展开根与匹配分类')
    assert(document.activeElement === control('palette-search'), '搜索重绘丢失了输入焦点')
    type('palette-search', '没有任何匹配的节点')
    assert(leaves().length === 0 && categories().length === 0, '无结果时应没有叶子与分类（不再有空态段落）')
    type('palette-search', '')
    assert(leaves().length === workspace.registry.list().length && categories().find((item) => item.dataset.folderPath === category.dataset.folderPath)?.open === false, '清空搜索未恢复完整节点库与折叠状态')
    paletteRoot.querySelector(':scope > summary').click()
    await pause(30)
    type('palette-search', 'json')
    assert(paletteRoot.open, '搜索未临时展开节点库根文件夹')
    type('palette-search', '')
    assert(!paletteRoot.open, '清空搜索未恢复节点库根折叠')
    paletteRoot.open = true
    category.open = true
    const nodeCount = workspace.getDocument().nodes.length
    type('palette-search', 'json-compare')
    leaves()[0].click()
    assert(workspace.getDocument().nodes.length === nodeCount + 1 && workspace.getDocument().nodes.at(-1).type === 'json-compare', '过滤后点击节点不能添加')
    type('palette-search', 'json')
    control('palette-search').focus()
    escape('palette-search')
    assert(control('palette-search').value === '' && !palettePanel.hidden && leaves().length === workspace.registry.list().length, '节点库 Esc 第一步应清空查询')
    escape('palette-search')
    assert(palettePanel.hidden && document.activeElement === control('nav-palette'), '节点库 Esc 第二步应收起面板')
    workspace.undo()
    report.push('节点库同款搜索框+文件夹树：无说明/计数/清除，搜索临时展开并恢复，无结果为 0 叶子，焦点保持，点击添加与 Esc 两步通过')

    /* ---------------- 文件读取与共享错误出口 ---------------- */
    control('nav-directory').click()
    await settle('读取前打开目录未结束')
    const errorOutput = control('error')
    const beforeInvalid = workspace.exportDocument()
    sideAll('[data-directory-name="bad.json"]')[0].click()
    await settle('无效文件读取未结束')
    assert(!errorOutput.hidden && errorOutput.textContent && !panel.contains(errorOutput) && !host.contains(errorOutput) && workspace.exportDocument() === beforeInvalid, '无效 JSON 应在页面共享错误出口显示且不污染已有流程')
    sideAll('[data-directory-name="read.json"]')[0].click()
    await settle('读取文件未结束')
    assert(errorOutput.hidden && workspace.activeId !== flow.id && workspace.getRuntime().status === 'idle', '读取不是新副本、未清除旧错误或自动运行')
    assert(workspace.documents.some((item) => item.id === flow.id), '读取覆盖了原流程')
    failList = true
    const originalNames = fileNames()
    control('nav-directory').click()
    control('nav-directory').click()
    await settle('刷新失败未结束')
    assert(!errorOutput.hidden && !host.contains(errorOutput) && JSON.stringify(fileNames()) === JSON.stringify(originalNames), '刷新失败应使用共享错误出口并保留旧列表')
    failList = false
    control('nav-directory').click()
    control('nav-directory').click()
    await settle('刷新重试未结束')
    assert(errorOutput.hidden, '刷新重试后错误未清除')
    report.push('点击文件导入新副本且不自动运行；错误只在页面共享出口，刷新失败保留列表并可重试')

    /* ---------------- 路由切换与销毁 ---------------- */
    window.location.hash = 'json-compare'
    await waitFor(() => root.hidden && host.hidden, '离开工作流路由后侧栏宿主未隐藏')
    window.location.hash = 'workflow'
    await waitFor(() => !root.hidden && !host.hidden, '返回工作流路由后侧栏宿主未恢复')
    assert(host.contains(control('nav-directory')), '路由往返后入口丢失')

    let releaseRead
    delayedRead = new Promise((resolve) => { releaseRead = resolve })
    sideAll('[data-directory-name="read.json"]')[0].click()
    const beforeDestroy = workspace.activeId
    const documentCount = workspace.documents.length
    instance.destroy()
    assert(host.hidden && host.children.length === 0 && root.querySelector('[data-wf="sidebar"]') && root.querySelector('[data-wf="nav-directory"]') && root.querySelector('[data-wf="palette-panel"]'), '销毁后侧栏应恢复到 root 内并隐藏宿主')
    releaseRead()
    delayedRead = null
    await pause(60)
    assert(workspace.activeId === beforeDestroy && workspace.documents.length === documentCount && errorOutput.hidden, '销毁后迟到读取仍导入或显示错误')
    instance = window.NestCloudWorkflow.mount(root)
    await pause()
    assert(host.querySelectorAll('[data-wf="sidebar"]').length === 1 && !root.querySelector('[data-wf="sidebar"]') && !host.hidden && control('directory-panel').hidden, '重新挂载后应只有一份侧栏且面板收起')
    assert(pickerCalls.length === 0, '不应调用浏览器目录选择器')
    report.push('离开/返回工作流路由时宿主隐藏与恢复；销毁后侧栏回到 root、迟到读取被隔离；重新挂载无重复宿主内容')
    return { passed: report.length, checks: report, directoryRequests: requests.length }
  } finally {
    window.fetch = originalFetch
    if (pickerDescriptor) Object.defineProperty(window, 'showDirectoryPicker', pickerDescriptor)
    else delete window.showDirectoryPicker
    for (const name of ['directory-search', 'palette-search']) if (control(name)?.value) type(name, '')
    for (const key of ['directory', 'palette']) if (control(`${key}-panel`) && !control(`${key}-panel`).hidden) control(`nav-${key}`).click()
    workspace.select(initialId)
    for (const doc of workspace.documents) if (!initialIds.has(doc.id)) workspace.remove(doc.id)
    instance.destroy()
    if (originalBindings === null) window.localStorage.removeItem(bindingKey)
    else window.localStorage.setItem(bindingKey, originalBindings)
    instance = window.NestCloudWorkflow.mount(root)
  }
})().then((result) => {
  window.__workflowDirectoryBrowserReport = result
  return result
}, (error) => {
  window.__workflowDirectoryBrowserReport = { error: error.message, stack: error.stack }
  throw error
})
