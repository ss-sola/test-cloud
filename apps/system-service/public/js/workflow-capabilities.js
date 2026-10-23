((root) => {
  const Core = typeof module !== 'undefined' && module.exports ? require('./workflow-core.js') : root.NestCloudWorkflowCore
  const Data = typeof module !== 'undefined' && module.exports ? require('./workflow-data.js') : root.NestCloudWorkflowData
  const { LIMITS } = Data
  const REQUEST_TIMEOUT_MS = 120_000
  const CREDENTIAL_STORAGE_KEY = 'nestcloud:release-tokens:v1'
  const ENDPOINTS = Object.freeze({
    githubCommits: '/api/workflow-capabilities/github-commits',
    aiText: '/api/workflow-capabilities/ai-text',
    feishuFindRow: '/api/workflow-capabilities/feishu-find-row',
    feishuWriteCells: '/api/workflow-capabilities/feishu-write-cells',
  })
  const CREDENTIAL_REF = 'token-config'
  const MERGE_PORTS = Object.freeze(['a', 'b', 'c', 'd'])
  const TEMPLATE_V2_ROOTS = Object.freeze(['context', 'text'])
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const text = (value, max = LIMITS.textLength) => typeof value === 'string' && value.length <= max
  const nonempty = (value, max) => text(value, max) && value.trim().length > 0
  const integer = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max

  /** 仅向调用方暴露固定安全错误，不传播凭据或远程正文。 */
  class CapabilityError extends Error {}

  /** 校验 GitHub 仓库形式，拒绝任意 Git 地址与附加查询。 */
  function validRepository(repository) {
    let name = repository
    if (repository.startsWith('https://')) {
      let url
      try { url = new URL(repository) } catch { return false }
      if (url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) return false
      name = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '')
    }
    return /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name)
  }

  /** 限定飞书 Wiki HTTPS 目标，不能通过节点配置引入任意接口。 */
  function validWikiUrl(value) {
    if (!nonempty(value, 2048)) return false
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && /^[a-z0-9-]+\.(?:feishu\.cn|larksuite\.com)$/i.test(url.hostname)
        && !url.username && !url.password && !url.port && !url.hash && /^\/(?:wiki|sheets)\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)
        && /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('sheet') || '')
    } catch { return false }
  }

  /** 按定义校验配置：允许字段即 fields 声明的键，远程节点另需固定凭据引用；字段业务规则由定义的 check 判断。 */
  function checkConfig(definition, config) {
    try {
      const keys = [...definition.fields.map((field) => field.key), ...(definition.remote ? ['credentialRef'] : [])]
      if (!object(config) || keys.some((key) => !has(config, key)) || Object.keys(config).some((key) => !keys.includes(key))) return '节点配置包含缺失或未允许的字段；凭据只能在 Token 配置中提供。'
      Data.assertJsonValue(config)
      if (definition.remote && config.credentialRef !== CREDENTIAL_REF) return '凭据引用只能是 token-config。'
      return definition.check(config) ? null : '节点配置字段格式或预算无效，请检查配置。'
    } catch { return '节点配置字段格式、字段路径或预算无效，请检查配置。' }
  }

  /** 旧版 AI 配置迁移：缺省上下文补默认值，废弃的 maxTokens 不进入新版配置。 */
  function upgradeAiConfig(config) {
    const next = { contextWindowTokens: LIMITS.aiDefaultContextWindowTokens }
    for (const key of ['systemPrompt', 'contextWindowTokens', 'credentialRef']) if (has(config, key)) next[key] = config[key]
    return next
  }

  /** 旧版模板迁移：data 引用改为 context；同时引用 data 与 context 时无法合并为单一输入，明确拒绝。 */
  function upgradeTemplateConfig(config) {
    const roots = Data.templateRoots(config.template)
    if (roots.has('data') && roots.has('context')) throw new Error('模板同时引用 data 与 context，无法自动合并为单一 context 输入；请先用 JSON 合并节点组合两路数据，再手动改写模板。')
    return { template: Data.renameTemplateRoot(config.template, 'data', 'context') }
  }

  /** 旧版写入配置迁移：保持原有不限行列的语义，由用户按需收紧。 */
  function upgradeWriteConfig(config) {
    return { startColumn: config.startColumn, maxRows: LIMITS.rows, expectedColumns: 0, credentialRef: config.credentialRef }
  }

  /** 对配置和入参创建独立 JSON 快照，不接受外部对象的迟到修改。 */
  function snapshot(value) {
    Data.assertJsonValue(value)
    return JSON.parse(JSON.stringify(value))
  }

  /** 深度冻结写入确认快照，确认视图不能改写实际请求。 */
  function freezeSnapshot(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freezeSnapshot)
      Object.freeze(value)
    }
    return value
  }

  /** 按节点类型最新版本的定义校验执行配置并创建快照；旧版本节点在执行器内先完成迁移。 */
  function executionConfig(type, config) {
    const error = checkConfig(LATEST.get(type), config)
    if (error) throw new CapabilityError(error)
    return snapshot(config)
  }

  /** 默认只读取现有浏览器 Token 配置，不写入或恢复执行状态。 */
  function readStoredCredentials() {
    try {
      const raw = root.localStorage?.getItem(CREDENTIAL_STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch { throw new CapabilityError('无法读取 Token 配置，请检查本浏览器配置。') }
  }

  /** 验证本次完整凭据并仅提取目标接口所需字段。 */
  function runtimeCredentials(kind, credentials) {
    if (!object(credentials)) throw new CapabilityError('请先在 Token 配置中填写本次调用所需的完整凭据。')
    if (kind === 'githubCommits') {
      if (!nonempty(credentials.githubToken, 4096)) throw new CapabilityError('请先在 Token 配置中填写 GitHub Token。')
      return { githubToken: credentials.githubToken }
    }
    if (kind === 'aiText') {
      const ai = credentials.ai
      if (!object(ai) || !nonempty(ai.apiKey, 4096) || !nonempty(ai.model, 256) || !nonempty(ai.baseUrl, 2048)) throw new CapabilityError('请先在 Token 配置中填写完整的 AI 地址、密钥和模型。')
      return { ai: { baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, enableThinking: ai.enableThinking === true } }
    }
    if (!nonempty(credentials.feishuAppId, 256) || !nonempty(credentials.feishuAppSecret, 4096)) throw new CapabilityError('请先在 Token 配置中填写完整的飞书 App ID 和 App Secret。')
    return { appId: credentials.feishuAppId, appSecret: credentials.feishuAppSecret }
  }

  /** 验证完整 ISO 时间和显式日期跨度，不替调用方补齐缺失参数。 */
  function validateRange(range) {
    if (!object(range) || !['since', 'until'].every((key) => nonempty(range[key], 80) && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(range[key]))) throw new CapabilityError('提交查询必须提供完整的 ISO since 和 until 范围。')
    const normalized = Data.createDateRange({ period: 'custom', since: range.since, until: range.until })
    const duration = new Date(normalized.until) - new Date(normalized.since)
    if (duration > LIMITS.dateRangeDays * 24 * 60 * 60 * 1000) throw new CapabilityError('提交查询日期跨度不能超过 366 天。')
    return { since: normalized.since, until: normalized.until }
  }

  /** 约束飞书匹配条件为明确列、模式和标量，且列必须位于读取范围内。 */
  function validateMatches(matches, range) {
    const copy = snapshot(matches)
    if (!Array.isArray(copy) || !copy.length || copy.length > LIMITS.lookupMatches) throw new CapabilityError('行查找必须提供有界的非空匹配条件数组。')
    const bounds = Data.parseCellRange(range)
    for (const match of copy) {
      if (!object(match) || Object.keys(match).length !== 3 || !['column', 'value', 'mode'].every((key) => has(match, key))
        || !['equals', 'contains'].includes(match.mode) || !text(match.value, LIMITS.cellLength)) throw new CapabilityError('匹配条件必须仅包含 column、value 和 equals/contains 模式。')
      const column = Data.columnNumber(match.column)
      if (column < bounds.startColumn || column > bounds.endColumn) throw new CapabilityError('匹配列必须位于明确的查找范围内。')
    }
    return copy
  }

  /** 从实际响应中读取有字节预算的 JSON，覆盖流、文本及可控测试响应。 */
  async function readPayload(response, signal) {
    const announced = response.headers?.get?.('content-length')
    if (announced && Number(announced) > LIMITS.responseBytes) throw new CapabilityError('能力服务响应超过大小限制。')
    let payload
    if (typeof response.body?.getReader === 'function') {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let length = 0
      const chunks = []
      try {
        while (true) {
          const chunk = await Core.withAbort(reader.read(), signal)
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > LIMITS.responseBytes) throw new CapabilityError('能力服务响应超过大小限制。')
          chunks.push(decoder.decode(chunk.value, { stream: true }))
        }
        chunks.push(decoder.decode())
        payload = JSON.parse(chunks.join(''))
      } finally {
        if (signal.aborted || length > LIMITS.responseBytes) Promise.resolve(reader.cancel()).catch(() => {})
        reader.releaseLock()
      }
    } else if (typeof response.text === 'function') {
      const content = await Core.withAbort(response.text(), signal)
      if (new TextEncoder().encode(content).length > LIMITS.responseBytes) throw new CapabilityError('能力服务响应超过大小限制。')
      payload = JSON.parse(content)
    } else {
      payload = await Core.withAbort(response.json(), signal)
      if (new TextEncoder().encode(JSON.stringify(payload)).length > LIMITS.responseBytes) throw new CapabilityError('能力服务响应超过大小限制。')
    }
    return payload
  }

  /** 白名单重建成功数据，错误正文、附加字段和凭据不能成为端口输出。 */
  function resultData(kind, value, context) {
    let result
    if (kind === 'githubCommits') {
      if (!Array.isArray(value) || value.length > context.maxCommits) throw new CapabilityError('GitHub 服务返回了无效提交数组。')
      result = value.map((commit) => {
        if (!object(commit) || !nonempty(commit.hash, 128) || !text(commit.author, 500) || !nonempty(commit.date, 80)
          || !/^\d{4}-\d{2}-\d{2}T/.test(commit.date) || !Number.isFinite(Date.parse(commit.date))
          || !text(commit.subject, LIMITS.textLength) || !text(commit.body, LIMITS.textLength) || typeof commit.isMerge !== 'boolean') throw new CapabilityError('GitHub 服务返回了无效提交记录。')
        return { hash: commit.hash, author: commit.author, date: commit.date, subject: commit.subject, body: commit.body, isMerge: commit.isMerge }
      })
    } else if (kind === 'aiText') {
      if (!object(value) || !text(value.text)) throw new CapabilityError('AI 服务没有返回有效的文本结果。')
      result = { text: value.text }
    } else if (kind === 'feishuFindRow') {
      const bounds = Data.parseCellRange(context.range)
      if (!object(value) || !validWikiUrl(value.wikiUrl) || value.wikiUrl !== context.wikiUrl || !integer(value.row, LIMITS.sheetRows)
        || value.row < bounds.startRow || value.row > bounds.endRow || !nonempty(value.sheetId, 256)
        || value.sheetId !== new URL(value.wikiUrl).searchParams.get('sheet')) throw new CapabilityError('飞书服务返回了无效的目标坐标。')
      result = { wikiUrl: value.wikiUrl, row: value.row, sheetId: value.sheetId }
    } else {
      if (!object(value) || value.range !== context.range || !['written', 'skipped'].includes(value.status)
        || !Number.isSafeInteger(value.updatedCells) || value.updatedCells < 0
        || (value.status === 'written' ? value.updatedCells !== context.cells : value.updatedCells !== 0)) throw new CapabilityError('飞书服务返回了无效的写入结果。')
      result = { range: value.range, updatedCells: value.updatedCells, status: value.status }
    }
    Data.assertJsonValue(result)
    return result
  }

  /** 取本次请求使用的真实秘密，用于拦截上游反射。 */
  function secretsOf(runtime) {
    return [runtime.githubToken, runtime.ai?.apiKey, runtime.appSecret].filter((secret) => typeof secret === 'string' && secret.length)
  }

  /** 检查白名单字符串没有包含本次真实秘密，避免上游意外反射凭据。 */
  function rejectReflectedSecrets(value, runtime) {
    const secrets = secretsOf(runtime)
    const pending = [value]
    while (pending.length) {
      const item = pending.pop()
      if (typeof item === 'string' && secrets.some((secret) => item.includes(secret))) throw new CapabilityError('能力服务返回了不安全结果，已拒绝分发。')
      if (item && typeof item === 'object') pending.push(...Object.values(item))
    }
  }

  /** 服务端失败文案均为受控固定文本，可直接展示；缺失、过长或含本次凭据时退回通用提示。 */
  function failureMessage(payload, runtime) {
    const message = payload?.message
    if (!nonempty(message, LIMITS.errorMessageChars) || secretsOf(runtime).some((secret) => message.includes(secret))) return '能力请求失败，请检查参数、凭据或稍后重试。'
    return `能力请求失败：${message.trim()}`
  }

  /** 创建独立同源服务；AI只跟随手动取消，其他能力仍使用既有总超时，人工确认阶段不计时。 */
  function createServices(options = {}) {
    const request = options.request || root.fetch?.bind(root)
    const readCredentials = options.readCredentials || readStoredCredentials
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    if (!integer(timeoutMs, 2_147_483_647)) throw new CapabilityError('能力请求超时配置无效。')

    /** 统一管理生命周期，忽略信号的外部回调也无法触发迟到请求或结果；lifecycle 含外部取消信号与可选的名额让出函数。 */
    async function perform(kind, lifecycle, prepare) {
      const { signal, suspend } = lifecycle
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) controller.abort()
      let timedOut = false
      let submittedWrite = false
      let timer = null
      const arm = () => { if (kind !== 'aiText') timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs) }
      /** 等待人工操作：暂停总超时并让出执行名额，仅跟随手动停止；结束后重新开始计时。 */
      const untimed = async (work) => {
        clearTimeout(timer)
        try {
          return await Core.withAbort(Promise.resolve().then(() => (suspend ? suspend(work) : work())), controller.signal)
        } finally { if (!controller.signal.aborted) arm() }
      }
      arm()
      try {
        if (controller.signal.aborted) throw new CapabilityError('运行已停止。')
        if (typeof request !== 'function' || typeof readCredentials !== 'function') throw new CapabilityError('当前环境无法访问能力服务或 Token 配置。')
        const execution = Promise.resolve().then(async () => {
          if (controller.signal.aborted) throw new CapabilityError('运行已停止。')
          const credentials = await Core.withAbort(Promise.resolve().then(readCredentials), controller.signal)
          if (controller.signal.aborted) throw new CapabilityError('运行已停止。')
          const runtime = runtimeCredentials(kind, credentials)
          const { body, context } = await Core.withAbort(prepare(runtime, { signal: controller.signal, untimed }), controller.signal)
          if (controller.signal.aborted) throw new CapabilityError('运行已停止。')
          submittedWrite = kind === 'feishuWriteCells'
          const response = await Core.withAbort(request(ENDPOINTS[kind], {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
            cache: 'no-store', redirect: 'error', body: JSON.stringify(body), signal: controller.signal,
          }), controller.signal)
          if (controller.signal.aborted) throw new CapabilityError('运行已停止。')
          const payload = await Core.withAbort(readPayload(response, controller.signal), controller.signal)
          if (controller.signal.aborted) throw new CapabilityError('运行已停止。')
          if (!response.ok || payload?.code !== 200) throw new CapabilityError(failureMessage(payload, runtime))
          const result = resultData(kind, payload.data, context)
          rejectReflectedSecrets(result, runtime)
          return result
        })
        return await Core.withAbort(execution, controller.signal)
      } catch (error) {
        const uncertain = submittedWrite ? '远端可能已经写入，请核实后再重试。' : ''
        if (timedOut) throw new CapabilityError(`能力请求超时。${uncertain || '请重试。'}`)
        if (signal?.aborted) throw new CapabilityError(`运行已停止。${uncertain}`)
        if (error instanceof CapabilityError) throw uncertain ? new CapabilityError(`${error.message}${uncertain}`) : error
        throw new CapabilityError(`能力服务返回无效结果或暂不可用。${uncertain || '请检查配置后重试。'}`)
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }

    return {
      /** 查询一个仓库的原始提交，不附带周报过滤或去重规则。 */
      async githubCommits({ config, range, signal }) {
        const current = executionConfig('github-commits', config)
        if (!current.repository) throw new CapabilityError('请填写 GitHub 仓库。')
        const dates = validateRange(snapshot(range))
        return perform('githubCommits', { signal }, async (runtime) => ({
          body: { repository: current.repository, branch: current.branch, author: current.author, ...dates, maxCommits: current.maxCommits, runtime },
          context: current,
        }))
      },
      /** 仅以显式提示词调用通用文本生成，不内置业务提示词或降级规则。 */
      async aiText({ config, prompt, signal }) {
        const current = executionConfig('ai-text', config)
        if (!nonempty(prompt, LIMITS.promptChars)) throw new CapabilityError('AI 提示词必须是最多 200000 字符的非空文本。')
        const result = await perform('aiText', { signal }, async (runtime) => ({ body: { prompt, systemPrompt: current.systemPrompt, contextWindowTokens: current.contextWindowTokens, runtime }, context: current }))
        return result.text
      },
      /** 在显式范围内按明确条件查找唯一行，只返回非秘密坐标。 */
      async feishuFindRow({ config, matches, signal }) {
        const current = executionConfig('feishu-find-row', config)
        if (!current.wikiUrl || !current.range) throw new CapabilityError('请填写飞书 Wiki 地址和明确的查找范围。')
        const conditions = validateMatches(matches, current.range)
        return perform('feishuFindRow', { signal }, async (runtime) => ({
          body: { wikiUrl: current.wikiUrl, range: current.range, matches: conditions, runtime }, context: current,
        }))
      },
      /** 校验行列约束后，以不可变真实矩阵逐次确认才发送一次写入；确认仅存在本次调用内存。 */
      async feishuWriteCells({ config, target, values, signal, nodeName, suspend }) {
        const current = executionConfig('feishu-write-cells', config)
        const destination = snapshot(target)
        const matrix = freezeSnapshot(snapshot(values))
        if (!object(destination) || !validWikiUrl(destination.wikiUrl) || !integer(destination.row, LIMITS.sheetRows)
          || Object.keys(destination).some((key) => !['wikiUrl', 'row', 'sheetId'].includes(key))
          || (has(destination, 'sheetId') && (!nonempty(destination.sheetId, 256) || destination.sheetId !== new URL(destination.wikiUrl).searchParams.get('sheet')))) throw new CapabilityError('写入目标必须是明确的飞书 Wiki 和绝对行坐标。')
        const dimensions = Data.validateCellValues(matrix)
        if (dimensions.rows > current.maxRows) throw new CapabilityError(`写入矩阵有 ${dimensions.rows} 行，超过节点允许的 ${current.maxRows} 行，已拒绝写入。`)
        if (current.expectedColumns && dimensions.columns !== current.expectedColumns) throw new CapabilityError(`写入矩阵有 ${dimensions.columns} 列，与节点要求的 ${current.expectedColumns} 列不一致，已拒绝写入。`)
        const range = Data.createCellRange({ startColumn: current.startColumn, row: destination.row, values: matrix })
        const context = { range, cells: dimensions.cells }
        const confirmation = freezeSnapshot({ wikiUrl: destination.wikiUrl, range, values: matrix, ...(text(nodeName, 120) ? { nodeName } : {}) })
        return perform('feishuWriteCells', { signal, suspend }, async (runtime, step) => {
          if (typeof options.confirmWrite !== 'function') throw new CapabilityError('未提供本次写入确认，已拒绝写入。')
          const accepted = await step.untimed(() => {
            if (step.signal.aborted) throw new CapabilityError('运行已停止。')
            return options.confirmWrite(Object.freeze({ ...confirmation, signal: step.signal }))
          })
          if (step.signal.aborted) throw new CapabilityError('运行已停止。')
          if (accepted !== true) throw new CapabilityError('本次写入未确认，已取消写入。')
          return { body: { wikiUrl: confirmation.wikiUrl, range, values: matrix, confirmed: true, runtime }, context }
        })
      },
    }
  }

  /** 语义子类型均以 json 为基类型：结构校验在连线分发时拦截错接，完整业务校验仍由各服务负责。 */
  const DATA_TYPES = Object.freeze({
    'date-range': (value) => Data.isJsonValue(value) && object(value) && ['since', 'until'].every((key) => nonempty(value[key], 80)),
    'commit-list': (value) => Array.isArray(value) && Data.isJsonValue(value) && value.every((commit) => object(commit) && nonempty(commit.hash, 128)),
    'match-list': (value) => Array.isArray(value) && value.length > 0 && Data.isJsonValue(value)
      && value.every((match) => object(match) && typeof match.column === 'string' && typeof match.value === 'string' && ['equals', 'contains'].includes(match.mode)),
    'sheet-target': (value) => Data.isJsonValue(value) && object(value) && validWikiUrl(value.wikiUrl) && integer(value.row, LIMITS.sheetRows),
    'cell-matrix': (value) => {
      try { Data.validateCellValues(value); return true } catch { return false }
    },
  })

  const TRIGGER = Object.freeze({ id: 'trigger', label: '启动', dataType: 'trigger', kind: Core.PORT_KIND.control })
  const AI_FIELDS = [
    { key: 'systemPrompt', label: '系统提示词', type: 'textarea', rows: 5 },
    { key: 'contextWindowTokens', label: '模型上下文（Token）', type: 'number', min: LIMITS.aiMinContextWindowTokens, max: LIMITS.aiMaxContextWindowTokens, help: '默认 100000，须填写 4096～1000000 的整数。长输入自动分批与归并；估算余量不保证真实模型上下文，不限制输出 Token。' },
  ]
  const AI_PORTS = { inputs: [TRIGGER, { id: 'prompt', label: '提示词', dataType: 'text', required: true }], outputs: [{ id: 'text', label: '生成文本', dataType: 'text' }] }
  const checkAi = (config) => text(config.systemPrompt, LIMITS.systemPromptChars)
    && integer(config.contextWindowTokens, LIMITS.aiMaxContextWindowTokens) && config.contextWindowTokens >= LIMITS.aiMinContextWindowTokens
  const WRITE_PORTS = {
    inputs: [TRIGGER, { id: 'target', label: '目标坐标', dataType: 'sheet-target', required: true }, { id: 'values', label: '二维单元格', dataType: 'cell-matrix', required: true }],
    outputs: [{ id: 'result', label: '写入结果', dataType: 'json' }],
  }
  const START_COLUMN = { key: 'startColumn', label: '起始列', type: 'text', help: '由起始列、目标行与二维矩阵计算实际范围；每次执行都需确认。' }
  const checkStartColumn = (config) => text(config.startColumn, 3) && (!config.startColumn || Data.columnNumber(config.startColumn) > 0)
  const PICK_PORTS = {
    inputs: [TRIGGER, { id: 'data', label: 'JSON 数据', dataType: 'json', required: true }],
    outputs: [{ id: 'data', label: '取值结果', dataType: 'json' }],
  }

  /** 按安全字段路径读取 JSON，字段不存在时失败而不补空值。 */
  function pickJson(value, path) {
    const picked = Data.readPath(value, path)
    if (picked === undefined) throw new Error('JSON 数据中不存在该字段路径。')
    return picked
  }

  /** 能力节点定义：fields 同时是表单元信息与允许的配置键，check 校验字段规则，remote 节点固定从 Token 配置读取凭据。 */
  const DEFINITIONS = [
    {
      type: 'date-range', version: 1, label: '日期范围', category: '数据输入', execution: Core.NODE_EXECUTION.data,
      inputs: [], outputs: [{ id: 'range', label: '日期范围', dataType: 'date-range' }],
      defaults: { period: 'last-week', since: '', until: '' },
      fields: [
        { key: 'period', label: '周期', type: 'select', options: [{ value: 'last-week', label: '上周' }, { value: 'this-week', label: '本周' }, { value: 'custom', label: '自定义' }] },
        { key: 'since', label: '开始时间', type: 'date', placeholder: 'YYYY-MM-DD', help: '自定义时使用：点日历按钮选择日期，或手输 YYYY-MM-DD / 含时区的 ISO 时间。' },
        { key: 'until', label: '结束时间', type: 'date', placeholder: 'YYYY-MM-DD', help: '日期形式包含当日；本周/上周按执行时本地周一计算，不使用这两项。' },
      ],
      check: (config) => ['last-week', 'this-week', 'custom'].includes(config.period) && text(config.since, 80) && text(config.until, 80),
      execute: ({ node }) => ({ range: Data.createDateRange(node.config) }),
    },
    {
      type: 'json-input', version: 1, label: 'JSON 输入', category: '数据输入', execution: Core.NODE_EXECUTION.data,
      inputs: [], outputs: [{ id: 'data', label: 'JSON 数据', dataType: 'json' }], defaults: { text: '{}' },
      fields: [{ key: 'text', label: 'JSON 原文', type: 'textarea', rows: 8, help: '允许保存无效草稿，执行时才解析；原文明文保存在本浏览器。' }],
      check: (config) => text(config.text),
      execute: ({ node }) => ({ data: Data.parseJson(node.config.text) }),
    },
    {
      type: 'json-parse', version: 1, label: 'JSON 解析', category: '内容处理', inputs: [TRIGGER, { id: 'text', label: '文本', dataType: 'text', required: true }],
      outputs: [{ id: 'data', label: 'JSON 数据', dataType: 'json' }], defaults: {}, fields: [], check: () => true,
      execute: ({ inputs }) => ({ data: Data.parseJson(inputs.text) }),
    },
    {
      type: 'json-pick', version: 1, label: 'JSON 取值', category: '内容处理', ...PICK_PORTS, defaults: { path: '' },
      fields: [{ key: 'path', label: '字段路径', type: 'text', help: '旧版路径相对输入本身，如 values；留空表示整个输入。' }],
      check: (config) => text(config.path, 1000) && Array.isArray(Data.parsePath(config.path)),
      execute: ({ node, inputs }) => ({ data: pickJson(inputs.data, node.config.path) }),
    },
    {
      type: 'json-pick', version: 2, label: 'JSON 取值', category: '内容处理', ...PICK_PORTS, defaults: { path: 'data' },
      fields: [{ key: 'path', label: '字段路径', type: 'text', help: '以 data 表示输入的原始 JSON，如 data.values、data.items.0.name；只写 data 表示整个输入。字段不存在时节点失败，不补空值。' }],
      check: (config) => text(config.path, 1000) && Data.parsePath(config.path)[0] === 'data',
      /** 旧版路径相对输入本身，迁移时补上 data 根引用。 */
      migrate: (config) => ({ path: !config.path ? 'data' : `data${config.path.startsWith('[') ? '' : '.'}${config.path}` }),
      execute: ({ node, inputs }) => ({ data: pickJson({ data: inputs.data }, node.config.path) }),
    },
    {
      type: 'json-pick', version: 3, label: 'JSON 取值', category: '内容处理',
      inputs: [TRIGGER, { id: 'context', label: 'JSON 数据', dataType: 'json', required: true }], outputs: PICK_PORTS.outputs, defaults: { path: 'context' },
      fields: [{ key: 'path', label: '字段路径', type: 'text', help: '以 context 表示输入的原始 JSON，如 context.values、context.items.0.name；只写 context 表示整个输入。字段不存在时节点失败，不补空值。' }],
      check: (config) => text(config.path, 1000) && Data.parsePath(config.path)[0] === 'context',
      /** v2 以 data 为根，迁移时改为 context，输入端口同步改名。 */
      migrate: (config) => ({ path: `context${config.path.slice('data'.length)}` }),
      renameInputs: { data: 'context' },
      execute: ({ node, inputs }) => ({ data: pickJson({ context: inputs.context }, node.config.path) }),
    },
    {
      type: 'json-merge', version: 1, label: 'JSON 合并', category: '内容处理',
      inputs: [TRIGGER, ...MERGE_PORTS.map((id, index) => ({ id, label: `输入 ${id.toUpperCase()}`, dataType: 'json', required: index < 2 }))],
      outputs: [{ id: 'data', label: '合并结果', dataType: 'json' }], defaults: { mode: 'object' },
      fields: [{ key: 'mode', label: '合并方式', type: 'select', options: [{ value: 'object', label: '按输入组合为对象 {a,b,c,d}' }, { value: 'concat', label: '依次拼接数组' }], help: '对象方式只包含已连接的输入，模板可引用 {{context.a}}；拼接方式要求每个输入都是数组。' }],
      check: (config) => ['object', 'concat'].includes(config.mode),
      execute: ({ node, inputs }) => {
        const parts = MERGE_PORTS.filter((id) => has(inputs, id))
        if (node.config.mode === 'object') return { data: Object.fromEntries(parts.map((id) => [id, inputs[id]])) }
        if (parts.some((id) => !Array.isArray(inputs[id]))) throw new Error('数组拼接方式要求每个输入都是数组。')
        return { data: parts.flatMap((id) => inputs[id]) }
      },
    },
    {
      type: 'text-template', version: 1, label: '文本模板', category: '内容处理',
      inputs: [TRIGGER, { id: 'data', label: 'JSON 数据', dataType: 'json' }, { id: 'context', label: '上下文', dataType: 'json' }, { id: 'text', label: '文本', dataType: 'text' }],
      outputs: [{ id: 'text', label: '文本', dataType: 'text' }], defaults: { template: '{{data}}' },
      fields: [{ key: 'template', label: '模板', type: 'textarea', rows: 8, help: '支持 {{data}}、{{data.path}}、{{context.path}}、{{text}}；{{json:data.path}} 按 JSON 序列化，字符串会转义。不执行脚本或表达式；多个来源可先经 JSON 合并。' }],
      check: (config) => text(config.template),
      execute: ({ node, inputs }) => ({ text: Data.renderTemplate(node.config.template, inputs) }),
    },
    {
      type: 'text-template', version: 2, label: '文本模板', category: '内容处理',
      inputs: [TRIGGER, { id: 'context', label: 'JSON 数据', dataType: 'json' }, { id: 'text', label: '文本', dataType: 'text' }],
      outputs: [{ id: 'text', label: '文本', dataType: 'text' }], defaults: { template: '{{context}}' },
      fields: [{ key: 'template', label: '模板', type: 'textarea', rows: 8, help: '以 context 表示输入的 JSON：{{context}}、{{context.path}}；{{text}} 为上游文本；{{json:context.path}} 按 JSON 序列化，字符串会转义。不执行脚本或表达式；多个 JSON 来源先经 JSON 合并，再用 {{context.a}} 等引用。' }],
      check: (config) => text(config.template),
      migrate: upgradeTemplateConfig,
      renameInputs: { data: 'context' },
      execute: ({ node, inputs }) => ({ text: Data.renderTemplate(node.config.template, inputs, TEMPLATE_V2_ROOTS) }),
    },
    {
      type: 'github-commits', version: 1, label: 'GitHub 提交', category: '外部能力', remote: true,
      inputs: [TRIGGER, { id: 'range', label: '日期范围', dataType: 'date-range', required: true }],
      outputs: [{ id: 'data', label: '提交数组', dataType: 'commit-list' }], defaults: { repository: '', branch: '', author: '', maxCommits: LIMITS.defaultCommits, credentialRef: CREDENTIAL_REF },
      fields: [
        { key: 'repository', label: '仓库', type: 'text', help: 'owner/name 或标准 HTTPS GitHub 仓库地址。' },
        { key: 'branch', label: '分支', type: 'text' }, { key: 'author', label: '作者', type: 'text' },
        { key: 'maxCommits', label: '最多提交数', type: 'number', min: 1, max: LIMITS.maxCommits },
      ],
      check: (config) => text(config.repository, 2048) && (!config.repository || validRepository(config.repository))
        && text(config.branch, 256) && text(config.author, 256) && integer(config.maxCommits, LIMITS.maxCommits),
      execute: async ({ node, inputs, services, signal }) => ({ data: await services.githubCommits({ config: node.config, range: inputs.range, signal }) }),
    },
    {
      type: 'ai-text', version: 1, label: 'AI 文本', category: '外部能力', remote: true, ...AI_PORTS,
      defaults: { systemPrompt: '', contextWindowTokens: LIMITS.aiDefaultContextWindowTokens, credentialRef: CREDENTIAL_REF }, fields: AI_FIELDS,
      /** 旧版允许缺省上下文并原样保留废弃的 maxTokens，迁移后按新版规则校验。 */
      validateConfig: (config) => (!object(config) || Object.keys(config).some((key) => !['systemPrompt', 'contextWindowTokens', 'credentialRef', 'maxTokens'].includes(key))
        ? '节点配置包含缺失或未允许的字段；凭据只能在 Token 配置中提供。'
        : checkConfig(LATEST.get('ai-text'), upgradeAiConfig(config))),
      execute: async ({ node, inputs, services, signal }) => ({ text: await services.aiText({ config: upgradeAiConfig(node.config), prompt: inputs.prompt, signal }) }),
    },
    {
      type: 'ai-text', version: 2, label: 'AI 文本', category: '外部能力', remote: true, ...AI_PORTS,
      defaults: { systemPrompt: '', contextWindowTokens: LIMITS.aiDefaultContextWindowTokens, credentialRef: CREDENTIAL_REF }, fields: AI_FIELDS,
      check: checkAi, migrate: upgradeAiConfig,
      execute: async ({ node, inputs, services, signal }) => ({ text: await services.aiText({ config: node.config, prompt: inputs.prompt, signal }) }),
    },
    {
      type: 'text-result', version: 1, label: '文本结果', category: '结果展示',
      inputs: [TRIGGER, { id: 'text', label: '文本', dataType: 'text' }, { id: 'data', label: 'JSON 数据', dataType: 'json' }],
      outputs: [{ id: 'text', label: '文本', dataType: 'text' }], defaults: { format: 'markdown' },
      fields: [{ key: 'format', label: '展示格式', type: 'select', options: [{ value: 'markdown', label: '安全 Markdown' }, { value: 'text', label: '纯文本' }, { value: 'json', label: 'JSON' }] }],
      check: (config) => ['markdown', 'text', 'json'].includes(config.format),
      /** 文本与 JSON 输入二选一；JSON 按两空格缩进格式化为文本，超出文本预算时失败而不截断。 */
      execute: ({ inputs }) => {
        if (has(inputs, 'text') === has(inputs, 'data')) throw new Error('请只连接文本或 JSON 数据其中一个输入。')
        if (has(inputs, 'text')) return { text: inputs.text }
        const text = JSON.stringify(inputs.data, null, 2)
        if (text.length > LIMITS.textLength) throw new Error('格式化后的 JSON 超过 500000 字符，请先用 JSON 取值缩小范围。')
        return { text }
      },
    },
    {
      type: 'feishu-find-row', version: 1, label: '飞书查找行', category: '外部能力', remote: true,
      inputs: [TRIGGER, { id: 'matches', label: '匹配条件', dataType: 'match-list', required: true }],
      outputs: [{ id: 'target', label: '目标坐标', dataType: 'sheet-target' }], defaults: { wikiUrl: '', range: 'A1:B200', credentialRef: CREDENTIAL_REF },
      fields: [{ key: 'wikiUrl', label: 'Wiki 地址', type: 'text' }, { key: 'range', label: '查找范围', type: 'text', help: 'A1:B200；匹配列使用 A、B、AA 等绝对列名。' }],
      check: (config) => {
        if (!text(config.wikiUrl, 2048) || (config.wikiUrl && !validWikiUrl(config.wikiUrl)) || !text(config.range, 40)) return false
        if (!config.range) return true
        const range = Data.parseCellRange(config.range)
        const rows = range.endRow - range.startRow + 1
        const columns = range.endColumn - range.startColumn + 1
        return rows <= LIMITS.lookupRows && columns <= LIMITS.lookupColumns && rows * columns <= LIMITS.readCells
      },
      execute: async ({ node, inputs, services, signal }) => ({ target: await services.feishuFindRow({ config: node.config, matches: inputs.matches, signal }) }),
    },
    {
      type: 'feishu-write-cells', version: 1, label: '飞书写入单元格', category: '外部能力', remote: true, ...WRITE_PORTS,
      defaults: { startColumn: 'C', credentialRef: CREDENTIAL_REF }, fields: [START_COLUMN], check: checkStartColumn,
      execute: async ({ node, inputs, services, signal, suspend }) => ({ result: await services.feishuWriteCells({ config: upgradeWriteConfig(node.config), target: inputs.target, values: inputs.values, signal, nodeName: node.name, suspend }) }),
    },
    {
      type: 'feishu-write-cells', version: 2, label: '飞书写入单元格', category: '外部能力', remote: true, ...WRITE_PORTS,
      defaults: { startColumn: 'C', maxRows: 1, expectedColumns: 0, credentialRef: CREDENTIAL_REF },
      fields: [
        START_COLUMN,
        { key: 'maxRows', label: '最多写入行数', type: 'number', min: 1, max: LIMITS.rows, help: '矩阵行数超过时拒绝写入，不截断；按查找到的单行写入时保持 1。' },
        { key: 'expectedColumns', label: '要求列数', type: 'number', min: 0, max: LIMITS.columns, help: '填 0 表示不限；大于 0 时列数不一致即拒绝写入。' },
      ],
      check: (config) => checkStartColumn(config) && integer(config.maxRows, LIMITS.rows)
        && Number.isSafeInteger(config.expectedColumns) && config.expectedColumns >= 0 && config.expectedColumns <= LIMITS.columns,
      migrate: upgradeWriteConfig,
      execute: async ({ node, inputs, services, signal, suspend }) => ({ result: await services.feishuWriteCells({ config: node.config, target: inputs.target, values: inputs.values, signal, nodeName: node.name, suspend }) }),
    },
  ]
  DEFINITIONS.forEach(freezeSnapshot)
  const LATEST = new Map(DEFINITIONS.map((definition) => [definition.type, definition]))

  /** 注册语义数据类型与原子节点；原有节点顺序由宿主保持，文本结果使用专用渲染器。 */
  function register(registry, renderers = {}) {
    registry.registerDataType('json', Data.isJsonValue)
    for (const [name, validate] of Object.entries(DATA_TYPES)) registry.registerDataType(name, validate, { base: 'json' })
    for (const definition of DEFINITIONS) {
      registry.register({
        size: { width: 320, height: 360 }, ...definition,
        render: definition.type === 'text-result' ? renderers.textResult : renderers.capability,
        validateConfig: definition.validateConfig ?? ((config) => checkConfig(definition, config)),
      })
    }
    return registry
  }

  const api = Object.freeze({ register, createServices, REQUEST_TIMEOUT_MS, CREDENTIAL_STORAGE_KEY })
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.NestCloudWorkflowCapabilities = api
})(typeof window === 'undefined' ? globalThis : window)
