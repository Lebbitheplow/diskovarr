import React, { useEffect, useRef, useState } from 'react'
import { useTheme } from '../context/ThemeContext'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

// Fixed full-viewport ambient layer: large translucent lens-flare/bokeh orbs
// on a canvas that drift slowly and sweep with the page while scrolling.
// Sits at z-index -1 with pointer-events: none — purely decorative.
export default function AmbientBackground() {
  const canvasRef = useRef(null)
  const { themeColor } = useTheme()
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION).matches)

  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (reduced) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let raf = 0
    let running = true
    let orbs = []
    let scrollY = window.scrollY
    let lastScroll = scrollY
    let scrollVel = 0
    let w = 0
    let h = 0

    // themeColor in the deps re-runs this effect when the admin changes the
    // accent, so the freshly applied --accent-rgb is re-read here
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() ||
      '229, 160, 13'

    // Pre-render each orb once: soft core, faint body, brighter rim — the rim
    // is what gives the lens-flare/bokeh read instead of a plain blurry dot
    function makeSprite(r) {
      const sprite = document.createElement('canvas')
      sprite.width = sprite.height = r * 2
      const c = sprite.getContext('2d')
      const g = c.createRadialGradient(r, r, 0, r, r, r)
      g.addColorStop(0, 'rgba(255, 255, 255, 0.1)')
      g.addColorStop(0.25, `rgba(${accent}, 0.14)`)
      g.addColorStop(0.7, `rgba(${accent}, 0.05)`)
      g.addColorStop(0.9, `rgba(${accent}, 0.16)`)
      g.addColorStop(1, `rgba(${accent}, 0)`)
      c.fillStyle = g
      c.beginPath()
      c.arc(r, r, r, 0, Math.PI * 2)
      c.fill()
      return sprite
    }

    function makeOrb() {
      const mobile = w <= 768
      const r = (mobile ? 24 : 36) + Math.random() * (mobile ? 56 : 90)
      const a = Math.random() * Math.PI * 2
      const s = 0.05 + Math.random() * 0.15
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        r,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        depth: 0.2 + Math.random() * 0.55,
        phase: Math.random() * Math.PI * 2,
        pulse: 0.3 + Math.random() * 0.5,
        sprite: makeSprite(r),
      }
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      orbs = Array.from({ length: w <= 768 ? 7 : 13 }, makeOrb)
    }

    function frame(t) {
      if (!running) return
      // Smoothed scroll velocity: orbs accelerate with the scroll and ease
      // back to their lazy drift when scrolling stops
      scrollVel += (scrollY - lastScroll - scrollVel) * 0.08
      lastScroll = scrollY

      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      for (const o of orbs) {
        o.x += o.vx
        // content moves up when scrolling down; orbs follow at their depth
        o.y += o.vy - scrollVel * o.depth * 0.6
        const m = o.r * 2
        if (o.x < -m) o.x = w + m
        if (o.x > w + m) o.x = -m
        if (o.y < -m) o.y = h + m
        if (o.y > h + m) o.y = -m
        ctx.globalAlpha = 0.55 + 0.45 * Math.sin(o.phase + t * 0.0004 * o.pulse)
        ctx.drawImage(o.sprite, o.x - o.r, o.y - o.r, o.r * 2, o.r * 2)
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }

    // Scroll work stays in the rAF loop; the listener only records position
    const onScroll = () => {
      scrollY = window.scrollY
    }
    const onVisibility = () => {
      cancelAnimationFrame(raf)
      running = !document.hidden
      if (running) {
        lastScroll = scrollY = window.scrollY
        raf = requestAnimationFrame(frame)
      }
    }

    resize()
    raf = requestAnimationFrame(frame)
    window.addEventListener('resize', resize)
    window.addEventListener('orientationchange', resize)
    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('orientationchange', resize)
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reduced, themeColor])

  if (reduced) return null

  return (
    <div className="ambient-bg" aria-hidden="true">
      <canvas ref={canvasRef} className="ambient-canvas" />
    </div>
  )
}
