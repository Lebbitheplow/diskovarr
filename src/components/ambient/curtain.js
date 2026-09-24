import { seeded, makeCanvas } from './palette'

// Stage curtain: velvet folds in the theme's velvet tone, pre-shaded once
// (diffuse light, velvet sheen on the fold flanks, darker troughs), then
// warped every frame through a grid of tiles: a slow ripple travels across
// the folds, bunching and spreading them, and the velvet brightens where they
// bunch. A soft spotlight wanders across it, and the lower viewport falls
// into shadow so the shelves sit on a quiet stage.
export default function createCurtain(pal, { ambient = 0.16, spot = 0.34 } = {}) {
  const S = 0.5          // render scale; the curtain is soft enough for half-res
  const M = 18           // side margin in sprite px so the warp never shows an edge
  let COLS = 16, ROWS = 64
  // Ripples in sprite px (half the page px). Two waves travelling in opposite
  // directions at unrelated speeds, so the motion never visibly repeats.
  const WAVES = [
    { amp: 5.5, lam: 260, period: 7500, dir: 1, ph: 0, tilt: 1.1 },
    { amp: 2.8, lam: 150, period: 13500, dir: -1, ph: 1.7, tilt: -0.8 },
  ].map(v => ({ ...v, k: (2 * Math.PI) / v.lam, w: (2 * Math.PI) / v.period }))
  let w = 0, h = 0, W = 0, H = 0
  let sprite, sway, spotLayer, sctx, pctx, fade

  // Several cosine components at unrelated wavelengths give irregular folds
  const rnd = seeded(11)
  const comps = [
    { lam: 118, amp: 1.0 }, { lam: 67, amp: 0.45 },
    { lam: 205, amp: 0.7 }, { lam: 39, amp: 0.14 },
  ].map(c => ({ ...c, ph: rnd() * Math.PI * 2, drift: (rnd() - 0.5) * 1.2 }))
  const ampSum = comps.reduce((s, c) => s + c.amp, 0)
  const slopeMax = comps.reduce((s, c) => s + c.amp * (2 * Math.PI / c.lam), 0)

  function buildSprite() {
    const SW = W + M * 2
    sprite = makeCanvas(SW, H)
    const c = sprite.getContext('2d')
    const img = c.createImageData(SW, H)
    const d = img.data
    const K = 1.7 / slopeMax              // steepest fold flank ≈ 60°
    const Lx = 0.34, Lz = 0.94            // key light a little right of front
    const [vr, vg, vb] = pal.velvet
    const [sr, sg, sb] = pal.sheen
    for (let y = 0; y < H; y++) {
      const yn = y / H
      // Gathered a little tighter at the top, as if hung from a rail
      const gather = 1 - 0.12 * (1 - yn) * (1 - yn)
      // Valance shadow at the top edge and a darker hem
      const vert = (0.5 + 0.5 * Math.min(1, yn / 0.12)) * (1 - 0.25 * Math.max(0, (yn - 0.85) / 0.15))
      for (let x = 0; x < SW; x++) {
        const xf = ((x - M) / S - w / 2) * gather + w / 2
        let f = 0, df = 0
        for (const k of comps) {
          const a = (2 * Math.PI * xf) / k.lam + k.ph + yn * k.drift
          f += k.amp * Math.cos(a)
          df -= k.amp * (2 * Math.PI / k.lam) * Math.sin(a) * gather
        }
        const slope = df * K
        const nz = 1 / Math.sqrt(1 + slope * slope)
        const nx = -slope * nz
        const diffuse = Math.max(0, nx * Lx + nz * Lz)
        const sheen = Math.pow(1 - nz, 1.4)            // velvet brightens at grazing angles
        const depth = (f / ampSum + 1) / 2             // 0 trough … 1 crest
        const shade = (0.16 + 0.84 * diffuse) * (0.3 + 0.7 * depth) * 1.3 * vert
        const gl = sheen * 0.55 * (0.4 + 0.6 * depth) * vert
        const i = (y * SW + x) * 4
        d[i] = Math.min(255, vr * shade + sr * gl)
        d[i + 1] = Math.min(255, vg * shade + sg * gl)
        d[i + 2] = Math.min(255, vb * shade + sb * gl)
        d[i + 3] = 255
      }
    }
    c.putImageData(img, 0, 0)
  }

  return {
    layout(Wf, Hf) {
      w = Wf; h = Hf
      W = Math.ceil(w * S); H = Math.ceil(h * S)
      buildSprite()
      // Rows are thin so neighbouring rows differ by well under a pixel and the
      // fold edges stay smooth; columns only need to follow the ripple's curve
      COLS = w <= 768 ? 10 : 16
      ROWS = w <= 768 ? 40 : 64
      sway = makeCanvas(W, H); sctx = sway.getContext('2d')
      spotLayer = makeCanvas(W, H); pctx = spotLayer.getContext('2d')
      fade = null
    },

    draw(ctx, t, { still }) {
      // ── warp: tiles follow a displacement field so the folds billow ──
      // Each row is split into columns whose edges move with the ripple;
      // neighbouring tiles share an edge, so the folds stretch and bunch
      // without seams. Where a tile is squeezed the velvet catches more light.
      sctx.clearRect(0, 0, W, H)
      const SW = W + M * 2
      const cw = SW / COLS, rh = H / ROWS
      const xs = new Array(COLS + 1)
      for (let r = 0; r < ROWS; r++) {
        const y0 = Math.floor(r * rh), y1 = Math.floor((r + 1) * rh)
        const yn = (r + 0.5) / ROWS
        const reach = 0.45 + 0.55 * yn                     // the hem moves most
        const drift = still ? 0 : 3 * Math.sin(t * 0.00035 + yn * 2.2)
        for (let i = 0; i <= COLS; i++) {
          const sx = i * cw
          let dx = drift
          if (!still) for (const v of WAVES) dx += v.amp * reach * Math.sin(v.k * sx - v.dir * v.w * t + v.ph + v.tilt * yn)
          xs[i] = sx - M + dx
        }
        // Tiles are drawn opaque with a hairline of overlap so no gaps show
        sctx.globalCompositeOperation = 'source-over'
        for (let i = 0; i < COLS; i++) {
          const dw = xs[i + 1] - xs[i]
          sctx.drawImage(sprite, i * cw, y0, cw, y1 - y0 + 1, xs[i], y0, dw + 0.5, y1 - y0 + 1)
        }
        // Shimmer as one smooth gradient per row (rows don't overlap), so the
        // brightness change has no tile edges: squeezed folds stay bright,
        // spread folds dim a little.
        const g = sctx.createLinearGradient(0, 0, W, 0)
        for (let i = 0; i < COLS; i++) {
          const dw = xs[i + 1] - xs[i]
          const b = still ? 0.85 : Math.max(0.55, Math.min(1, 0.85 + (1 - dw / cw) * 1.6))
          const pos = Math.max(0, Math.min(1, (xs[i] + dw / 2) / W))
          g.addColorStop(pos, `rgba(0,0,0,${(1 - b).toFixed(3)})`)
        }
        sctx.globalCompositeOperation = 'destination-out'
        sctx.fillStyle = g
        sctx.fillRect(0, y0, W, y1 - y0)
      }
      sctx.globalCompositeOperation = 'source-over'

      // ── spotlight: the swayed curtain, masked to a soft roaming ellipse ──
      pctx.globalCompositeOperation = 'source-over'
      pctx.clearRect(0, 0, W, H)
      pctx.drawImage(sway, 0, 0)
      pctx.globalCompositeOperation = 'destination-in'
      // Wanders on two unrelated cycles (~40 s and ~27 s) so it never retraces
      const cx = W * (0.55 + (still ? 0 : 0.2 * Math.sin(t * 0.00016) + 0.06 * Math.sin(t * 0.00041 + 2)))
      const cy = H * (0.2 + (still ? 0 : 0.07 * Math.sin(t * 0.00023 + 1.3)))
      const rx = W * 0.4, ry = H * 0.62
      pctx.save()
      pctx.translate(cx, cy)
      pctx.scale(1, ry / rx)
      const g = pctx.createRadialGradient(0, 0, 0, 0, 0, rx)
      g.addColorStop(0, 'rgba(0,0,0,1)')
      g.addColorStop(0.4, 'rgba(0,0,0,0.6)')
      g.addColorStop(0.75, 'rgba(0,0,0,0.15)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      pctx.fillStyle = g
      pctx.fillRect(-W * 3, -W * 3, W * 6, W * 6)
      pctx.restore()

      // ── composite: dim curtain everywhere, spotlight added on top ──
      const flicker = still ? 1 : 1 + Math.sin(t * 0.0019) * 0.02 + Math.sin(t * 0.0133) * 0.01
      ctx.globalAlpha = ambient
      ctx.drawImage(sway, 0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = spot * flicker
      ctx.drawImage(spotLayer, 0, 0, w, h)
      ctx.globalAlpha = 1

      // Lower viewport falls into shadow
      if (!fade) {
        fade = ctx.createLinearGradient(0, 0, 0, h)
        fade.addColorStop(0, 'rgba(0,0,0,1)')
        fade.addColorStop(0.45, 'rgba(0,0,0,0.8)')
        fade.addColorStop(1, 'rgba(0,0,0,0.3)')
      }
      ctx.globalCompositeOperation = 'destination-in'
      ctx.fillStyle = fade
      ctx.fillRect(0, 0, w, h)
    },
  }
}
