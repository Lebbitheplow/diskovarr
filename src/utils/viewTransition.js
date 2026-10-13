import { flushSync } from 'react-dom'

const REDUCED = '(prefers-reduced-motion: reduce)'
const NAME = 'media-poster'

// The card most recently clicked. Captured document-wide rather than threaded
// through every card component and page: a capture-phase listener runs before
// React's own handler, so by the time a page opens its detail modal this
// already points at the right card.
let lastCard = null

// The transition in flight: { transition, queue }. `queue` collects updates
// that ask for a transition of their own before this one's callback has run,
// and is null from then on.
let active = null

// The card an opening morph lifted off, set only while that open's update
// runs (see morphSource)
let opening = null

const noop = () => {}

export function trackPosterClicks() {
  const onClick = (e) => {
    const card = e.target.closest?.('.card')
    lastCard = card?.querySelector('.card-poster-link') ? card : null
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

function canAnimate() {
  return typeof document !== 'undefined'
    && typeof document.startViewTransition === 'function'
    && !window.matchMedia(REDUCED).matches
}

/**
 * The card's untransformed layout box in viewport pixels, from its on-screen
 * rect and computed transform (a scale and translate about `origin`, which is
 * all the card lift uses): where a copy has to sit, carrying the same
 * transform, to cover it exactly.
 */
export function layoutBox(rect, { a = 1, d = 1, e = 0, f = 0 } = {}, [ox = 0, oy = 0] = []) {
  return {
    left: rect.left - ox * (1 - a) - e,
    top: rect.top - oy * (1 - d) - f,
    width: rect.width / a,
    height: rect.height / d,
  }
}

/**
 * clip-path insets (top, right, bottom, left, in the element's own
 * untransformed pixels) that hide the parts of `rect` outside `visible`, or
 * null when nothing is cut off. Sides that aren't cut get `slack` of negative
 * inset so the shadow there survives.
 */
export function clipInsets(rect, visible, { a = 1, d = 1 } = {}, slack = 48) {
  const cut = [
    (visible.top - rect.top) / d,
    (rect.right - visible.right) / a,
    (rect.bottom - visible.bottom) / d,
    (visible.left - rect.left) / a,
  ]
  if (cut.every(v => v < 0.5)) return null
  return cut.map(v => (v < 0.5 ? -slack : v))
}

// The part of `el` its scrolling ancestors and the viewport leave on screen
function visibleRect(el) {
  let left = 0
  let top = 0
  let right = window.innerWidth
  let bottom = window.innerHeight
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
    const r = p.getBoundingClientRect()
    left = Math.max(left, r.left)
    top = Math.max(top, r.top)
    right = Math.min(right, r.right)
    bottom = Math.min(bottom, r.bottom)
  }
  return { left, top, right, bottom }
}

function onScreen(el) {
  if (!el?.isConnected || el.getClientRects().length === 0) return false
  const r = el.getBoundingClientRect()
  const v = visibleRect(el)
  return Math.min(r.right, v.right) - Math.max(r.left, v.left) > 8
    && Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top) > 8
}

// What hover, keyboard focus and the entrance animation change on a card and
// its parts. Pinning copies their current values inline and stops
// transitions, so the card holds exactly the frame that was on screen.
const HELD = [
  'transform', 'transform-origin', 'opacity', 'visibility', 'max-height',
  'margin-top', 'box-shadow', 'filter',
  'outline-color', 'outline-style', 'outline-width', 'outline-offset',
]
// Inherited text styles, which the stand-in would otherwise take from <body>
// instead of the card's own ancestors. Not line-height: it reads back in
// pixels, and children would inherit that instead of the unitless factor.
const INHERITED = [
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'text-transform', 'text-align',
]

// The card's current look: its elements, the HELD values of each, and the
// scrim (a pseudo-element, so it is pinned through a custom property)
function readLook(card) {
  const els = [card, ...card.querySelectorAll('*')]
  const styles = els.map(el => getComputedStyle(el))
  return {
    els,
    rows: styles.map(s => HELD.map(p => s.getPropertyValue(p))),
    inherited: INHERITED.map(p => styles[0].getPropertyValue(p)),
    scrim: getComputedStyle(card, '::after').transform,
    transform: styles[0].transform,
    origin: styles[0].transformOrigin,
  }
}

// `els` mirror the looked-at card's elements one for one
function pin(els, look) {
  els.forEach((el, i) => {
    look.rows[i].forEach((v, j) => el.style.setProperty(HELD[j], v))
    el.style.setProperty('transition', 'none', 'important')
  })
  els[0].style.setProperty('--vt-scrim', look.scrim)
  els[0].classList.add('vt-pinned')
}

/**
 * Keeps the clicked card looking as it did at the click until the returned
 * function lets go. In the new state it has lost hover and focus to the
 * modal; the page cross-fade would otherwise blend its relaxed look with the
 * snapshot of its hovered one, doubling the title and buttons.
 */
function holdLook(card, look) {
  const saved = look.els.map(el => el.getAttribute('style'))
  pin(look.els, look)
  return () => {
    look.els.forEach((el, i) => {
      if (saved[i] == null) el.removeAttribute('style')
      else el.setAttribute('style', saved[i])
    })
    card.classList.remove('vt-pinned')
  }
}

/**
 * A fixed-position copy of `card` laid exactly over it, pinned to its current
 * look (hover lift, poster zoom, revealed overlay and all). The morph flies
 * this copy rather than the card: a named element is cut out of the page
 * snapshot, so naming the card itself would leave a hole where it stood, and
 * naming just its poster image would drop the card's clipping, corners and
 * overlay on the first frame.
 */
function standInFor(card, look = readLook(card)) {
  const copy = card.cloneNode(true)
  const to = [copy, ...copy.querySelectorAll('*')]
  const rect = card.getBoundingClientRect()
  const visible = visibleRect(card)
  const matrix = look.transform && look.transform !== 'none' ? new DOMMatrixReadOnly(look.transform) : undefined
  const origin = look.origin.split(' ').map(parseFloat)

  pin(to, look)
  to.forEach(el => el.style.setProperty('animation', 'none', 'important'))
  INHERITED.forEach((p, i) => copy.style.setProperty(p, look.inherited[i]))

  const box = layoutBox(rect, matrix, origin)
  Object.assign(copy.style, {
    position: 'fixed',
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: '0',
    zIndex: '1',
  })
  const clip = clipInsets(rect, visible, matrix)
  if (clip) copy.style.clipPath = `inset(${clip.map(v => `${v}px`).join(' ')})`
  for (const attr of [...copy.attributes]) {
    if (attr.name.startsWith('data-')) copy.removeAttribute(attr.name)
  }
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true

  // The exact file the card shows, loaded eagerly and decoded with the frame:
  // a lazy or async image could still be blank when the browser snapshots it
  look.els.forEach((el, i) => {
    if (el.tagName !== 'IMG' || !el.currentSrc) return
    const img = to[i]
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')
    img.loading = 'eager'
    img.decoding = 'sync'
    img.src = el.currentSrc
  })
  copy.style.viewTransitionName = NAME
  return copy
}

// Hover and focus changes that have started on the card jump to where they
// end, so a stand-in made now matches what the card settles on
function settle(el) {
  if (typeof CSSTransition === 'undefined') return
  for (const a of el.getAnimations({ subtree: true })) {
    if (a instanceof CSSTransition) a.finish()
  }
}

/**
 * Starts a view transition whose callback runs `apply(flushQueued)`;
 * `flushQueued` applies any update that arrived for a transition of its own
 * before this one got there. `cleanup` runs once it is over, however it ends.
 * Returns false when the browser refused to start one.
 */
function begin(apply, cleanup) {
  const entry = { transition: null, queue: [] }
  let transition
  try {
    transition = document.startViewTransition(() => {
      const queued = entry.queue
      entry.queue = null
      return apply(() => queued.forEach(update => update()))
    })
  } catch {
    cleanup()
    return false
  }
  entry.transition = transition
  active = entry
  transition.ready.catch(noop)
  transition.finished.catch(noop).finally(() => {
    if (active === entry) active = null
    cleanup()
  })
  return true
}

/**
 * Runs a state update inside a view transition, morphing the clicked card into
 * the detail modal's poster (which carries the matching view-transition-name
 * in effects.css).
 *
 * A stand-in copy of the card flies, never the card itself, and is removed
 * inside the callback — after the browser has snapshotted the old state and
 * before it snapshots the new one — so the name is never on two elements at
 * once. The card stays put in the page snapshot and dims under the modal's
 * backdrop as the page cross-fades.
 *
 * One click starts one transition: a second call before the first has applied
 * its update joins that update; one while it animates just applies.
 *
 * Falls back to a plain update where the API is missing, the user asked for
 * reduced motion, or there is no card with a loaded poster on screen to morph
 * from (the modal then plays its own entrance).
 */
export function withViewTransition(update) {
  const card = lastCard
  lastCard = null

  if (active) {
    if (active.queue) active.queue.push(update)
    else update()
    return
  }
  // Only a card showing a loaded poster morphs: one showing its placeholder
  // or a failed image has nothing for the modal's poster to land as
  const poster = card?.querySelector('img.card-poster')
  if (!poster?.complete || !poster.naturalWidth || !canAnimate() || !onScreen(card)) {
    update()
    return
  }

  const look = readLook(card)
  const standIn = standInFor(card, look)
  const release = holdLook(card, look)
  document.body.appendChild(standIn)
  const started = begin((flushQueued) => {
    standIn.remove()
    opening = card
    try {
      flushSync(() => {
        update()
        flushQueued()
      })
    } finally {
      opening = null
    }
  }, () => {
    standIn.remove()
    release()
  })
  if (!started) update()
}

/**
 * The card a view transition is morphing the detail modal out of, while that
 * open's update runs; null otherwise. Read once, at mount (a useState
 * initializer): a morphed-in modal skips its own entrance, since the morph is
 * the motion, and hands the card back to closeWithTransition later.
 */
export function morphSource() {
  return opening
}

/**
 * Resolves once the view transition in flight, if any, is over. Content that
 * would grow or load heavily mid-morph (the trailer embed) waits for this.
 */
export function afterTransition() {
  return active ? active.transition.finished.then(noop, noop) : Promise.resolve()
}

/**
 * Runs the update that closes the detail modal inside a view transition: its
 * poster flies back into `card` when that is still on screen, and otherwise
 * the modal simply fades out with the page.
 *
 * A transition still playing (an open closed mid-morph) plays out first, so
 * the close never starts from a half-faded modal: the poster lands, then flies
 * straight back. Skipping it instead snapped the poster ~100px into its slot
 * and held that frame while the close captured it. The landing spot is a
 * stand-in again, laid over the card after the update, so the page snapshot
 * keeps the card whole and the poster settles onto an exact copy of it.
 */
export function closeWithTransition(update, { poster = null, card = null } = {}) {
  if (active) {
    // Checked again once it is over, in case another has started meanwhile
    active.transition.finished.then(noop, noop)
      .then(() => closeWithTransition(update, { poster, card }))
    return
  }
  if (!canAnimate()) {
    update()
    return
  }

  const target = onScreen(poster) && onScreen(card) ? card : null
  // Nothing to fly back to (or from — the modal scrolled the poster away):
  // the poster fades with the rest of the modal rather than lingering as a
  // group of its own
  if (!target && poster) poster.style.viewTransitionName = 'none'

  let standIn = null
  const started = begin(async (flushQueued) => {
    flushSync(() => {
      update()
      flushQueued()
    })
    if (!target) return
    // Closing hands focus back to the card (dialogStack, a microtask) — a
    // keyboard close reveals its overlay. Let that land and settle first.
    await Promise.resolve()
    settle(target)
    standIn = standInFor(target)
    document.body.appendChild(standIn)
  }, () => standIn?.remove())
  if (!started) update()
}
