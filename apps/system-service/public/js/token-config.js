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
    const clear = root.querySelector('#token-config-clear')
    const status = root.querySelector('#token-config-status')
    if (!(form instanceof HTMLFormElement) || !(github instanceof HTMLInputElement)
      || !(jenkinsUrl instanceof HTMLInputElement) || !(jenkins instanceof HTMLInputElement)
      || !(feishuAppId instanceof HTMLInputElement) || !(feishuAppSecret instanceof HTMLInputElement)
      || !(clear instanceof HTMLButtonElement) || !(status instanceof HTMLElement)) return

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
      github.value = typeof value.githubToken === 'string' ? value.githubToken : ''
      jenkinsUrl.value = typeof value.jenkinsBaseUrl === 'string' ? value.jenkinsBaseUrl : ''
      jenkins.value = typeof value.jenkinsToken === 'string' ? value.jenkinsToken : ''
      feishuAppId.value = typeof value.feishuAppId === 'string' ? value.feishuAppId : ''
      feishuAppSecret.value = typeof value.feishuAppSecret === 'string' ? value.feishuAppSecret : ''
      status.textContent = window.localStorage.getItem(STORAGE_KEY) ? '已从当前浏览器恢复' : '尚未保存'
    }

    function save(event) {
      event.preventDefault()
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        githubToken: github.value,
        jenkinsBaseUrl: jenkinsUrl.value.trim(),
        jenkinsToken: jenkins.value,
        feishuAppId: feishuAppId.value.trim(),
        feishuAppSecret: feishuAppSecret.value,
      }))
      window.dispatchEvent(new CustomEvent('nestcloud:tokens-updated'))
      status.textContent = '已保存到当前浏览器'
    }

    function clearCredentials() {
      window.localStorage.removeItem(STORAGE_KEY)
      github.value = ''
      jenkinsUrl.value = ''
      jenkins.value = ''
      feishuAppId.value = ''
      feishuAppSecret.value = ''
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
