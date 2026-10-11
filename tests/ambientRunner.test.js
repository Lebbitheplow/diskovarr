import { describe, it, expect, vi, beforeEach } from 'vitest'

// The real curtain needs a canvas implementation; the runner only cares that
// it is laid out and drawn, and at what time.
const draws = []
vi.mock('../src/components/ambient/curtain', () => ({
  RENDER_SCALE: 0.5,
  default: () => ({
    layout: vi.fn(),
    draw: (ctx, t, opts) => draws.push({ t, still: opts.still }),
  }),
}))

const { default: createRunner } = await import('../src/components/ambient/runner')

function fakeCanvas() {
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true } })
  return { width: 0, height: 0, getContext: () => ctx }
}

// A manual display: each frame() call fires the pending callback at +16.67 ms
function fakeDisplay() {
  let pending = null
  let now = 1000
  return {
    raf: (cb) => { pending = cb; return 1 },
    caf: () => { pending = null },
    frame(n = 1) {
      for (let i = 0; i < n; i++) {
        now += 1000 / 60
        const cb = pending
        pending = null
        cb?.(now)
      }
    },
    get running() { return !!pending },
  }
}

const PALETTE = { velvet: [1, 2, 3], sheen: [4, 5, 6] }

beforeEach(() => { draws.length = 0 })

describe('ambient runner', () => {
  it('sizes the canvas at the render scale, not the device pixel size', () => {
    const canvas = fakeCanvas()
    const runner = createRunner(canvas, fakeDisplay())
    runner.resize(1441, 900)
    expect([canvas.width, canvas.height]).toEqual([721, 450])
  })

  it('draws every third frame on a 60 Hz display', () => {
    const display = fakeDisplay()
    const runner = createRunner(fakeCanvas(), display)
    runner.resize(800, 600)
    runner.setPalette(PALETTE)
    draws.length = 0
    display.frame(60)
    expect(draws.length).toBe(20)
  })

  it('stops while paused and resumes without the clock jumping ahead', () => {
    const display = fakeDisplay()
    const runner = createRunner(fakeCanvas(), display)
    runner.resize(800, 600)
    runner.setPalette(PALETTE)
    display.frame(30)
    const before = draws.at(-1).t

    runner.setState({ paused: true })
    expect(display.running).toBe(false)
    const count = draws.length
    display.frame(600) // ten seconds with a modal open
    expect(draws.length).toBe(count)

    runner.setState({ paused: false })
    display.frame(6)
    // Resumed within a few frames of where it stopped, not ten seconds later
    expect(draws.at(-1).t - before).toBeLessThan(200)
  })

  it('paints one still frame under reduced motion and does not loop', () => {
    const display = fakeDisplay()
    const runner = createRunner(fakeCanvas(), display)
    runner.setState({ reduced: true })
    runner.resize(800, 600)
    runner.setPalette(PALETTE)
    expect(display.running).toBe(false)
    expect(draws.at(-1)).toEqual({ t: 0, still: true })
  })

  it('repaints immediately on resize even while hidden', () => {
    const display = fakeDisplay()
    const runner = createRunner(fakeCanvas(), display)
    runner.resize(800, 600)
    runner.setPalette(PALETTE)
    runner.setState({ hidden: true })
    const count = draws.length
    runner.resize(1024, 768)
    expect(draws.length).toBe(count + 1)
    expect(display.running).toBe(false)
  })
})
