/**
 * Generates a 128×128 PNG avatar with the Diskovarr logo in the accent colour
 * on a solid black background, for use as the Discord bot avatar.
 * Pure Node.js — no native addons required.
 */
const zlib = require('zlib');

// ── CRC32 ──────────────────────────────────────────────────────────────────────
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crcBuf]);
}

function encodePng(pixels, W, H) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth=8, colour type=RGBA
  // Scanlines: 1 filter byte + W*4 RGBA bytes per row
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // None filter
    for (let x = 0; x < W; x++) {
      const si = y * (1 + W * 4) + 1 + x * 4;
      const pi = (y * W + x) * 4;
      raw[si] = pixels[pi]; raw[si + 1] = pixels[pi + 1];
      raw[si + 2] = pixels[pi + 2]; raw[si + 3] = pixels[pi + 3];
    }
  }
  return Buffer.concat([SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── Pixel helpers ──────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  hex = (hex || 'e5a00d').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function setPixelAlpha(pixels, W, x, y, alpha, lr, lg, lb) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= W) return;
  const i = (y * W + x) * 4;
  const a = alpha / 255;
  pixels[i]     = Math.min(255, Math.round(lr * a + pixels[i]     * (1 - a)));
  pixels[i + 1] = Math.min(255, Math.round(lg * a + pixels[i + 1] * (1 - a)));
  pixels[i + 2] = Math.min(255, Math.round(lb * a + pixels[i + 2] * (1 - a)));
  pixels[i + 3] = 255;
}

// Draw the Diskovarr SVG logo (viewBox 0 0 24 24) scaled to WxW canvas, in the given colour
function drawLogo(pixels, W, lr, lg, lb) {
  const S = W / 24;

  function fillRect(sx, sy, sw, sh) {
    for (let py = Math.round(sy * S); py < Math.round((sy + sh) * S); py++)
      for (let px = Math.round(sx * S); px < Math.round((sx + sw) * S); px++)
        setPixelAlpha(pixels, W, px, py, 255, lr, lg, lb);
  }

  function strokeCircle(cx, cy, r, sw) {
    const outer = (r + sw / 2) * S, inner = (r - sw / 2) * S;
    const pcx = cx * S, pcy = cy * S;
    for (let py = Math.floor(pcy - outer - 2); py <= Math.ceil(pcy + outer + 2); py++)
      for (let px = Math.floor(pcx - outer - 2); px <= Math.ceil(pcx + outer + 2); px++) {
        const d = Math.sqrt((px - pcx) ** 2 + (py - pcy) ** 2);
        if (d <= outer && d >= inner) setPixelAlpha(pixels, W, px, py, 255, lr, lg, lb);
      }
  }

  function strokeLine(x1, y1, x2, y2, sw) {
    const px1 = x1 * S, py1 = y1 * S, px2 = x2 * S, py2 = y2 * S;
    const psw = sw * S;
    const dx = px2 - px1, dy = py2 - py1, len = Math.sqrt(dx * dx + dy * dy);
    const nx = -dy / len, ny = dx / len;
    const steps = Math.ceil(len * 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = px1 + dx * t, cy = py1 + dy * t;
      for (let w = -psw / 2; w <= psw / 2; w += 0.5)
        setPixelAlpha(pixels, W, cx + nx * w, cy + ny * w, 255, lr, lg, lb);
    }
  }

  // Baseline bar
  fillRect(0.5, 17.5, 13, 1.5);
  // Bar 1 (tallest)
  fillRect(1, 8.5, 2.5, 9);
  // Bar 2 (medium)
  fillRect(4.5, 11, 3, 6.5);
  // Bar 3 (short)
  fillRect(8.5, 10, 2.5, 7.5);
  // Search circle
  strokeCircle(15, 9, 5, 2);
  // Magnifier handle
  strokeLine(18.5, 12.5, 22, 16, 2.5);
}

// ── Cache + public API ─────────────────────────────────────────────────────────
const _cache = new Map();

function generateAvatar(hexColor) {
  const key = (hexColor || 'e5a00d').toLowerCase().replace('#', '');
  if (_cache.has(key)) return _cache.get(key);

  const W = 128;
  const [r, g, b] = hexToRgb(key);
  const pixels = new Uint8Array(W * W * 4);

  // Fill background black
  for (let i = 0; i < W * W; i++) {
    pixels[i * 4] = 0; pixels[i * 4 + 1] = 0;
    pixels[i * 4 + 2] = 0; pixels[i * 4 + 3] = 255;
  }

  // Draw logo in accent colour
  drawLogo(pixels, W, r, g, b);

  const png = encodePng(pixels, W, W);
  const result = { png, dataUri: 'data:image/png;base64,' + png.toString('base64') };
  _cache.set(key, result);
  return result;
}

module.exports = { generateAvatar };
