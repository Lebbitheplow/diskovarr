import createRunner from './runner'

// Renders the ambient curtain off the main thread: AmbientBackground hands
// over its canvas with transferControlToOffscreen and then only forwards
// size, palette and pause state. Page work (React renders, scrolling, image
// decodes) can no longer stall the curtain, and the curtain's per-frame
// drawing no longer competes with the page.

// Worker requestAnimationFrame is widely but not universally supported
const raf = self.requestAnimationFrame
  ? self.requestAnimationFrame.bind(self)
  : (cb) => setTimeout(() => cb(performance.now()), 16)
const caf = self.cancelAnimationFrame ? self.cancelAnimationFrame.bind(self) : clearTimeout

let runner = null

self.onmessage = ({ data }) => {
  switch (data.type) {
    case 'init':
      runner = createRunner(data.canvas, { raf, caf })
      runner.setState(data.state)
      runner.resize(data.width, data.height)
      runner.setPalette(data.palette)
      break
    case 'resize':
      runner?.resize(data.width, data.height)
      break
    case 'palette':
      runner?.setPalette(data.palette)
      break
    case 'state':
      runner?.setState(data.state)
      break
  }
}
