import React, { useEffect, useRef, useState } from 'react'
import { useTheme } from '../context/ThemeContext'
import { readAccent, paletteFor } from './ambient/palette'
import createCurtain from './ambient/curtain'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

// Fixed full-viewport ambient layer behind the app: a velvet stage curtain in
// the theme's colours (see ./ambient/curtain). The loop here owns sizing,
// scroll velocity, tab visibility and reduced motion; the curtain only lays
// out for a viewport and draws a frame. z-index -1, pointer-events none.
// Grain and vignette live in CSS (.ambient-bg::after / ::before).
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
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    // themeColor in the deps re-runs this when the admin changes the accent,
    // so the freshly applied --accent-rgb is read here
    const scene = createCurtain(paletteFor(readAccent()))
    let raf = 0, running = true, last = 0
    let w = 0, h = 0
    let scrollY = window.scrollY, lastScroll = scrollY, scrollVel = 0

    function layout() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth; h = window.innerHeight
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      scene.layout(w, h)
    }

    function frame(t) {
      if (!running) return
      const dt = last ? Math.min(t - last, 50) : 16.7
      last = t
      scrollVel += (scrollY - lastScroll - scrollVel) * 0.08
      lastScroll = scrollY
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, w, h)
      scene.draw(ctx, reduced ? 0 : t, { w, h, dt, scrollVel, still: reduced })
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      if (reduced) { running = false; return } // one static frame is enough
      raf = requestAnimationFrame(frame)
    }

    const onScroll = () => { scrollY = window.scrollY }
    const onVisibility = () => {
      cancelAnimationFrame(raf)
      running = !document.hidden
      if (running) { last = 0; lastScroll = scrollY = window.scrollY; raf = requestAnimationFrame(frame) }
    }
    const onResize = () => { layout(); if (reduced) { running = true; frame(0) } }

    layout()
    raf = requestAnimationFrame(frame)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reduced, themeColor])

  return (
    <div className="ambient-bg" aria-hidden="true">
      <canvas ref={canvasRef} className="ambient-canvas" />
    </div>
  )
}
