// Kodi-style episodedetails NFO, built from yt-dlp's info json. Jellyfin
// reads it natively; Plex needs its XBMCnfo agent. Keeps the YouTube id as a
// uniqueid so scanners can link back to the source.

function xmlEscape(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// yt-dlp upload_date is "YYYYMMDD"
function isoDate(uploadDate) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(uploadDate || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

// meta (from Tuberr's own records) wins over whatever the video is called.
function fromInfoJson(info = {}, meta = {}) {
  return {
    title: meta.title || info.title || '',
    showTitle: meta.showTitle || info.channel || info.uploader || '',
    season: meta.season != null ? Number(meta.season) : null,
    episode: meta.episode != null ? Number(meta.episode) : null,
    plot: info.description || '',
    aired: isoDate(info.upload_date) || (info.release_date ? isoDate(info.release_date) : ''),
    runtimeMin: info.duration > 0 ? Math.round(info.duration / 60) : null,
    thumb: info.thumbnail || '',
    videoId: info.id || meta.videoId || '',
  };
}

function buildEpisodeNfo(fields) {
  const lines = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<episodedetails>'];
  const tag = (name, value) => {
    if (value === null || value === undefined || value === '') return;
    lines.push(`  <${name}>${xmlEscape(value)}</${name}>`);
  };
  tag('title', fields.title);
  tag('showtitle', fields.showTitle);
  tag('season', fields.season);
  tag('episode', fields.episode);
  tag('plot', fields.plot);
  tag('aired', fields.aired);
  tag('runtime', fields.runtimeMin);
  tag('thumb', fields.thumb);
  if (fields.videoId) lines.push(`  <uniqueid type="youtube" default="true">${xmlEscape(fields.videoId)}</uniqueid>`);
  lines.push('</episodedetails>', '');
  return lines.join('\n');
}

module.exports = { fromInfoJson, buildEpisodeNfo, isoDate };
