(() => {
  if (typeof document === 'undefined') return

  const STORAGE_KEY = 'nestcloud:release-automation:v1'
  const TOKEN_STORAGE_KEY = 'nestcloud:release-tokens:v1'
  const POLL_INTERVAL_MS = 1000
  const MAX_POLL_MS = 15 * 60 * 1000
  const STAGE_LABELS = {
    planned: '计划已创建',
    preflight_blocked: '前置条件阻断',
    branch_plan_ready: '远程分支计划',
    candidate_prepared: '候选版本冻结',
    jenkins_queued: 'Jenkins 排队',
    jenkins_running: 'Jenkins 验证与打包',
    jenkins_trigger_unknown: 'Jenkins 触发待核对',
    jenkins_verified: 'Jenkins 已完成',
    docs_ready: '更新文档已准备',
    feishu_failed: '飞书输出失败',
    release_tag_created: 'tag 已创建',
    modify_log_clear_pending: '等待清空 modify-log.sql',
    cleanup_pending: '等待清理',
    manual_intervention: '需要人工处理',
    'partial-success': '部分完成',
    completed: '已完成',
    failed: '失败',
  }
  const EXECUTION_TASKS = [
    ['git-tag', '创建 Git tag（已存在则跳过）'],
    ['github-merge', 'GitHub Merge API 合并 dev/master → 目标分支'],
    ['jenkins', 'Jenkins API 校验并打包，获取 Pipeline tag'],
    ['release-docs', 'GitHub ENV/提交日志 + SQL/AI 整理更新 Markdown'],
    ['modify-log', 'GitHub database API 转换/清空 modify-log.sql 并提交 Release Version'],
    ['feishu', 'Feishu CLI 创建或更新更新文档'],
  ]

  function mount(root) {
    if (!(root instanceof HTMLElement)) return
    const form = root.querySelector('#release-automation-form')
    const branch = root.querySelector('#release-target-branch')
    const gitAddress = root.querySelector('#release-git-address')
    const gitTag = root.querySelector('#release-git-tag')
    const submit = root.querySelector('#release-automation-submit')
    const progress = root.querySelector('#release-automation-progress')
    const stageLabel = root.querySelector('#release-automation-stage-label')
    const status = root.querySelector('#release-automation-status')
    const bar = root.querySelector('#release-automation-progress-bar')
    const message = root.querySelector('#release-automation-message')
    const jobLabel = root.querySelector('#release-automation-job')
    const stages = root.querySelector('#release-automation-stages')
    const logOutput = root.querySelector('#release-automation-log')
    const error = root.querySelector('#release-automation-error')

    if (!(form instanceof HTMLFormElement) || !(branch instanceof HTMLInputElement)
      || !(gitAddress instanceof HTMLInputElement) || !(gitTag instanceof HTMLInputElement)
      || !(submit instanceof HTMLButtonElement)
      || !(progress instanceof HTMLElement) || !(stageLabel instanceof HTMLElement)
      || !(status instanceof HTMLElement) || !(bar instanceof HTMLElement)
      || !(message instanceof HTMLElement) || !(jobLabel instanceof HTMLElement)
      || !(stages instanceof HTMLOListElement) || !(logOutput instanceof HTMLPreElement)
      || !(error instanceof HTMLElement)) return

    let controller = null
    let generation = 0
    let startedAt = 0
    let jobId = ''
    let selectedTasks = new Set(EXECUTION_TASKS.map(([key]) => key))

    function readDraft() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        const value = raw ? JSON.parse(raw) : null
        if (!value || typeof value !== 'object') return null
        if (typeof value.targetBranch !== 'string' || typeof value.gitAddress !== 'string' || typeof value.gitTag !== 'string') return null
        return value
      } catch { return null }
    }

    function readTokens() {
      try {
        const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY)
        const value = raw ? JSON.parse(raw) : null
        if (!value || typeof value !== 'object') return {}
        return {
          githubToken: typeof value.githubToken === 'string' ? value.githubToken : '',
          jenkinsBaseUrl: typeof value.jenkinsBaseUrl === 'string' ? value.jenkinsBaseUrl : '',
          jenkinsToken: typeof value.jenkinsToken === 'string' ? value.jenkinsToken : '',
          jenkinsTagMarker: typeof value.jenkinsTagMarker === 'string' ? value.jenkinsTagMarker : '',
          feishuAppId: typeof value.feishuAppId === 'string' ? value.feishuAppId : '',
          feishuAppSecret: typeof value.feishuAppSecret === 'string' ? value.feishuAppSecret : '',
        }
      } catch { return {} }
    }

    function writeDraft(value) {
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* optional */ }
    }

    function restoreConfig(value) {
      if (!value) return
      selectedTasks = new Set(Array.isArray(value.selectedTasks)
        ? EXECUTION_TASKS.map(([key]) => key).filter((key) => value.selectedTasks.includes(key))
        : EXECUTION_TASKS.map(([key]) => key))
      gitAddress.value = value.gitAddress || ''
      gitTag.value = value.gitTag || ''
      branch.value = value.targetBranch || value.branch || ''
    }

    function persistConfig() {
      const previous = readDraft() || {}
      writeDraft({
        ...previous,
        gitAddress: gitAddress.value.trim(),
        gitTag: gitTag.value.trim(),
        targetBranch: branch.value.trim(),
        selectedTasks: [...selectedTasks],
      })
    }

    function createIdempotencyKey() {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID()
      return `release-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    }

    function setError(text) {
      error.textContent = text || ''
      error.hidden = !text
    }

    function setBusy(value) {
      submit.disabled = value
      branch.disabled = value
      gitAddress.disabled = value
      gitTag.disabled = value
      progress.hidden = false
      progress.setAttribute('aria-busy', String(value))
      stages.querySelectorAll('input').forEach((input) => { input.disabled = value })
    }

    function renderTaskList(activeStage = '', taskStatuses = {}) {
      stages.replaceChildren()
      EXECUTION_TASKS.forEach(([key, label]) => {
        const item = document.createElement('li')
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = selectedTasks.has(key)
        checkbox.disabled = progress.getAttribute('aria-busy') === 'true'
        checkbox.setAttribute('aria-label', label)
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedTasks.add(key)
          else selectedTasks.delete(key)
          persistConfig()
        })
        const active = key === activeStage || (key === 'preflight' && activeStage === 'planned')
        const taskStatus = typeof taskStatuses[key] === 'string'
          ? taskStatuses[key]
          : active ? 'running' : selectedTasks.has(key) ? 'pending' : 'skipped'
        item.dataset.status = taskStatus
        item.append(checkbox, document.createTextNode(` ${label} · ${taskStatus}`))
        stages.append(item)
      })
    }

    function renderProgress(payload) {
      const data = payload?.data || payload
      const current = data?.progress || data
      if (!current || typeof current !== 'object') return
      const stage = typeof current.stage === 'string' ? current.stage : 'planned'
      const percent = Math.max(0, Math.min(100, Number(current.percent) || 0))
      const stageText = STAGE_LABELS[stage] || stage
      stageLabel.textContent = stageText
      status.textContent = stageText
      status.className = `status-badge status-badge--${stage === 'completed' ? 'ready' : stage.includes('failed') || stage.includes('blocked') || stage === 'manual_intervention' ? 'error' : 'loading'}`
      bar.style.width = `${percent}%`
      bar.setAttribute('aria-valuenow', String(percent))
      message.textContent = typeof current.message === 'string' ? current.message : '服务端正在处理。'
      const logs = Array.isArray(data.logs) ? data.logs : Array.isArray(current.logs) ? current.logs : []
      if (logs.length > 0) {
        logOutput.textContent = logs.map((entry) => {
          if (typeof entry === 'string') return entry
          const time = typeof entry.timestamp === 'string' ? entry.timestamp : ''
          const level = typeof entry.level === 'string' ? entry.level.toUpperCase() : 'INFO'
          const text = typeof entry.message === 'string' ? entry.message : ''
          return `[${time}] [${level}] ${text}`
        }).join('\n')
        logOutput.scrollTop = logOutput.scrollHeight
      }      if (typeof data.jobId === 'string') {
        jobId = data.jobId
        jobLabel.textContent = `Job: ${jobId}`
        jobLabel.dataset.jobId = jobId
      }
      const stageEntries = current.stages && typeof current.stages === 'object' ? Object.entries(current.stages) : []
      if (stageEntries.length === 0) {
        renderTaskList(stage, current.taskStatuses || {})
        return
      }
      stages.replaceChildren()
      stageEntries.forEach(([key, value]) => {
        const item = document.createElement('li')
        const record = value && typeof value === 'object' ? value : {}
        item.dataset.status = typeof record.status === 'string' ? record.status : 'pending'
        item.textContent = `${STAGE_LABELS[key] || key} · ${record.status || 'pending'}${record.message ? ` · ${record.message}` : ''}`
        stages.append(item)
      })
    }

    async function requestStatus(id, requestGeneration) {
      while (requestGeneration === generation && Date.now() - startedAt < MAX_POLL_MS) {
        const response = await fetch(`/api/release-automation/jobs/status?jobId=${encodeURIComponent(id)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller?.signal,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok) throw new Error(payload?.message || `查询发布状态失败（${response.status}）。`)
        renderProgress(payload)
        const stage = payload?.data?.progress?.stage
        if (['completed', 'partial-success', 'failed', 'manual_intervention', 'preflight_blocked'].includes(stage)) return
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }
      if (requestGeneration === generation) throw new Error('发布状态轮询超时，请使用同一幂等键恢复。')
    }

    async function createJob(event) {
      event.preventDefault()
      if (!form.reportValidity()) return
      const requestGeneration = ++generation
      controller?.abort()
      controller = new AbortController()
      startedAt = Date.now()
      setBusy(true)
      setError('')
      const idempotencyKey = createIdempotencyKey()
      try {
        const tokens = readTokens()
        const response = await fetch('/api/release-automation/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          credentials: 'same-origin',
          body: JSON.stringify({
            gitAddress: gitAddress.value.trim(),
            branch: branch.value.trim(),
            targetBranch: branch.value.trim(),
            gitTag: gitTag.value.trim(),
            mode: 'apply',
            githubToken: tokens.githubToken,
            jenkinsToken: tokens.jenkinsToken,
            jenkinsBaseUrl: tokens.jenkinsBaseUrl,
            jenkinsTagMarker: tokens.jenkinsTagMarker,
            feishuAppId: tokens.feishuAppId,
            feishuAppSecret: tokens.feishuAppSecret,
            tasks: [...selectedTasks],
          }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload?.data?.jobId) throw new Error(payload?.message || `创建发布 Job 失败（${response.status}）。`)
        jobId = payload.data.jobId
        writeDraft({
          jobId,
          gitAddress: gitAddress.value.trim(),
          gitTag: gitTag.value.trim(),
          targetBranch: branch.value.trim(),
          selectedTasks: [...selectedTasks],
          idempotencyKey,
        })
        renderProgress(payload)
        await requestStatus(jobId, requestGeneration)
      } catch (requestError) {
        if (requestGeneration !== generation || requestError?.name === 'AbortError') return
        setError(requestError instanceof Error ? requestError.message : '发布计划创建失败。')
        status.textContent = '错误'
        status.className = 'status-badge status-badge--error'
      } finally {
        if (requestGeneration === generation) {
          controller = null
          setBusy(false)
        }
      }
    }

    async function resumeDraft() {
      const draft = readDraft()
      if (!draft) return
      restoreConfig(draft)
      if (typeof draft.jobId !== 'string' || !draft.jobId) return
      try {
        const requestGeneration = ++generation
        controller = new AbortController()
        startedAt = Date.now()
        setBusy(true)
        await requestStatus(draft.jobId, requestGeneration)
      } catch (resumeError) {
        if (resumeError?.name !== 'AbortError') setError(resumeError instanceof Error ? resumeError.message : '无法恢复发布 Job。')
      } finally {
        controller = null
        setBusy(false)
      }
    }

    renderTaskList()
    form.addEventListener('submit', createJob)
    ;[gitAddress, gitTag, branch]
      .forEach((field) => field.addEventListener('input', persistConfig))
    void resumeDraft()

    return {
      destroy() {
        generation += 1
        controller?.abort()
        controller = null
      },
    }
  }

  window.NestCloudReleaseAutomation = Object.freeze({ mount })
})()
