const zlib = require('zlib');

// Below this, compression costs more than it saves
const MIN_BYTES = 1024;

const BROTLI_OPTS = (size) => ({
  params: {
    // Quality 4 is the usual on-the-fly setting: most of the size win at a
    // small fraction of the CPU of the default 11.
    [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
  },
});

/**
 * Compresses JSON responses for clients that accept it. Recommendation and
 * explore payloads run from a few hundred KB to over 1 MB and shrink 6-8x.
 *
 * Only res.json() is wrapped (res.send(object) routes through it too), so
 * streams, server-sent events, images and files are never touched. The
 * compression itself runs on libuv's thread pool rather than the event loop.
 */
function compressJson() {
  return (req, res, next) => {
    if (!req.headers['accept-encoding']) return next();
    // Checked one at a time so brotli wins whenever it is accepted at all:
    // negotiating both at once follows the client's listing order, and
    // browsers list gzip first.
    const encoding = ['br', 'gzip'].find(enc => req.acceptsEncodings(enc) === enc);
    if (!encoding) return next();

    const json = res.json.bind(res);
    res.json = function compressedJson(obj) {
      res.vary('Accept-Encoding');
      const body = JSON.stringify(obj);
      if (body === undefined || res.getHeader('Content-Encoding')) return json(obj);
      const raw = Buffer.from(body, 'utf8');
      if (raw.length < MIN_BYTES) return json(obj);

      const done = (err, buf) => {
        if (res.headersSent) return;
        if (err) return json(obj);
        res.setHeader('Content-Encoding', encoding);
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(buf);
      };
      if (encoding === 'br') zlib.brotliCompress(raw, BROTLI_OPTS(raw.length), done);
      else zlib.gzip(raw, { level: 6 }, done);
      return res;
    };
    next();
  };
}

module.exports = compressJson;
module.exports.MIN_BYTES = MIN_BYTES;
