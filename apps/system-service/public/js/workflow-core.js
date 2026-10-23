((root) => {
  const LIMITS = Object.freeze({
    documents: 30, nodes: 100, edges: 300, textLength: 500_000,
    documentBytes: 4 * 1024 * 1024, workspaceBytes: 8 * 1024 * 1024,
    historyBytes: 8 * 1024 * 1024, historySteps: 30, configDepth: 16,
    coordinate: 100_000, minSize: 160, maxSize: 2400, minZoom: 0.2, maxZoom: 2,
    concurrency: 3, resultDocuments: 10, resultBytes: 32 * 1024 * 1024, inputMergeMs: 600,
  })
  const STORAGE_KEY = 'nestcloud:workflows:v1'
  const NODE_EXECUTION = Object.freeze({ entry: 'entry', data: 'data', task: 'task' })
  const PORT_KIND = Object.freeze({ data: 'data', control: 'control' })
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const bytes = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const finite = (value, max) => Number.isFinite(value) && Math.abs(value) <= max
  const idValid = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)
  const makeId = () => root.crypto?.randomUUID?.() || `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const idleRuntime = () => ({ running: false, status: 'idle', runId: null, states: new Map(), startedAt: null, finishedAt: null })
  const QUEUED = Object.freeze({ status: 'queued', message: '', outputs: null })

  const frozenData = new WeakSet()

  /** 冻结可分发的 JSON 数据，避免分支间相互修改。 */
  function freeze(value) {
    if (value && typeof value === 'object' && !frozenData.has(value)) {
      frozenData.add(value)
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }

  /** 检查配置是有深度上限的 JSON 数据，不执行或合并未知键。 */
  function inspectJson(value, depth = 0) {
    if (depth > LIMITS.configDepth) throw new Error('节点配置嵌套过深。')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number' && Number.isFinite(value)) return
    if (typeof value !== 'object') throw new Error('节点配置必须是 JSON 数据。')
    for (const item of Object.values(value)) inspectJson(item, depth + 1)
  }

  /** 节点能力注册表；文档只能引用已注册实现，不能提供执行代码。 */
  class NodeRegistry {
    constructor() {
      this.definitions = new Map()
      this.dataTypes = new Map([['text', (value) => typeof value === 'string' && value.length <= LIMITS.textLength]])
      this.bases = new Map()
    }

    /** 注册数据类型与执行边界校验；base 声明其所属的已注册基类型，形成单层语义子类型。 */
    registerDataType(name, validate, options = {}) {
      if (!idValid(name) || typeof validate !== 'function' || this.dataTypes.has(name)
        || (options.base !== undefined && (!this.dataTypes.has(options.base) || this.bases.has(options.base)))) throw new Error('数据类型定义无效或重复。')
      this.dataTypes.set(name, validate)
      if (options.base !== undefined) this.bases.set(name, options.base)
      return this
    }

    /** 判断输出能否接入输入：类型相同，或一方是另一方的子类型；同一基类型下的不同子类型互不相容。 */
    compatible(output, input) {
      return output === input || this.bases.get(output) === input || this.bases.get(input) === output
    }

    /** 注册一个版本的节点，包括端口、配置、执行器和可选渲染器。 */
    register(definition) {
      const { type, version, inputs = [], outputs = [], execution = NODE_EXECUTION.task } = definition
      const key = `${type}@${version}`
      if (!idValid(type) || !Number.isSafeInteger(version) || version < 1 || this.definitions.has(key)
        || typeof definition.execute !== 'function') throw new Error('节点定义无效或重复。')
      if (!Object.values(NODE_EXECUTION).includes(execution)) throw new Error('节点执行角色无效。')
      if ((execution === NODE_EXECUTION.entry || execution === NODE_EXECUTION.data) && inputs.length) throw new Error('开始节点和被动数据节点不能声明输入。')
      if (execution === NODE_EXECUTION.entry && !outputs.length) throw new Error('开始节点至少需要一个输出连接点。')
      for (const ports of [inputs, outputs]) {
        const ids = new Set()
        for (const port of ports) {
          if (!idValid(port.id) || ids.has(port.id) || !this.dataTypes.has(port.dataType)
            || !Object.values(PORT_KIND).includes(port.kind ?? PORT_KIND.data)) throw new Error('节点端口定义无效。')
          ids.add(port.id)
        }
      }
      this.definitions.set(key, Object.freeze({ ...definition, execution, inputs: freeze(clone(inputs)), outputs: freeze(clone(outputs)), defaults: freeze(clone(definition.defaults || {})) }))
      return this
    }

    /** 按精确节点版本查找，未知版本不会回退执行。 */
    get(type, version = 1) {
      return this.definitions.get(`${type}@${version}`)
    }

    /** 节点库仅展示各类型的最新注册版本。 */
    list() {
      const latest = new Map()
      for (const definition of this.definitions.values()) {
        if (!latest.has(definition.type) || latest.get(definition.type).version < definition.version) latest.set(definition.type, definition)
      }
      return [...latest.values()]
    }
  }

  /** 只读连线预检，不创建边、不修改历史。 */
  function validateConnection(document, registry, connection) {
    const { source, target } = connection
    const from = document.nodes.find((node) => node.id === source?.nodeId)
    const to = document.nodes.find((node) => node.id === target?.nodeId)
    if (!from || !to) return '连线引用了不存在的节点。'
    if (from.id === to.id) return '节点不能连接自身。'
    if (!idValid(source.port) || !idValid(target.port)) return '连接点标识无效。'
    const fromDef = registry.get(from.type, from.version)
    const toDef = registry.get(to.type, to.version)
    if ((!fromDef || !toDef) && !connection.allowUnknown) return '缺少节点实现，不能连接。'
    const outPort = fromDef?.outputs.find((port) => port.id === source.port)
    const inPort = toDef?.inputs.find((port) => port.id === target.port)
    if ((fromDef && !outPort) || (toDef && !inPort)) return '请选择输出连接点连接到输入连接点。'
    if (outPort && inPort && !registry.compatible(outPort.dataType, inPort.dataType)) return '连接点的数据类型不兼容。'
    if (outPort && inPort && (outPort.kind ?? PORT_KIND.data) !== (inPort.kind ?? PORT_KIND.data)) return '控制连接点与数据连接点不能混接。'
    if (document.edges.some((edge) => edge.id !== connection.id && edge.target.nodeId === to.id && edge.target.port === target.port)) return '每个输入连接点只能接入一个来源。'
    const pending = [to.id]
    const visited = new Set()
    while (pending.length) {
      const id = pending.pop()
      if (id === from.id) return '连线会形成循环，当前仅支持无环数据流。'
      if (visited.has(id)) continue
      visited.add(id)
      document.edges.filter((edge) => edge.id !== connection.id && edge.source.nodeId === id).forEach((edge) => pending.push(edge.target.nodeId))
    }
    return null
  }

  /** 校验并规范化文档；未知节点配置保留，非法文档整体拒绝。 */
  function parseDocument(raw, registry) {
    if (typeof raw === 'string' && bytes(raw) > LIMITS.documentBytes) throw new Error('工作流文件超过 4 MiB 限制。')
    let value
    try { value = typeof raw === 'string' ? JSON.parse(raw) : clone(raw) } catch { throw new Error('工作流不是有效 JSON。') }
    if (!isObject(value) || value.version !== 1) throw new Error('不支持的工作流格式版本。')
    if (!idValid(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) throw new Error('工作流标识或名称无效。')
    if (!Array.isArray(value.nodes) || value.nodes.length > LIMITS.nodes || !Array.isArray(value.edges) || value.edges.length > LIMITS.edges) throw new Error('工作流最多包含 100 个节点和 300 条连线。')
    const ids = new Set()
    const nodes = value.nodes.map((node) => {
      if (!isObject(node) || !idValid(node.id) || ids.has(node.id) || !idValid(node.type)
        || !Number.isSafeInteger(node.version) || node.version < 1 || typeof node.name !== 'string' || node.name.length > 120) throw new Error('节点标识、名称或版本无效。')
      ids.add(node.id)
      if (!isObject(node.position) || !finite(node.position.x, LIMITS.coordinate) || !finite(node.position.y, LIMITS.coordinate)) throw new Error('节点坐标超出限制。')
      if (!isObject(node.size) || !['width', 'height'].every((key) => Number.isFinite(node.size[key]) && node.size[key] >= LIMITS.minSize && node.size[key] <= LIMITS.maxSize)) throw new Error('节点尺寸须在 160–2400 之间。')
      if (!isObject(node.config)) throw new Error('节点配置必须是对象。')
      inspectJson(node.config)
      const definition = registry.get(node.type, node.version)
      const error = definition?.validateConfig?.(node.config)
      if (error) throw new Error(error)
      return { id: node.id, type: node.type, version: node.version, name: node.name, position: { x: node.position.x, y: node.position.y }, size: { width: node.size.width, height: node.size.height }, config: node.config }
    })
    if (nodes.filter((node) => registry.get(node.type, node.version)?.execution === NODE_EXECUTION.entry).length > 1) throw new Error('每个工作流最多只能有一个开始节点。')
    const edgeIds = new Set()
    const edges = value.edges.map((edge) => {
      if (!isObject(edge) || !idValid(edge.id) || ids.has(edge.id) || edgeIds.has(edge.id)
        || !isObject(edge.source) || !isObject(edge.target)) throw new Error('连线标识或端点无效。')
      edgeIds.add(edge.id)
      return { id: edge.id, source: { nodeId: edge.source.nodeId, port: edge.source.port }, target: { nodeId: edge.target.nodeId, port: edge.target.port } }
    })
    const viewport = value.viewport
    if (!isObject(viewport) || !finite(viewport.x, LIMITS.coordinate) || !finite(viewport.y, LIMITS.coordinate)
      || !Number.isFinite(viewport.zoom) || viewport.zoom < LIMITS.minZoom || viewport.zoom > LIMITS.maxZoom) throw new Error('画布视口无效。')
    const document = { version: 1, id: value.id, name: value.name.trim(), nodes, edges, viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } }
    for (const edge of edges) {
      const error = validateConnection(document, registry, { ...edge, allowUnknown: true })
      if (error) throw new Error(error)
    }
    if (bytes(document) > LIMITS.documentBytes) throw new Error('工作流内容超过 4 MiB 限制。')
    return freeze(document)
  }

  /** 从唯一入口确定任务范围，仅补齐被引用的数据来源，不扩张无关分支。 */
  function createExecutionPlan(document, registry) {
    const nodes = new Map(document.nodes.map((node) => [node.id, node]))
    const definitions = new Map()
    for (const node of document.nodes) {
      const definition = registry.get(node.type, node.version)
      if (!definition) throw new Error(`节点“${node.name}”的类型或版本尚未安装，无法运行。`)
      definitions.set(node.id, definition)
    }
    const entries = document.nodes.filter((node) => definitions.get(node.id).execution === NODE_EXECUTION.entry)
    if (entries.length !== 1) throw new Error('流程必须包含一个开始节点，请先添加开始节点。')
    const entry = entries[0]
    const incoming = new Map(document.nodes.map((node) => [node.id, []]))
    const outgoing = new Map(document.nodes.map((node) => [node.id, []]))
    for (const edge of document.edges) {
      incoming.get(edge.target.nodeId).push(edge)
      outgoing.get(edge.source.nodeId).push(edge)
    }
    if (!outgoing.get(entry.id).length) throw new Error('开始节点未连接后续流程，请连接处理节点的启动输入。')
    const active = new Set([entry.id])
    const pending = [entry.id]
    while (pending.length) {
      for (const edge of outgoing.get(pending.pop())) {
        if (active.has(edge.target.nodeId)) continue
        active.add(edge.target.nodeId)
        pending.push(edge.target.nodeId)
      }
    }
    for (const id of active) {
      for (const edge of incoming.get(id)) {
        const port = definitions.get(id).inputs.find((item) => item.id === edge.target.port)
        if ((port.kind ?? PORT_KIND.data) === PORT_KIND.data && definitions.get(edge.source.nodeId).execution === NODE_EXECUTION.data) active.add(edge.source.nodeId)
      }
    }
    return { entry, active, incoming, outgoing, nodes, definitions }
  }

  /** 找出两版文档间节点内容或连线变化的节点及其全部下游，只有这些节点的旧结果失效。 */
  function affectedNodes(previous, next) {
    const before = new Map(previous.nodes.map((node) => [node.id, node]))
    const after = new Set(next.nodes.map((node) => node.id))
    const seeds = new Set()
    for (const node of next.nodes) {
      const old = before.get(node.id)
      if (!old || old.type !== node.type || old.version !== node.version || old.name !== node.name
        || JSON.stringify(old.config) !== JSON.stringify(node.config)) seeds.add(node.id)
    }
    for (const id of before.keys()) if (!after.has(id)) seeds.add(id)
    const key = (edge) => JSON.stringify([edge.source.nodeId, edge.source.port, edge.target.nodeId, edge.target.port])
    const oldEdges = new Set(previous.edges.map(key))
    const newEdges = new Set(next.edges.map(key))
    for (const edge of previous.edges) if (!newEdges.has(key(edge))) seeds.add(edge.target.nodeId)
    for (const edge of next.edges) if (!oldEdges.has(key(edge))) seeds.add(edge.target.nodeId)
    const edges = [...previous.edges, ...next.edges]
    for (const id of seeds) for (const edge of edges) if (edge.source.nodeId === id) seeds.add(edge.target.nodeId)
    return seeds
  }

  /** 创建可识别的取消异常，不携带业务原文。 */
  function abortError() {
    const error = new Error('运行已停止。')
    error.name = 'AbortError'
    return error
  }

  /** 即使执行器忽略取消，也及时结束等待并拒绝迟到结果。 */
  function withAbort(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(abortError())
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  /** 工作区共享并发额度，切换或新增工作流不能绕过限制。 */
  class ExecutionPool {
    constructor() {
      this.active = 0
      this.waiters = []
    }

    /** 获取可取消的执行名额，归还时唤醒下一任务。 */
    acquire(signal) {
      if (signal.aborted) return Promise.reject(abortError())
      return new Promise((resolve, reject) => {
        const entry = {
          signal,
          start: () => {
            signal.removeEventListener('abort', entry.abort)
            this.active += 1
            let released = false
            resolve(() => {
              if (released) return
              released = true
              this.active -= 1
              const next = this.waiters.shift()
              if (next) next.start()
            })
          },
          abort: () => {
            this.waiters = this.waiters.filter((item) => item !== entry)
            reject(abortError())
          },
        }
        signal.addEventListener('abort', entry.abort, { once: true })
        if (this.active < LIMITS.concurrency) entry.start()
        else this.waiters.push(entry)
      })
    }
  }

  /** 独立于画布库的文档、历史、保存及数据流执行工作区。 */
  class Workspace {
    constructor({ registry, storage = null, services = {}, onStorageError = () => {} }) {
      this.registry = registry
      this.storage = storage
      this.services = services
      this.onStorageError = onStorageError
      this._documents = []
      this._activeId = null
      this.sessions = new Map()
      this.listeners = new Set()
      this.pool = new ExecutionPool()
      this.storageProtected = false
      this.storageError = ''
      this._restore()
    }

    get documents() { return Object.freeze([...this._documents]) }
    get activeId() { return this._activeId }

    /** 返回不可修改的流程定义。 */
    getDocument(id = this._activeId) {
      const document = this._documents.find((item) => item.id === id)
      if (!document) throw new Error('工作流不存在。')
      return document
    }

    /** 返回隔离的运行状态；输出本身为深冻结数据。 */
    getRuntime(id = this._activeId) {
      const runtime = this._session(id).runtime
      return Object.freeze({ ...runtime, controller: undefined, states: new Map([...runtime.states].map(([key, state]) => [key, Object.freeze({ ...state })])) })
    }

    /** 订阅局部变更，返回解除订阅函数。 */
    subscribe(listener) {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }

    /** 初始化或恢复草稿；损坏内容进入保护状态而非静默覆盖。 */
    _restore() {
      try {
        const raw = this.storage?.getItem(STORAGE_KEY)
        if (raw) {
          if (bytes(raw) > LIMITS.workspaceBytes) throw new Error('工作区草稿超出限制。')
          const value = JSON.parse(raw)
          if (value?.version !== 1 || !Array.isArray(value.documents) || !value.documents.length || value.documents.length > LIMITS.documents) throw new Error('工作区草稿格式不兼容。')
          const documents = value.documents.map((item) => parseDocument(item, this.registry))
          if (new Set(documents.map((item) => item.id)).size !== documents.length) throw new Error('工作区草稿包含重复流程。')
          this._documents = documents
          this._activeId = documents.some((item) => item.id === value.activeId) ? value.activeId : documents[0].id
          return
        }
      } catch {
        this.storageProtected = true
        this.storageError = '原草稿损坏、不可读取或版本不兼容，尚未覆盖；显式新建或导入后才会替换本地草稿。'
        this.onStorageError(this.storageError)
      }
      const document = this._empty('未命名工作流')
      this._documents = [document]
      this._activeId = document.id
    }

    /** 生成独立的空文档。 */
    _empty(name) {
      return parseDocument({ version: 1, id: makeId(), name, nodes: [], edges: [], viewport: { x: 24, y: 24, zoom: 1 } }, this.registry)
    }

    /** 保存白名单文档，不包含运行状态、结果或应用认证信息。 */
    _persist() {
      if (this.storageProtected) return
      try {
        if (!this.storage) throw new Error('storage unavailable')
        const raw = JSON.stringify({ version: 1, activeId: this._activeId, documents: this._documents })
        this.storage.setItem(STORAGE_KEY, raw)
        this.storageError = ''
      } catch {
        const message = '本地保存失败（存储不可用或空间不足），当前内容仍保留在页面内存中，请及时导出。'
        if (this.storageError !== message) this.onStorageError(message)
        this.storageError = message
      }
    }

    /** 校验整个工作区的累计预算，超限不安装变更。 */
    _checkBudget(documents, activeId = this._activeId) {
      if (documents.length > LIMITS.documents) throw new Error('最多保存 30 份工作流。')
      if (bytes({ version: 1, activeId, documents }) > LIMITS.workspaceBytes) throw new Error('工作区累计内容超过 8 MiB，请导出并删除不再使用的流程。')
    }

    /** 取得流程私有历史和运行状态。 */
    _session(id) {
      this.getDocument(id)
      if (!this.sessions.has(id)) this.sessions.set(id, { past: [], future: [], merge: null, runtime: idleRuntime() })
      return this.sessions.get(id)
    }

    /** 广播语义事件，视图自行决定局部刷新范围。 */
    _notify(id, event) {
      for (const listener of this.listeners) listener(id, event)
    }

    /** 运行时阻止所有业务修改，不依赖界面禁用状态。 */
    _assertEditable(id) {
      if (this._session(id).runtime.running) throw new Error('工作流正在运行，请先停止或等待完成。')
    }

    /** 只让变化节点及其下游的结果失效，其余成功结果保留供“从此节点运行”复用。 */
    _invalidate(session, previous, next) {
      const runtime = session.runtime
      if (!runtime.states.size) return
      const affected = affectedNodes(previous, next)
      if (!affected.size) return
      const states = new Map([...runtime.states].filter(([nodeId]) => !affected.has(nodeId)))
      session.runtime = states.size ? { ...runtime, status: 'stale', states } : idleRuntime()
    }

    /** 限制每份流程及整个工作区的撤销数据量。 */
    _trimHistory() {
      const entries = []
      for (const session of this.sessions.values()) {
        if (session.past.length > LIMITS.historySteps) session.past.splice(0, session.past.length - LIMITS.historySteps)
        for (const stack of [session.past, session.future]) for (const entry of stack) entries.push({ stack, entry })
      }
      let total = entries.reduce((sum, item) => sum + item.entry.bytes, 0)
      entries.sort((a, b) => a.entry.at - b.entry.at)
      while (total > LIMITS.historyBytes && entries.length) {
        const { stack, entry } = entries.shift()
        stack.splice(stack.indexOf(entry), 1)
        total -= entry.bytes
      }
    }

    /** 原子提交编辑，历史与运行结果按语义更新。 */
    _commit(id, mutate, options = {}) {
      this._assertEditable(id)
      const previous = this.getDocument(id)
      const draft = clone(previous)
      mutate(draft)
      const next = parseDocument(draft, this.registry)
      if (JSON.stringify(previous) === JSON.stringify(next)) return previous
      const documents = this._documents.map((item) => item.id === id ? next : item)
      this._checkBudget(documents)
      const session = this._session(id)
      const now = Date.now()
      if (!options.merge || session.merge?.key !== options.merge || now - session.merge.at > LIMITS.inputMergeMs) {
        session.past.push({ document: previous, at: now, bytes: bytes(previous), kind: options.kind || 'structure' })
      }
      session.merge = options.merge ? { key: options.merge, at: now } : null
      session.future = []
      this._documents = documents
      this._invalidate(session, previous, next)
      this._trimHistory()
      this._persist()
      this._notify(id, { kind: options.kind || 'structure', nodeIds: options.nodeIds })
      return next
    }

    /** 新建流程；显式操作允许替换受保护的损坏草稿。 */
    create(name = '未命名工作流') {
      const document = this._empty(name)
      this._checkBudget([...this._documents, document], document.id)
      this._documents.push(document)
      this._activeId = document.id
      this.storageProtected = false
      this._persist()
      this._notify(document.id, { kind: 'workspace' })
      return document
    }

    /** 切换画布，不影响其他流程的运行。 */
    select(id) {
      this.getDocument(id)
      this._checkBudget(this._documents, id)
      this._activeId = id
      this._persist()
      this._notify(id, { kind: 'workspace' })
    }

    /** 修改工作流名称。 */
    rename(id, name) {
      return this._commit(id, (draft) => { draft.name = name }, { kind: 'content' })
    }

    /** 复制完整流程与连接关系，但不复制结果或历史。 */
    duplicate(id) {
      this._assertEditable(id)
      return this.importDocument(this.getDocument(id))
    }

    /** 删除非运行中的流程，至少保留一个空工作流。 */
    remove(id) {
      this._assertEditable(id)
      this._documents = this._documents.filter((item) => item.id !== id)
      this.sessions.delete(id)
      if (!this._documents.length) this._documents.push(this._empty('未命名工作流'))
      if (this._activeId === id) this._activeId = this._documents[0].id
      this._persist()
      this._notify(this._activeId, { kind: 'workspace' })
    }

    /** 校验成功后作为新流程导入，不覆盖同标识已有流程。 */
    importDocument(raw) {
      const original = parseDocument(raw, this.registry)
      const document = parseDocument({ ...clone(original), id: makeId(), name: `${original.name.slice(0, 115)} 副本` }, this.registry)
      this._checkBudget([...this._documents, document], document.id)
      this._documents.push(document)
      this._activeId = document.id
      this.storageProtected = false
      this._persist()
      this._notify(document.id, { kind: 'workspace' })
      return document
    }

    /** 仅导出定义和用户输入，原文可能含敏感值。 */
    exportDocument(id = this._activeId) {
      return JSON.stringify(this.getDocument(id))
    }

    /** 使用注册定义的默认参数创建节点。 */
    addNode(type, position) {
      const definition = this.registry.list().find((item) => item.type === type)
      if (!definition) throw new Error('未注册的节点类型。')
      const node = { id: makeId(), type, version: definition.version, name: definition.label, position, size: clone(definition.size || { width: 300, height: 220 }), config: clone(definition.defaults) }
      this._commit(this._activeId, (draft) => { draft.nodes.push(node) }, { nodeIds: [node.id] })
      return this.getDocument().nodes.find((item) => item.id === node.id)
    }

    /** 按注册的逐版本迁移（配置与可选的输入端口改名）把节点显式升级到最新版本，作为一次可撤销的编辑；缺少迁移时拒绝。 */
    upgradeNode(nodeId, id = this._activeId) {
      const node = this.getDocument(id).nodes.find((item) => item.id === nodeId)
      if (!node) throw new Error('节点不存在。')
      const latest = this.registry.list().find((item) => item.type === node.type)
      if (!latest || latest.version <= node.version) throw new Error('节点已是最新版本。')
      let config = clone(node.config)
      const renames = []
      for (let version = node.version + 1; version <= latest.version; version += 1) {
        const definition = this.registry.get(node.type, version)
        if (typeof definition?.migrate !== 'function') throw new Error('该节点缺少版本迁移方案，不能自动升级。')
        config = definition.migrate(config)
        if (definition.renameInputs) renames.push(definition.renameInputs)
      }
      return this._commit(id, (draft) => {
        const target = draft.nodes.find((item) => item.id === nodeId)
        target.version = latest.version
        target.config = config
        for (const rename of renames) {
          for (const edge of draft.edges) if (edge.target.nodeId === nodeId && has(rename, edge.target.port)) edge.target.port = rename[edge.target.port]
        }
      }, { nodeIds: [nodeId] })
    }

    /** 更新内容或布局；连续文本输入合并为一次撤销。 */
    updateNode(nodeId, patch, id = this._activeId) {
      const content = has(patch, 'config') || has(patch, 'name')
      return this._commit(id, (draft) => {
        const node = draft.nodes.find((item) => item.id === nodeId)
        if (!node) throw new Error('节点不存在。')
        for (const key of ['name', 'position', 'size', 'config']) if (has(patch, key)) node[key] = clone(patch[key])
      }, { kind: content ? 'content' : 'layout', nodeIds: [nodeId], merge: has(patch, 'config') ? `text:${nodeId}` : null })
    }

    /** 删除选择的节点和连线，同时清理关联连线。 */
    deleteSelection({ nodeIds = [], edgeIds = [] }, id = this._activeId) {
      const selected = new Set(nodeIds)
      this._commit(id, (draft) => {
        draft.nodes = draft.nodes.filter((node) => !selected.has(node.id))
        draft.edges = draft.edges.filter((edge) => !edgeIds.includes(edge.id) && !selected.has(edge.source.nodeId) && !selected.has(edge.target.nodeId))
      })
    }

    /** 复制选中子图，重建节点及内部连线标识。 */
    copySelection(nodeIds, id = this._activeId) {
      const document = this.getDocument(id)
      const map = new Map(document.nodes.filter((node) => nodeIds.includes(node.id)).map((node) => [node.id, makeId()]))
      const nodes = document.nodes.filter((node) => map.has(node.id)).map((node) => ({ ...clone(node), id: map.get(node.id), position: { x: node.position.x + 32, y: node.position.y + 32 } }))
      const edges = document.edges.filter((edge) => map.has(edge.source.nodeId) && map.has(edge.target.nodeId)).map((edge) => ({ id: makeId(), source: { nodeId: map.get(edge.source.nodeId), port: edge.source.port }, target: { nodeId: map.get(edge.target.nodeId), port: edge.target.port } }))
      this._commit(id, (draft) => { draft.nodes.push(...nodes); draft.edges.push(...edges) })
      return nodes
    }

    /** 一次插入完整子图，校验后统一分配标识并写入一条历史。 */
    insertSubgraph(graph, id = this._activeId) {
      this._assertEditable(id)
      const part = parseDocument({ version: 1, id: 'fragment', name: '节点片段', nodes: graph.nodes, edges: graph.edges, viewport: { x: 0, y: 0, zoom: 1 } }, this.registry)
      for (const node of part.nodes) if (!this.registry.get(node.type, node.version)) throw new Error('不能新建未注册的节点类型或版本。')
      const ids = new Map(part.nodes.map((node) => [node.id, makeId()]))
      const nodes = part.nodes.map((node) => ({ ...clone(node), id: ids.get(node.id) }))
      const edges = part.edges.map((edge) => ({ id: makeId(), source: { nodeId: ids.get(edge.source.nodeId), port: edge.source.port }, target: { nodeId: ids.get(edge.target.nodeId), port: edge.target.port } }))
      this._commit(id, (draft) => { draft.nodes.push(...nodes); draft.edges.push(...edges) })
      return nodes
    }

    /** 将一次多选拖动作为原子的布局编辑，避免逐节点撤销。 */
    updateLayout(updates, id = this._activeId) {
      return this._commit(id, (draft) => {
        for (const update of updates) {
          const node = draft.nodes.find((item) => item.id === update.id)
          if (!node) throw new Error('节点不存在。')
          for (const key of ['position', 'size']) if (has(update, key)) node[key] = clone(update[key])
        }
      }, { kind: 'layout', nodeIds: updates.map((item) => item.id) })
    }

    /** 创建通过类型和无环校验的连线。 */
    connect(connection, id = this._activeId) {
      const error = validateConnection(this.getDocument(id), this.registry, { source: connection.source, target: connection.target })
      if (error) throw new Error(error)
      const edge = { id: makeId(), source: clone(connection.source), target: clone(connection.target) }
      this._commit(id, (draft) => { draft.edges.push(edge) })
      return edge
    }

    /** 删除指定连线。 */
    disconnect(edgeId, id = this._activeId) {
      return this.deleteSelection({ edgeIds: [edgeId] }, id)
    }

    /** 保存视口，不修改历史或运行结果，运行中也可使用。 */
    setViewport(viewport, id = this._activeId) {
      const previous = this.getDocument(id)
      const next = parseDocument({ ...previous, viewport }, this.registry)
      const documents = this._documents.map((item) => item.id === id ? next : item)
      this._checkBudget(documents)
      this._documents = documents
      this._persist()
      this._notify(id, { kind: 'viewport' })
    }

    /** 检查当前文档能否撤销。 */
    canUndo(id = this._activeId) { return !this._session(id).runtime.running && this._session(id).past.length > 0 }
    /** 检查当前文档能否重做。 */
    canRedo(id = this._activeId) { return !this._session(id).runtime.running && this._session(id).future.length > 0 }

    /** 在历史栈间移动，旧结果始终失效。 */
    _travel(id, direction) {
      this._assertEditable(id)
      const session = this._session(id)
      const from = direction === 'undo' ? session.past : session.future
      const to = direction === 'undo' ? session.future : session.past
      const entry = from[from.length - 1]
      if (!entry) return
      const current = this.getDocument(id)
      const restored = parseDocument({ ...entry.document, viewport: current.viewport }, this.registry)
      const documents = this._documents.map((item) => item.id === id ? restored : item)
      this._checkBudget(documents)
      from.pop()
      to.push({ document: current, at: Date.now(), bytes: bytes(current), kind: entry.kind })
      this._documents = documents
      session.merge = null
      this._invalidate(session, current, restored)
      this._trimHistory()
      this._persist()
      this._notify(id, { kind: entry.kind === 'layout' ? 'layout' : 'structure' })
    }

    /** 撤销当前文档的上一步编辑。 */
    undo(id = this._activeId) { this._travel(id, 'undo') }
    /** 重做当前文档的下一步编辑。 */
    redo(id = this._activeId) { this._travel(id, 'redo') }

    /** 控制非运行中的结果保留数量，不持久化执行输出。 */
    _evictResults() {
      const completed = [...this.sessions.entries()].filter(([, session]) => !session.runtime.running && session.runtime.states.size)
        .sort((a, b) => (a[1].runtime.finishedAt || 0) - (b[1].runtime.finishedAt || 0))
      while (completed.length > LIMITS.resultDocuments) {
        const [id, session] = completed.shift()
        session.runtime = idleRuntime()
        this._notify(id, { kind: 'runtime' })
      }
    }

    /** 限制所有流程累计输出体积，先释放其他已完成流程的旧结果。 */
    _admitOutputs(id, outputs) {
      const measure = () => {
        const seen = new Set()
        let total = 0
        const add = (value) => {
          if (value && typeof value === 'object') {
            if (seen.has(value)) return
            seen.add(value)
          }
          total += bytes(value)
        }
        Object.values(outputs).forEach(add)
        for (const session of this.sessions.values()) for (const state of session.runtime.states.values()) {
          if (state.outputs) Object.values(state.outputs).forEach(add)
        }
        return total
      }
      if (measure() <= LIMITS.resultBytes) return
      const old = [...this.sessions.entries()].filter(([key, session]) => key !== id && !session.runtime.running && session.runtime.states.size)
        .sort((a, b) => (a[1].runtime.finishedAt || 0) - (b[1].runtime.finishedAt || 0))
      for (const [key, session] of old) {
        session.runtime = idleRuntime()
        this._notify(key, { kind: 'runtime', message: '较早的运行结果已从内存清理，可重新运行。' })
        if (measure() <= LIMITS.resultBytes) return
      }
      throw new Error('工作区运行结果超过 32 MiB 限制，请减少处理节点或输入量后重试。')
    }

    /** 根据数据依赖执行整图；分支失败不会阻塞独立分支。 */
    async run(id = this._activeId) {
      this._assertEditable(id)
      const document = parseDocument(this.getDocument(id), this.registry)
      const plan = createExecutionPlan(document, this.registry)
      const unreachable = Object.freeze({ status: 'skipped', message: '未连接开始节点，本次未执行。', outputs: null })
      const states = new Map(document.nodes.map((node) => [node.id, plan.active.has(node.id) ? QUEUED : unreachable]))
      return this._execute(id, { document, plan, scope: plan.active, states })
    }

    /** 复用上游已成功的结果，只重跑指定节点及其下游；上游任务缺少可复用结果时在执行前拒绝。 */
    async runFrom(nodeId, id = this._activeId) {
      this._assertEditable(id)
      const document = parseDocument(this.getDocument(id), this.registry)
      const plan = createExecutionPlan(document, this.registry)
      if (!plan.active.has(nodeId)) throw new Error('该节点未连接开始节点，不能从此节点运行。')
      const previous = this._session(id).runtime.states
      const scope = new Set([nodeId])
      for (const current of scope) {
        for (const edge of plan.outgoing.get(current)) if (plan.active.has(edge.target.nodeId)) scope.add(edge.target.nodeId)
      }
      for (const current of scope) {
        for (const edge of plan.incoming.get(current)) {
          const source = edge.source.nodeId
          if (scope.has(source) || previous.get(source)?.status === 'succeeded') continue
          if (plan.definitions.get(source).execution !== NODE_EXECUTION.task) scope.add(source) // 开始与被动数据节点直接重新求值
          else throw new Error(`上游节点“${plan.nodes.get(source).name}”没有可复用的成功结果，请先运行整图。`)
        }
      }
      const states = new Map(previous)
      for (const current of scope) states.set(current, QUEUED)
      return this._execute(id, { document, plan, scope, states })
    }

    /** 执行范围内的节点并保留范围外的既有状态；类型不同的连线按输入端口类型校验后才分发。 */
    async _execute(id, { document, plan, scope, states }) {
      const { entry, incoming: incomingByNode, nodes, definitions } = plan
      const session = this._session(id)
      const controller = new AbortController()
      const runtime = { running: true, status: 'running', runId: makeId(), states, startedAt: Date.now(), finishedAt: null, controller }
      session.runtime = runtime
      session.merge = null
      const current = () => this.sessions.get(id)?.runtime === runtime && runtime.running && !controller.signal.aborted
      const setState = (nodeId, state) => {
        if (!current()) return
        runtime.states.set(nodeId, state)
        this._notify(id, { kind: 'runtime', nodeIds: [nodeId] })
      }
      const tasks = new Map()
      const execute = (node) => {
        if (tasks.has(node.id)) return tasks.get(node.id)
        const task = (async () => {
          const definition = definitions.get(node.id)
          const incoming = incomingByNode.get(node.id)
          await Promise.all(incoming.filter((edge) => scope.has(edge.source.nodeId)).map((edge) => execute(nodes.get(edge.source.nodeId))))
          if (!current()) return
          if (incoming.some((edge) => runtime.states.get(edge.source.nodeId)?.status !== 'succeeded')) {
            setState(node.id, { status: 'skipped', message: '上游失败或未完成，已跳过。', outputs: null })
            return
          }
          const values = Object.create(null)
          for (const edge of incoming) {
            const outputs = runtime.states.get(edge.source.nodeId).outputs
            if (!outputs || !has(outputs, edge.source.port)) continue
            const port = definition.inputs.find((item) => item.id === edge.target.port)
            const source = definitions.get(edge.source.nodeId).outputs.find((item) => item.id === edge.source.port)
            if (source.dataType !== port.dataType && !this.registry.dataTypes.get(port.dataType)(outputs[edge.source.port])) {
              setState(node.id, { status: 'failed', message: `输入“${port.label}”不符合 ${port.dataType} 数据类型。`, outputs: null })
              return
            }
            values[edge.target.port] = outputs[edge.source.port]
          }
          const missing = definition.inputs.filter((port) => port.required && !has(values, port.id))
          if (missing.length) {
            setState(node.id, { status: 'failed', message: `缺少输入：${missing.map((port) => port.label).join('、')}。`, outputs: null })
            return
          }
          const inputs = Object.create(null)
          const controls = Object.create(null)
          for (const port of definition.inputs) {
            if (!has(values, port.id)) continue
            const destination = port.kind === PORT_KIND.control ? controls : inputs
            destination[port.id] = values[port.id]
          }
          let release
          try {
            release = await this.pool.acquire(controller.signal)
            if (!current()) return
            setState(node.id, { status: 'running', message: '', outputs: null })
            let slot = release
            release = null
            /** 等待人工确认等非计算阶段时归还并发名额，结束后重新排队取得名额。 */
            const suspend = async (work) => {
              slot()
              try { return await work() } finally { slot = await this.pool.acquire(controller.signal) }
            }
            const execution = Promise.resolve().then(() => {
              if (!current()) throw abortError()
              return definition.execute({ node, inputs: freeze(inputs), controls: freeze(controls), services: this.services, signal: controller.signal, suspend })
            }).finally(() => slot())
            const result = await withAbort(execution, controller.signal)
            if (!current()) return
            if (!isObject(result)) throw new Error('节点未返回有效的端口输出。')
            const outputs = Object.create(null)
            for (const port of definition.outputs) {
              if (!has(result, port.id) || !this.registry.dataTypes.get(port.dataType)(result[port.id])) throw new Error(`节点输出“${port.label}”缺失或类型不正确。`)
              const value = result[port.id]
              outputs[port.id] = value && typeof value === 'object' && frozenData.has(value) ? value : freeze(clone(value))
            }
            this._admitOutputs(id, outputs)
            setState(node.id, { status: 'succeeded', message: '', outputs: Object.freeze(outputs) })
          } catch (error) {
            if (current()) setState(node.id, { status: 'failed', message: error instanceof Error ? error.message : '节点执行失败，请重试。', outputs: null })
          } finally { release?.() }
        })()
        tasks.set(node.id, task)
        return task
      }
      this._notify(id, { kind: 'runtime' })
      const others = document.nodes.filter((node) => scope.has(node.id) && node.id !== entry.id)
      if (scope.has(entry.id)) await execute(entry)
      if (current()) {
        if (!scope.has(entry.id) || runtime.states.get(entry.id).status === 'succeeded') await Promise.all(others.map(execute))
        else for (const node of others) setState(node.id, { status: 'skipped', message: '开始节点未成功，已跳过。', outputs: null })
      }
      if (current()) {
        const results = others.filter((node) => definitions.get(node.id).execution === NODE_EXECUTION.task).map((node) => runtime.states.get(node.id).status)
        const successes = results.filter((status) => status === 'succeeded').length
        const entryFailed = scope.has(entry.id) && runtime.states.get(entry.id).status !== 'succeeded'
        runtime.status = entryFailed ? 'failed' : successes === results.length ? 'succeeded' : successes ? 'partial' : 'failed'
        runtime.running = false
        runtime.finishedAt = Date.now()
        this._notify(id, { kind: 'runtime' })
        this._evictResults()
      }
      return Object.freeze({ status: runtime.status, runId: runtime.runId })
    }

    /** 停止调度和等待；旧执行器的迟到输出不能写入下一次运行。 */
    stop(id = this._activeId) {
      const runtime = this._session(id).runtime
      if (!runtime.running) return
      runtime.running = false
      runtime.status = 'cancelled'
      runtime.finishedAt = Date.now()
      for (const [nodeId, state] of runtime.states) if (state.status === 'running' || state.status === 'queued') runtime.states.set(nodeId, { status: 'cancelled', message: '运行已停止。', outputs: null })
      runtime.controller.abort()
      this._notify(id, { kind: 'runtime' })
      this._evictResults()
    }
  }

  const api = Object.freeze({ LIMITS, STORAGE_KEY, NODE_EXECUTION, PORT_KIND, NodeRegistry, Workspace, parseDocument, validateConnection, withAbort })
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.NestCloudWorkflowCore = api
})(typeof window === 'undefined' ? globalThis : window)
