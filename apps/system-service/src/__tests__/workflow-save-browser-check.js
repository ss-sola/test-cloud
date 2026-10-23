window.__workflowSaveBrowserReport = null
window.__workflowSaveBrowserCheck = (async () => {
  const root = document.querySelector('[data-view="workflow"]')
  const host = document.querySelector('#workflow-sidebar-host')
  const FILES_KEY = 'nestcloud:workflow-files:v1'
  let instance = window.NestCloudWorkflow.mount(root)
  const { workspace } = instance
  const initialId = workspace.activeId
  const initialIds = new Set(workspace.documents.map((flow) => flow.id))
  const backup = { files: localStorage.getItem(FILES_KEY) }
  const originalFetch = window.fetch
  const originalConfirm = window.confirm
  const originalCreateObjectURL = URL.createObjectURL
  const originalAnchorClick = HTMLAnchorElement.prototype.click
  const originalHash = window.location.hash
  const report = []
  const server = new Map()
  const posts = []
  const downloads = []
  let confirmCalls = 0
  let inflight = 0
  let hold = null
  let revisionCounter = 0
  const revision = () => (++revisionCounter).toString(16).padStart(64, '0')
  const control = (name) => root.querySelector(`[data-wf="${name}"]`) ?? host.querySelector(`[data-wf="${name}"]`)
  const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const current = () => instance
  const record = (id) => JSON.parse(localStorage.getItem(FILES_KEY) ?? '{"records":[]}').records.find((item) => item.id === id)
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 6000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message)
      await pause()
    }
  }
  /** 派发保存快捷键；返回是否被页面阻止了浏览器默认保存。 */
  function press(target, init = {}) {
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true, ...init })
    return { prevented: !target.dispatchEvent(event) }
  }
  /** 触发一次保存并等待请求完成与界面更新。 */
  async function save(target, init = {}) {
    const before = posts.length
    const result = press(target, init)
    await waitFor(() => posts.length === before + 1 && inflight === 0, '保存请求没有完成')
    await pause(60)
    return { ...result, post: posts.at(-1) }
  }
  /** 保存应被忽略：默认行为按期望阻止，但不发出任何请求。 */
  async function expectNoSave(target, init, prevented, message) {
    const before = posts.length
    const result = press(target, init)
    await pause(120)
    assert(posts.length === before && inflight === 0 && result.prevented === prevented, message)
  }
  const hint = () => control('hint').textContent
  const errorText = () => (control('error').hidden ? '' : control('error').textContent)
  function remount() {
    instance.destroy()
    instance = window.NestCloudWorkflow.mount(root)
    return instance
  }
  function response(status, data, extra = {}) {
    return new Response(JSON.stringify({ code: status, message: status === 200 ? '成功' : '文件已存在或版本已变化', data, ...extra }), { status, headers: { 'Content-Type': 'application/json' } })
  }
  window.confirm = () => { confirmCalls += 1; return true }
  URL.createObjectURL = (...args) => { downloads.push('blob'); return originalCreateObjectURL.apply(URL, args) }
  HTMLAnchorElement.prototype.click = function click(...args) {
    if (this.download) downloads.push(this.download)
    return originalAnchorClick.apply(this, args)
  }
  window.fetch = async (url, options = {}) => {
    const address = new URL(url, window.location.origin)
    if (!address.pathname.startsWith('/api/workflow-directory/')) return originalFetch(url, options)
    assert(options.credentials === 'same-origin' && options.cache === 'no-store', '目录请求未使用同源凭据或 no-store')
    if (address.pathname.endsWith('/list')) return response(200, { directory: 'public/workflow', list: [...server.keys()].map((name) => ({ name })) })
    if (options.method === 'GET') {
      const filename = address.searchParams.get('filename')
      const file = server.get(filename)
      return file ? response(200, { filename, ...file }) : response(404, null)
    }
    const body = JSON.parse(options.body)
    posts.push({ filename: body.filename, expectedRevision: body.expectedRevision, text: body.text })
    inflight += 1
    try {
      if (hold) await hold
      const file = server.get(body.filename)
      const latest = file?.revision ?? null
      if (latest !== body.expectedRevision) return response(409, null, { revision: latest })
      const saved = { text: body.text, revision: revision() }
      server.set(body.filename, saved)
      return response(200, { filename: body.filename, revision: saved.revision })
    } finally { inflight -= 1 }
  }
  remount() // 使用受控 fetch 与确认函数重新创建目录客户端和文件服务
  try {
    assert(!root.hidden, '请先进入工作流路由再执行保存验收')

    /* ---------------- 极简顶部，保留已确认的区域按钮 ---------------- */
    const toolbar = root.querySelector('.wf-toolbar')
    const names = [...toolbar.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter((element) => element.type !== 'file').map((element) => element.dataset.wf)
    assert(JSON.stringify(names) === JSON.stringify(['doc-name', 'doc-create', 'doc-import', 'doc-export', 'run', 'stop', 'add-region']), `顶部只允许六项基础操作与已确认的区域按钮，实际 ${JSON.stringify(names)}`)
    for (const removed of ['doc-select', 'doc-duplicate', 'doc-remove', 'doc-save', 'undo', 'redo', 'copy-selection', 'delete-selection', 'zoom-in', 'zoom-out', 'zoom-reset', 'zoom-fit', 'zoom-label']) {
      assert(!control(removed), `已移除控件 ${removed} 仍然存在`)
    }
    const status = control('run-status')
    const statusBox = status.getBoundingClientRect()
    assert(status && !toolbar.contains(status) && statusBox.width <= 1 && statusBox.height <= 1, '运行状态应移到工具栏外并仅供读屏')
    report.push('顶部仅名称/新建/导入/导出/运行/停止及已确认的区域按钮，旧控件均不存在，运行状态移到工具栏外 sr-only')

    /* ---------------- Ctrl+S 从输入焦点保存最新内容 ---------------- */
    const flowA = workspace.create('QA 保存甲')
    const node = workspace.addNode('text', { x: 40, y: 40 })
    await pause(80)
    const textarea = root.querySelector(`[data-node-id="${node.id}"] textarea`)
    textarea.focus()
    textarea.value = 'Ctrl+S 最新文本'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    control('doc-name').value = 'QA 保存甲 新名称'
    const { tx, ty } = current().graph.translate()
    current().graph.translate(tx + 37, ty + 11)
    const first = await save(textarea)
    const saved = JSON.parse(first.post.text)
    assert(first.prevented, 'Ctrl+S 没有阻止浏览器默认保存')
    assert(first.post.filename === 'QA 保存甲 新名称.json' && first.post.expectedRevision === null, `首次保存应使用最新名称生成文件名，实际 ${first.post.filename}`)
    assert(saved.id === flowA.id && saved.name === 'QA 保存甲 新名称' && saved.nodes.find((item) => item.id === node.id).config.text === 'Ctrl+S 最新文本', '保存没有提交未失焦的名称或节点文本')
    assert(Math.abs(saved.viewport.x - (tx + 37)) <= 1 && Math.abs(saved.viewport.y - (ty + 11)) <= 1, '保存没有提交最新视口')
    assert(hint().includes('已保存“QA 保存甲 新名称.json”'), `成功提示应包含真实文件名，实际“${hint()}”`)
    assert(downloads.length === 0, 'Ctrl+S 不应触发网页下载')
    report.push('Ctrl+S 从节点输入焦点保存最新文本、未失焦名称与视口，阻止默认保存，提示真实文件名，无下载')

    // 忽略与不拦截的组合
    await expectNoSave(textarea, { shiftKey: true }, false, 'Ctrl+Shift+S 不应被保存拦截')
    await expectNoSave(textarea, { altKey: true }, false, 'Ctrl+Alt+S 不应被保存拦截')
    await expectNoSave(textarea, { repeat: true }, true, '按键重复应阻止默认行为但不重复保存')
    await expectNoSave(textarea, { isComposing: true }, true, '输入法组合期间应阻止默认行为但不保存')
    report.push('Shift/Alt 组合不拦截；repeat/isComposing 阻止默认但不重复保存')

    /* ---------------- 新建流程首次 name.json，Cmd+S 与侧栏焦点 ---------------- */
    const flowB = workspace.create('QA 首存')
    workspace.addNode('text', { x: 40, y: 40 })
    await pause(80)
    control('nav-directory').click()
    await pause(80)
    const afterB = await save(control('doc-name'), { ctrlKey: false, metaKey: true })
    assert(afterB.prevented && afterB.post.filename === 'QA 首存.json' && afterB.post.expectedRevision === null, `新建流程首存应使用 name.json 且 expectedRevision 为 null，实际 ${JSON.stringify(afterB.post.filename)}`)
    await waitFor(() => [...control('directory-list').querySelectorAll('button')].some((button) => button.dataset.directoryName === 'QA 首存.json'), '保存后可见的项目目录没有刷新')
    const firstRevision = server.get('QA 首存.json').revision
    assert(record(flowB.id)?.filename === 'QA 首存.json' && record(flowB.id).revision === firstRevision, '关联信息没有记录文件名与版本')
    workspace.rename(flowB.id, 'QA 改名后')
    control('nav-palette').click()
    const searchInput = control('palette-search')
    searchInput.focus()
    const second = await save(searchInput)
    assert(second.prevented && second.post.filename === 'QA 首存.json' && second.post.expectedRevision === firstRevision, '已关联流程应按源文件和版本连存，而不是按新名称另存')
    assert(confirmCalls === 0, '已有来源的保存不应弹出覆盖确认')
    report.push('新建流程首存 name.json 并刷新可见目录；改名后连存仍写原文件并携带版本；侧栏搜索框与 Cmd+S 同样生效，无确认')

    /* ---------------- 打开原文件保留名称并连续保存 ---------------- */
    const temp = workspace.create('QA 源名称')
    workspace.addNode('text', { x: 40, y: 40 })
    const sourceText = workspace.exportDocument()
    workspace.remove(temp.id)
    const sourceRevision = revision()
    server.set('QA 打开.json', { text: sourceText, revision: sourceRevision })
    control('nav-directory').click()
    await waitFor(() => !control('directory-panel').hidden && control('directory-panel').getAttribute('aria-busy') === 'false', '目录面板未打开')
    await pause(80)
    const openButton = () => [...control('directory-list').querySelectorAll('button')].find((button) => button.dataset.directoryName === 'QA 打开.json')
    assert(openButton(), '目录中没有 QA 打开.json')
    openButton().click()
    await waitFor(() => workspace.getDocument().name === 'QA 源名称', '打开文件后没有保留流程内名称')
    const opened = workspace.getDocument()
    assert(opened.id !== temp.id && record(opened.id)?.filename === 'QA 打开.json' && record(opened.id).revision === sourceRevision, '打开文件后没有绑定 filename 与 revision')
    const openedBox = opened.id
    const viaOpen1 = await save(control('doc-name'))
    const revisionAfterFirst = server.get('QA 打开.json').revision
    const viaOpen2 = await save(control('doc-name'))
    assert(viaOpen1.post.filename === 'QA 打开.json' && viaOpen1.post.expectedRevision === sourceRevision, '打开后的首次保存应携带源版本')
    assert(viaOpen2.post.filename === 'QA 打开.json' && viaOpen2.post.expectedRevision === revisionAfterFirst && revisionAfterFirst !== sourceRevision, '连续保存应使用上一次保存返回的版本')
    assert(confirmCalls === 0 && workspace.getDocument().name === 'QA 源名称', '打开后连存不应确认或改变流程名称')
    const documentCount = workspace.documents.length
    await pause(80)
    openButton()?.click()
    await pause(150)
    assert(workspace.documents.length === documentCount && workspace.activeId === openedBox, '再次打开同文件同版本应复用已有流程')
    report.push('目录打开保留流程名称并绑定源 filename+revision，连续保存无确认，重复打开同版本复用流程')

    /* ---------------- 保存中切换流程快照不串文件 ---------------- */
    workspace.select(flowB.id)
    await pause(80)
    const nodesOfB = JSON.parse(workspace.exportDocument(flowB.id)).nodes.length
    const nodesOfA = JSON.parse(server.get('QA 保存甲 新名称.json').text).nodes.length
    let release
    hold = new Promise((resolve) => { release = resolve })
    const before = posts.length
    press(control('doc-name'))
    await waitFor(() => posts.length === before + 1, '保持中的保存请求没有发出')
    workspace.select(flowA.id)
    workspace.addNode('text', { x: 200, y: 200 })
    workspace.select(flowB.id)
    workspace.addNode('text', { x: 240, y: 240 })
    release()
    hold = null
    await waitFor(() => inflight === 0, '保存请求没有结束')
    await pause(80)
    const writtenB = JSON.parse(server.get('QA 首存.json').text)
    const writtenA = JSON.parse(server.get('QA 保存甲 新名称.json').text)
    assert(posts.length === before + 1 && writtenB.id === flowB.id && writtenB.nodes.length === nodesOfB, '保存期间的编辑进入了已固定的快照')
    assert(writtenA.id === flowA.id && writtenA.nodes.length === nodesOfA, '保存期间切换流程改写了另一个文件')
    assert(record(flowB.id).revision === server.get('QA 首存.json').revision, '迟到的保存结果没有更新对应流程的版本')
    report.push('保存期间切换/编辑流程不影响已固定快照，不串写其他文件，版本只更新所属流程')

    /* ---------------- 已知版本 409：不确认、不重试 ---------------- */
    server.get('QA 首存.json').revision = revision()
    const staleRevision = record(flowB.id).revision
    const staleBefore = posts.length
    const stale = press(control('doc-name'))
    await waitFor(() => posts.length === staleBefore + 1 && inflight === 0, '版本冲突保存没有结束')
    await pause(120)
    assert(stale.prevented && posts.length === staleBefore + 1 && confirmCalls === 0, '已知版本冲突不应确认或自动重试')
    assert(errorText().includes('QA 改名后') && errorText().includes('文件已存在或版本已变化') && record(flowB.id).revision === staleRevision, `冲突应在页面错误出口展示且不更新关联版本，实际“${errorText()}”`)
    report.push('已知版本遇到 409 只请求一次、无确认，错误显示且关联版本保持不变')

    /* ---------------- 损坏元信息：来源不明拒绝保存 ---------------- */
    const validRaw = localStorage.getItem(FILES_KEY)
    localStorage.setItem(FILES_KEY, '{broken')
    remount()
    await pause(80)
    assert(!control('storage-alert').hidden && control('storage-alert').textContent.includes('文件关联信息损坏'), '损坏元信息没有给出明确提示')
    const unknownBefore = posts.length
    const unknown = press(control('doc-name'))
    await pause(150)
    assert(unknown.prevented && posts.length === unknownBefore && errorText().includes('来源不明'), `来源不明的流程应拒绝保存且不发请求，实际“${errorText()}”`)
    assert(localStorage.getItem(FILES_KEY) === '{broken', '损坏的关联信息不应被覆盖')
    localStorage.setItem(FILES_KEY, validRaw)
    remount()
    await pause(80)
    assert(control('storage-alert').hidden, '恢复有效关联信息后仍提示损坏')
    report.push('损坏的关联信息来源不明：提示、拒绝保存、不发请求且不覆盖原键；恢复有效值后恢复正常')

    /* ---------------- 离开路由不拦截，destroy/重挂不重复监听 ---------------- */
    window.location.hash = 'json-compare'
    await waitFor(() => root.hidden, '无法离开工作流路由')
    const hiddenBefore = posts.length
    const hiddenPress = press(document.body)
    await pause(120)
    assert(!hiddenPress.prevented && posts.length === hiddenBefore, '离开工作流路由后 Ctrl+S 不应被拦截或保存')
    window.location.hash = 'workflow'
    await waitFor(() => !root.hidden, '无法返回工作流路由')
    report.push('工作流隐藏时 Ctrl+S 不被拦截也不保存')

    instance.destroy()
    const destroyedBefore = posts.length
    const afterDestroy = press(document.body)
    await pause(120)
    assert(!afterDestroy.prevented && posts.length === destroyedBefore, '销毁后快捷键监听仍然存在')
    instance = window.NestCloudWorkflow.mount(root)
    remount()
    remount()
    workspace.select(flowB.id)
    await pause(120)
    server.get('QA 首存.json').revision = record(flowB.id).revision // 与关联版本一致，避免因前面的人为冲突失败
    const once = await save(control('doc-name'))
    await pause(150)
    assert(once.prevented && posts.length === destroyedBefore + 1, `多次销毁重挂后一次快捷键应只保存一次，实际新增 ${posts.length - destroyedBefore}`)
    assert(downloads.length === 0 && confirmCalls === 0, '整个保存验收期间不应出现下载或覆盖确认')
    report.push('销毁后不再响应；多次销毁重挂后一次 Ctrl+S 只发起一次保存')

    control('doc-create').click()
    control('doc-name').value = 'QA 微缩验收'
    control('doc-name').dispatchEvent(new Event('change', { bubbles: true }))
    current().graph.zoom(0.00001, { absolute: true })
    current().graph.translate(0, 0)
    if (control('palette-panel').hidden) control('nav-palette').click()
    control('palette-search').value = 'text'
    control('palette-search').dispatchEvent(new Event('input', { bubbles: true }))
    host.querySelector('.wf-palette__item[data-type="text"]').click()
    const miniature = workspace.getDocument()
    assert(miniature.nodes.length === 1 && !errorText(), '微缩状态点击添加节点超出有效坐标范围')
    assert(Math.abs(miniature.nodes[0].position.x) <= 100000 && Math.abs(miniature.nodes[0].position.y) <= 100000, '微缩状态新节点坐标未受业务范围约束')
    const miniSaved = await save(control('stage'))
    const tinyViewport = JSON.parse(miniSaved.post.text).viewport
    assert(tinyViewport.zoom > 0 && tinyViewport.zoom < 0.0001, 'Ctrl+S 没有保留低于 0.01% 的正缩放值')
    report.push('微缩到 0.001% 后仍能点击添加节点，位置保持合法，Ctrl+S 保留微缩视口')
    return { passed: report.length, checks: report, posts: posts.length }
  } finally {
    window.fetch = originalFetch
    window.confirm = originalConfirm
    URL.createObjectURL = originalCreateObjectURL
    HTMLAnchorElement.prototype.click = originalAnchorClick
    hold = null
    window.location.hash = originalHash || 'workflow'
    for (const key of ['directory', 'palette']) if (control(`${key}-panel`) && !control(`${key}-panel`).hidden) control(`nav-${key}`).click()
    workspace.select(initialId)
    for (const flow of workspace.documents) if (!initialIds.has(flow.id)) workspace.remove(flow.id)
    if (backup.files === null) localStorage.removeItem(FILES_KEY)
    else localStorage.setItem(FILES_KEY, backup.files)
    try { instance.destroy() } catch { /* 失败路径上实例可能已销毁 */ }
    instance = window.NestCloudWorkflow.mount(root)
  }
})().then((result) => {
  window.__workflowSaveBrowserReport = result
  return result
}, (error) => {
  window.__workflowSaveBrowserReport = { error: error.message, stack: error.stack }
  throw error
})
