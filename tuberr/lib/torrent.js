const crypto = require('crypto');
const bencode = require('./bencode');

const PIECE_LENGTH = 16 * 1024 * 1024;
const SOURCE_PREFIX = 'tuberr:yt:';

// Builds a syntactically valid single-file .torrent that no client could ever
// download (invalid tracker, synthetic pieces). It only exists so Sonarr can
// grab a "release" and hand it back to our fake qBittorrent, which recovers
// the videoId from info.source. Piece bytes are derived from the videoId so
// the same (videoId, title, size) always yields the same infohash.
function buildTorrent({ releaseTitle, sizeBytes, videoId }) {
  const numPieces = Math.max(1, Math.ceil(sizeBytes / PIECE_LENGTH));
  const pieces = Buffer.concat(
    Array.from({ length: numPieces }, (_, i) =>
      crypto.createHash('sha1').update(`${videoId}:${i}`).digest())
  );
  const torrent = {
    announce: 'http://tracker.tuberr.invalid/announce',
    'creation date': 0,
    info: {
      length: sizeBytes,
      name: releaseTitle,
      'piece length': PIECE_LENGTH,
      pieces,
      source: SOURCE_PREFIX + videoId,
    },
  };
  const buffer = bencode.encode(torrent);
  return { buffer, infoHash: bencode.infoHashOf(buffer) };
}

function parseTorrent(buffer) {
  const { value, infoRange } = bencode.decode(buffer);
  if (!infoRange || !value.info) throw new Error('not a torrent: missing info dict');
  const infoHash = crypto.createHash('sha1')
    .update(buffer.subarray(infoRange[0], infoRange[1]))
    .digest('hex');
  const source = value.info.source ? value.info.source.toString('utf8') : '';
  return {
    infoHash,
    name: value.info.name ? value.info.name.toString('utf8') : '',
    size: Number(value.info.length) || 0,
    videoId: source.startsWith(SOURCE_PREFIX) ? source.slice(SOURCE_PREFIX.length) : null,
  };
}

module.exports = { buildTorrent, parseTorrent, PIECE_LENGTH };
