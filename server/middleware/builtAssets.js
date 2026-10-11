const express = require('express');
const fs = require('fs');
const path = require('path');

// Vite content-hashes every file under dist/assets, so a given URL never
// changes content and can be cached for good. Without this the browser
// revalidated every chunk on every visit.
const CACHE = { maxAge: '1y', immutable: true };

// Precompressed siblings written at build time (see vite.config.js), in the
// order they are preferred.
const ENCODINGS = [['br', '.br'], ['gzip', '.gz']];

/**
 * Serves the hashed build assets, preferring the .br/.gz file written next to
 * each one when the client accepts it, and falling back to the plain file.
 * Mount at /assets.
 */
function builtAssets(dir) {
  const root = path.resolve(dir);
  const plain = express.static(root, { ...CACHE, index: false });

  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.headers['accept-encoding']) {
      return plain(req, res, next);
    }

    let file;
    try {
      file = path.join(root, decodeURIComponent(req.path));
    } catch {
      return plain(req, res, next);
    }
    if (!file.startsWith(root + path.sep)) return plain(req, res, next);

    // One at a time, so our order wins over the client's (browsers list gzip
    // before br, and negotiating both at once would follow that)
    const match = ENCODINGS.find(([enc]) => req.acceptsEncodings(enc) === enc);
    if (!match) return plain(req, res, next);
    const [encoding, ext] = match;

    fs.stat(file + ext, (err, stat) => {
      if (err || !stat.isFile()) return plain(req, res, next);
      // send() only infers a type when none is set, so this keeps the
      // original file's type rather than one for .br/.gz
      res.type(path.extname(file));
      res.setHeader('Content-Encoding', encoding);
      res.vary('Accept-Encoding');
      res.sendFile(file + ext, CACHE, (sendErr) => {
        if (sendErr && !res.headersSent) {
          res.removeHeader('Content-Encoding');
          plain(req, res, next);
        }
      });
    });
  };
}

module.exports = builtAssets;
