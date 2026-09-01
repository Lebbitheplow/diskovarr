import { flushSync } from 'react-dom'

const REDUCED = '(prefers-reduced-motion: reduce)'
const NAME = 'media-poster'

// The poster of the most recently clicked card. Captured document-wide rather
// than threaded through every card component and page: a capture-phase listener
// runs before React's own handler, so by the time a page opens its detail modal
// this already points at the right element.
let lastPoster = null

export function trackPosterClicks() {
  const onClick = (e) => {
    const link = e.target.closest?.('.card-poster-link')
    lastPoster = link ? link.querySelector('.card-poster') : null
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

/**
 * Runs a state update inside a view transition, morphing the clicked poster
 * into the detail modal's poster.
 *
 * Both elements have to carry the same view-transition-name, but never at the
 * same time — a duplicate name aborts the transition. The card's name is
 * therefore cleared inside the callback, after the browser has snapshotted the
 * old state and before it snapshots the new one.
 *
 * Falls back to a plain update where the API is missing or the user asked for
 * reduced motion.
 */
export function withViewTransition(update) {
  const poster = lastPoster
  const reduced = window.matchMedia(REDUCED).matches

  if (typeof document.startViewTransition !== 'function' || reduced) {
    update()
    return
  }

  if (poster) poster.style.viewTransitionName = NAME

  let transition
  try {
    transition = document.startViewTransition(() => {
      if (poster) poster.style.viewTransitionName = ''
      flushSync(update)
    })
  } catch {
    if (poster) poster.style.viewTransitionName = ''
    update()
    return
  }

  transition.finished.catch(() => {}).finally(() => {
    if (poster) poster.style.viewTransitionName = ''
  })
}
