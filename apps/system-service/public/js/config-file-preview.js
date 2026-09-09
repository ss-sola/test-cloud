(() => {
  if (typeof document === 'undefined') return

  const TOKEN_STORAGE_KEY = 'nestcloud:release-tokens:v1'

  function readGithubToken() {
    try {
      const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY)
      const value = raw ? JSON.parse(raw) : null
      return value && typeof value.githubToken === 'string' ? value.githubToken.trim() : ''
    } catch { return '' }
  }

  function mount(root) {
    if (!(root instanceof HTMLElement)) return

    const form = root.querySelector('#config-file-preview-form')
  const repositoryUrl = root.querySelector('#config-preview-repository-url')
  const branch = root.querySelector('#config-preview-branch')
  const filePath = root.querySelector('#config-preview-file-path')
  const tag = root.querySelector('#config-preview-tag')
  const submitButton = root.querySelector('#config-preview-submit')
  const errorElement = root.querySelector('#config-preview-error')
  const result = root.querySelector('.config-file-preview-result')
  const statusBadge = root.querySelector('#config-preview-status')
  const statusLabel = root.querySelector('#config-preview-status-label')
  const meta = root.querySelector('#config-preview-meta')
  const output = root.querySelector('#config-preview-output')
  const resultActions = root.querySelector('#config-preview-result-actions')
  const copyButton = root.querySelector('#config-preview-copy')

  if (!(form instanceof HTMLFormElement)
    || !(repositoryUrl instanceof HTMLInputElement)
    || !(branch instanceof HTMLInputElement)
    || !(filePath instanceof HTMLInputElement)
    || !(tag instanceof HTMLInputElement)
    || !(submitButton instanceof HTMLButtonElement)
    || !(errorElement instanceof HTMLElement)
    || !(result instanceof HTMLElement)
    || !(statusBadge instanceof HTMLElement)
    || !(statusLabel instanceof HTMLElement)
    || !(meta instanceof HTMLElement)
    || !(output instanceof HTMLElement)
    || !(resultActions instanceof HTMLElement)
    || !(copyButton instanceof HTMLButtonElement)) return

  let requestController = null
  let requestGeneration = 0
  let latestContent = ''

  function setError(message) {
    errorElement.textContent = message
    errorElement.hidden = !message
  }

  function setStatus(status, label) {
    statusBadge.className = `status-badge status-badge--${status}`
    statusBadge.dataset.status = status
    statusLabel.textContent = label
  }

  function collectInput() {
    return {
      repositoryUrl: repositoryUrl.value.trim(),
      branch: branch.value.trim(),
      filePath: filePath.value.trim(),
      ...(tag.value.trim() ? { tag: tag.value.trim() } : {}),
      githubToken: readGithubToken(),
    }
  }

  async function doFetch(event) {
    event?.preventDefault()
    if (!form.reportValidity()) return
    if (!readGithubToken()) {
      setError('请先在 Token 配置页面填写 GitHub Token。')
      setStatus('error', '缺少凭据')
      return
    }

    const generation = ++requestGeneration
    requestController?.abort()
    requestController = new AbortController()
    submitButton.disabled = true
    result.setAttribute('aria-busy', 'true')
    setError('')
    setStatus('loading', '读取中')
    latestContent = ''
    output.textContent = ''
    output.hidden = true
    resultActions.hidden = true
    meta.textContent = '正在读取 GitHub 文件内容，请稍候。'

    try {
      const response = await fetch('/api/config-file-preview/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(collectInput()),
        signal: requestController.signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.data) throw new Error(payload?.message || `请求失败（${response.status}）。`)
      if (generation !== requestGeneration) return

      const data = payload.data
      latestContent = typeof data.content === 'string' ? data.content : ''
      output.textContent = latestContent
      output.hidden = false
      resultActions.hidden = !latestContent
      meta.textContent = `${data.selectedTag || tag.value.trim() || '—'} · ${data.branch || branch.value.trim()} · ${data.filePath || filePath.value.trim()} · ${Number(data.byteLength || 0).toLocaleString()} 字节`
      setStatus('ready', '已读取')
    } catch (error) {
      if (generation !== requestGeneration) return
      output.textContent = ''
      output.hidden = true
      resultActions.hidden = true
      meta.textContent = '未读取文件内容。'
      if (error?.name !== 'AbortError') setError(error instanceof Error ? error.message : '版本读取失败，请稍后重试。')
      setStatus('error', '错误')
    } finally {
      if (generation === requestGeneration) {
        requestController = null
        submitButton.disabled = false
        result.setAttribute('aria-busy', 'false')
      }
    }
  }

  async function copyContent() {
    if (!latestContent) return
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(latestContent)
      else {
        const helper = document.createElement('textarea')
        helper.value = latestContent
        helper.setAttribute('readonly', '')
        helper.style.position = 'fixed'
        helper.style.opacity = '0'
        document.body.append(helper)
        helper.select()
        document.execCommand('copy')
        helper.remove()
      }
      meta.textContent = `${meta.textContent} · 内容已复制`
    } catch {
      setError('无法访问剪贴板，请直接选择并复制文件内容。')
    }
  }

  form.addEventListener('submit', doFetch)
  copyButton.addEventListener('click', copyContent)

    return {
      destroy() {
        requestController?.abort()
        requestGeneration += 1
      },
    }
  }

  window.NestCloudConfigFilePreview = Object.freeze({ mount })
})()
