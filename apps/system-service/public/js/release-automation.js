(() => {
  if (typeof document === 'undefined') return

  const VERSION = '1.9.0'
  const STORAGE_KEY = 'nestcloud:release-automation:v1'
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

  function mount(root) {
    if (!(root instanceof HTMLElement)) return
    const form = root.querySelector('#release-automation-form')
    const branch = root.querySelector('#release-target-branch')
    const sha = root.querySelector('#release-candidate-sha')
    const submit = root.querySelector('#release-automation-submit')
    const progress = root.querySelector('#release-automation-progress')
    const stageLabel = root.querySelector('#release-automation-stage-label')
    const status = root.querySelector('#release-automation-status')
    const bar = root.querySelector('#release-automation-progress-bar')
    const message = root.querySelector('#release-automation-message')
    const jobLabel = root.querySelector('#release-automation-job')
    const stages = root.querySelector('#release-automation-stages')
    const error = root.querySelector('#release-automation-error')

    if (!(form instanceof HTMLFormElement) || !(branch instanceof HTMLInputElement)
      || !(sha instanceof HTMLInputElement) || !(submit instanceof HTMLButtonElement)
      || !(progress instanceof HTMLElement) || !(stageLabel instanceof HTMLElement)
      || !(status instanceof HTMLElement) || !(bar instanceof HTMLElement)
      || !(message instanceof HTMLElement) || !(jobLabel instanceof HTMLElement)
      || !(stages instanceof HTMLOListElement) || !(error instanceof HTMLElement)) return

    let controller = null
    let generation = 0
    let startedAt = 0
    let jobId = ''

    function readDraft() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        const value = raw ? JSON.parse(raw) : null
        if (!value || typeof value !== 'object') return null
        if (typeof value.jobId !== 'string' || typeof value.targetBranch !== 'string' || typeof value.candidateSha !== 'string') return null
        return value
      } catch { return null }
    }

    function writeDraft(value) {
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* optional */ }
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
      sha.disabled = value
      progress.hidden = false
      progress.setAttribute('aria-busy', String(value))
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
      if (typeof data.jobId === 'string') {
        jobId = data.jobId
        jobLabel.textContent = `Job: ${jobId}`
        jobLabel.dataset.jobId = jobId
      }
      stages.replaceChildren()
      const stageEntries = current.stages && typeof current.stages === 'object' ? Object.entries(current.stages) : []
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
        if (['completed', 'partial-success', 'failed', 'manual-intervention', 'preflight_blocked'].includes(stage)) return
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
        const response = await fetch('/api/release-automation/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          credentials: 'same-origin',
          body: JSON.stringify({
            version: VERSION,
            mode: 'dry-run',
            targetBranch: branch.value.trim(),
            candidateSha: sha.value.trim(),
          }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload?.data?.jobId) throw new Error(payload?.message || `创建发布 Job 失败（${response.status}）。`)
        jobId = payload.data.jobId
        writeDraft({ jobId, targetBranch: branch.value.trim(), candidateSha: sha.value.trim(), idempotencyKey })
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
      branch.value = draft.targetBranch
      sha.value = draft.candidateSha
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

    form.addEventListener('submit', createJob)
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
