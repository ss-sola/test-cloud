((root) => {
  const Core = typeof module !== 'undefined' && module.exports ? require('./workflow-core.js') : root.NestCloudWorkflowCore
  const DIRECTORY = 'public/workflow'
  const API = '/api/workflow-directory'
  const LIMITS = Object.freeze({ entries: 1000, filename: 120, filenameBytes: 255, timeoutMs: 30_000 })
  const INVALID_FILENAME = /[\\/:*?"<>|\p{Cc}\p{Cf}\p{Cs}]/u
  const RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
  const REVISION = /^[a-f0-9]{64}$/

  /** 将流程名称转换为可跨平台保存的单段 JSON 文件名。 */
  function filenameOf(name) {
    let stem = [...name].map((character) => INVALID_FILENAME.test(character) ? '_' : character).join('').replace(/\.tmp\./gi, '_').trim().replace(/^[. ]+/, '').replace(/[. ]+$/, '') || 'workflow'
    if (RESERVED_FILENAME.test(stem)) stem = `_${stem}`
    let bounded = ''
    for (const character of stem) {
      const next = bounded + character
      if (next.length + 5 > LIMITS.filename || new TextEncoder().encode(`${next}.json`).length > LIMITS.filenameBytes) break
      bounded = next
    }
    return `${bounded.trim().replace(/[. ]+$/, '') || 'workflow'}.json`
  }

  /** 拒绝路径、设备名和非法字符，只允许固定目录中的 JSON 文件。 */
  function validateFilename(name) {
    if (typeof name !== 'string' || !name || name.startsWith('.') || name.length > LIMITS.filename || new TextEncoder().encode(name).length > LIMITS.filenameBytes
      || INVALID_FILENAME.test(name) || name.toLowerCase().includes('.tmp.') || !/^.+\.json$/i.test(name)) {
      throw new Error(`请输入有效的 JSON 文件名（不含路径，最多 ${LIMITS.filename} 字符）。`)
    }
    const stem = name.slice(0, -5)
    if (!stem.replaceAll('.', '').trim() || stem !== stem.trim() || RESERVED_FILENAME.test(stem)) {
      throw new Error(`请输入有效的 JSON 文件名（不含路径，最多 ${LIMITS.filename} 字符）。`)
    }
  }

  /** 保留文件版本冲突元信息，网络或内部错误不回显请求正文。 */
  class DirectoryRequestError extends Error {
    constructor(message, { status = 0, revision } = {}) {
      super(message)
      this.status = status
      this.revision = revision
    }
  }

  /** 通过固定同源接口访问项目 public/workflow，不接收本机路径或目录句柄。 */
  class ProjectDirectoryService {
    constructor({ maxBytes, request = root.fetch?.bind(root), timeoutMs = LIMITS.timeoutMs }) {
      this.maxBytes = maxBytes
      this.request = request
      this.timeoutMs = timeoutMs
      this.entries = []
      this.pending = new Set()
      this.destroyed = false
    }

    /** 请求固定接口并处理超时、取消、业务错误和版本冲突。 */
    async requestData(path, body) {
      if (this.destroyed) throw new DirectoryRequestError('目录请求已取消。')
      if (typeof this.request !== 'function') throw new DirectoryRequestError('当前环境无法访问项目目录。')
      const controller = new AbortController()
      this.pending.add(controller)
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
      try {
        const response = await Core.withAbort(this.request(`${API}${path}`, {
          method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        }), controller.signal)
        const payload = await Core.withAbort(response.json(), controller.signal)
        if (!response.ok || payload?.code !== 200) {
          const status = response.status
          const message = status >= 500 ? '项目目录服务暂不可用，请稍后重试。' : typeof payload?.message === 'string' ? payload.message : `目录请求失败（${status}）。`
          const revision = status === 409 && typeof payload?.revision === 'string' && REVISION.test(payload.revision) ? payload.revision : undefined
          throw new DirectoryRequestError(message, { status, revision })
        }
        return payload.data
      } catch (error) {
        if (timedOut) throw new DirectoryRequestError(body ? '保存请求超时，结果可能已写入，请刷新目录确认。' : '项目目录请求超时，请重试。')
        if (this.destroyed || controller.signal.aborted) throw new DirectoryRequestError('目录请求已取消。')
        if (error instanceof DirectoryRequestError) throw error
        throw new DirectoryRequestError(body ? '保存结果尚未确认，请刷新目录检查文件状态。' : '无法连接项目目录，请检查服务后重试。')
      } finally {
        clearTimeout(timer)
        this.pending.delete(controller)
      }
    }

    /** 手动读取固定目录列表，失败时保留原列表。 */
    async refresh() {
      const data = await this.requestData('/list')
      if (data?.directory !== DIRECTORY || !Array.isArray(data.list) || data.list.length > LIMITS.entries
        || data.list.some((entry) => !entry || typeof entry.name !== 'string' || entry.name.length > 255)) {
        throw new DirectoryRequestError('项目目录返回了无效文件列表。')
      }
      this.entries = data.list.map((entry) => ({ name: entry.name }))
    }

    /** 读取一个受预算限制的流程文本，结构校验仍由工作区原子导入。 */
    async read(name, { metadata = false } = {}) {
      validateFilename(name)
      const data = await this.requestData(`/document?filename=${encodeURIComponent(name)}`)
      if (data?.filename !== name || typeof data.text !== 'string' || typeof data.revision !== 'string' || !REVISION.test(data.revision)) throw new DirectoryRequestError('项目目录返回了无效工作流。')
      if (new TextEncoder().encode(data.text).length > this.maxBytes) throw new DirectoryRequestError('工作流文件超过 4 MiB 限制，未导入。')
      return metadata ? data : data.text
    }

    /** 指定版本时直接保存；首次未关联文件撞名时确认后仅重试一次。 */
    async save({ name, text, confirmOverwrite, expectedRevision, metadata = false }) {
      validateFilename(name)
      if (typeof text !== 'string' || new TextEncoder().encode(text).length > this.maxBytes) throw new DirectoryRequestError('工作流文件超过 4 MiB 限制，未保存。')
      if (expectedRevision !== undefined && expectedRevision !== null && (typeof expectedRevision !== 'string' || !REVISION.test(expectedRevision))) throw new DirectoryRequestError('文件版本不合法，请重新打开项目文件。')
      const snapshot = { filename: name, text, expectedRevision: expectedRevision ?? null }
      let data
      try { data = await this.requestData('/document', snapshot) } catch (error) {
        if (expectedRevision !== undefined || error.status !== 409 || !error.revision || typeof confirmOverwrite !== 'function') throw error
        if (!await confirmOverwrite(name)) return false
        if (this.destroyed) throw new DirectoryRequestError('目录请求已取消。')
        data = await this.requestData('/document', { ...snapshot, expectedRevision: error.revision })
      }
      if (data?.filename !== name || typeof data.revision !== 'string' || !REVISION.test(data.revision)) throw new DirectoryRequestError('保存响应无效，请刷新目录确认文件状态。')
      return metadata ? data : true
    }

    /** 取消当前目录请求，阻止销毁后的读取或覆盖重试。 */
    destroy() {
      this.destroyed = true
      for (const controller of this.pending) controller.abort()
      this.pending.clear()
    }
  }

  /** 将工作流工具挂到系统侧栏，保留搜索、折叠及隐藏面板的 DOM。 */
  function mount({ root, refs, host, client, importDocument, maxBytes }) {
    const service = client ?? new ProjectDirectoryService({ maxBytes })
    const listeners = []
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler)
      listeners.push(() => target.removeEventListener(type, handler))
    }
    let restoreSidebar = null
    if (host) {
      const parent = refs.sidebar.parentNode
      const nextSibling = refs.sidebar.nextSibling
      host.append(refs.sidebar)
      const syncVisibility = () => { host.hidden = root.hidden }
      const observer = new MutationObserver(syncVisibility)
      observer.observe(root, { attributes: true, attributeFilter: ['hidden'] })
      syncVisibility()
      restoreSidebar = () => {
        observer.disconnect()
        host.hidden = true
        parent.insertBefore(refs.sidebar, nextSibling)
      }
    }
    let activePanel = null
    let busy = false
    let destroyed = false
    let searching = false
    let folderWasOpen = refs['directory-folder'].open
    let ignoreFolderToggle = false
    const panelNames = ['directory', 'palette']

    /** 切换侧栏内容，重新展开项目文件夹时读取最新文件列表。 */
    function showPanel(name, restoreFocus = false) {
      const previous = activePanel
      activePanel = name
      refs.sidebar.classList.toggle('wf-sidebar--expanded', Boolean(name))
      for (const key of panelNames) {
        refs[`${key}-panel`].hidden = key !== name
        refs[`nav-${key}`].setAttribute('aria-expanded', String(key === name))
      }
      if (restoreFocus && previous) refs[`nav-${previous}`].focus({ preventScroll: true })
      if (name === 'directory' && refs['directory-folder'].open) perform(() => service.refresh())
    }

    /** 只按文件名进行本地多词过滤，不读取正文或触发网络。 */
    function renderDirectory() {
      refs['directory-panel'].setAttribute('aria-busy', String(busy))
      const terms = refs['directory-search'].value.normalize('NFKC').toLowerCase().trim().split(/\s+/u).filter(Boolean)
      const fragment = document.createDocumentFragment()
      for (const entry of service.entries) {
        const name = entry.name.normalize('NFKC').toLowerCase()
        if (!terms.every((term) => name.includes(term))) continue
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'wf-directory__entry'
        button.dataset.directoryName = entry.name
        button.disabled = busy
        const label = document.createElement('span')
        label.textContent = entry.name
        button.append(label)
        button.addEventListener('click', () => perform(async () => {
          const file = await service.read(entry.name, { metadata: true })
          if (!destroyed) importDocument(file.text, file)
        }))
        fragment.append(button)
      }
      refs['directory-list'].replaceChildren(fragment)
    }

    /** 搜索临时展开文件夹；清空时恢复之前的折叠状态。 */
    function searchDirectory() {
      const nextSearching = Boolean(refs['directory-search'].value.trim())
      if (nextSearching && !searching) folderWasOpen = refs['directory-folder'].open
      const open = nextSearching || folderWasOpen
      if ((nextSearching || searching) && refs['directory-folder'].open !== open) {
        ignoreFolderToggle = true
        refs['directory-folder'].open = open
      }
      searching = nextSearching
      renderDirectory()
    }

    /** 目录操作失败使用页面既有错误出口，文件夹内不增加提示区。 */
    async function perform(action) {
      if (busy || destroyed) return
      busy = true
      refs.error.hidden = true
      renderDirectory()
      try { await action() } catch (error) {
        if (!destroyed) {
          refs.error.textContent = error.message || '目录操作失败，请重试。'
          refs.error.hidden = false
        }
      } finally {
        busy = false
        if (!destroyed) renderDirectory()
      }
    }

    for (const key of panelNames) {
      listen(refs[`nav-${key}`], 'click', () => showPanel(activePanel === key ? null : key))
    }
    listen(refs['directory-search'], 'input', searchDirectory)
    listen(refs['directory-folder'], 'toggle', () => {
      if (ignoreFolderToggle) { ignoreFolderToggle = false; return }
      if (activePanel === 'directory' && refs['directory-folder'].open && !searching) perform(() => service.refresh())
    })
    listen(refs.sidebar, 'keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !activePanel) return
      if (!refs[`${activePanel}-panel`].contains(event.target) && !refs[`nav-${activePanel}`].contains(event.target)) return
      event.preventDefault()
      const search = refs[`${activePanel}-search`]
      if (search.value) {
        search.value = ''
        search.dispatchEvent(new Event('input', { bubbles: true }))
      } else showPanel(null, true)
    })
    showPanel(null)
    renderDirectory()

    return {
      /** 保存文件后仅刷新当前可见的目录，保留查询和折叠状态。 */
      async refreshDirectory() {
        if (root?.hidden || activePanel !== 'directory' || !refs['directory-folder'].open) return
        await perform(() => service.refresh())
      },
      /** 解除监听、取消请求，并将侧栏内容移回原视图以便重新挂载。 */
      destroy() {
        destroyed = true
        listeners.forEach((remove) => remove())
        service.destroy()
        restoreSidebar?.()
      },
    }
  }

  const api = Object.freeze({ DIRECTORY, LIMITS, REVISION_PATTERN: REVISION, ProjectDirectoryService, filenameOf, validateFilename, mount })
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.NestCloudWorkflowDirectory = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
