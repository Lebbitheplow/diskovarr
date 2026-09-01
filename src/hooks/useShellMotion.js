import { useEffect } from 'react'
import { trackPosterClicks } from '../utils/viewTransition'

const REDUCED = '(prefers-reduced-motion: reduce)'

/**
 * Page-level motion wiring, installed once by AppShell.
 *
 * 1. Shelves reveal as they scroll into view rather than all burning their
 *    entrance animation on mount — previously every shelf below the fold had
 *    already finished animating by the time you reached it.
 * 2. Sticky section headers learn when they are actually pinned, so the blur
 *    is only composited for a header that's stuck rather than for all six.
 *
 * The opt-in flag lives on <html>: CSS hides un-revealed cards only while
 * data-motion="on" is set, so if this never runs the content is simply visible.
 */
export default function useShellMotion() {
  useEffect(() => {
    if (window.matchMedia(REDUCED).matches) return

    const root = document.documentElement
    root.setAttribute('data-motion', 'on')

    const reveal = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('is-revealed')
        reveal.unobserve(e.target)
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 })

    let stuck = null
    const buildStuckObserver = () => {
      stuck?.disconnect()
      const topbar = parseInt(
        getComputedStyle(root).getPropertyValue('--topbar-h'), 10,
      ) || 60
      // A sticky header stops being fully visible the moment it pins against
      // the top bar, which is what the ratio < 1 test detects. isIntersecting
      // is required as well: headers that are simply off-screen also report a
      // ratio below 1, and without this every shelf below the fold counts as
      // pinned — which is exactly the pile of blur layers this avoids.
      stuck = new IntersectionObserver((entries) => {
        for (const e of entries) {
          e.target.classList.toggle('is-stuck', e.isIntersecting && e.intersectionRatio < 1)
        }
      }, { threshold: [0, 1], rootMargin: `-${topbar + 1}px 0px 0px 0px` })
      document.querySelectorAll('.section-header').forEach(el => stuck.observe(el))
    }
    buildStuckObserver()

    let queued = false
    const scan = () => {
      queued = false
      document.querySelectorAll('.card-grid:not(.is-revealed)').forEach(el => reveal.observe(el))
      document.querySelectorAll('.section-header').forEach(el => stuck.observe(el))
    }
    scan()

    // Routes are lazy and their data arrives async, so shelves appear well
    // after mount. Re-scan on DOM changes, coalesced to one pass per frame.
    const mutations = new MutationObserver(() => {
      if (queued) return
      queued = true
      requestAnimationFrame(scan)
    })
    mutations.observe(document.body, { childList: true, subtree: true })

    const breakpoint = window.matchMedia('(max-width: 960px)')
    const onBreakpoint = () => buildStuckObserver()
    breakpoint.addEventListener('change', onBreakpoint)

    const stopTracking = trackPosterClicks()

    return () => {
      root.removeAttribute('data-motion')
      reveal.disconnect()
      stuck?.disconnect()
      mutations.disconnect()
      breakpoint.removeEventListener('change', onBreakpoint)
      stopTracking()
    }
  }, [])
}
