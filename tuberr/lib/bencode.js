const crypto = require('crypto');

// Minimal bencode. Encoding sorts dict keys (spec requirement) so output is
// deterministic; decoding tracks byte offsets so the raw `info` dict bytes can
// be extracted verbatim — Sonarr computes the infohash from those exact bytes,
// so we must hash what is actually serialized, never a re-encoding.

function encode(value) {
  const chunks = [];
  encodeInto(value, chunks);
  return Buffer.concat(chunks);
}

function encodeInto(value, chunks) {
  if (Buffer.isBuffer(value)) {
    chunks.push(Buffer.from(`${value.length}:`), value);
  } else if (typeof value === 'string') {
    const buf = Buffer.from(value, 'utf8');
    chunks.push(Buffer.from(`${buf.length}:`), buf);
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('bencode: only integers supported');
    chunks.push(Buffer.from(`i${value}e`));
  } else if (Array.isArray(value)) {
    chunks.push(Buffer.from('l'));
    for (const item of value) encodeInto(item, chunks);
    chunks.push(Buffer.from('e'));
  } else if (value && typeof value === 'object') {
    chunks.push(Buffer.from('d'));
    for (const key of Object.keys(value).sort()) {
      encodeInto(key, chunks);
      encodeInto(value[key], chunks);
    }
    chunks.push(Buffer.from('e'));
  } else {
    throw new Error(`bencode: unsupported type ${typeof value}`);
  }
}

function decode(buffer) {
  const state = { buf: buffer, pos: 0, infoRange: null };
  const value = decodeValue(state, false);
  return { value, infoRange: state.infoRange };
}

function decodeValue(state, insideInfo) {
  const { buf } = state;
  const c = buf[state.pos];
  if (c === 0x69) { // 'i'
    const end = buf.indexOf(0x65, state.pos); // 'e'
    if (end === -1) throw new Error('bencode: unterminated integer');
    const num = Number(buf.subarray(state.pos + 1, end).toString('ascii'));
    state.pos = end + 1;
    return num;
  }
  if (c === 0x6c) { // 'l'
    state.pos++;
    const list = [];
    while (buf[state.pos] !== 0x65) list.push(decodeValue(state, insideInfo));
    state.pos++;
    return list;
  }
  if (c === 0x64) { // 'd'
    state.pos++;
    const dict = {};
    while (buf[state.pos] !== 0x65) {
      const key = decodeValue(state, insideInfo).toString('utf8');
      if (key === 'info' && !insideInfo && !state.infoRange) {
        const start = state.pos;
        dict[key] = decodeValue(state, true);
        state.infoRange = [start, state.pos];
      } else {
        dict[key] = decodeValue(state, insideInfo);
      }
    }
    state.pos++;
    return dict;
  }
  if (c >= 0x30 && c <= 0x39) { // digit → string
    const colon = buf.indexOf(0x3a, state.pos); // ':'
    if (colon === -1) throw new Error('bencode: malformed string length');
    const len = Number(buf.subarray(state.pos, colon).toString('ascii'));
    const start = colon + 1;
    state.pos = start + len;
    return buf.subarray(start, state.pos);
  }
  throw new Error(`bencode: unexpected byte 0x${c?.toString(16)} at ${state.pos}`);
}

function infoHashOf(torrentBuffer) {
  const { infoRange } = decode(torrentBuffer);
  if (!infoRange) throw new Error('bencode: torrent has no info dict');
  return crypto.createHash('sha1')
    .update(torrentBuffer.subarray(infoRange[0], infoRange[1]))
    .digest('hex');
}

module.exports = { encode, decode, infoHashOf };
