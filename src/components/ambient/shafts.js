import { rgba, seeded, makeCanvas } from './palette'

// Projector light: a fan of shafts from a lamp above the top-left corner,
// each swaying and pulsing on its own slow cycle, broken up by a rolling haze,
// with dust drifting outward along the rays. Fades out down the viewport.
export default function createShafts(pal, { strength = 0.55 } = {}) {
  const LS = 0.5 // light renders at half resolution; it is all soft gradients
  const layer = makeCanvas(1, 1)
  const lctx = layer.getContext('2d')
  const lamp = { x: 0, y: 0, base: 0, len: 0 }
  let w = 0, h = 0, raySprite, hazePattern, glowSprite, fade
  let rays = [], dust = []

  function buildRaySprite() {
    const L = Math.ceil(lamp.len * LS), H = 160
    raySprite = makeCanvas(L, H)
    const c = raySprite.getContext('2d')
    const across = c.createLinearGradient(0, 0, 0, H)
    across.addColorStop(0, rgba(pal.velvet, 0))
    across.addColorStop(0.3, rgba(pal.velvet, 0.3))
    across.addColorStop(0.5, rgba(pal.light, 0.75))
    across.addColorStop(0.7, rgba(pal.velvet, 0.3))
    across.addColorStop(1, rgba(pal.velvet, 0))
    c.fillStyle = across
    c.fillRect(0, 0, L, H)
    const along = c.createLinearGradient(0, 0, L, 0)
    along.addColorStop(0, 'rgba(0,0,0,0.95)')
    along.addColorStop(0.12, 'rgba(0,0,0,1)')
    along.addColorStop(0.55, 'rgba(0,0,0,0.55)')
    along.addColorStop(1, 'rgba(0,0,0,0)')
    c.globalCompositeOperation = 'destination-in'
    c.fillStyle = along
    c.fillRect(0, 0, L, H)
  }

  function buildHaze() {
    const S = 384
    const t = makeCanvas(S, S)
    const c = t.getContext('2d')
    c.fillStyle = 'rgba(255,255,255,0.2)'
    c.fillRect(0, 0, S, S)
    const rnd = seeded(7)
    for (let i = 0; i < 70; i++) {
      const x = rnd() * S, y = rnd() * S, r = 40 + rnd() * 110, a = 0.25 + rnd() * 0.55
      for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
        const g = c.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r)
        g.addColorStop(0, `rgba(255,255,255,${a})`)
        g.addColorStop(1, 'rgba(255,255,255,0)')
        c.fillStyle = g
        c.fillRect(x + dx - r, y + dy - r, r * 2, r * 2)
      }
    }
    hazePattern = lctx.createPattern(t, 'repeat')
  }

  function buildGlow() {
    const R = 220
    glowSprite = makeCanvas(R * 2, R * 2)
    const c = glowSprite.getContext('2d')
    const g = c.createRadialGradient(R, R, 0, R, R, R)
    g.addColorStop(0, rgba(pal.light, 0.3))
    g.addColorStop(0.18, rgba(pal.light, 0.16))
    g.addColorStop(0.5, rgba(pal.velvet, 0.06))
    g.addColorStop(1, rgba(pal.velvet, 0))
    c.fillStyle = g
    c.fillRect(0, 0, R * 2, R * 2)
  }

  function buildRays() {
    const n = w <= 768 ? 3 : 4
    const rnd = seeded(3)
    rays = Array.from({ length: n }, (_, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1)
      return {
        offset: (t - 0.5) * 0.5 + (rnd() - 0.5) * 0.06,
        halfWidth: 0.012 + rnd() * 0.03,
        bright: 0.45 + rnd() * 0.55,
        swayAmp: 0.006 + rnd() * 0.014,
        swaySpeed: 0.00008 + rnd() * 0.00012,
        phase: rnd() * Math.PI * 2,
        pulseSpeed: 0.00025 + rnd() * 0.0003,
      }
    })
  }

  function makeMote(fresh) {
    const ray = rays[Math.floor(Math.random() * rays.length)]
    return {
      ray,
      a: (Math.random() - 0.5) * 2 * ray.halfWidth * 0.9,
      d: lamp.len * (0.12 + Math.random() * (fresh ? 0.1 : 0.8)),
      speed: 0.12 + Math.random() * 0.25,
      r: 0.8 + Math.random() * 1.6,
      phase: Math.random() * Math.PI * 2,
      twinkle: 0.5 + Math.random() * 1.2,
      depth: 0.2 + Math.random() * 0.5,
    }
  }

  const rayAngle = (r, t) => lamp.base + r.offset + Math.sin(t * r.swaySpeed + r.phase) * r.swayAmp

  return {
    layout(W, H) {
      w = W; h = H
      layer.width = Math.ceil(w * LS); layer.height = Math.ceil(h * LS)
      lamp.x = -w * 0.06
      lamp.y = -h * 0.28
      lamp.base = Math.atan2(h * 1.15, w * 0.7)
      lamp.len = Math.hypot(w, h) * 1.3
      buildRaySprite(); buildHaze(); buildGlow(); buildRays()
      dust = Array.from({ length: w <= 768 ? 14 : 36 }, () => makeMote(false))
      fade = lctx.createLinearGradient(0, 0, 0, layer.height)
      fade.addColorStop(0, 'rgba(0,0,0,1)')
      fade.addColorStop(0.35, 'rgba(0,0,0,0.7)')
      fade.addColorStop(0.7, 'rgba(0,0,0,0.12)')
      fade.addColorStop(1, 'rgba(0,0,0,0.03)')
    },

    draw(ctx, t, { scrollVel, still }) {
      const flicker = still ? 1 : 1 + Math.sin(t * 0.0023) * 0.035 + Math.sin(t * 0.0171) * 0.015
      const LW = layer.width, LH = layer.height
      lctx.globalCompositeOperation = 'source-over'
      lctx.clearRect(0, 0, LW, LH)
      lctx.globalCompositeOperation = 'lighter'
      for (const r of rays) {
        const pulse = still ? 1 : 0.7 + 0.3 * Math.sin(t * r.pulseSpeed + r.phase * 1.7)
        const hw = Math.tan(r.halfWidth) * lamp.len * LS
        lctx.save()
        lctx.globalAlpha = 0.24 * strength * r.bright * pulse * flicker
        lctx.translate(lamp.x * LS, lamp.y * LS)
        lctx.rotate(rayAngle(r, t))
        lctx.drawImage(raySprite, 0, -hw, raySprite.width, hw * 2)
        lctx.restore()
      }
      lctx.globalCompositeOperation = 'destination-in'
      lctx.save()
      lctx.translate(LW / 2, LH / 2)
      lctx.rotate(lamp.base)
      lctx.translate(-(t * 0.012) % 384, Math.sin(t * 0.00005) * 60)
      lctx.fillStyle = hazePattern
      lctx.fillRect(-LW * 2, -LH * 2, LW * 4, LH * 4)
      lctx.restore()
      lctx.fillStyle = fade
      lctx.fillRect(0, 0, LW, LH)

      ctx.globalCompositeOperation = 'lighter'
      ctx.drawImage(layer, 0, 0, w, h)
      const gr = Math.max(w, h) * 0.55
      ctx.globalAlpha = 0.7 * strength * flicker
      ctx.drawImage(glowSprite, lamp.x - gr, lamp.y - gr, gr * 2, gr * 2)
      ctx.globalAlpha = 1
      if (still) return

      for (const m of dust) {
        m.d += m.speed - scrollVel * m.depth * 0.5
        if (m.d > lamp.len * 0.95 || m.d < lamp.len * 0.05) Object.assign(m, makeMote(true))
        const ang = rayAngle(m.ray, t) + m.a
        const x = lamp.x + Math.cos(ang) * m.d
        const y = lamp.y + Math.sin(ang) * m.d
        if (y < -5 || y > h + 5 || x < -5 || x > w + 5) continue
        const along = 1 - m.d / lamp.len
        const vfade = 1 - Math.min(1, Math.max(0, (y / h - 0.45) / 0.5)) * 0.85
        const tw = 0.5 + 0.5 * Math.sin(m.phase + t * 0.0012 * m.twinkle)
        const a = (0.1 + 0.6 * along) * m.ray.bright * tw * vfade * (0.5 + strength * 0.5)
        if (a < 0.02) continue
        ctx.globalAlpha = a
        const mg = ctx.createRadialGradient(x, y, 0, x, y, m.r * 1.8)
        mg.addColorStop(0, rgba(tw > 0.7 ? pal.cream : pal.light, 1))
        mg.addColorStop(0.5, rgba(pal.light, 0.5))
        mg.addColorStop(1, rgba(pal.light, 0))
        ctx.fillStyle = mg
        ctx.beginPath()
        ctx.arc(x, y, m.r * 1.8, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    },
  }
}
