// Colour helpers shared by the ambient styles. Everything derives from the
// admin accent so each style follows the theme colour.

export const CREAM = [255, 243, 220]
const DEEP_RED = [58, 11, 16]

export const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t))
export const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`

export function readAccent() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()
  return (raw || '229, 160, 13').split(',').map(n => parseInt(n, 10) || 0)
}

export function paletteFor(accent) {
  return {
    accent,
    // Same fold as --velvet in style.css: 38% accent over deep red
    velvet: mix(accent, DEEP_RED, 0.62),
    // Warm light that still carries the accent hue
    light: mix(accent, CREAM, 0.25),
    sheen: mix(accent, CREAM, 0.4),
    cream: CREAM,
  }
}

// Small deterministic PRNG so layouts are stable across resizes
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
