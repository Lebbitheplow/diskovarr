import { useEffect } from 'react'
import { trackPosterClicks } from '../utils/viewTransition'

const REDUCED = '(prefers-reduced-motion: reduce)'

// The staggered entrance runs 0.4 s, and its last card starts 0.36 s in
// (effects.css); the class comes off with some slack after that.
const ENTRANCE_MS = 1000

/**
 * Whether a box overlaps the viewport. A box with no size (a grid under a
 * display:none parent) never counts, so it waits for the observer instead.
 */
export function isOnScreen(rect, width, height) {
  return rect.width > 0 && rect.height > 0 &&
    rect.bottom > 0 && rect.top < height &&
    rect.right > 0 && rect.left < width
}

/**
 * Page-level motion wiring, installed once by AppShell.
 *
 * 1. Shelves reveal as they scroll into view rather than all burning their
 *    entrance animation on mount — previously every shelf below the fold had
 *    already finished animating by the time you reached it. A grid that is
 *    already on screen when it mounts is shown as it is, before its first
 *    paint: it is usually replacing something the user was looking at (a
 *    skeleton, the previous shuffle), and fading it in from nothing blinked
 *    the whole shelf.
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

    const timers = new Set()
    const reveal = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const grid = e.target
        reveal.unobserve(grid)
        grid.classList.add('is-revealed', 'is-arriving')
        // The stagger plays once. Cards that arrive in this grid later (a
        // shuffle, the next page of results) just appear in place.
        const id = setTimeout(() => {
          timers.delete(id)
          grid.classList.remove('is-arriving')
        }, ENTRANCE_MS)
        timers.add(id)
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

    // Each grid is looked at once, when it first appears. Run from the
    // mutation callback, a microtask after React's commit and its layout
    // effects (RouteFade's scroll reset included), so the check sees the
    // final position and lands before the browser paints; the observer
    // alone reports a frame later, after the grid has painted hidden.
    const seen = new WeakSet()
    const scanGrids = () => {
      const fresh = []
      document.querySelectorAll('.card-grid:not(.is-revealed)').forEach((el) => {
        if (!seen.has(el)) { seen.add(el); fresh.push(el) }
      })
      if (!fresh.length) return
      const w = window.innerWidth
      const h = window.innerHeight
      const shown = []
      for (const el of fresh) {
        if (isOnScreen(el.getBoundingClientRect(), w, h)) shown.push(el)
        else reveal.observe(el)
      }
      if (!shown.length) return
      // Measuring styled the new cards hidden, so revealing them now would run
      // the card's own opacity transition up from 0. One style pass with
      // transitions off (is-instant) lands them visible with nothing to fade.
      for (const el of shown) el.classList.add('is-revealed', 'is-instant')
      void document.body.offsetHeight
      for (const el of shown) el.classList.remove('is-instant')
    }

    let queued = false
    const scanHeaders = () => {
      queued = false
      document.querySelectorAll('.section-header').forEach(el => stuck.observe(el))
    }
    scanGrids()

    // Routes are lazy and their data arrives async, so shelves appear well
    // after mount. Re-scan on DOM changes; headers coalesce to one pass a frame.
    const mutations = new MutationObserver(() => {
      scanGrids()
      if (queued) return
      queued = true
      requestAnimationFrame(scanHeaders)
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
      timers.forEach(clearTimeout)
      breakpoint.removeEventListener('change', onBreakpoint)
      stopTracking()
    }
  }, [])
}
