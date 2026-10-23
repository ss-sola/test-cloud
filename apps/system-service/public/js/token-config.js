(() => {
  if (typeof document === 'undefined') return

  const STORAGE_KEY = 'nestcloud:release-tokens:v1'

  function mount(root) {
    if (!(root instanceof HTMLElement)) return
    const form = root.querySelector('#token-config-form')
    const github = root.querySelector('#token-github')
    const feishuAppId = root.querySelector('#token-feishu-app-id')
    const feishuAppSecret = root.querySelector('#token-feishu-app-secret')
    const aiBaseUrl = root.querySelector('#token-ai-base-url')
    const aiApiKey = root.querySelector('#token-ai-api-key')
    const aiModel = root.querySelector('#token-ai-model')
    const aiThinking = root.querySelector('#token-ai-enable-thinking')
    const clear = root.querySelector('#token-config-clear')
    const status = root.querySelector('#token-config-status')
    if (!(form instanceof HTMLFormElement) || !(github instanceof HTMLInputElement)
      || !(feishuAppId instanceof HTMLInputElement) || !(feishuAppSecret instanceof HTMLInputElement)
      || !(aiBaseUrl instanceof HTMLInputElement) || !(aiApiKey instanceof HTMLInputElement)
      || !(aiModel instanceof HTMLInputElement) || !(aiThinking instanceof HTMLInputElement)
      || aiThinking.type !== 'checkbox' || !(clear instanceof HTMLButtonElement)
      || !(status instanceof HTMLElement)) return

    function read() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        const value = raw ? JSON.parse(raw) : null
        if (!value || typeof value !== 'object') return {}
        return value
      } catch { return {} }
    }

    function restore() {
      const value = read()
      const ai = value.ai && typeof value.ai === 'object' ? value.ai : {}
      github.value = typeof value.githubToken === 'string' ? value.githubToken : ''
      feishuAppId.value = typeof value.feishuAppId === 'string' ? value.feishuAppId : ''
      feishuAppSecret.value = typeof value.feishuAppSecret === 'string' ? value.feishuAppSecret : ''
      aiBaseUrl.value = typeof ai.baseUrl === 'string' ? ai.baseUrl : ''
      aiApiKey.value = typeof ai.apiKey === 'string' ? ai.apiKey : ''
      aiModel.value = typeof ai.model === 'string' ? ai.model : ''
      aiThinking.checked = ai.enableThinking === true // 旧配置或非法存量值保持关闭
      status.textContent = window.localStorage.getItem(STORAGE_KEY) ? '已从当前浏览器恢复' : '尚未保存'
    }

    function save(event) {
      event.preventDefault()
      const ai = {
        baseUrl: aiBaseUrl.value.trim(),
        apiKey: aiApiKey.value.trim(),
        model: aiModel.value.trim(),
        enableThinking: aiThinking.checked === true,
      }
      const aiValues = [ai.baseUrl, ai.apiKey, ai.model] // 完整性只看三个必填字符串，不含思考开关
      const value = {
        githubToken: github.value,
        feishuAppId: feishuAppId.value.trim(),
        feishuAppSecret: feishuAppSecret.value,
      }
      if (aiValues.some(Boolean) || ai.enableThinking) value.ai = ai
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      window.dispatchEvent(new CustomEvent('nestcloud:tokens-updated'))
      status.textContent = aiValues.every(Boolean)
        ? '已保存到当前浏览器，AI 摘要已启用'
        : aiValues.some(Boolean)
          ? '已保存草稿，但 AI 配置不完整，无法生成周报'
          : '已保存到当前浏览器，尚未配置 AI，无法生成周报'
    }

    function clearCredentials() {
      window.localStorage.removeItem(STORAGE_KEY)
      github.value = ''
      feishuAppId.value = ''
      feishuAppSecret.value = ''
      aiBaseUrl.value = ''
      aiApiKey.value = ''
      aiModel.value = ''
      aiThinking.checked = false
      window.dispatchEvent(new CustomEvent('nestcloud:tokens-updated'))
      status.textContent = '凭据已清空'
    }

    form.addEventListener('submit', save)
    clear.addEventListener('click', clearCredentials)
    restore()
    return { destroy() {} }
  }

  window.NestCloudTokenConfig = Object.freeze({ mount })
})()
