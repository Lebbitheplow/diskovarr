'use strict';

// Adds DUMB's symlink library folders to Plex libraries and applies the
// per-library / server scan settings that work best on a debrid mount.
//
// Why these settings: a debrid (rclone) mount is slow to open files, so every
// background analysis pass (intro/credits/voice detection, preview thumbnails)
// hammers the mount for hours and can stall playback. Movies keep credits +
// voice detection (cheap enough, one file each); TV disables them. Video
// preview thumbnails are off everywhere. "Empty trash automatically" is OFF
// because a mount hiccup would otherwise delete the whole library from Plex.
// Partial scans on change plus a 30-minute scheduled scan keep new symlinks
// appearing promptly without a full nightly crawl.

const db = require('../db/database');

const RECOMMENDED_LIBRARY_PREFS = {
  movie: {
    enableBIFGeneration: '0',            // Video preview thumbnails
    enableCreditsMarkerGeneration: '1',  // Credits detection
    enableVoiceActivityGeneration: '1',  // Voice activity detection
    enableAdMarkerGeneration: '1',
    ratingsSource: 'rottentomatoes',
    collectionMode: '2',
  },
  show: {
    enableBIFGeneration: '0',
    enableIntroMarkerGeneration: '0',    // Intro detection
    enableCreditsMarkerGeneration: '0',  // Credits detection
    enableVoiceActivityGeneration: '0',
    enableAdMarkerGeneration: '1',
    useLocalAssets: '0',
    showOrdering: 'aired',
    collectionMode: '2',
  },
};

const RECOMMENDED_SERVER_PREFS = {
  FSEventLibraryUpdatesEnabled: '1',     // Scan my library automatically
  FSEventLibraryPartialScanEnabled: '1', // Run a partial scan when changes are detected
  ScheduledLibraryUpdatesEnabled: '1',   // Scan my library periodically
  ScheduledLibraryUpdateInterval: '1800',// every 30 minutes
  autoEmptyTrash: '0',                   // Empty trash automatically after every scan — OFF
  ButlerTaskRefreshLibraries: '1',
};

const LIBRARY_DEFAULTS = {
  movie: { agent: 'tv.plex.agents.movie', scanner: 'Plex Movie', language: 'en-US', name: 'Movies' },
  show: { agent: 'tv.plex.agents.series', scanner: 'Plex TV Series', language: 'en-US', name: 'TV Shows' },
};

const PLEX_HEADERS = {
  Accept: 'application/json',
  'X-Plex-Client-Identifier': 'diskovarr-app',
  'X-Plex-Product': 'Diskovarr',
};

function plexBase() {
  const url = db.getSetting('plex_url', '') || process.env.PLEX_URL || '';
  const token = db.getSetting('plex_token', '') || process.env.PLEX_TOKEN || '';
  if (!url || !token) throw new Error('Plex is not configured in Admin → Connections');
  return { url: url.replace(/\/$/, ''), token };
}

async function plexCall(method, path, params = []) {
  const { url, token } = plexBase();
  const qs = new URLSearchParams(params);
  qs.append('X-Plex-Token', token);
  const res = await fetch(`${url}${path}?${qs.toString()}`, {
    method, headers: PLEX_HEADERS, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Plex ${method} ${path} → ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ── Reads ──────────────────────────────────────────────────────────────────────

async function listLibraries() {
  const json = await plexCall('GET', '/library/sections');
  const dirs = json?.MediaContainer?.Directory || [];
  return dirs
    .filter(s => s.type === 'movie' || s.type === 'show')
    .map(s => ({
      id: String(s.key),
      title: s.title,
      type: s.type,
      agent: s.agent,
      scanner: s.scanner,
      language: s.language,
      locations: (s.Location || []).map(l => l.path),
    }));
}

async function getLibraryPrefs(sectionId) {
  const json = await plexCall('GET', `/library/sections/${sectionId}/prefs`);
  const out = {};
  for (const p of json?.MediaContainer?.Setting || []) out[p.id] = String(p.value);
  return out;
}

// Plex's own directory browser — proves the path exists *from Plex's point of
// view* (host path for a native install, container path for a Docker Plex).
async function pathVisibleToPlex(path) {
  try {
    const json = await plexCall('GET', '/services/browse', [['path', path], ['includeFiles', '0']]);
    return !!json?.MediaContainer;
  } catch {
    return false;
  }
}

// ── Writes ─────────────────────────────────────────────────────────────────────

async function addLocation(sectionId, path) {
  const libs = await listLibraries();
  const lib = libs.find(l => l.id === String(sectionId));
  if (!lib) throw new Error(`Plex library ${sectionId} not found`);
  if (lib.locations.includes(path)) return { added: false, locations: lib.locations };
  // PUT replaces the location set, so resend the existing ones plus the new one.
  const params = [...lib.locations, path].map(p => ['location', p]);
  await plexCall('PUT', `/library/sections/${sectionId}`, params);
  return { added: true, locations: [...lib.locations, path] };
}

async function applyLibraryPrefs(sectionId, type) {
  const prefs = RECOMMENDED_LIBRARY_PREFS[type];
  if (!prefs) throw new Error(`No recommended prefs for library type '${type}'`);
  const current = await getLibraryPrefs(sectionId);
  // Only send keys the library actually exposes; Plex 400s on unknown ids.
  const params = Object.entries(prefs).filter(([k]) => k in current);
  if (params.length) await plexCall('PUT', `/library/sections/${sectionId}/prefs`, params);
  return Object.fromEntries(params);
}

async function applyServerPrefs() {
  await plexCall('PUT', '/:/prefs', Object.entries(RECOMMENDED_SERVER_PREFS));
  return { ...RECOMMENDED_SERVER_PREFS };
}

async function createLibrary(type, path, name) {
  const d = LIBRARY_DEFAULTS[type];
  if (!d) throw new Error(`Unsupported library type '${type}'`);
  await plexCall('POST', '/library/sections', [
    ['name', name || d.name], ['type', type], ['agent', d.agent],
    ['scanner', d.scanner], ['language', d.language], ['location', path],
  ]);
  const libs = await listLibraries();
  return libs.find(l => l.locations.includes(path) && l.type === type) || null;
}

async function scanLibrary(sectionId) {
  await plexCall('GET', `/library/sections/${sectionId}/refresh`);
}

// Full pass for one media type: attach (or create) the library, apply the
// recommended per-library settings, kick a scan.
async function setupLibrary({ type, path, sectionId, createName }) {
  const steps = [];
  let lib = null;
  if (sectionId) {
    const r = await addLocation(sectionId, path);
    steps.push({ step: 'location', added: r.added });
    lib = { id: String(sectionId) };
  } else {
    lib = await createLibrary(type, path, createName);
    if (!lib) throw new Error(`Plex did not report the new ${type} library`);
    steps.push({ step: 'create', id: lib.id });
  }
  const applied = await applyLibraryPrefs(lib.id, type);
  steps.push({ step: 'prefs', applied });
  await scanLibrary(lib.id);
  steps.push({ step: 'scan' });
  return { sectionId: lib.id, steps };
}

// Human-readable fallback when the admin prefers to do it by hand.
function instructions(paths) {
  const moviePrefs = Object.entries(RECOMMENDED_LIBRARY_PREFS.movie);
  const showPrefs = Object.entries(RECOMMENDED_LIBRARY_PREFS.show);
  const label = (k, v) => `${k} = ${v}`;
  return {
    folders: [
      { type: 'movie', path: paths.movies, library: 'your Movies library' },
      { type: 'show', path: paths.shows, library: 'your TV Shows library' },
    ],
    libraryPrefs: {
      movie: moviePrefs.map(([k, v]) => label(k, v)),
      show: showPrefs.map(([k, v]) => label(k, v)),
    },
    serverPrefs: Object.entries(RECOMMENDED_SERVER_PREFS).map(([k, v]) => label(k, v)),
    notes: [
      'Plex must see the folder at exactly this path. If Plex runs in Docker, mount the DUMB "mnt/debrid" folder into the Plex container at the same path DUMB uses (/mnt/debrid) so symlink targets resolve.',
      'Leave "Empty trash automatically after every scan" OFF — a mount hiccup would otherwise wipe the library.',
      'Keep video preview thumbnails off; intro/credits detection is fine for movies but off for TV to spare the debrid mount.',
    ],
  };
}

module.exports = {
  RECOMMENDED_LIBRARY_PREFS, RECOMMENDED_SERVER_PREFS, LIBRARY_DEFAULTS,
  listLibraries, getLibraryPrefs, pathVisibleToPlex,
  addLocation, applyLibraryPrefs, applyServerPrefs, createLibrary, scanLibrary,
  setupLibrary, instructions,
};
