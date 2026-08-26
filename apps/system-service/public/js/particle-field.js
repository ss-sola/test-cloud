(function attachParticleField(root, factory) {
  const api = factory(root)
  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else if (root) {
    root.NestCloudParticleField = api
  }
})(typeof globalThis === 'object' ? globalThis : null, function createParticleFieldApi(root) {
  const MAX_DPR = 2
  const INTERACTION_RADIUS = 220
  const SPRING = 0.032
  const ENTRY_SPRING = 0.045
  const DAMPING = 0.91
  const BURST_FADE = 0.965

  function fitImage(width, height, sourceWidth, sourceHeight) {
    const scale = Math.min(width / sourceWidth, height / sourceHeight)
    return {
      scale,
      offsetX: (width - sourceWidth * scale) / 2,
      offsetY: (height - sourceHeight * scale) / 2,
    }
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min)
  }

  function pointCoords(point, meta, width, height) {
    if (!point || !meta || !width || !height) return null
    const { scale, offsetX, offsetY } = fitImage(width, height, meta.sourceWidth, meta.sourceHeight)
    return {
      x: offsetX + point.nx * meta.sourceWidth * scale,
      y: offsetY + point.ny * meta.sourceHeight * scale,
    }
  }

  function createParticle(point, width, height) {
    return {
      size: point.size,
      alpha: point.alpha,
      phase: point.phase,
      sourcePoint: { nx: point.nx, ny: point.ny },
      targetPoint: null,
      sourceCoords: null,
      targetCoords: null,
      x: randomBetween(-40, Math.max(width, 40)),
      y: randomBetween(-40, Math.max(height, 40)),
      baseX: 0,
      baseY: 0,
      vx: 0,
      vy: 0,
      burst: 0,
      morphDelay: 0,
      spiralStartX: 0,
      spiralStartY: 0,
      initialized: false,
    }
  }

  function createParticleField(stage, options = {}) {
    if (!stage || typeof document === 'undefined') return null
    const imageApi = root?.NestCloudImageParticles
    if (!imageApi) throw new Error('粒子处理模块未加载。')

    const canvas = document.createElement('canvas')
    canvas.className = 'particle-canvas'
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', '图片边缘粒子画布；点击或按 Enter、空格切换素材形态')
    const particleStage = document.createElement('div')
    particleStage.className = 'particle-stage'
    particleStage.append(canvas)
    const cornerTop = document.createElement('span')
    cornerTop.className = 'stage-corner stage-corner--tl'
    const cornerBottom = document.createElement('span')
    cornerBottom.className = 'stage-corner stage-corner--br'
    const hint = document.createElement('span')
    hint.className = 'stage-hint'
    hint.textContent = '点击切换形态'
    particleStage.append(cornerTop, cornerBottom, hint)
    stage.replaceChildren(particleStage)

    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持 Canvas 绘制。')

    const state = {
      activeTarget: 0,
      bursts: [],
      destroyed: false,
      frameId: 0,
      loadVersions: [0, 0],
      particleLimit: Math.max(1, Number(options.particleLimit) || 5000),
      particles: [],
      pointer: { x: 0, y: 0, active: false },
      rawResults: [null, null],
      reducedMotion: false,
      size: { width: 0, height: 0, dpr: 1 },
      targetMeta: [null, null],
      targetPoints: [null, null],
      transition: { active: false, startedAt: 0, effect: 'spring', duration: 1200, centerX: 0, centerY: 0, direction: 1, turns: 1 },
      transitionEffect: options.transitionEffect || 'spring',
      visible: typeof document === 'undefined' || document.visibilityState === 'visible',
    }

    const onParticleCountChange = options.onParticleCountChange || (() => {})
    const onStatusChange = options.onStatusChange || (() => {})
    const onTargetReady = options.onTargetReady || (() => {})
    const onActiveTargetChange = options.onActiveTargetChange || (() => {})

    function syncParticleCohort(requestedCount) {
      const sourceResult = state.rawResults[0]
      if (!sourceResult || state.destroyed) return

      const count = Math.max(1, Math.min(imageApi.MAX_PARTICLES, Math.round(Number(requestedCount) || imageApi.MAX_PARTICLES)))
      const sourcePoints = imageApi.resamplePointsToCount(sourceResult.points, count)
      const targetPoints = state.rawResults[1]
        ? imageApi.resamplePointsToCount(state.rawResults[1].points, count)
        : null
      const { width, height } = state.size
      const nextParticles = state.particles.slice(0, count)

      for (let index = nextParticles.length; index < count; index += 1) {
        nextParticles.push(createParticle(sourcePoints[index], width, height))
      }

      nextParticles.forEach((particle, index) => {
        particle.sourcePoint = { nx: sourcePoints[index].nx, ny: sourcePoints[index].ny }
        particle.targetPoint = targetPoints ? { nx: targetPoints[index].nx, ny: targetPoints[index].ny } : null
      })

      state.particles = nextParticles
      state.targetPoints[0] = sourcePoints
      state.targetPoints[1] = targetPoints
      onParticleCountChange(count)
      resize()
    }

    function resize() {
      if (state.destroyed) return
      const rect = particleStage.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      state.size = { width: rect.width, height: rect.height, dpr }
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`

      state.particles.forEach((particle) => {
        particle.sourceCoords = pointCoords(particle.sourcePoint, state.targetMeta[0], rect.width, rect.height)
        particle.targetCoords = pointCoords(particle.targetPoint, state.targetMeta[1], rect.width, rect.height)
        const next = state.activeTarget === 1 && particle.targetCoords ? particle.targetCoords : particle.sourceCoords
        if (!next) return
        particle.baseX = next.x
        particle.baseY = next.y
        if (!particle.initialized) {
          particle.x = next.x
          particle.y = next.y
        }
      })
    }

    function startMorph(nextTarget, origin = null) {
      if (state.destroyed || (nextTarget === 1 && !state.targetMeta[1])) return false

      const effect = state.reducedMotion ? 'spring' : state.transitionEffect
      const { width, height } = state.size
      const centerX = effect === 'rotate' ? width / 2 : origin?.x ?? width / 2
      const centerY = effect === 'rotate' ? height / 2 : origin?.y ?? height / 2
      const duration = effect === 'wave' ? 1800 : effect === 'rotate' ? 2200 : 1200

      state.activeTarget = nextTarget
      state.transition = { active: true, startedAt: 0, effect, duration, centerX, centerY, direction: 1, turns: 1 }
      resize()

      if (effect === 'rotate' && !origin) {
        state.bursts.push({ x: centerX, y: centerY, radius: 12, alpha: 0.65 })
        if (state.bursts.length > 4) state.bursts.shift()
      }

      state.particles.forEach((particle) => {
        particle.vx *= 0.72
        particle.vy *= 0.72
        particle.morphDelay = effect === 'wave'
          ? (particle.targetPoint?.ny ?? particle.sourcePoint.ny) * 700 + (Math.sin(particle.phase) + 1) * 24
          : 0

        if (effect === 'rotate') {
          particle.spiralStartX = particle.x
          particle.spiralStartY = particle.y
          particle.vx = 0
          particle.vy = 0
          particle.burst = Math.max(particle.burst, 28)
        }
      })

      onActiveTargetChange(nextTarget)
      return true
    }

    function draw(time) {
      if (state.destroyed) return
      state.frameId = requestAnimationFrame(draw)
      if (!state.visible) return

      const { width, height, dpr } = state.size
      if (!width || !height) return
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, width, height)
      const particles = state.particles
      const pointer = state.pointer
      const isReduced = state.reducedMotion
      const transition = state.transition
      if (transition.active && transition.startedAt === 0) transition.startedAt = time
      const elapsed = transition.active ? time - transition.startedAt : 0

      context.globalCompositeOperation = 'lighter'
      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index]
        if (!particle.initialized) {
          particle.x += (particle.baseX - particle.x) * (isReduced ? 0.18 : ENTRY_SPRING)
          particle.y += (particle.baseY - particle.y) * (isReduced ? 0.18 : ENTRY_SPRING)
          if (Math.abs(particle.x - particle.baseX) < 0.4 && Math.abs(particle.y - particle.baseY) < 0.4) particle.initialized = true
        }

        const isSpiral = transition.active && transition.effect === 'rotate' && !isReduced
        if (isSpiral) {
          const progress = Math.min(1, Math.max(0, elapsed / transition.duration))
          const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
          const startDX = particle.spiralStartX - transition.centerX
          const startDY = particle.spiralStartY - transition.centerY
          const startRadius = Math.hypot(startDX, startDY)
          const startAngle = Math.atan2(startDY, startDX)
          const angle = startAngle + transition.direction * Math.PI * 2 * transition.turns * eased
          const radius = startRadius * (1 - eased)
          const movingCenterX = transition.centerX + (particle.baseX - transition.centerX) * eased
          const movingCenterY = transition.centerY + (particle.baseY - transition.centerY) * eased
          particle.x = movingCenterX + Math.cos(angle) * radius
          particle.y = movingCenterY + Math.sin(angle) * radius
          particle.vx = 0
          particle.vy = 0
        } else {
          const dx = particle.baseX - particle.x
          const dy = particle.baseY - particle.y
          let spring = SPRING
          if (transition.active && !isReduced && transition.effect === 'wave' && elapsed < particle.morphDelay) spring *= 0.08
          particle.vx += dx * spring
          particle.vy += dy * spring
          particle.vx *= DAMPING
          particle.vy *= DAMPING
          particle.x += particle.vx
          particle.y += particle.vy
        }
        particle.burst *= BURST_FADE

        if (!isReduced) {
          particle.x += Math.sin(time * 0.0012 + particle.phase) * 0.11
          particle.y += Math.cos(time * 0.001 + particle.phase) * 0.08
        }

        const glow = Math.min(1, particle.burst * 0.012 + 0.22)
        context.fillStyle = `rgba(0, 123, 255, ${Math.min(0.1, 0.025 + particle.burst * 0.0018)})`
        context.beginPath()
        context.arc(particle.x, particle.y, particle.size + 0.8 + particle.burst * 0.06, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = index % 7 === 0
          ? `rgba(23, 162, 184, ${glow * 0.95})`
          : `rgba(0, 123, 255, ${Math.min(1, particle.alpha + particle.burst * 0.006)})`
        context.beginPath()
        context.arc(particle.x, particle.y, particle.size + particle.burst * 0.055, 0, Math.PI * 2)
        context.fill()

        if (particle.burst > 2) {
          context.fillStyle = `rgba(40, 167, 69, ${Math.min(0.18, particle.burst / 240)})`
          context.beginPath()
          context.arc(particle.x, particle.y, particle.size + particle.burst * 0.12, 0, Math.PI * 2)
          context.fill()
        }

        if (pointer.active && !isReduced) {
          const distance = Math.hypot(pointer.x - particle.x, pointer.y - particle.y)
          if (distance < INTERACTION_RADIUS && distance > 1) {
            const influence = (1 - distance / INTERACTION_RADIUS) * 0.012
            particle.vx += (particle.x - pointer.x) * influence
            particle.vy += (particle.y - pointer.y) * influence
          }
        }
      }

      if (transition.active && elapsed > transition.duration) {
        transition.active = false
        particles.forEach((particle) => { particle.morphDelay = 0 })
      }

      if (pointer.active && !isReduced) {
        const pointerGlow = context.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 78)
        pointerGlow.addColorStop(0, 'rgba(0, 123, 255, 0.18)')
        pointerGlow.addColorStop(1, 'rgba(0, 123, 255, 0)')
        context.fillStyle = pointerGlow
        context.beginPath()
        context.arc(pointer.x, pointer.y, 78, 0, Math.PI * 2)
        context.fill()
      }

      state.bursts = state.bursts.filter((burst) => burst.alpha > 0.02)
      state.bursts.forEach((burst) => {
        burst.radius += 8
        burst.alpha *= 0.91
        context.strokeStyle = `rgba(40, 167, 69, ${burst.alpha})`
        context.lineWidth = 1.2
        context.beginPath()
        context.arc(burst.x, burst.y, burst.radius, 0, Math.PI * 2)
        context.stroke()
      })

      context.globalCompositeOperation = 'source-over'
      if (!isReduced && particles.length > 24) {
        context.lineWidth = 0.45
        for (let index = 0; index < particles.length - 12; index += 13) {
          const first = particles[index]
          const second = particles[index + 7]
          const distance = Math.hypot(first.x - second.x, first.y - second.y)
          if (distance < 42) {
            context.strokeStyle = `rgba(23, 162, 184, ${0.1 * (1 - distance / 42)})`
            context.beginPath()
            context.moveTo(first.x, first.y)
            context.lineTo(second.x, second.y)
            context.stroke()
          }
        }
      }
    }

    function handlePointerMove(event) {
      const rect = canvas.getBoundingClientRect()
      state.pointer.x = event.clientX - rect.left
      state.pointer.y = event.clientY - rect.top
      state.pointer.active = true
    }

    function handlePointerLeave() {
      state.pointer.active = false
    }

    function handlePointerDown(event) {
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      state.pointer.x = x
      state.pointer.y = y
      state.pointer.active = true
      state.bursts.push({ x, y, radius: 12, alpha: 0.8 })
      if (state.bursts.length > 4) state.bursts.shift()

      if (!state.reducedMotion && state.transitionEffect !== 'rotate') {
        state.particles.forEach((particle) => {
          const dx = particle.x - x
          const dy = particle.y - y
          const distance = Math.hypot(dx, dy)
          if (distance >= INTERACTION_RADIUS) return
          const influence = 1 - distance / INTERACTION_RADIUS
          const angle = distance > 1 ? Math.atan2(dy, dx) : randomBetween(0, Math.PI * 2)
          const impulse = 7 + influence * 24
          particle.vx += Math.cos(angle) * impulse * influence
          particle.vy += Math.sin(angle) * impulse * influence
          particle.burst = Math.max(particle.burst, influence * 86)
        })
      }

      if (state.targetMeta[1]) startMorph(state.activeTarget === 0 ? 1 : 0, { x, y })
    }

    function handleKeyDown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      handlePointerDown({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 })
    }

    function setSourceImage(source) {
      const version = state.loadVersions[0] + 1
      state.loadVersions[0] = version
      state.activeTarget = 0
      state.transition.active = false
      onActiveTargetChange(0)
      state.rawResults[0] = null
      state.targetMeta[0] = null
      state.targetPoints[0] = null
      onStatusChange('loading', '', 0)
      return imageApi.createParticlesFromImage(source, { sampleStep: 1 }).then((result) => {
        if (state.destroyed || version !== state.loadVersions[0]) return false
        state.rawResults[0] = result
        state.targetMeta[0] = result
        syncParticleCohort(state.particleLimit)
        onStatusChange('ready', '', 0)
        return true
      }).catch((error) => {
        if (!state.destroyed && version === state.loadVersions[0]) onStatusChange('error', error.message, 0)
        return false
      })
    }

    function setTargetImage(source) {
      const version = state.loadVersions[1] + 1
      state.loadVersions[1] = version
      state.targetMeta[1] = null
      state.targetPoints[1] = null
      state.rawResults[1] = null
      state.activeTarget = 0
      state.transition.active = false
      onActiveTargetChange(0)
      onTargetReady(false)
      if (!source) return Promise.resolve(false)

      onStatusChange('loading', '', 1)
      return imageApi.createParticlesFromImage(source, { sampleStep: 1 }).then((result) => {
        if (state.destroyed || version !== state.loadVersions[1]) return false
        state.rawResults[1] = result
        state.targetMeta[1] = result
        syncParticleCohort(state.particleLimit)
        onTargetReady(true)
        onStatusChange('ready', '', 1)
        return true
      }).catch((error) => {
        if (!state.destroyed && version === state.loadVersions[1]) {
          onTargetReady(false)
          onStatusChange('error', error.message, 1)
        }
        return false
      })
    }

    function setParticleLimit(value) {
      state.particleLimit = Math.max(1, Math.min(imageApi.MAX_PARTICLES, Math.round(Number(value) || imageApi.MAX_PARTICLES)))
      syncParticleCohort(state.particleLimit)
    }

    function setTransitionEffect(effect) {
      state.transitionEffect = effect
    }

    function requestMorph() {
      return startMorph(state.activeTarget === 0 ? 1 : 0)
    }

    function handleVisibilityChange() {
      state.visible = document.visibilityState === 'visible'
    }

    let observer
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(resize)
      observer.observe(particleStage)
    } else {
      window.addEventListener('resize', resize)
    }
    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const handleMotionChange = () => { state.reducedMotion = Boolean(motionQuery?.matches) }
    handleMotionChange()
    motionQuery?.addEventListener?.('change', handleMotionChange)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerleave', handlePointerLeave)
    canvas.addEventListener('pointercancel', handlePointerLeave)
    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('keydown', handleKeyDown)
    resize()
    state.frameId = requestAnimationFrame(draw)

    return {
      destroy() {
        if (state.destroyed) return
        state.destroyed = true
        state.loadVersions[0] += 1
        state.loadVersions[1] += 1
        cancelAnimationFrame(state.frameId)
        observer?.disconnect()
        if (!observer) window.removeEventListener('resize', resize)
        motionQuery?.removeEventListener?.('change', handleMotionChange)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        canvas.removeEventListener('pointermove', handlePointerMove)
        canvas.removeEventListener('pointerleave', handlePointerLeave)
        canvas.removeEventListener('pointercancel', handlePointerLeave)
        canvas.removeEventListener('pointerdown', handlePointerDown)
        canvas.removeEventListener('keydown', handleKeyDown)
        particleStage.replaceChildren()
      },
      getActiveTarget: () => state.activeTarget,
      requestMorph,
      setParticleLimit,
      setSourceImage,
      setTargetImage,
      setTransitionEffect,
    }
  }

  return { createParticleField }
})
