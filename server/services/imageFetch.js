// Bounded upstream image fetches, shared by the poster proxy and the share-card
// renderer: a timeout, a byte cap, raster image content types only (never
// JSON/HTML from a media-server API, never same-origin-scriptable SVG), and
// redirects followed by hand so a token-bearing request can't be bounced to
// another origin.

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;

class ImageFetchError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ImageFetchError';
    this.status = status;
  }
}

function isRasterImage(type) {
  return /^image\/[a-z0-9.+-]+$/.test(type) && type !== 'image/svg+xml';
}

function discard(res) {
  try { res.body?.cancel?.().catch(() => {}); } catch { /* already consumed */ }
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discard(res);
    throw new ImageFetchError('image too large');
  }
  if (!res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new ImageFetchError('image too large');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new ImageFetchError('image too large');
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/**
 * GET an image. Resolves { contentType, body: Buffer }; rejects with
 * ImageFetchError (upstream status, non-image, too large, bad redirect) or the
 * fetch/abort error. Redirects must stay on the original origin unless
 * crossOriginRedirects is set (only for token-free absolute URLs).
 */
async function fetchImage(url, { headers = {}, timeoutMs = 10000, maxBytes = DEFAULT_MAX_BYTES, crossOriginRedirects = false } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const origin = new URL(url).origin;
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { headers, signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      discard(res);
      const location = res.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS) throw new ImageFetchError('unfollowable redirect');
      const next = new URL(location, current);
      if (!/^https?:$/.test(next.protocol)) throw new ImageFetchError('redirect to a non-http URL');
      if (!crossOriginRedirects && next.origin !== origin) throw new ImageFetchError('redirect to another origin');
      current = next.href;
      continue;
    }
    if (!res.ok) {
      discard(res);
      throw new ImageFetchError(`upstream returned ${res.status}`, res.status);
    }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!isRasterImage(type)) {
      discard(res);
      throw new ImageFetchError('upstream did not return an image');
    }
    return { contentType: type, body: await readCapped(res, maxBytes) };
  }
}

module.exports = { fetchImage, ImageFetchError, DEFAULT_MAX_BYTES };
