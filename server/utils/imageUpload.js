const express = require('express');

// Image uploads that arrive as base64 data URIs inside a JSON body (the
// Discord bot avatar). The global express.json() keeps its small default
// limit; routes taking an image get their own parser sized to the image cap.

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// File signatures, checked against the decoded bytes rather than trusting the
// data URI's declared MIME type.
const SIGNATURES = [
  { mime: 'image/png', test: (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  { mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)) },
  { mime: 'image/webp', test: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

function detectImageType(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const hit = SIGNATURES.find(s => s.test(buf));
  return hit ? hit.mime : null;
}

const LABELS = { 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/gif': 'GIF', 'image/webp': 'WebP' };

function describeTypes(allowed) {
  const names = allowed.map(m => LABELS[m] || m);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}` : names[0];
}

function formatMb(bytes) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Validates an image data URI. Returns { ok: true, mime, bytes, dataUri } with
 * the URI rebuilt around the detected type (a PNG saved as .jpg still gets
 * served as image/png), or { ok: false, status, error } ready to send.
 */
function parseImageDataUri(dataUri, { maxBytes = AVATAR_MAX_BYTES, allowed = ['image/png', 'image/jpeg', 'image/gif'] } = {}) {
  const typeList = describeTypes(allowed);
  if (typeof dataUri !== 'string' || !dataUri) {
    return { ok: false, status: 400, error: 'imageDataUri required' };
  }
  // The declared type isn't trusted either way (a file picked without an
  // extension arrives as application/octet-stream); the bytes decide below.
  const match = dataUri.match(/^data:[^;,]*;base64,/i);
  if (!match) return { ok: false, status: 400, error: `Must be a ${typeList} image` };
  const payload = dataUri.slice(match[0].length);
  // Buffer.from() silently skips characters outside the alphabet, so check the
  // shape first or a corrupt upload would decode to garbage and be accepted.
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    return { ok: false, status: 400, error: 'Image data is not valid base64' };
  }
  // Decoded size, computed before decoding anything
  const bytes = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  if (bytes > maxBytes) {
    return { ok: false, status: 413, error: `Image exceeds the ${formatMb(maxBytes)} limit` };
  }
  const buf = Buffer.from(payload, 'base64');
  const mime = detectImageType(buf);
  if (!mime || !allowed.includes(mime)) {
    return { ok: false, status: 400, error: `File is not a ${typeList} image` };
  }
  return { ok: true, mime, bytes: buf.length, dataUri: `data:${mime};base64,${payload}` };
}

/**
 * JSON body parser for one route that carries a base64 image of up to
 * maxBytes. Base64 inflates by 4/3; the slack covers the data URI prefix and
 * the other JSON fields. Parser failures come back as JSON so the admin UI can
 * show the message instead of express's HTML error page.
 */
function imageJsonParser(maxBytes = AVATAR_MAX_BYTES) {
  const parse = express.json({ limit: Math.ceil(maxBytes / 3) * 4 + 64 * 1024 });
  return (req, res, next) => parse(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: `Image exceeds the ${formatMb(maxBytes)} limit` });
    }
    return res.status(err.status || 400).json({ error: 'Malformed upload body' });
  });
}

/**
 * The app-wide JSON parser (default 100 KB limit), leaving POST bodies to
 * `uploadPath` unread so that route can run its auth check before its own,
 * larger imageJsonParser. Matches the path the way Express routes do (any
 * case, optional trailing slash).
 */
function jsonParserExcept(uploadPath) {
  const parse = express.json();
  const escaped = uploadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const skip = new RegExp(`^${escaped}/?$`, 'i');
  return (req, res, next) => (req.method === 'POST' && skip.test(req.path) ? next() : parse(req, res, next));
}

module.exports = { AVATAR_MAX_BYTES, detectImageType, parseImageDataUri, imageJsonParser, jsonParserExcept };
