import { rgba, mix, seeded, makeCanvas } from './palette'

// Atmospheric theatre ceiling, after the 1920s picture palaces: a deep sky of
// faintly twinkling stars with slow cloud wisps drifting across, the way a
// Brenograph projected them over the auditorium. Stars gather toward the top
// ("the ceiling") and thin out down the page; clouds carry the velvet and
// accent tones. A rare, faint shooting star crosses now and then.
export default function createSky(pal) {
  let w = 0, h = 0
  let stars = [], clouds = [], cloudSprites = [], starSprites = {}
  let skyGlow = null
  let shoot = null, nextShoot = 0

  const smooth = x => x * x * (3 - 2 * x)

  // Value-noise fBm on a small lattice; plenty for soft cloud shapes
  function noiseField(seed, gw, gh) {
    const rnd = seeded(seed)
    const g = Array.from({ length: (gw + 1) * (gh + 1) }, () => rnd())
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y)
      const xf = smooth(x - xi), yf = smooth(y - yi)
      const at = (i, j) => g[((j % gh) * (gw + 1)) + (i % gw)]
      const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1)
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf
    }
  }

  function buildCloud(seed) {
    const CW = 360, CH = 120
    const cv = makeCanvas(CW, CH)
    const c = cv.getContext('2d')
    const img = c.createImageData(CW, CH)
    const d = img.data
    const octs = [noiseField(seed, 16, 8), noiseField(seed + 1, 16, 8), noiseField(seed + 2, 16, 8), noiseField(seed + 3, 16, 8)]
    const hi = mix(pal.light, pal.cream, 0.3)
    for (let y = 0; y < CH; y++) {
      const yn = y / CH
      for (let x = 0; x < CW; x++) {
        const xn = x / CW
        // Stretched horizontally so the shapes read as wisps, not puffs
        let n = 0, amp = 0.55, fx = xn * 3.2, fy = yn * 2.2
        for (const o of octs) { n += o(fx % 16, fy % 8) * amp; amp *= 0.5; fx *= 2; fy *= 2 }
        const ex = (xn - 0.5) / 0.42, ey = (yn - 0.5) / 0.3
        const env = Math.exp(-(ex * ex + ey * ey) * 1.6)
        const v = n * env
        const a = Math.max(0, Math.min(1, (v - 0.16) / 0.42))
        if (a <= 0) continue
        // Lit from above: top edges pick up the accent light, bellies stay velvet
        const lit = Math.max(0, Math.min(1, (0.55 - yn) * 1.4 + (n - 0.45)))
        const col = mix(pal.velvet, hi, lit)
        const i = (y * CW + x) * 4
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]
        d[i + 3] = Math.round(smooth(a) * 255)
      }
    }
    c.putImageData(img, 0, 0)
    return cv
  }

  function buildStarSprite(col) {
    const R = 16
    const cv = makeCanvas(R * 2, R * 2)
    const c = cv.getContext('2d')
    const g = c.createRadialGradient(R, R, 0, R, R, R)
    g.addColorStop(0, rgba(col, 1))
    g.addColorStop(0.12, rgba(col, 0.85))
    g.addColorStop(0.35, rgba(col, 0.18))
    g.addColorStop(1, rgba(col, 0))
    c.fillStyle = g
    c.fillRect(0, 0, R * 2, R * 2)
    return cv
  }

  function makeCloud(rnd, initial) {
    const scale = (w <= 768 ? 1.4 : 2.2) + rnd() * 1.4
    const cw = 360 * scale
    return {
      sprite: cloudSprites[Math.floor(rnd() * cloudSprites.length)],
      x: initial ? rnd() * (w + cw) - cw : -cw,
      y: h * (0.02 + rnd() * 0.5) - 60 * scale,
      scale,
      speed: 0.004 + rnd() * 0.008,   // px per ms: a slow Brenograph drift
      alpha: 0.07 + rnd() * 0.08,
      flip: rnd() < 0.5,
    }
  }

  return {
    layout(W, H) {
      w = W; h = H
      const rnd = seeded(29)
      if (!cloudSprites.length) cloudSprites = [101, 211, 307].map(buildCloud)
      starSprites = { cream: buildStarSprite(pal.cream), tint: buildStarSprite(mix(pal.accent, pal.cream, 0.45)) }
      const n = Math.round((w * h) / (w <= 768 ? 5200 : 7800))
      stars = Array.from({ length: n }, () => {
        const big = rnd() < 0.06
        return {
          x: rnd() * w,
          y: h * Math.pow(rnd(), 1.5),                // gathered toward the ceiling
          r: big ? 1.3 + rnd() * 0.9 : 0.45 + Math.pow(rnd(), 2) * 0.8,
          base: big ? 0.45 + rnd() * 0.3 : 0.14 + Math.pow(rnd(), 2) * 0.36,
          tw: 0.00035 + rnd() * 0.0012,
          depth: 0.25 + rnd() * 0.6,
          amp: 0.25 + rnd() * 0.6,
          phase: rnd() * Math.PI * 2,
          tint: rnd() < 0.3,
        }
      })
      clouds = Array.from({ length: w <= 768 ? 3 : 5 }, () => makeCloud(rnd, true))
      skyGlow = null
      nextShoot = 0
    },

    draw(ctx, t, { dt, scrollVel, still }) {
      // Faint velvet wash across the ceiling
      if (!skyGlow) {
        skyGlow = ctx.createLinearGradient(0, 0, 0, h * 0.6)
        skyGlow.addColorStop(0, rgba(pal.velvet, 0.14))
        skyGlow.addColorStop(1, rgba(pal.velvet, 0))
      }
      ctx.fillStyle = skyGlow
      ctx.fillRect(0, 0, w, h * 0.6)

      // Clouds, additive like projected light
      ctx.globalCompositeOperation = 'lighter'
      const rnd = Math.random
      for (const c of clouds) {
        if (!still) {
          c.x += c.speed * dt
          if (c.x > w) Object.assign(c, makeCloud(seeded(Math.floor(t) + 1), false), { sprite: c.sprite })
        }
        const cw = 360 * c.scale, ch = 120 * c.scale
        const vf = 1 - Math.min(1, Math.max(0, (c.y / h - 0.3) / 0.4)) * 0.7
        ctx.globalAlpha = c.alpha * vf
        if (c.flip) {
          ctx.save(); ctx.translate(c.x + cw, c.y); ctx.scale(-1, 1)
          ctx.drawImage(c.sprite, 0, 0, cw, ch)
          ctx.restore()
        } else {
          ctx.drawImage(c.sprite, c.x, c.y, cw, ch)
        }
      }

      // Stars
      for (const s of stars) {
        if (!still) {
          s.y -= scrollVel * s.depth * 0.25
          if (s.y < -4) s.y += h + 8
          if (s.y > h + 4) s.y -= h + 8
        }
        const tw = still ? 1 : 1 - s.amp * 0.5 * (1 + Math.sin(t * s.tw + s.phase))
        const vfade = 1 - Math.min(1, Math.max(0, (s.y / h - 0.35) / 0.6)) * 0.85
        const a = s.base * tw * vfade
        if (a < 0.02) continue
        const R = s.r * 5
        ctx.globalAlpha = a
        ctx.drawImage(s.tint ? starSprites.tint : starSprites.cream, s.x - R, s.y - R, R * 2, R * 2)
      }

      // A rare shooting star
      if (!still) {
        if (!nextShoot) nextShoot = t + 20000 + rnd() * 30000
        if (!shoot && t > nextShoot) {
          const ang = Math.PI * (0.78 + rnd() * 0.1)
          shoot = { x: w * (0.3 + rnd() * 0.6), y: h * (0.03 + rnd() * 0.2), ang, len: 140 + rnd() * 90, start: t, dur: 950 }
        }
        if (shoot) {
          const p = (t - shoot.start) / shoot.dur
          if (p >= 1) { shoot = null; nextShoot = t + 45000 + rnd() * 45000 }
          else {
            const travel = 260 * p
            const hx = shoot.x + Math.cos(shoot.ang) * travel, hy = shoot.y + Math.sin(shoot.ang) * travel
            const tx = hx - Math.cos(shoot.ang) * shoot.len, ty = hy - Math.sin(shoot.ang) * shoot.len
            const g = ctx.createLinearGradient(tx, ty, hx, hy)
            g.addColorStop(0, rgba(pal.light, 0))
            g.addColorStop(1, rgba(pal.cream, 0.55))
            ctx.globalAlpha = Math.sin(Math.PI * p)
            ctx.strokeStyle = g
            ctx.lineWidth = 1.2
            ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke()
          }
        }
      }
      ctx.globalAlpha = 1
    },
  }
}
