// Tiny multipart/form-data parser — enough for Sonarr's torrents/add upload
// (a few small fields + one .torrent file). Avoids pulling in multer/busboy.

function parse(bodyBuffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return { fields: {}, files: [] };
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);

  const fields = {};
  const files = [];
  let pos = bodyBuffer.indexOf(boundary);
  while (pos !== -1) {
    const partStart = pos + boundary.length;
    // final boundary is followed by '--'
    if (bodyBuffer.subarray(partStart, partStart + 2).toString('ascii') === '--') break;
    const next = bodyBuffer.indexOf(boundary, partStart);
    if (next === -1) break;
    // part = \r\n headers \r\n\r\n content \r\n
    const part = bodyBuffer.subarray(partStart + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headers);
      const filenameMatch = /filename="([^"]*)"/i.exec(headers);
      const name = nameMatch ? nameMatch[1] : '';
      if (filenameMatch) {
        files.push({ name, filename: filenameMatch[1], data: content });
      } else {
        fields[name] = content.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

module.exports = { parse };
