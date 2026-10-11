import createCurtain, { RENDER_SCALE } from './curtain'

// The curtain's motion is slow (its fastest ripple takes 7.5 s to pass), so
// frame-to-frame movement at 24 fps is well under a pixel. Every frame drawn
// here also makes the compositor re-blur each backdrop-filter surface over
// it (rail, top bar, modal), so the rate is capped rather than run at the
// display's refresh rate.
const FRAME_MS = 1000 / 24

// Longest step the clock takes between frames, so a stall (busy main thread,
// a frame dropped under load) doesn't make the folds lurch forward
const MAX_STEP_MS = 100

/**
 * Drives the curtain on one canvas: sizing, the frame clock, and pausing.
 * The same code runs in the worker (curtain.worker.js, OffscreenCanvas) and,
 * where that isn't supported, on the main thread (AmbientBackground.jsx).
 *
 * The canvas is sized at the curtain's render scale and stretched by CSS, so
 * the compositor does the upscale instead of the canvas filling every
 * device pixel.
 *
 * The clock only advances while running: after a pause (hidden tab, modal
 * open) the curtain resumes where it stopped rather than jumping ahead.
 */
export default function createRunner(canvas, { raf, caf }) {
  const ctx = canvas.getContext('2d')
  let scene = null
  let palette = null
  let w = 0, h = 0
  let hidden = false, paused = false, reduced = false
  let handle = 0
  let clock = 0       // curtain time in ms
  let lastTick = 0    // timestamp of the previous tick, 0 when (re)starting
  let lastDraw = -Infinity

  const running = () => scene && w > 0 && !hidden && !paused && !reduced

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // The curtain lays out in page px; this maps them onto the smaller canvas
    ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0)
    scene.draw(ctx, reduced ? 0 : clock, { still: reduced })
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }

  function tick(t) {
    handle = 0
    if (!running()) return
    if (lastTick) clock += Math.min(t - lastTick, MAX_STEP_MS)
    lastTick = t
    // Skips whole display frames: 24 fps on 120/144 Hz, 20 fps on 60 Hz
    if (t - lastDraw >= FRAME_MS - 1) {
      lastDraw = t
      draw()
    }
    handle = raf(tick)
  }

  // Called after any change: starts or stops the clock. `repaint` draws at
  // once, so a resized (and therefore cleared) canvas is never shown blank.
  function update(repaint) {
    if (handle) { caf(handle); handle = 0 }
    if (!scene || w <= 0) return
    if (repaint || reduced) draw()
    if (running()) {
      lastTick = 0
      handle = raf(tick)
    }
  }

  function rebuild() {
    if (!palette || w <= 0) return
    scene = createCurtain(palette)
    scene.layout(w, h)
  }

  return {
    resize(width, height) {
      if (width === w && height === h) return
      w = width; h = height
      // Resizing the canvas clears it, hence the repaint below
      canvas.width = Math.max(1, Math.ceil(w * RENDER_SCALE))
      canvas.height = Math.max(1, Math.ceil(h * RENDER_SCALE))
      rebuild()
      update(true)
    },
    setPalette(next) {
      palette = next
      rebuild()
      update(true)
    },
    setState(next) {
      hidden = !!next.hidden
      paused = !!next.paused
      reduced = !!next.reduced
      update(false)
    },
    stop() {
      if (handle) caf(handle)
      handle = 0
      scene = null
    },
  }
}
