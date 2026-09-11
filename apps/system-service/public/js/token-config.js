(() => {
  if (typeof document === 'undefined') return

  const STORAGE_KEY = 'nestcloud:release-tokens:v1'

  function mount(root) {
    if (!(root instanceof HTMLElement)) return
    const form = root.querySelector('#token-config-form')
    const github = root.querySelector('#token-github')
    const jenkinsUrl = root.querySelector('#token-jenkins-url')
    const jenkins = root.querySelector('#token-jenkins')
    const feishuAppId = root.querySelector('#token-feishu-app-id')
    const feishuAppSecret = root.querySelector('#token-feishu-app-secret')
    const aiBaseUrl = root.querySelector('#token-ai-base-url')
    const aiApiKey = root.querySelector('#token-ai-api-key')
    const aiModel = root.querySelector('#token-ai-model')
    const clear = root.querySelector('#token-config-clear')
    const status = root.querySelector('#token-config-status')
    if (!(form instanceof HTMLFormElement) || !(github instanceof HTMLInputElement)
      || !(jenkinsUrl instanceof HTMLInputElement) || !(jenkins instanceof HTMLInputElement)
      || !(feishuAppId instanceof HTMLInputElement) || !(feishuAppSecret instanceof HTMLInputElement)
      || !(aiBaseUrl instanceof HTMLInputElement) || !(aiApiKey instanceof HTMLInputElement)
      || !(aiModel instanceof HTMLInputElement) || !(clear instanceof HTMLButtonElement)
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
      jenkinsUrl.value = typeof value.jenkinsBaseUrl === 'string' ? value.jenkinsBaseUrl : ''
      jenkins.value = typeof value.jenkinsToken === 'string' ? value.jenkinsToken : ''
      feishuAppId.value = typeof value.feishuAppId === 'string' ? value.feishuAppId : ''
      feishuAppSecret.value = typeof value.feishuAppSecret === 'string' ? value.feishuAppSecret : ''
      aiBaseUrl.value = typeof ai.baseUrl === 'string' ? ai.baseUrl : ''
      aiApiKey.value = typeof ai.apiKey === 'string' ? ai.apiKey : ''
      aiModel.value = typeof ai.model === 'string' ? ai.model : ''
      status.textContent = window.localStorage.getItem(STORAGE_KEY) ? '已从当前浏览器恢复' : '尚未保存'
    }

    function save(event) {
      event.preventDefault()
      const ai = {
        baseUrl: aiBaseUrl.value.trim(),
        apiKey: aiApiKey.value.trim(),
        model: aiModel.value.trim(),
      }
      const aiValues = Object.values(ai)
      const value = {
        githubToken: github.value,
        jenkinsBaseUrl: jenkinsUrl.value.trim(),
        jenkinsToken: jenkins.value,
        feishuAppId: feishuAppId.value.trim(),
        feishuAppSecret: feishuAppSecret.value,
      }
      if (aiValues.some(Boolean)) value.ai = ai
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      window.dispatchEvent(new CustomEvent('nestcloud:tokens-updated'))
      status.textContent = aiValues.every(Boolean)
        ? '已保存到当前浏览器，AI 摘要已启用'
        : aiValues.some(Boolean)
          ? '已保存，但 AI 配置不完整，周报不会发起 AI 请求'
          : '已保存到当前浏览器，周报使用本地规则摘要'
    }

    function clearCredentials() {
      window.localStorage.removeItem(STORAGE_KEY)
      github.value = ''
      jenkinsUrl.value = ''
      jenkins.value = ''
      feishuAppId.value = ''
      feishuAppSecret.value = ''
      aiBaseUrl.value = ''
      aiApiKey.value = ''
      aiModel.value = ''
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
