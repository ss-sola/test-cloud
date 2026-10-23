((root) => {
  /** 从节点定义生成过滤后的目录，不读取工作流输入，也不修改注册定义；区域等画布标注由工具栏添加，不进入节点库。 */
  function createPaletteTree(definitions, query = '') {
    const normalize = (text) => String(text ?? '').normalize('NFKC').toLowerCase()
    const terms = normalize(query).trim().split(/\s+/u).filter(Boolean)
    const tree = { name: '', path: '', folders: [], items: [], count: 0 }
    const byPath = new Map()
    for (const definition of definitions) {
      if (definition.execution === 'annotation') continue
      const categories = String(definition.category ?? '').split('/').map((name) => name.trim()).filter(Boolean)
      if (!categories.length) categories.push('其他节点')
      const fields = [definition.label, definition.type, ...categories]
      for (const port of [...definition.inputs, ...definition.outputs]) fields.push(port.label, port.dataType, port.id)
      const searchable = fields.map(normalize).join(' ')
      if (!terms.every((term) => searchable.includes(term))) continue
      tree.count += 1
      let parent = tree
      const path = []
      for (const name of categories) {
        path.push(name)
        const key = path.join('/')
        let folder = byPath.get(key)
        if (!folder) {
          folder = { name, path: key, folders: [], items: [], count: 0 }
          byPath.set(key, folder)
          parent.folders.push(folder)
        }
        folder.count += 1
        parent = folder
      }
      parent.items.push(definition)
    }
    return tree
  }

  const api = Object.freeze({ createPaletteTree })
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.NestCloudWorkflowPalette = api
})(typeof window === 'undefined' ? globalThis : window)
