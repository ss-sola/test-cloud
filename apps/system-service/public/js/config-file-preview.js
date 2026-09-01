(() => {
  if (typeof document === 'undefined') return

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
    || !(tag instanceof HTMLSelectElement)
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
  const dirtyFields = new Set()

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
    }
  }

  async function loadTags(repository) {
    const response = await fetch('/api/config-file-preview/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ repositoryUrl: repository }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.data) throw new Error(payload?.message || `Tag 请求失败（${response.status}）。`)
    tag.replaceChildren()
    const tags = Array.isArray(payload.data)
      ? payload.data.filter((item) => item && typeof item.name === 'string' && item.name)
      : []
    tags.forEach((item) => {
      const option = document.createElement('option')
      option.value = item.name
      option.textContent = item.name
      tag.append(option)
    })
    tag.disabled = tags.length === 0
    if (tags.length > 0) tag.selectedIndex = 0
  }

  async function doFetch(event) {
    event?.preventDefault()
    if (!form.reportValidity()) return

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

  async function loadDefaults() {
    const generation = requestGeneration
    try {
      const response = await fetch('/api/config-file-preview/defaults', { credentials: 'same-origin' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.data) throw new Error(payload?.message || `请求失败（${response.status}）。`)
      if (generation !== requestGeneration) return
      const data = payload.data
      if (!dirtyFields.has('repositoryUrl') && !repositoryUrl.value.trim() && typeof data.repositoryUrl === 'string') repositoryUrl.value = data.repositoryUrl
      if (!dirtyFields.has('branch') && !branch.value.trim() && typeof data.branch === 'string') branch.value = data.branch
      if (!dirtyFields.has('filePath') && !filePath.value.trim() && typeof data.filePath === 'string') filePath.value = data.filePath
      await loadTags(repositoryUrl.value.trim())
      meta.textContent = '默认值和 tag 已加载；修改配置后读取指定文件。'
    } catch (error) {
      if (generation !== requestGeneration) return
      setError(error instanceof Error ? error.message : '默认配置加载失败，请手动填写后重试。')
      setStatus('error', '配置不可用')
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
  repositoryUrl.addEventListener('input', () => dirtyFields.add('repositoryUrl'))
  branch.addEventListener('input', () => dirtyFields.add('branch'))
  filePath.addEventListener('input', () => dirtyFields.add('filePath'))
  tag.addEventListener('change', () => {
    if (!tag.disabled) void doFetch()
  })
  copyButton.addEventListener('click', copyContent)
  void loadDefaults()

    return {
      destroy() {
        requestController?.abort()
        requestGeneration += 1
      },
    }
  }

  window.NestCloudConfigFilePreview = Object.freeze({ mount })
})()
