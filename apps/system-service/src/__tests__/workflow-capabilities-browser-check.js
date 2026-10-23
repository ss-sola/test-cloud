window.__workflowCapabilitiesBrowserReport = null
window.__workflowCapabilitiesBrowserCheck = (async () => {
  const root = document.querySelector('[data-view="workflow"]')
  const { workspace } = window.NestCloudWorkflow.mount(root)
  const originalId = workspace.activeId
  const originalServices = { ...workspace.services }
  const sidebarHost = document.querySelector('#workflow-sidebar-host')
  const originalQuery = sidebarHost.querySelector('[data-wf="palette-search"]').value
  const created = []
  const checks = []
  const calls = []
  let credentialsAvailable = true
  let holdAi = false
  let releaseAi = null
  const RESULT_TEXT = '# 工作周报\n\n- 实现独立节点\n\nAI_RESULT_ONLY_69fa\n\n<img data-wf-unsafe src=x>\n\n[不安全链接](javascript:alert(1))'
  const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
  const control = (name) => root.querySelector(`[data-wf="${name}"]`) ?? sidebarHost.querySelector(`[data-wf="${name}"]`)
  /** 撤销/重做只保留 stage 快捷键入口，派发真实键盘事件。 */
  const stageKey = (key, options = {}) => control('stage').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))
  const nodeOf = (type) => workspace.getDocument().nodes.find((node) => node.type === type)
  const hostOf = (node) => root.querySelector(`[data-node-id="${node.id}"]`)
  function assert(condition, message) { if (!condition) throw new Error(message) }
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 8000
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(message)
      await pause()
    }
  }
  function create(name) {
    control('doc-create').click()
    created.push(workspace.activeId)
    workspace.rename(workspace.activeId, name)
  }
  function add(type, config = {}, position = { x: 40, y: 40 }) {
    const node = workspace.addNode(type, position)
    workspace.updateNode(node.id, { config: { ...node.config, ...config } })
    return workspace.getDocument().nodes.find((item) => item.id === node.id)
  }
  function connect(source, port, target, input) {
    workspace.connect({ source: { nodeId: source.id, port }, target: { nodeId: target.id, port: input } })
  }
  function edit(node, key, value) {
    const input = hostOf(node).querySelector(`[data-wf-field="${key}"]`)
    assert(input, `节点 ${node.type} 缺少可编辑字段 ${key}`)
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input
  }
  async function runTo(status) {
    control('run').click()
    await waitFor(() => workspace.getRuntime().status === status && !workspace.getRuntime().running, `运行没有达到 ${status}，实际 ${workspace.getRuntime().status}`)
  }
  const readCredentials = () => credentialsAvailable ? {
    githubToken: 'github-test-secret', feishuAppId: 'test-app', feishuAppSecret: 'feishu-test-secret',
    ai: { baseUrl: 'http://model-server:8080/v1?tenant=demo#client-fragment', apiKey: 'ai-test-secret', model: 'test-model' },
  } : {}
  const request = async (path, options) => {
    const body = JSON.parse(options.body)
    calls.push({ path, body, signal: options.signal, options })
    assert(options.method === 'POST' && options.credentials === 'same-origin' && options.cache === 'no-store', '远程节点没有保持完整同源 POST/no-store 边界')
    assert(options.signal instanceof AbortSignal, '远程节点缺少取消信号')
    let data
    if (path.endsWith('/github-commits')) {
      const start = nodeOf('start')
      assert(workspace.getRuntime().states.get(start.id)?.status === 'succeeded', 'GitHub 请求早于开始节点成功')
      data = [
        { hash: 'a'.repeat(40), author: 'dev', date: body.since, subject: '实现独立节点', body: '实现通用能力', isMerge: false },
        { hash: 'b'.repeat(40), author: 'dev', date: body.since, subject: '', body: 'RAW_EMPTY_SUBJECT', isMerge: false },
        { hash: 'c'.repeat(40), author: 'dev', date: body.since, subject: 'Merge pull request', body: '保留原始合并记录', isMerge: true },
      ]
    } else if (path.endsWith('/ai-text')) {
      assert(!['maxTokens', 'max_tokens', 'max_completion_tokens', 'max_output_tokens'].some((key) => Object.hasOwn(body, key)), 'AI 请求仍携带输出 Token 上限')
      if (holdAi) await new Promise((resolve) => { releaseAi = resolve })
      data = { text: RESULT_TEXT }
    } else if (path.endsWith('/feishu-find-row')) {
      data = { wikiUrl: body.wikiUrl, row: 9, sheetId: 'sheet1' }
    } else if (path.endsWith('/feishu-write-cells')) {
      assert(body.confirmed === true, '写请求没有携带本次显式确认')
      data = { range: body.range, updatedCells: 2, status: 'written' }
    } else throw new Error(`原子节点调用了非预期接口 ${path}`)
    return { ok: true, status: 200, json: async () => ({ code: 200, data }) }
  }
  const writeCalls = () => calls.filter((call) => call.path.endsWith('/feishu-write-cells'))
  const dialog = () => document.querySelector('[data-wf-write-confirm]')
  const dialogAction = (name) => {
    const button = dialog()?.querySelector(`[data-wf-write-action="${name}"]`)
    assert(button, `写入确认缺少 ${name} 按钮`)
    button.click()
  }
  Object.assign(workspace.services, window.NestCloudWorkflowNodes.createServices({
    request, readCredentials, confirmWrite: window.NestCloudWorkflowCapabilityView.confirmWrite,
  }))
  try {
    const definitions = workspace.registry.list()
    const expectedTypes = ['date-range', 'json-input', 'json-parse', 'json-pick', 'json-merge', 'text-template', 'github-commits', 'ai-text', 'text-result', 'feishu-find-row', 'feishu-write-cells']
    assert(expectedTypes.every((type) => definitions.some((definition) => definition.type === type)), '节点库缺少约定的原子能力')
    assert(!definitions.some((definition) => definition.type === 'data-filter'), '节点库仍包含已移除的数据筛选节点')
    create('原子能力浏览器：周报组合')
    const before = calls.length
    control('template-weekly').click()
    assert(workspace.getDocument().nodes.length === 7 && workspace.getDocument().edges.length === 7, '周报样例不是七个独立能力节点（含 JSON 合并）的完整数据流')
    assert(!workspace.getDocument().nodes.some((node) => node.type.startsWith('feishu-')), '周报样例意外包含发布步骤')
    assert(calls.length === before && workspace.getRuntime().status === 'idle', '载入周报样例自动请求了远程服务')
    stageKey('z', { ctrlKey: true })
    assert(workspace.getDocument().nodes.length === 0, '周报样例载入不是一次撤销')
    stageKey('z', { ctrlKey: true, shiftKey: true })
    const github = nodeOf('github-commits')
    const aiNode = nodeOf('ai-text')
    assert(!Object.hasOwn(aiNode.config, 'maxTokens') && !hostOf(aiNode).querySelector('[data-wf-field="maxTokens"]'), '新 AI 节点仍显示或保存最大输出 Token')
    let legacyRejected = false
    try { workspace.updateNode(aiNode.id, { config: { ...aiNode.config, maxTokens: 1_000_000 } }) } catch { legacyRejected = true }
    assert(legacyRejected && !hostOf(aiNode).querySelector('[data-wf-field="maxTokens"]'), '新版 AI 节点接受了废弃的 maxTokens 或恢复了 Token 控件')
    edit(github, 'repository', 'acme/sample')
    edit(github, 'author', 'dev')
    credentialsAvailable = false
    await runTo('failed')
    assert(calls.length === before, '缺少凭据仍发出了远程请求')
    credentialsAvailable = true
    await runTo('succeeded')
    assert(calls.length === before + 2 && calls[before].path.endsWith('/github-commits') && calls[before + 1].path.endsWith('/ai-text'), '抓取和 AI 没有作为两个独立请求顺序执行')
    assert(!calls.some((call) => call.path.includes('/weekly-commit-reports/')), '组合样例仍由旧周报一体化接口执行')
    assert(calls[before].body.repository === 'acme/sample' && calls[before].body.author === 'dev', '运行前未 flush 通用表单编辑')
    assert(calls[before + 1].body.runtime.ai.baseUrl === 'http://model-server:8080/v1?tenant=demo#client-fragment', 'AI 地址被前端拦截或改写，没有按配置原样发送')
    assert(calls[before + 1].body.prompt.includes('实现独立节点') && calls[before + 1].body.prompt.includes('RAW_EMPTY_SUBJECT'), '模板没有完整接收原始抓取结果')
    assert(calls[before + 1].body.prompt.includes('Merge pull request'), '抓取或模板隐藏过滤了原始合并记录')
    const result = nodeOf('text-result')
    assert(workspace.getRuntime().states.get(result.id).outputs.text === RESULT_TEXT, '通用文本结果未收到 AI 输出')
    const resultHost = hostOf(result)
    assert(resultHost.textContent.includes('实现独立节点') && !resultHost.querySelector('img,script,iframe'), '文本/Markdown 结果解释了不安全 HTML')
    assert(![...resultHost.querySelectorAll('a')].some((link) => /^javascript:/i.test(link.getAttribute('href') || '')), 'Markdown 渲染了不安全链接')
    assert(!workspace.exportDocument().includes('test-secret'), '节点导出包含运行凭据')
    const saved = localStorage.getItem(window.NestCloudWorkflowCore.STORAGE_KEY)
    assert(!saved.includes('test-secret') && !saved.includes('AI_RESULT_ONLY_69fa'), '运行凭据或 AI 结果被写入工作流草稿')
    checks.push('AI 无最大输出 Token 控件/默认值，旧字段兼容且不进入请求通过')
    checks.push('七节点周报样例、单步撤销、零自动请求、缺凭据阻断、独立抓取/模板/AI、原始空标题和合并记录与安全 Markdown 通过')

    const beforeInvalidDraft = calls.length
    const budget = edit(github, 'maxCommits', '0')
    control('run').click()
    await pause(80)
    assert(calls.length === beforeInvalidDraft && !workspace.getRuntime().running, '无效数字草稿没有阻止运行，悄悄使用了旧配置')
    assert(budget.getAttribute('aria-invalid') === 'true' && !control('error').hidden, '未保存的配置错误没有可见提示')
    assert(workspace.getDocument().nodes.find((node) => node.id === github.id).config.maxCommits === 100, '错误草稿覆盖了有效配置')
    hostOf(github).querySelector('[data-wf-capability-action="restore"]').click()
    assert(budget.value === '100' && budget.getAttribute('aria-invalid') !== 'true', '放弃未保存修改没有恢复有效配置')
    checks.push('无效表单草稿的宿主 flush 阻断运行、零额外请求与恢复有效配置通过')

    const originalSetTimeout = window.setTimeout
    const scheduled = []
    const waitingAi = new AbortController()
    holdAi = true
    releaseAi = null
    window.setTimeout = (callback, delay, ...args) => {
      scheduled.push(delay)
      return originalSetTimeout.call(window, callback, delay, ...args)
    }
    try {
      const pending = workspace.services.aiText({ config: nodeOf('ai-text').config, prompt: '无主动时限的浏览器等待测试', signal: waitingAi.signal }).catch((error) => error)
      await waitFor(() => typeof releaseAi === 'function', '无时限 AI 未进入请求等待')
      assert(!scheduled.includes(120_000), 'AI 请求仍创建了旧的 120 秒主动定时器')
      waitingAi.abort()
      const stopped = await pending
      assert(stopped instanceof Error && stopped.message.includes('停止'), '无时限 AI 不能手动取消')
      assert(calls.at(-1).signal.aborted, '手动停止未中止无时限 AI 请求信号')
      releaseAi()
      await pause()
      assert(await pending === stopped, '无时限 AI 的迟到结果覆盖了取消')
    } finally {
      window.setTimeout = originalSetTimeout
      waitingAi.abort()
      releaseAi?.()
      holdAi = false
      releaseAi = null
    }
    checks.push('实际浏览器 AI 不创建主动超时定时器，等待可手动取消且迟到结果隔离通过')

    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const originalAnchorClick = HTMLAnchorElement.prototype.click
    let copied = null
    let download = null
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copied = text } } })
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) download = { name: this.download, href: this.href }
        else originalAnchorClick.call(this)
      }
      const copy = resultHost.querySelector('[data-wf-result-action="copy"]')
      const downloadButton = resultHost.querySelector('[data-wf-result-action="download"]')
      assert(copy && downloadButton, '通用文本结果缺少复制/下载入口')
      copy.click()
      await pause()
      downloadButton.click()
      assert(copied === RESULT_TEXT && download?.href.startsWith('blob:'), '复制或下载没有使用完整结果原文')
    } finally {
      HTMLAnchorElement.prototype.click = originalAnchorClick
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      else delete navigator.clipboard
    }
    checks.push('通用文本结果完整复制与 Blob 下载通过')

    holdAi = true
    releaseAi = null
    control('run').click()
    await waitFor(() => typeof releaseAi === 'function', 'AI 节点未进入等待状态')
    assert([...root.querySelectorAll('[data-wf-field]')].every((field) => field.readOnly || field.disabled), '运行期间通用表单未锁定')
    const held = calls[calls.length - 1]
    control('stop').click()
    assert(workspace.getRuntime().status === 'cancelled' && held.signal.aborted, '停止没有取消节点请求与等待')
    holdAi = false
    releaseAi()
    await pause(100)
    assert(workspace.getRuntime().status === 'cancelled' && !hostOf(result).textContent.includes('AI_RESULT_ONLY_69fa'), '迟到 AI 结果覆盖了取消状态')
    checks.push('通用表单运行锁、停止取消与迟到 AI 隔离通过')

    create('原子能力浏览器：纯文本组合')
    const start = add('start')
    const source = add('text', { text: '<b>原始文本</b>' }, { x: 40, y: 300 })
    const template = add('text-template', { template: '摘要：{{text}}' }, { x: 480, y: 40 })
    const display = add('text-result', { format: 'text' }, { x: 960, y: 40 })
    connect(start, 'trigger', template, 'trigger')
    connect(source, 'text', template, 'text')
    connect(template, 'text', display, 'text')
    const pureCalls = calls.length
    await runTo('succeeded')
    assert(calls.length === pureCalls && workspace.getRuntime().states.get(display.id).outputs.text === '摘要：<b>原始文本</b>', '模板不能在不依赖 GitHub/AI 的情况下独立运行')
    assert(!hostOf(display).querySelector('b')?.textContent.includes('原始文本'), '纯文本输出解释了输入 HTML')
    checks.push('开始＋被动文本＋独立模板＋通用展示纯本地组合通过')

    const sourceState = workspace.getRuntime().states.get(source.id)
    edit(template, 'template', '新摘要：{{text}}')
    await waitFor(() => workspace.getRuntime().status === 'stale', '编辑模板后结果没有标记为部分过期')
    assert(control('run-status').textContent.includes('结果部分过期'), '工具栏没有显示部分过期状态')
    assert(workspace.getRuntime().states.get(source.id)?.outputs === sourceState.outputs && !workspace.getRuntime().states.has(display.id), '编辑只应让模板及其下游结果失效')
    hostOf(template).querySelector('.wf-node__run').click()
    await waitFor(() => workspace.getRuntime().status === 'succeeded' && !workspace.getRuntime().running, '从此节点运行没有完成')
    assert(workspace.getRuntime().states.get(display.id).outputs.text === '新摘要：<b>原始文本</b>' && calls.length === pureCalls, '从此节点运行没有用新模板重算下游')
    assert(!hostOf(start).querySelector('.wf-node__run'), '开始节点不应提供从此节点运行入口')
    checks.push('编辑后仅下游结果失效、部分过期状态与从此节点运行通过')

    const legacy = JSON.parse(workspace.exportDocument())
    legacy.nodes.push({ id: 'legacy-ai', type: 'ai-text', version: 1, name: '旧 AI', position: { x: 40, y: 700 }, size: { width: 320, height: 360 }, config: { systemPrompt: '旧提示', credentialRef: 'token-config', maxTokens: 4096 } })
    const imported = workspace.importDocument(legacy)
    created.push(imported.id)
    const legacyNode = imported.nodes.find((node) => node.type === 'ai-text')
    const upgradeButton = hostOf(legacyNode).querySelector('.wf-node__upgrade button')
    assert(upgradeButton && hostOf(legacyNode).textContent.includes('旧版本 v1'), '旧版本节点没有显式升级入口')
    upgradeButton.click()
    const upgraded = workspace.getDocument().nodes.find((node) => node.id === legacyNode.id)
    assert(upgraded.version === 2 && !Object.hasOwn(upgraded.config, 'maxTokens') && upgraded.config.contextWindowTokens === 100000, '升级没有按迁移生成新版配置')
    assert(!hostOf(upgraded).querySelector('.wf-node__upgrade'), '升级后节点视图没有重建')
    stageKey('z', { ctrlKey: true })
    assert(workspace.getDocument().nodes.find((node) => node.id === legacyNode.id).version === 1, '升级不能一步撤销')
    checks.push('旧版本节点显式升级、视图重建与一步撤销通过')

    create('原子能力浏览器：JSON 解析与模板')
    const parseStart = add('start')
    const raw = add('text', { text: '[{"kind":"first","value":1},{"kind":"second","value":2}]' })
    const parse = add('json-parse')
    const format = add('text-template', { template: '{{context}}' })
    const parsedDisplay = add('text-result', { format: 'text' })
    connect(parseStart, 'trigger', parse, 'trigger')
    connect(raw, 'text', parse, 'text')
    connect(parse, 'data', format, 'context')
    connect(format, 'text', parsedDisplay, 'text')
    await runTo('succeeded')
    assert(workspace.getRuntime().states.get(parsedDisplay.id).outputs.text === raw.config.text && calls.length === pureCalls, 'JSON解析/模板没有完整传递原始记录')
    const parsePreview = hostOf(parse).querySelector('.wf-cap__pre')
    const resultRaw = hostOf(parsedDisplay).querySelector('.wf-cap-result__raw')
    assert(parsePreview && getComputedStyle(parsePreview).userSelect === 'text' && getComputedStyle(resultRaw).userSelect === 'text', 'JSON 解析预览或文本结果不能选中复制')
    workspace.updateNode(raw.id, { config: { text: '[' } })
    await runTo('failed')
    assert(workspace.getRuntime().states.get(parse.id).status === 'failed' && workspace.getRuntime().states.get(parsedDisplay.id).status === 'skipped', '非法 JSON 未只阻断其下游')
    checks.push('JSON 解析、模板串联完整数据与非法草稿执行错误通过')

    create('原子能力浏览器：飞书查找与逐次确认')
    const feishuStart = add('start')
    const matches = add('json-input', { text: '[{"column":"B","value":"测试人员","mode":"equals"}]' })
    const wikiUrl = 'https://example.feishu.cn/wiki/test-node?sheet=sheet1'
    const find = add('feishu-find-row', { wikiUrl, range: 'A1:B20' })
    const values = add('json-input', { text: '[["Monday","Tuesday"]]' })
    const write = add('feishu-write-cells', { startColumn: 'D' })
    connect(feishuStart, 'trigger', find, 'trigger')
    connect(matches, 'data', find, 'matches')
    connect(find, 'target', write, 'target')
    connect(values, 'data', write, 'values')
    const writesBefore = writeCalls().length
    control('run').click()
    await waitFor(() => Boolean(dialog()), '实际写入前没有即时确认对话框')
    assert(writeCalls().length === writesBefore, '确认前已发送写请求')
    assert(dialog().textContent.includes('D9:E9') && dialog().textContent.includes('Monday') && dialog().textContent.includes(wikiUrl), '确认没有展示实际目标、范围与矩阵')
    assert(!Object.hasOwn(workspace.getDocument().nodes.find((node) => node.id === write.id).config, 'confirmed'), '本次确认混入了持久配置')
    dialogAction('cancel')
    await waitFor(() => !workspace.getRuntime().running, '拒绝写入后工作流未结束')
    assert(writeCalls().length === writesBefore, '拒绝确认仍写入飞书')
    control('run').click()
    await waitFor(() => Boolean(dialog()), '第二次运行没有再次确认')
    dialogAction('confirm')
    await waitFor(() => workspace.getRuntime().status === 'succeeded', '确认后的写入未成功')
    assert(writeCalls().length === writesBefore + 1 && writeCalls().at(-1).body.range === 'D9:E9', '行查找与写入未按明确起始列和矩阵组合')
    control('run').click()
    await waitFor(() => Boolean(dialog()), '成功发布后重跑绕过本次确认')
    control('stop').click()
    await waitFor(() => !dialog(), '停止没有清理等待中的确认对话框')
    assert(writeCalls().length === writesBefore + 1 && workspace.getRuntime().status === 'cancelled', '确认期间停止仍产生写请求')
    const exported = JSON.parse(workspace.exportDocument())
    exported.nodes.find((node) => node.id === write.id).config.confirmed = true
    const count = workspace.documents.length
    let rejected = false
    try { workspace.importDocument(exported) } catch { rejected = true }
    assert(rejected && workspace.documents.length === count && writeCalls().length === writesBefore + 1, '导入持久确认可以绕过本次授权')
    checks.push('飞书查找与矩阵范围独立组合、本次确认前零写入、拒绝/重跑/停止和导入确认防绕过通过（网络为受控 mock）')
    assert(!calls.some((call) => call.path.includes('/weekly-commit-reports/')), '原子能力意外使用旧周报作业')
    return { passed: checks.length, checks, requests: calls.map((call) => call.path) }
  } finally {
    releaseAi?.()
    for (const id of created.reverse()) {
      if (workspace.getRuntime(id).running) workspace.stop(id)
      workspace.remove(id)
    }
    workspace.select(originalId)
    Object.assign(workspace.services, originalServices)
    control('palette-search').value = originalQuery
    control('palette-search').dispatchEvent(new Event('input', { bubbles: true }))
  }
})().then((report) => {
  window.__workflowCapabilitiesBrowserReport = report
  return report
}, (error) => {
  window.__workflowCapabilitiesBrowserReport = { error: error.message }
  throw error
})
