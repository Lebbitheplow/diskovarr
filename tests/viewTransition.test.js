import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  layoutBox,
  clipInsets,
  withViewTransition,
  closeWithTransition,
  afterTransition,
  morphSource,
} from '../src/utils/viewTransition'

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height })
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('view transition geometry', () => {
  it('returns an untransformed box as it is', () => {
    expect(layoutBox(rect(248, 614, 172, 258))).toEqual({ left: 248, top: 614, width: 172, height: 258 })
  })

  it('undoes the card lift: a scale and translate about the centre', () => {
    // A 172×258 card at (248, 614) under translateY(-6px) scale(1.035)
    const a = 1.035
    const onScreen = rect(248 - 86 * (a - 1), 614 - 129 * (a - 1) - 6, 172 * a, 258 * a)
    const box = layoutBox(onScreen, { a, d: a, e: 0, f: -6 }, [86, 129])
    expect(box.left).toBeCloseTo(248, 6)
    expect(box.top).toBeCloseTo(614, 6)
    expect(box.width).toBeCloseTo(172, 6)
    expect(box.height).toBeCloseTo(258, 6)
  })

  it('needs no clip for an element fully on screen', () => {
    expect(clipInsets(rect(248, 614, 172, 258), { left: 0, top: 0, right: 1440, bottom: 900 })).toBeNull()
  })

  it('cuts only the hidden sides, leaving room for the shadow elsewhere', () => {
    // Scrolled half out of a carousel on the left, in the element's own pixels
    const insets = clipInsets(rect(200, 100, 172, 258), { left: 286, top: 0, right: 1440, bottom: 900 }, undefined, 40)
    expect(insets).toEqual([-40, -40, -40, 86])
  })

  it('measures cuts in untransformed pixels for a scaled element', () => {
    const insets = clipInsets(rect(0, 0, 200, 300), { left: 0, top: 0, right: 100, bottom: 300 }, { a: 2, d: 2 })
    expect(insets[1]).toBe(50)
  })
})

// A document whose transitions are driven by hand: each start records its
// callback, and `end()` settles it the way the browser would.
function fakeTransitions() {
  const started = []
  const doc = {
    startViewTransition: vi.fn((callback) => {
      let finish
      const finished = new Promise((resolve) => { finish = resolve })
      const t = {
        callback,
        ran: false,
        async run() { t.ran = true; await callback() },
        async end() { if (!t.ran) await t.run(); finish(); await flush() },
        skipTransition: vi.fn(() => t.end()),
        ready: Promise.resolve(),
        finished,
      }
      started.push(t)
      return t
    }),
  }
  return { doc, started }
}

describe('view transition runs', () => {
  let started
  let reduced

  beforeEach(() => {
    const fake = fakeTransitions()
    started = fake.started
    reduced = false
    globalThis.document = fake.doc
    globalThis.window = { matchMedia: () => ({ matches: reduced }) }
  })

  afterEach(async () => {
    for (const t of started) await t.end()
    delete globalThis.document
    delete globalThis.window
  })

  it('opens with a plain update when no card was clicked', () => {
    const update = vi.fn()
    withViewTransition(update)
    expect(update).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(0)
  })

  it('closes with a plain update under reduced motion or without the API', () => {
    reduced = true
    const update = vi.fn()
    closeWithTransition(update)
    expect(update).toHaveBeenCalledTimes(1)

    reduced = false
    delete globalThis.document.startViewTransition
    closeWithTransition(update)
    expect(update).toHaveBeenCalledTimes(2)
    expect(started).toHaveLength(0)
  })

  it('fades out inside a transition when there is no card to fly back to', async () => {
    const update = vi.fn()
    closeWithTransition(update, { poster: null, card: null })
    expect(started).toHaveLength(1)
    expect(update).not.toHaveBeenCalled()
    await started[0].run()
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('lets a second open before the callback ride along in the same transition', async () => {
    const close = vi.fn()
    const open = vi.fn()
    closeWithTransition(close)
    withViewTransition(open)
    expect(started).toHaveLength(1)
    expect(open).not.toHaveBeenCalled()
    await started[0].run()
    expect(close).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('applies an open straight away once the running transition has updated', async () => {
    closeWithTransition(vi.fn())
    await started[0].run()
    const open = vi.fn()
    withViewTransition(open)
    expect(open).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(1)
  })

  it('lets a transition still in flight play out before closing', async () => {
    closeWithTransition(vi.fn())
    const first = started[0]
    await first.run()
    const close = vi.fn()
    closeWithTransition(close)
    // Not skipped (that snapped the poster to its end) and not stacked on top
    expect(first.skipTransition).not.toHaveBeenCalled()
    expect(started).toHaveLength(1)
    expect(close).not.toHaveBeenCalled()

    await first.end()
    expect(started).toHaveLength(2)
    await started[1].run()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes at once under reduced motion even after waiting on a transition', async () => {
    closeWithTransition(vi.fn())
    await started[0].run()
    const close = vi.fn()
    closeWithTransition(close)
    reduced = true
    await started[0].end()
    expect(close).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(1)
  })

  it('holds afterTransition until the running transition is over', async () => {
    await expect(afterTransition()).resolves.toBeUndefined()

    closeWithTransition(vi.fn())
    let done = false
    afterTransition().then(() => { done = true })
    await flush()
    expect(done).toBe(false)
    await started[0].end()
    expect(done).toBe(true)
  })

  it('reports no morph source outside an opening morph', () => {
    expect(morphSource()).toBeNull()
  })
})
