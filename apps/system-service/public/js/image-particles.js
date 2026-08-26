(function attachImageParticles(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else if (root) {
    root.NestCloudImageParticles = api
  }
})(typeof globalThis === 'object' ? globalThis : null, function createImageParticles() {
  const MAX_SOURCE_SIDE = 900
  const MAX_PARTICLES = 10000

  function getLuminance(data, index) {
    return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('图片无法解码，请换一张图片再试。'))
      image.src = source
    })
  }

  function extractEdgePoints(data, width, height, requestedStep = 2) {
    const points = []
    const threshold = width * height < 180000 ? 22 : 28
    const step = Math.max(1, Number(requestedStep) || 2)

    for (let y = 1; y < height - 1; y += step) {
      for (let x = 1; x < width - 1; x += step) {
        const index = (y * width + x) * 4
        const alpha = data[index + 3]
        if (alpha < 28) continue

        const center = getLuminance(data, index)
        const left = getLuminance(data, index - 4)
        const right = getLuminance(data, index + 4)
        const up = getLuminance(data, index - width * 4)
        const down = getLuminance(data, index + width * 4)
        const horizontal = Math.abs(left - right)
        const vertical = Math.abs(up - down)
        const gradient = Math.max(horizontal, vertical, Math.abs(center - left), Math.abs(center - up))
        const alphaEdge = Math.min(data[index - 1], data[index + 3], data[index + width * 4 - 1], data[index - width * 4 + 3])
        const isTransparentBoundary = alpha < 220 && alphaEdge > alpha + 12

        if (gradient < threshold && !isTransparentBoundary) continue

        points.push({
          x,
          y,
          nx: x / width,
          ny: y / height,
          size: 0.55 + ((x * 17 + y * 11) % 10) / 18,
          alpha: clamp(0.55 + gradient / 180, 0.55, 0.98),
          phase: (x * 0.017 + y * 0.013) % (Math.PI * 2),
        })
      }
    }
    return points
  }

  async function createParticlesFromImage(source, options = {}) {
    const image = await loadImage(source)
    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height
    const scale = Math.min(1, MAX_SOURCE_SIDE / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(2, Math.round(sourceWidth * scale))
    const height = Math.max(2, Math.round(sourceHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })

    if (!context) throw new Error('浏览器不支持 Canvas 像素读取。')

    context.drawImage(image, 0, 0, width, height)
    let pixels
    try {
      pixels = context.getImageData(0, 0, width, height)
    } catch {
      throw new Error('图片读取失败，请确认文件来自本地并重试。')
    }

    const points = extractEdgePoints(pixels.data, width, height, options.sampleStep)
    if (!points.length) throw new Error('没有检测到清晰边缘，请选择一张主体与背景对比明显的图片。')

    if (points.length > MAX_PARTICLES) {
      const stride = points.length / MAX_PARTICLES
      const reduced = []
      for (let index = 0; index < MAX_PARTICLES; index += 1) reduced.push(points[Math.floor(index * stride)])
      return { points: reduced, sourceWidth: width, sourceHeight: height }
    }

    return { points, sourceWidth: width, sourceHeight: height }
  }

  function resamplePointsToCount(points, targetCount) {
    if (!points.length || targetCount <= 0) return []
    if (points.length === targetCount) return points.map((point) => ({ ...point }))

    return Array.from({ length: targetCount }, (_, index) => {
      const sourceIndex = points.length > targetCount
        ? Math.min(points.length - 1, Math.floor(((index + 0.5) * points.length) / targetCount))
        : index % points.length
      return { ...points[sourceIndex] }
    })
  }

  return {
    MAX_PARTICLES,
    MAX_SOURCE_SIDE,
    createParticlesFromImage,
    extractEdgePoints,
    resamplePointsToCount,
  }
})
