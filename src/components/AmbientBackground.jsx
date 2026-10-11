import React, { useEffect, useRef } from 'react'
import { useTheme } from '../context/ThemeContext'
import { readAccent, paletteFor } from './ambient/palette'
import createRunner from './ambient/runner'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

const paletteKey = (p) => p.velvet.join() + '|' + p.sheen.join()

function mountCanvas(host) {
  const canvas = document.createElement('canvas')
  canvas.className = 'ambient-canvas'
  host.appendChild(canvas)
  return canvas
}

function startOnMainThread(host, init) {
  const canvas = mountCanvas(host)
  const runner = createRunner(canvas, {
    raf: (cb) => window.requestAnimationFrame(cb),
    caf: (id) => window.cancelAnimationFrame(id),
  })
  runner.setState(init.state)
  runner.resize(init.width, init.height)
  runner.setPalette(init.palette)
  return { ...runner, stop() { runner.stop(); canvas.remove() } }
}

/**
 * Starts the curtain in a worker when the browser can hand a canvas to one,
 * otherwise on the main thread; both sides expose the same four calls. The
 * canvas is created here rather than rendered by React because a canvas can
 * only be transferred once, and StrictMode mounts effects twice.
 */
function startCurtain(host, init) {
  const latest = { ...init }
  let impl = null
  let stopped = false

  const probe = document.createElement('canvas')
  if (typeof probe.transferControlToOffscreen !== 'function' || typeof Worker === 'undefined') {
    impl = startOnMainThread(host, latest)
  } else {
    let worker = null
    const canvas = mountCanvas(host)
    const workerImpl = {
      resize: (width, height) => worker.postMessage({ type: 'resize', width, height }),
      setPalette: (palette) => worker.postMessage({ type: 'palette', palette }),
      setState: (state) => worker.postMessage({ type: 'state', state }),
      stop: () => { worker?.terminate(); canvas.remove() },
    }
    try {
      worker = new Worker(new URL('./ambient/curtain.worker.js', import.meta.url), { type: 'module' })
      // A worker that fails to load (no module worker support, a blocked
      // script) reports here. Its canvas is spent, so start over on a new one.
      worker.onerror = (e) => {
        e.preventDefault?.()
        if (stopped || impl !== workerImpl) return
        workerImpl.stop()
        impl = startOnMainThread(host, latest)
      }
      const offscreen = canvas.transferControlToOffscreen()
      worker.postMessage({ type: 'init', canvas: offscreen, ...latest }, [offscreen])
      impl = workerImpl
    } catch {
      workerImpl.stop()
      impl = startOnMainThread(host, latest)
    }
  }

  return {
    resize(width, height) { latest.width = width; latest.height = height; impl.resize(width, height) },
    setPalette(palette) { latest.palette = palette; impl.setPalette(palette) },
    setState(state) { latest.state = state; impl.setState(state) },
    stop() { stopped = true; impl.stop() },
  }
}

// Fixed full-viewport ambient layer behind the app: a velvet stage curtain in
// the theme's colours (see ./ambient/curtain, driven by ./ambient/runner).
// This component only wires the browser to it: viewport size, the accent,
// and when to pause (hidden tab, modal open, reduced motion).
// z-index -1, pointer-events none. Grain and vignette live in CSS
// (.ambient-bg::after / ::before).
export default function AmbientBackground() {
  const hostRef = useRef(null)
  const curtainRef = useRef(null)
  const paletteRef = useRef('')
  const { themeColor } = useTheme()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const root = document.documentElement
    const reducedMq = window.matchMedia(REDUCED_MOTION)
    const readState = () => ({
      hidden: document.hidden,
      paused: root.hasAttribute('data-modal-open'), // see hooks/useModalOpen
      reduced: reducedMq.matches,
    })

    const palette = paletteFor(readAccent())
    paletteRef.current = paletteKey(palette)
    const curtain = startCurtain(host, {
      width: window.innerWidth,
      height: window.innerHeight,
      palette,
      state: readState(),
    })
    curtainRef.current = curtain

    // A resize rebuilds the pre-shaded curtain, so coalesce a drag-resize or
    // a mobile URL bar sliding to one rebuild per frame
    let resizeQueued = 0
    const onResize = () => {
      if (resizeQueued) return
      resizeQueued = requestAnimationFrame(() => {
        resizeQueued = 0
        curtain.resize(window.innerWidth, window.innerHeight)
      })
    }
    const onState = () => curtain.setState(readState())
    const modalWatch = new MutationObserver(onState)
    modalWatch.observe(root, { attributes: true, attributeFilter: ['data-modal-open'] })

    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    document.addEventListener('visibilitychange', onState)
    reducedMq.addEventListener('change', onState)
    return () => {
      cancelAnimationFrame(resizeQueued)
      modalWatch.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      document.removeEventListener('visibilitychange', onState)
      reducedMq.removeEventListener('change', onState)
      curtain.stop()
      curtainRef.current = null
    }
  }, [])

  // The admin accent changed: ThemeContext has already applied the new
  // --accent-rgb by the time this runs
  useEffect(() => {
    const palette = paletteFor(readAccent())
    const key = paletteKey(palette)
    if (key === paletteRef.current) return
    paletteRef.current = key
    curtainRef.current?.setPalette(palette)
  }, [themeColor])

  return <div ref={hostRef} className="ambient-bg" aria-hidden="true" />
}
