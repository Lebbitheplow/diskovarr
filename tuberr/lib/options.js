const { getSetting, setSetting } = require('../db');

// Admin-tunable download options, stored in the settings table and exposed
// through GET/PUT /manage/config. Booleans are stored as '1'/'0'.

const DEFAULTS = {
  writeNfo: true,       // Kodi/Jellyfin episodedetails .nfo next to the mp4
  embedMetadata: true,  // yt-dlp --embed-metadata --embed-thumbnail
  embedSubs: false,     // yt-dlp --write-subs --sub-langs en.* --embed-subs
  sponsorblock: false,  // yt-dlp --sponsorblock-remove sponsor,selfpromo
  maxConcurrent: 6,     // parallel yt-dlp processes
};

const KEYS = {
  writeNfo: 'write_nfo',
  embedMetadata: 'embed_metadata',
  embedSubs: 'embed_subs',
  sponsorblock: 'sponsorblock',
  maxConcurrent: 'max_concurrent',
};

function getOptions() {
  const out = {};
  for (const [name, key] of Object.entries(KEYS)) {
    const raw = getSetting(key, '');
    const def = DEFAULTS[name];
    if (typeof def === 'boolean') out[name] = raw === '' ? def : raw === '1';
    else out[name] = raw === '' || !Number.isFinite(Number(raw)) ? def : Number(raw);
  }
  return out;
}

function setOptions(partial) {
  for (const [name, key] of Object.entries(KEYS)) {
    if (partial[name] === undefined) continue;
    const def = DEFAULTS[name];
    if (typeof def === 'boolean') {
      setSetting(key, partial[name] === true || partial[name] === '1' || partial[name] === 'true' ? '1' : '0');
    } else {
      const n = Number(partial[name]);
      setSetting(key, Number.isFinite(n) && n > 0 ? String(Math.round(n)) : String(def));
    }
  }
  return getOptions();
}

module.exports = { getOptions, setOptions, DEFAULTS };
