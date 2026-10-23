((root) => {
  const Core = typeof module !== 'undefined' && module.exports ? require('./workflow-core.js') : root.NestCloudWorkflowCore
  const Capabilities = typeof module !== 'undefined' && module.exports ? require('./workflow-capabilities.js') : root.NestCloudWorkflowCapabilities
  const ENDPOINTS = Object.freeze({ json: '/api/content-compare/json', env: '/api/content-compare/env' })
  const REQUEST_TIMEOUT_MS = 30_000
  const STATUSES = new Set(['added', 'removed', 'modified', 'unchanged'])
  const MAX_TREE_NODES = 50_000

  /** 校验结构化结果，避免将错误响应作为成功数据分发。 */
  function isDiffResult(value) {
    if (!value || !Object.hasOwn(ENDPOINTS, value.format) || typeof value.leftText !== 'string' || typeof value.rightText !== 'string'
      || value.leftText.length > Core.LIMITS.textLength || value.rightText.length > Core.LIMITS.textLength
      || !value.stats || !['added', 'removed', 'modified'].every((key) => Number.isSafeInteger(value.stats[key]) && value.stats[key] >= 0)) return false
    for (const side of ['left', 'right']) {
      const segments = value.segments?.[side]
      if (!Array.isArray(segments) || segments.length > MAX_TREE_NODES * 4
        || segments.some((segment) => !segment || typeof segment.text !== 'string' || (segment.status !== null && !['added', 'removed', 'modified'].includes(segment.status)))
        || segments.map((segment) => segment.text).join('') !== value[`${side}Text`]) return false
    }
    const pending = [value.tree]
    let count = 0
    while (pending.length) {
      const node = pending.pop()
      if (++count > MAX_TREE_NODES || !node || !Array.isArray(node.children) || typeof node.path !== 'string'
        || !['string', 'number'].includes(typeof node.key) || !STATUSES.has(node.status)
        || !['object', 'array', 'value'].includes(node.type) || typeof node.hasLeft !== 'boolean' || typeof node.hasRight !== 'boolean'
        || typeof node.leftDisplay !== 'string' || typeof node.rightDisplay !== 'string') return false
      for (const child of node.children) pending.push(child)
    }
    return true
  }

  /** 仅承载可向用户展示的受控错误，不传播解析器或网络原始异常。 */
  class CompareRequestError extends Error {}

  /** 格式化后端按侧返回的安全错误，不回显提交的原文。 */
  function responseError(payload, status) {
    const messages = []
    for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
      if (!Array.isArray(payload?.errors?.[side])) continue
      for (const error of payload.errors[side].slice(0, 20)) {
        if (typeof error?.message === 'string') messages.push(`${label}${Number.isSafeInteger(error.line) ? ` 第 ${error.line} 行` : ''}：${error.message}`)
      }
    }
    return messages.join('\n') || `对比请求失败（${status}），请检查输入或稍后重试。`
  }

  /** 创建可替换的同源对比适配，所有业务数据均由本次节点输入提供。 */
  function createServices(options = {}) {
    const request = options.request || root.fetch?.bind(root)
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    return {
      ...Capabilities.createServices(options),
      /** 提交一组完整文本，处理超时、取消及后端协议错误。 */
      async compare({ format, left, right, signal }) {
        if (!Object.hasOwn(ENDPOINTS, format)) throw new CompareRequestError('不支持的对比格式。')
        if (typeof left !== 'string' || typeof right !== 'string' || left.length > Core.LIMITS.textLength || right.length > Core.LIMITS.textLength) throw new CompareRequestError('每侧文本最多 500000 字符。')
        if (typeof request !== 'function') throw new CompareRequestError('当前环境无法访问对比服务。')
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) controller.abort()
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        try {
          if (controller.signal.aborted) throw new CompareRequestError('运行已停止。')
          const response = await Core.withAbort(request(ENDPOINTS[format], {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin', cache: 'no-store',
            body: JSON.stringify({ left, right }), signal: controller.signal,
          }), controller.signal)
          const payload = await Core.withAbort(response.json(), controller.signal)
          if (!response.ok || payload?.code !== 200) throw new CompareRequestError(responseError(payload, response.status))
          const result = { ...payload.data, format }
          if (!isDiffResult(result)) throw new CompareRequestError('对比服务返回了无效结果，请重试。')
          return result
        } catch (error) {
          if (timedOut) throw new CompareRequestError('对比请求超时，请重试。')
          if (signal?.aborted) throw new CompareRequestError('运行已停止。')
          if (error instanceof CompareRequestError) throw error
          throw new CompareRequestError('对比服务暂不可用，请检查网络后重试。')
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        }
      },
    }
  }

  /** 注册首批节点；新增能力只需注册定义、执行器和自己的渲染器。 */
  function createRegistry(renderers = {}) {
    const registry = new Core.NodeRegistry()
    registry.registerDataType('trigger', (value) => value === true)
    registry.registerDataType('diff', isDiffResult)
    registry.register({
      type: 'start', version: 1, label: '开始', category: '流程控制', execution: Core.NODE_EXECUTION.entry,
      inputs: [], outputs: [{ id: 'trigger', label: '开始', dataType: 'trigger', kind: Core.PORT_KIND.control }],
      defaults: {}, size: { width: 220, height: 180 }, render: renderers.start,
      execute: () => ({ trigger: true }),
    })
    registry.register({
      type: 'text', version: 1, label: '文本', category: '数据输入', execution: Core.NODE_EXECUTION.data,
      inputs: [], outputs: [{ id: 'text', label: '文本', dataType: 'text' }],
      defaults: { text: '' }, size: { width: 320, height: 280 }, render: renderers.capability, preview: false,
      fields: [{ key: 'text', label: '文本内容', type: 'textarea', fill: true, counter: true, placeholder: '输入或粘贴文本，运行时作为输出传给下游节点' }],
      validateConfig: (config) => typeof config.text !== 'string' || config.text.length > Core.LIMITS.textLength ? '文本节点内容必须是最多 500000 字符的文本。' : null,
      execute: ({ node }) => ({ text: node.config.text }),
    })
    for (const format of ['json', 'env']) {
      registry.register({
        type: `${format}-compare`, version: 1, label: `${format.toUpperCase()} 对比`, category: '内容处理',
        inputs: [{ id: 'trigger', label: '启动', dataType: 'trigger', kind: Core.PORT_KIND.control }, { id: 'a', label: 'A 内容', dataType: 'text', required: true }, { id: 'b', label: 'B 内容', dataType: 'text', required: true }],
        outputs: [{ id: 'diff', label: '对比结果', dataType: 'diff' }],
        defaults: {}, size: { width: 280, height: 220 }, render: renderers.compare,
        execute: async ({ inputs, services, signal }) => ({ diff: await services.compare({ format, left: inputs.a, right: inputs.b, signal }) }),
      })
    }
    registry.register({
      type: 'diff-result', version: 1, label: '对比结果', category: '结果展示',
      inputs: [{ id: 'diff', label: '对比结果', dataType: 'diff', required: true }],
      outputs: [{ id: 'diff', label: '差异数据', dataType: 'diff' }],
      defaults: {}, size: { width: 820, height: 580 }, render: renderers.result,
      execute: ({ inputs }) => ({ diff: inputs.diff }),
    })
    Capabilities.register(registry, renderers)
    return registry
  }

  const api = Object.freeze({ createRegistry, createServices, isDiffResult, REQUEST_TIMEOUT_MS })
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.NestCloudWorkflowNodes = api
})(typeof window === 'undefined' ? globalThis : window)
