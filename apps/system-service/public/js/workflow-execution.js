((root) => {
  const LIMITS = Object.freeze({
    responseBytes: 34 * 1024 * 1024, frameBytes: 2 * 1024 * 1024,
    requestMs: 30_000, heartbeatMs: 45_000, detachedPollMs: 5000,
    retryMs: Object.freeze([250, 500, 1000, 2000, 5000]),
  })
  const API = '/api/workflow'
  const TOKEN_HEADER = 'X-Workflow-Token'
  const TOKEN_STORAGE_KEY = 'nestcloud:release-tokens:v1'
  const EVENTS = Object.freeze(['snapshot', 'node-state', 'confirmations', 'run-finished'])
  const TERMINAL = Object.freeze(['succeeded', 'partial', 'failed', 'cancelled'])
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const byteLength = (value) => new TextEncoder().encode(value).length

  /** 协议错误与网络暂不可用分开处理，不回显请求、凭据或服务端原始异常。 */
  class ExecutionError extends Error {
    constructor(message, kind = 'protocol') {
      super(message)
      this.name = 'WorkflowExecutionError'
      this.kind = kind
    }
  }

  /** 只读取现有 Token 配置的允许字段，每次运行快照，不持久化服务端访问令牌。 */
  function runtimeCredentials(value) {
    const runtime = {}
    for (const key of ['githubToken', 'feishuAppId', 'feishuAppSecret']) if (typeof value?.[key] === 'string') runtime[key] = value[key]
    if (object(value?.ai)) {
      runtime.ai = {}
      for (const key of ['baseUrl', 'apiKey', 'model']) if (typeof value.ai[key] === 'string') runtime.ai[key] = value.ai[key]
      if (typeof value.ai.enableThinking === 'boolean') runtime.ai.enableThinking = value.ai.enableThinking
    }
    return runtime
  }

  /** 默认读取本浏览器凭据，读取失败即中止启动，不依赖服务端记忆参数。 */
  function readCredentials() {
    try {
      const raw = root.localStorage?.getItem(TOKEN_STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch { throw new ExecutionError('无法读取 Token 配置，请检查本浏览器配置。') }
  }

  /** 有界消费 JSON 响应，防止状态查询或错误正文无限增长。 */
  async function readPayload(response) {
    if (Number(response.headers?.get?.('Content-Length')) > LIMITS.responseBytes) throw new ExecutionError('执行服务响应超过结果预算。')
    if (!response.body?.getReader) {
      const value = await response.json()
      if (byteLength(JSON.stringify(value)) > LIMITS.responseBytes) throw new ExecutionError('执行服务响应超过结果预算。')
      return value
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = ''
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > LIMITS.responseBytes) throw new ExecutionError('执行服务响应超过结果预算。')
        text += decoder.decode(value, { stream: true })
      }
      return JSON.parse(text + decoder.decode())
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  /** SSE 增量解析器支持 UTF-8 解码后的跨块 CRLF、多行 data 与注释，逐帧限制内存。 */
  function createEventParser(onEvent) {
    let line = ''
    let event = ''
    let data = []
    let size = 0
    let afterCR = false
    const consume = () => {
      if (!line) {
        if (data.length && EVENTS.includes(event)) {
          let value
          try { value = JSON.parse(data.join('\n')) } catch { throw new ExecutionError('执行服务事件格式无效。') }
          onEvent(event, value)
        }
        event = ''
        data = []
        size = 0
      } else if (!line.startsWith(':')) {
        const separator = line.indexOf(':')
        const field = separator < 0 ? line : line.slice(0, separator)
        let value = separator < 0 ? '' : line.slice(separator + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      line = ''
    }
    return {
      /** 接纳一段已解码文本，先检查未结束行，再逐行推进帧状态。 */
      push(text) {
        let start = 0
        for (let index = 0; index < text.length; index += 1) {
          const character = text[index]
          if (afterCR) {
            afterCR = false
            if (character === '\n') { start = index + 1; continue }
          }
          if (character !== '\r' && character !== '\n') continue
          const part = text.slice(start, index)
          size += byteLength(part) + 1
          if (size > LIMITS.frameBytes) throw new ExecutionError('执行服务事件超过帧预算。')
          line += part
          consume()
          afterCR = character === '\r'
          start = index + 1
        }
        const rest = text.slice(start)
        size += byteLength(rest)
        if (size > LIMITS.frameBytes) throw new ExecutionError('执行服务事件超过帧预算。')
        line += rest
      },
    }
  }

  /** 建立固定同源后端执行适配器；断开订阅不取消任务，状态轮询仍使锁最终收敛。 */
  function createRunner(options = {}) {
    const request = options.request || root.fetch?.bind(root)
    const credentials = options.readCredentials || readCredentials
    const confirmWrite = options.confirmWrite
    const timing = { ...LIMITS, ...options.timing }

    /** 每次调用仅提交一次启动请求；handle 中的认证信息只保存在闭包内存。 */
    function start(input) {
      let runId = null
      let accessToken = null
      let revision = -1
      let finished = false
      let attached = true
      let stopping = false
      let stream = null
      let wake = null
      let latest = null
      let terminal = false
      const pending = new Map()
      const answered = new Set()
      const controllers = new Set()
      const outputsPending = new Set()
      const nodeStates = new Map()
      const nodeRevisions = new Map()
      const hydrated = new Set()
      let outputTask = null
      let outputError = null
      let outputWake = null
      const onUpdate = input.onUpdate
      // 立即序列化本次完整文档和凭据，调用方之后的编辑与配置变化不影响请求。
      let body
      let startupError
      try {
        body = JSON.stringify({ document: JSON.stringify(input.document), runtime: runtimeCredentials(credentials()),
          dateContext: { now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          ...(input.fromNodeId === undefined ? {} : { fromNodeId: input.fromNodeId, previousOutputs: input.previousOutputs || [] }) })
      } catch { startupError = new ExecutionError('无法准备本次运行参数，请检查 Token 配置。') }
      input = null

      /** 中止已消失、停止或脱离视图的确认框，不把 abort 解析出的 false 回传后端。 */
      function cancelConfirmations() {
        for (const item of pending.values()) { item.controller.abort(); clearTimeout(item.timer) }
        pending.clear()
      }

      /** 同源 JSON 请求使用专用认证头、预算和超时；只在服务端明确 404 时声明结果丢失。 */
      async function json(path, payload, authenticated = true) {
        const controller = new AbortController()
        controllers.add(controller)
        const timer = setTimeout(() => controller.abort(), timing.requestMs)
        try {
          const response = await request(`${API}/${path}`, {
            method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authenticated ? { [TOKEN_HEADER]: accessToken } : {}) },
            ...(payload === undefined ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }), signal: controller.signal,
          })
          if (authenticated && response.status === 404) throw new ExecutionError('服务端执行状态已丢失或过期，运行结果未知，请核实后再运行。', 'lost')
          if (!response.ok) throw new ExecutionError('执行服务暂不可用，请稍后重试。', 'network')
          const result = await readPayload(response)
          if (result?.code !== 200 || !object(result.data)) throw new ExecutionError('执行服务未接受请求，请检查参数或稍后重试。', 'network')
          return result.data
        } catch (error) {
          if (error instanceof ExecutionError) throw error
          throw new ExecutionError('执行服务连接暂时中断，正在恢复状态。', 'network')
        } finally {
          clearTimeout(timer)
          controllers.delete(controller)
        }
      }

      /** 校准新序号并向核心发送状态，完整查询允许同序号补回输出但不回退旧状态。 */
      function receive(snapshot, full = false) {
        if (!object(snapshot) || snapshot.runId !== runId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
          || typeof snapshot.running !== 'boolean' || !Array.isArray(snapshot.states) || snapshot.states.length > 100) throw new ExecutionError('执行服务返回无效状态。')
        if (snapshot.revision < revision || (snapshot.revision === revision && !full)) return false
        try { onUpdate(snapshot, { full }) } catch { throw new ExecutionError('执行服务返回的节点结果无效或超过预算，运行结果未知。') }
        revision = snapshot.revision
        latest = snapshot
        for (const state of snapshot.states) {
          if (!object(state) || typeof state.nodeId !== 'string' || !state.nodeId.length || state.nodeId.length > 128
            || (!nodeStates.has(state.nodeId) && nodeStates.size >= 100)) throw new ExecutionError('执行服务节点数量或标识无效。')
          nodeStates.set(state.nodeId, state)
          nodeRevisions.set(state.nodeId, snapshot.revision)
          if (state.status === 'succeeded' && has(state, 'outputs')) hydrated.add(state.nodeId)
        }
        terminal = snapshot.running === false
        if (has(snapshot, 'confirmations')) syncConfirmations(snapshot.confirmations)
        if (terminal) cancelConfirmations()
        return true
      }

      /** 逐次展示真实写入内容；确认 ID 去重，失效或取消后不允许旧弹窗授权。 */
      function syncConfirmations(confirmations) {
        if (!Array.isArray(confirmations) || confirmations.length > 3) throw new ExecutionError('执行服务确认信息无效。')
        const present = new Set(confirmations.map((item) => item.confirmationId))
        for (const [id, item] of pending) if (!present.has(id)) {
          item.controller.abort()
          clearTimeout(item.timer)
          pending.delete(id)
        }
        if (!attached || stopping || terminal || typeof confirmWrite !== 'function') return
        for (const item of confirmations) {
          const id = item.confirmationId
          if (typeof id !== 'string' || !id.length || id.length > 128 || !Number.isFinite(item.expiresAt)) throw new ExecutionError('执行服务确认信息无效。')
          if (pending.has(id) || answered.has(id)) continue
          const controller = new AbortController()
          const record = { controller, timer: setTimeout(() => controller.abort(), Math.max(0, Math.min(item.expiresAt - Date.now(), timing.requestMs * 20))) }
          pending.set(id, record)
          void Promise.resolve().then(() => {
            if (controller.signal.aborted) return false
            return confirmWrite({ nodeName: item.nodeName, wikiUrl: item.wikiUrl, range: item.range, values: item.values, signal: controller.signal })
          }).then(async (accepted) => {
            if (controller.signal.aborted || pending.get(id) !== record || !attached || stopping || finished) return
            answered.add(id)
            try { await json('confirm', { runId, confirmationId: id, accepted: accepted === true }) }
            catch (error) { if (error.kind === 'lost') throw error; answered.delete(id) }
          }).catch(() => { /* 状态查询负责恢复确认列表；弹窗异常不能授权写入。 */ }).finally(() => {
            clearTimeout(record.timer)
            if (pending.get(id) === record) pending.delete(id)
          })
        }
      }

      /** 取消等待可立即重新挂载，不留下未清理的退避定时器。 */
      function wait(ms) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => { wake = null; resolve() }, ms)
          wake = () => { clearTimeout(timer); wake = null; resolve() }
        })
      }

      /** 首次、断线恢复及终态查询完整快照，正常 SSE 运行不反复传输全量结果。 */
      async function recover() {
        const snapshot = await json(`status?runId=${encodeURIComponent(runId)}`)
        receive(snapshot, true)
        return snapshot
      }

      /** 单并发有界输出队列；旧全局序号的响应只补未变化节点的输出，不覆盖新元数据。 */
      function hydrateOutputs() {
        if (outputTask || terminal || finished || !outputsPending.size) return
        outputTask = (async () => {
          let failures = 0
          while (outputsPending.size && !terminal && !finished) {
            const nodeId = outputsPending.values().next().value
            outputsPending.delete(nodeId)
            if (hydrated.has(nodeId) || nodeStates.get(nodeId)?.status !== 'succeeded') continue
            try {
              const snapshot = await json(`status?runId=${encodeURIComponent(runId)}&nodeId=${encodeURIComponent(nodeId)}`)
              if (finished || terminal) return
              if (!object(snapshot) || snapshot.runId !== runId || !Number.isSafeInteger(snapshot.revision)
                || !Array.isArray(snapshot.states) || snapshot.states.length !== 1 || snapshot.states[0].nodeId !== nodeId) throw new ExecutionError('执行服务返回无效节点结果。')
              if (snapshot.running === false) { terminal = true; stream?.abort(); wake?.(); return }
              const state = snapshot.states[0]
              const current = nodeStates.get(nodeId)
              if (snapshot.revision < nodeRevisions.get(nodeId)) throw new ExecutionError('节点状态正在同步。', 'network')
              if (state.status !== 'succeeded' || !has(state, 'outputs') || !object(state.outputs)) throw new ExecutionError('执行服务未返回完整节点结果。')
              if (current?.status !== 'succeeded') continue
              const patch = { runId, revision, running: true, status: latest?.status || 'running', states: [{ ...current, outputs: state.outputs }] }
              try { onUpdate(patch, { full: true }) } catch { throw new ExecutionError('执行服务返回的节点结果无效或超过预算，运行结果未知。') }
              hydrated.add(nodeId)
              failures = 0
            } catch (error) {
              if (finished || terminal) return
              if (error.kind !== 'network') throw error
              outputsPending.add(nodeId)
              await new Promise((resolve) => {
                const timer = setTimeout(() => { outputWake = null; resolve() }, timing.retryMs[Math.min(failures++, timing.retryMs.length - 1)])
                outputWake = () => { clearTimeout(timer); outputWake = null; resolve() }
              })
            }
          }
        })().catch((error) => {
          outputError = error
          stream?.abort()
          wake?.()
        }).finally(() => { outputTask = null; if (!outputError) hydrateOutputs() })
      }

      /** 消费带认证头的 SSE，节点成功只排入结果队列；连接持续接收后续状态与确认。 */
      async function subscribe() {
        const controller = new AbortController()
        stream = controller
        let timer
        let reader
        const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timing.heartbeatMs) }
        try {
          arm()
          const response = await request(`${API}/events?runId=${encodeURIComponent(runId)}`, {
            method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { [TOKEN_HEADER]: accessToken, Accept: 'text/event-stream' }, signal: controller.signal,
          })
          if (response.status === 404) throw new ExecutionError('服务端执行状态已丢失或过期，运行结果未知，请核实后再运行。', 'lost')
          if (!response.ok || !response.body?.getReader || !response.headers?.get?.('Content-Type')?.includes('text/event-stream')) throw new ExecutionError('实时状态连接暂时中断。', 'network')
          reader = response.body.getReader()
          const decoder = new TextDecoder('utf-8', { fatal: true })
          const parser = createEventParser((event, snapshot) => {
            if (!receive(snapshot)) return
            if (event === 'node-state' || event === 'snapshot') {
              for (const state of snapshot.states) if (state.status === 'succeeded' && !hydrated.has(state.nodeId)) outputsPending.add(state.nodeId)
              hydrateOutputs()
            }
            if (terminal) controller.abort()
          })
          while (!controller.signal.aborted && attached && !finished) {
            const part = await reader.read()
            if (part.done) { parser.push(decoder.decode()); break }
            arm()
            parser.push(decoder.decode(part.value, { stream: true }))
          }
        } catch (error) {
          if (error instanceof ExecutionError && error.kind !== 'network') throw error
          // 断线、超时和视图卸载都只触发状态恢复，不修改节点执行状态。
        } finally {
          clearTimeout(timer)
          controller.abort()
          if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
          if (stream === controller) stream = null
        }
      }

      const started = (async () => {
        if (startupError) throw startupError
        try {
          const result = await json('run', body, false)
          if (typeof result.runId !== 'string' || !result.runId.length || typeof result.accessToken !== 'string' || !result.accessToken.length) throw new ExecutionError('执行服务启动响应无效，后台运行结果未知。')
          runId = result.runId
          accessToken = result.accessToken
        } catch (error) {
          if (error.kind === 'network') throw new ExecutionError('启动请求未确认，后台可能仍在执行，请核实后再运行。')
          throw error
        } finally { body = null }
      })()

      const done = (async () => {
        try {
          await started
          let failures = 0
          for (;;) {
            try {
              if (outputError) throw outputError
              const snapshot = await recover()
              if (!snapshot.running) {
                if (!TERMINAL.includes(snapshot.status)) throw new ExecutionError('执行服务未返回有效终态。')
                return snapshot
              }
              if (attached) await subscribe()
              if (outputError) throw outputError
              if (terminal) continue // 终态事件不带输出，下一轮必须重新查询完整 status。
              failures = Math.min(failures + 1, timing.retryMs.length - 1)
              await wait(attached ? timing.retryMs[failures] : timing.detachedPollMs)
            } catch (error) {
              if (error.kind !== 'network') throw error
              await wait(attached ? timing.retryMs[Math.min(failures++, timing.retryMs.length - 1)] : timing.detachedPollMs)
            }
          }
        } finally {
          finished = true
          cancelConfirmations()
          stream?.abort()
          wake?.()
          outputWake?.()
          outputsPending.clear()
          nodeStates.clear()
          nodeRevisions.clear()
          hydrated.clear()
          for (const controller of controllers) controller.abort()
          controllers.clear()
          accessToken = null
          latest = null
        }
      })()
      return Object.freeze({
        done,
        /** 显式停止必须等待启动结果后补发 POST，失败保持订阅与运行锁，交由调用方展示。 */
        async stop() {
          if (finished) return
          stopping = true
          cancelConfirmations()
          try { await started; if (!finished) await json('stop', { runId }); stream?.abort(); wake?.() }
          catch { stopping = false; throw new ExecutionError('停止请求失败，后台可能仍在运行，已继续订阅，请重试停止。', 'network') }
        },
        /** 视图移除仅关闭流和弹窗，后续状态轮询仍收敛结果与工作区锁。 */
        disconnect() { attached = false; cancelConfirmations(); stream?.abort(); wake?.() },
        /** 同页重新挂载恢复 SSE 与未确认弹窗，不重新 POST run。 */
        reconnect() { if (finished) return; attached = true; if (latest?.confirmations) syncConfirmations(latest.confirmations); stream?.abort(); wake?.() },
      })
    }
    return Object.freeze({ start })
  }

  const api = Object.freeze({ createRunner, createEventParser, runtimeCredentials, LIMITS })
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.NestCloudWorkflowExecution = api
})(typeof window === 'undefined' ? globalThis : window)
