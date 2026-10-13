const fs = require('fs');
const path = require('path');
const config = require('../config');

// Filesystem containment for everything Tuberr writes. Release names arrive
// in uploaded .torrent metadata and categories/save paths through the
// qBittorrent API, and both end up as directory/file names — so names must be
// a single safe path segment, and every write destination must resolve
// (through symlinks) strictly inside config.downloadsDir.

// Encoded separators/NUL are harmless to the kernel but rejected anyway: no
// legitimate release name contains them, and something downstream might decode.
const ENCODED_UNSAFE_RE = /%(?:2f|5c|00)/i;

function hasControlChars(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// One path segment: no separators, no NUL/control chars, no dot segments or
// hidden names. Spaces, brackets and unicode are fine (Sonarr release names).
function isSafeSegment(name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (hasControlChars(name) || ENCODED_UNSAFE_RE.test(name)) return false;
  if (name.startsWith('.')) return false; // '.', '..' and hidden files
  return true;
}

// qBittorrent category names become a directory under the downloads dir.
// Sonarr's default is 'tv-sonarr' (ours 'tv-youtube'); keep to a plain charset.
const CATEGORY_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
function isSafeCategory(name) {
  return typeof name === 'string' && CATEGORY_RE.test(name);
}

// Canonical form of p: the deepest existing ancestor is resolved through
// symlinks (fs.realpath) and the not-yet-created remainder appended lexically.
function resolveReal(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(current);
      if (parent === current) throw e;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// True when p resolves strictly inside the downloads dir (or is the dir
// itself, with allowRoot). Any resolution error counts as outside.
function isInsideDownloads(p, { allowRoot = false } = {}) {
  if (!p || typeof p !== 'string') return false;
  try {
    const root = resolveReal(config.downloadsDir);
    const target = resolveReal(p);
    if (target === root) return allowRoot;
    return target.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

function assertInsideDownloads(p, what = 'path') {
  if (!isInsideDownloads(p)) throw new Error(`${what} resolves outside the downloads dir: ${p}`);
  return p;
}

module.exports = { isSafeSegment, isSafeCategory, resolveReal, isInsideDownloads, assertInsideDownloads };
