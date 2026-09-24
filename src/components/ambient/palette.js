// Colour and canvas helpers for the ambient curtain. Everything derives from
// the admin accent so the curtain follows the theme colour.

const CREAM = [255, 243, 220]
const DEEP_RED = [58, 11, 16]

const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t))

export function readAccent() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()
  return (raw || '229, 160, 13').split(',').map(n => parseInt(n, 10) || 0)
}

export function paletteFor(accent) {
  return {
    // Same fold as --velvet in style.css: 38% accent over deep red
    velvet: mix(accent, DEEP_RED, 0.62),
    // Highlight the velvet picks up on its fold edges
    sheen: mix(accent, CREAM, 0.4),
  }
}

// Small deterministic PRNG so the fold pattern is stable across resizes
export function seeded(seed) {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return () => (s = (s * 48271) % 2147483647) / 2147483647
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  return c
}
