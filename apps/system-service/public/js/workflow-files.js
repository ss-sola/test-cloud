((root) => {
  const node = typeof module !== 'undefined' && module.exports
  const Core = node ? require('./workflow-core.js') : root.NestCloudWorkflowCore
  const Directory = node ? require('./workflow-directory.js') : root.NestCloudWorkflowDirectory
  const STORAGE_KEY = 'nestcloud:workflow-files:v1'
  const MAX_BYTES = 64 * 1024
  const RECORD_KEYS = ['filename', 'id', 'revision']
  const MESSAGES = Object.freeze({
    unreadable: '文件关联信息损坏或不可读取，已保留原数据；现有流程的文件来源不明，请从项目目录重新打开或导出后再保存。',
    unwritable: '文件关联无法写入本地存储；本页仍可保存，刷新后请从目录重新打开。',
    unknownSource: '该流程的文件来源不明，不能直接保存；请从项目目录重新打开，或导出后另行保存。',
    cancelled: '文件保存已取消。',
  })
  const bytes = (value) => new TextEncoder().encode(value).length

  /** 管理工作区流程与项目文件的来源关联：打开复用、串行保存及独立的元信息存储。 */
  class WorkflowFileService {
    constructor({ workspace, directory, storage = null, confirmOverwrite }) {
      this.workspace = workspace
      this.directory = directory
      this.storage = storage
      this.confirmOverwrite = confirmOverwrite
      this.bindings = new Map()
      this.storageError = ''
      this.queue = Promise.resolve()
      this.destroyed = false
      this._restore()
    }

    /**
     * 严格恢复关联记录并过滤已不存在的流程。键损坏或不可读取时不覆盖原键，
     * 并把现有流程全部标记为来源不明（filename/revision 为 null），避免被当作新文件另存。
     */
    _restore() {
      try {
        const raw = this.storage?.getItem(STORAGE_KEY)
        if (raw === null || raw === undefined) return
        if (bytes(raw) > MAX_BYTES) throw new Error('关联信息过大')
        const value = JSON.parse(raw)
        if (value?.version !== 1 || !Array.isArray(value.records) || value.records.length > Core.LIMITS.documents) throw new Error('格式不兼容')
        const ids = new Set(this.workspace.documents.map((item) => item.id))
        const restored = new Map()
        for (const record of value.records) {
          if (!record || typeof record !== 'object' || Object.keys(record).sort().join() !== RECORD_KEYS.join() || typeof record.id !== 'string' || restored.has(record.id)) throw new Error('记录无效')
          if (record.filename !== null || record.revision !== null) {
            if (typeof record.revision !== 'string' || !Directory.REVISION_PATTERN.test(record.revision)) throw new Error('记录无效')
            Directory.validateFilename(record.filename)
          }
          restored.set(record.id, { filename: record.filename, revision: record.revision })
        }
        for (const [id, binding] of restored) if (ids.has(id)) this.bindings.set(id, binding)
      } catch {
        this.bindings.clear()
        for (const item of this.workspace.documents) this.bindings.set(item.id, { filename: null, revision: null })
        this.storageError = MESSAGES.unreadable
      }
    }

    /** 清理已不存在的流程记录后写入独立键；失败只记录警告，内存关联继续有效。 */
    _persist() {
      const ids = new Set(this.workspace.documents.map((item) => item.id))
      for (const id of [...this.bindings.keys()]) if (!ids.has(id)) this.bindings.delete(id)
      try {
        const raw = JSON.stringify({ version: 1, records: [...this.bindings].map(([id, { filename, revision }]) => ({ id, filename, revision })) })
        if (!this.storage || bytes(raw) > MAX_BYTES) throw new Error('storage unavailable')
        this.storage.setItem(STORAGE_KEY, raw)
        this.storageError = ''
      } catch {
        this.storageError = MESSAGES.unwritable
      }
    }

    /** 打开项目文件：复用同文件同版本且仍存在的流程并保留其未保存编辑，否则导入为新流程并绑定来源，不删除旧草稿。 */
    open({ filename, text, revision }) {
      for (const [id, binding] of this.bindings) {
        if (binding.filename === filename && binding.revision === revision && this.workspace.documents.some((item) => item.id === id)) {
          this.workspace.select(id)
          return this.workspace.getDocument(id)
        }
      }
      const document = this.workspace.importDocument(text, { preserveName: true })
      this.bindings.set(document.id, { filename, revision })
      this._persist()
      return document
    }

    /** 同步固定快照并排队保存；返回 {filename, revision}，首次撞名确认被取消时返回 null。 */
    save({ id, name, text }) {
      const task = this.queue.then(() => this._save({ id, name, text }))
      this.queue = task.catch(() => undefined)
      return task
    }

    /** 已关联流程按保存时的最新版本原位写入原文件；未关联流程按名称生成文件名并保留首次撞名确认；来源不明的流程拒绝保存。 */
    async _save({ id, name, text }) {
      if (this.destroyed) throw new Error(MESSAGES.cancelled)
      const binding = this.bindings.get(id)
      if (binding && !binding.filename) throw new Error(MESSAGES.unknownSource)
      const result = binding
        ? await this.directory.save({ name: binding.filename, text, expectedRevision: binding.revision, metadata: true })
        : await this.directory.save({ name: Directory.filenameOf(name), text, metadata: true, confirmOverwrite: this.confirmOverwrite })
      if (!result) return null
      const saved = { filename: result.filename, revision: result.revision }
      if (this.destroyed || !this.workspace.documents.some((item) => item.id === id)) return saved
      this.bindings.set(id, { filename: saved.filename, revision: saved.revision })
      this._persist()
      return saved
    }

    /** 标记销毁：排队任务不再发请求，迟到结果不更新关联与存储；共享目录客户端由调用方销毁。 */
    destroy() {
      this.destroyed = true
    }
  }

  const api = Object.freeze({ STORAGE_KEY, WorkflowFileService })
  if (node) module.exports = api
  else root.NestCloudWorkflowFiles = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
