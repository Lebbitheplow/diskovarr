'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const logger = require('../services/logger');
const { parseQuality, parseCodec, parseSizeMb, isSeasonPack, extractInfohash } = require('../services/torrentParser');

// ── TMDB helpers for imdb_id lookups ─────────────────────────────────────────

async function getImdbId(tmdbId, mediaType) {
  const apiKey = db.getSetting('tmdb_api_key', null) || process.env.TMDB_API_KEY || null;
  if (!apiKey) throw new Error('TMDB API key not configured');
  const BASE = 'https://api.themoviedb.org/3';
  if (mediaType === 'movie') {
    const res = await fetch(`${BASE}/movie/${tmdbId}?api_key=${apiKey}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    const data = await res.json();
    return data.imdb_id || null;
  } else {
    const res = await fetch(`${BASE}/tv/${tmdbId}/external_ids?api_key=${apiKey}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    const data = await res.json();
    return data.imdb_id || null;
  }
}

// ── Config helpers ────────────────────────────────────────────────────────────

const RIVEN_SETTINGS_PATH = '/home/lebbi/docker/DUMB/data/riven/settings.json';

function getRivenConfig() {
  return {
    url: db.getSetting('riven_url', 'http://127.0.0.1:8082'),
    apiKey: db.getSetting('riven_api_key', ''),
    rdApiKey: db.getSetting('riven_rd_api_key', ''),
  };
}

// Auto-read RD api key from Riven's settings.json as fallback
function getRdApiKey() {
  const stored = db.getSetting('riven_rd_api_key', '');
  if (stored) return stored;
  try {
    const raw = fs.readFileSync(RIVEN_SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    return settings?.downloaders?.real_debrid?.api_key || '';
  } catch {
    return '';
  }
}

// Auto-read Riven API key from settings.json as fallback
function getRivenApiKey() {
  const stored = db.getSetting('riven_api_key', '');
  if (stored) return stored;
  try {
    const raw = fs.readFileSync(RIVEN_SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    return settings?.api_key || '';
  } catch {
    return '';
  }
}

function getRivenUrl() {
  return db.getSetting('riven_url', '') || 'http://127.0.0.1:8082';
}

// ── Riven API proxy helpers ───────────────────────────────────────────────────

async function rivenFetch(method, pathname, { body, query } = {}) {
  const apiKey = getRivenApiKey();
  if (!apiKey) throw new Error('Riven API key not configured');
  const base = getRivenUrl().replace(/\/$/, '');
  let url = `${base}/api/v1${pathname}`;
  if (query) {
    const params = new URLSearchParams(query);
    url += '?' + params.toString();
  }
  const opts = {
    method,
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      const raw = body.detail || body.message || body.error || '';
      detail = Array.isArray(raw) ? raw.map(e => e.msg || JSON.stringify(e)).join('; ') : String(raw);
    } catch {}
    throw new Error(`Riven API ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

// ── Torrentio helpers ─────────────────────────────────────────────────────────

// Torrentio config prefix — sort by quality+size (default providers cover all major sources)
const TORRENTIO_CFG = 'sort=qualitysize';


async function fetchTorrentio(imdbId, mediaType, season, episode) {
  let url;
  if (mediaType === 'tv') {
    const s = season || 1;
    const e = episode || 1;
    url = `https://torrentio.strem.fun/${TORRENTIO_CFG}/stream/series/${imdbId}:${s}:${e}.json`;
  } else {
    url = `https://torrentio.strem.fun/${TORRENTIO_CFG}/stream/movie/${imdbId}.json`;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Torrentio ${res.status}`);
  const data = await res.json();
  return data.streams || [];
}

// ── RD cache check ────────────────────────────────────────────────────────────

// Returns: { [hash]: { cached: bool, fileCount: int } }
// Returns null if the RD endpoint is unavailable (so caller can show "unknown" status)
async function checkRdCache(hashes) {
  if (!hashes.length) return {};
  const rdKey = getRdApiKey();
  if (!rdKey) {
    logger.debug('RD cache check skipped: no RD API key');
    return null; // null = unavailable
  }
  const results = {};
  let anySuccess = false;
  for (let i = 0; i < hashes.length; i += 20) {
    const chunk = hashes.slice(i, i + 20);
    const hashPath = chunk.join('/');
    try {
      const res = await fetch(
        `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashPath}`,
        {
          headers: { Authorization: `Bearer ${rdKey}` },
          signal: AbortSignal.timeout(15000),
        }
      );
      if (!res.ok) {
        logger.warn(`RD cache check HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      // Detect API-level error (e.g. error_code 37 = disabled_endpoint)
      if (data?.error_code || data?.error) {
        logger.warn(`RD instant availability API error: ${data.error || data.error_code}`);
        return null; // endpoint disabled — treat all as unknown
      }
      anySuccess = true;
      for (const [hash, info] of Object.entries(data)) {
        const h = hash.toLowerCase();
        const rdArr = Array.isArray(info?.rd) ? info.rd : [];
        const cached = rdArr.length > 0;
        let fileCount = 0;
        if (cached) {
          fileCount = Math.max(...rdArr.map(variant =>
            typeof variant === 'object' ? Object.keys(variant).length : 0
          ));
        }
        results[h] = { cached, fileCount };
      }
    } catch (err) {
      logger.warn('RD cache check error:', err.message);
    }
  }
  return anySuccess ? results : null; // null = unavailable
}

// ── Classify episode pack type ────────────────────────────────────────────────

function classifyEpType(releaseName) {
  const n = releaseName.replace(/\./g, ' ');
  // Extra: multi-season range
  if (/s\d\d?\s*[-–]\s*s\d\d?/i.test(n) || /seasons?\s*\d+\s*[-–]\s*\d+/i.test(n)) return 'extra';
  // Incomplete: explicit episode range within a season (e.g. E01-E06, 01-08)
  const rangeMatch = n.match(/[Ee](\d\d?)\s*[-–]\s*[Ee]?(\d\d?)(?!\d)/);
  if (rangeMatch && parseInt(rangeMatch[1]) !== parseInt(rangeMatch[2])) return 'incomplete';
  // Single episode
  if (/\bs\d\d?e\d\d?\b/i.test(n) || /\b\d\d?x\d\d?\b/.test(n)) return 'single';
  // Complete: season pack with no specific episode
  if (/\b(complete|all[\s.-]*seasons?|all[\s.-]*episodes?)\b/i.test(n)) return 'complete';
  if (/\bs\d\d?\b/i.test(n) || /\bseason\s*\d/i.test(n)) return 'complete';
  return 'movie';
}

// ── Parse Torrentio streams into our format ───────────────────────────────────

// Extract episode/file count hint from Torrentio title lines (📺 N or 🗃️ N)
function parseTitleFileCount(title) {
  // 📺 N — episode count  // 🗃️ N — file count
  const m = title.match(/[📺🗃️]\s*(\d+)/u);
  return m ? parseInt(m[1]) : 0;
}

function parseStreams(rawStreams) {
  return rawStreams
    .map(s => {
      const name = s.name || '';
      const title = s.title || '';
      const infoHash = (s.infoHash || extractInfohash(s.magnet || '') || '').toLowerCase();
      if (!infoHash) return null;
      const magnet = s.magnet || `magnet:?xt=urn:btih:${infoHash}`;
      // First line of title is the actual release name; name field is the quality summary
      const releaseName = title.split('\n')[0].trim() || name;
      return {
        infoHash,
        magnet,
        releaseName,
        name,
        title,
        quality: parseQuality(name + ' ' + title),
        codec: parseCodec(name + ' ' + title),
        sizeMb: parseSizeMb(title),
        epType: classifyEpType(releaseName),
        titleFileCount: parseTitleFileCount(title), // hint from Torrentio
        isCached: false,   // filled in later
        rdFileCount: 0,    // filled in later from RD cache
      };
    })
    .filter(Boolean);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /admin/riven/browse — render the browser page
router.get('/browse', (req, res) => {
  const themeParam = db.getSetting('theme_color', 'e5a00d');
  res.render('admin/riven', { themeParam });
});

// GET /admin/riven/config — return current config (keys masked)
router.get('/config', (req, res) => {
  // Auto-create DUMB app row (and ensure it's enabled) whenever Riven is enabled
  let dumbApp = db.listApiApps().find(a => a.type === 'dumb') || null;
  if (!dumbApp) {
    dumbApp = db.createApiApp('DUMB', 'dumb');
    const key68 = generateDumbKey();
    db.prepare('UPDATE api_apps SET api_key = ?, enabled = 1 WHERE id = ?').run(key68, dumbApp.id);
    dumbApp = db.getApiApp(dumbApp.id);
  } else if (!dumbApp.enabled) {
    db.updateApiApp(dumbApp.id, { enabled: true });
    dumbApp = db.getApiApp(dumbApp.id);
  } else if (dumbApp.api_key && dumbApp.api_key.length !== 68) {
    const key68 = generateDumbKey();
    db.prepare('UPDATE api_apps SET api_key = ? WHERE id = ?').run(key68, dumbApp.id);
    dumbApp = db.getApiApp(dumbApp.id);
  }
  res.json({
    url: getRivenUrl(),
    apiKey: getRivenApiKey() ? '••••••••' : '',
    rdApiKey: getRdApiKey() ? '••••••••' : '',
    hasApiKey: !!getRivenApiKey(),
    hasRdKey: !!getRdApiKey(),
    enabled: db.getSetting('riven_enabled', '0') === '1',
    dumbRequestMode: db.getSetting('dumb_request_mode', 'pull'),
    dumbHasApiKey: !!(dumbApp?.api_key),
  });
});

// POST /admin/riven/config/save
router.post('/config/save', (req, res) => {
  const { url, apiKey, rdApiKey, enabled, dumbRequestMode } = req.body;
  if (url !== undefined) db.setSetting('riven_url', url.trim());
  if (apiKey && apiKey !== '••••••••') db.setSetting('riven_api_key', apiKey.trim());
  if (rdApiKey && rdApiKey !== '••••••••') db.setSetting('riven_rd_api_key', rdApiKey.trim());
  if (enabled !== undefined) db.setSetting('riven_enabled', enabled ? '1' : '0');
  if (dumbRequestMode !== undefined) db.setSetting('dumb_request_mode', dumbRequestMode);
  res.json({ ok: true });
});

// Riven validates Overseerr API keys with an exact length check of 68 characters.
// Use 34 random bytes (68 hex chars) for all DUMB keys.
function generateDumbKey() {
  const { randomBytes } = require('crypto');
  return randomBytes(34).toString('hex');
}

// GET /admin/riven/dumb/config — get DUMB app state (auto-creates app row)
router.get('/dumb/config', (req, res) => {
  let app = db.listApiApps().find(a => a.type === 'dumb') || null;
  if (!app) {
    app = db.createApiApp('DUMB', 'dumb');
    // Override the default 64-char key with a 68-char key Riven will accept
    const key68 = generateDumbKey();
    db.prepare('UPDATE api_apps SET api_key = ?, enabled = 0 WHERE id = ?').run(key68, app.id);
    app = db.getApiApp(app.id);
  } else if (app.api_key && app.api_key.length !== 68) {
    // Fix any existing key that's the wrong length
    const key68 = generateDumbKey();
    db.prepare('UPDATE api_apps SET api_key = ? WHERE id = ?').run(key68, app.id);
    app = db.getApiApp(app.id);
  }
  res.json({ hasApiKey: !!app.api_key, enabled: !!app.enabled });
});

// POST /admin/riven/dumb/enable — toggle DUMB integration on/off
router.post('/dumb/enable', (req, res) => {
  const { enabled } = req.body;
  let app = db.listApiApps().find(a => a.type === 'dumb');
  if (!app) app = db.createApiApp('DUMB', 'dumb');
  db.updateApiApp(app.id, { enabled: !!enabled });
  db.setSetting('dumb_enabled', enabled ? '1' : '0');
  res.json({ ok: true, enabled: !!enabled });
});

// POST /admin/riven/dumb/regenerate-key — create or regenerate DUMB API key (68 chars)
router.post('/dumb/regenerate-key', (req, res) => {
  const newKey = generateDumbKey();
  let app = db.listApiApps().find(a => a.type === 'dumb');
  if (!app) {
    app = db.createApiApp('DUMB', 'dumb');
    db.updateApiApp(app.id, { enabled: true });
  }
  db.prepare('UPDATE api_apps SET api_key = ? WHERE id = ?').run(newKey, app.id);
  res.json({ ok: true, apiKey: newKey });
});

// POST /admin/riven/config/test
router.post('/config/test', async (req, res) => {
  try {
    const data = await rivenFetch('GET', '/items', { query: { limit: 1 } });
    res.json({ ok: true, message: 'Connected to Riven successfully' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /admin/riven/tmdb/search?q=... — TMDB multi-search for the browse page
router.get('/tmdb/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ results: [] });
  const apiKey = db.getSetting('tmdb_api_key', null) || process.env.TMDB_API_KEY || null;
  if (!apiKey) return res.status(503).json({ error: 'TMDB API key not configured' });
  try {
    const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(q)}&page=1&include_adult=false&api_key=${apiKey}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    const json = await r.json();
    const results = (json.results || [])
      .filter(x => x.media_type === 'movie' || x.media_type === 'tv')
      .slice(0, 8)
      .map(x => ({
        tmdbId: x.id,
        mediaType: x.media_type,
        title: x.title || x.name || '',
        year: parseInt((x.release_date || x.first_air_date || '').slice(0, 4)) || null,
        posterUrl: x.poster_path ? `https://image.tmdb.org/t/p/w92${x.poster_path}` : null,
      }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/riven/tmdb/seasons?tmdbId=X — returns season list for a TV show
router.get('/tmdb/seasons', async (req, res) => {
  const { tmdbId } = req.query;
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId required' });
  const apiKey = db.getSetting('tmdb_api_key', null) || process.env.TMDB_API_KEY || null;
  if (!apiKey) return res.status(503).json({ error: 'TMDB API key not configured' });
  try {
    const r = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    const data = await r.json();
    const seasons = (data.seasons || [])
      .filter(s => s.season_number > 0) // exclude specials (season 0)
      .map(s => ({ number: s.season_number, name: s.name, episodeCount: s.episode_count }));
    res.json({ seasons, imdbId: data.external_ids?.imdb_id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/riven/tmdb/imdb-id?tmdbId=X&mediaType=movie|tv
router.get('/tmdb/imdb-id', async (req, res) => {
  const { tmdbId, mediaType } = req.query;
  if (!tmdbId || !mediaType) return res.status(400).json({ error: 'tmdbId and mediaType required' });
  try {
    const imdbId = await getImdbId(tmdbId, mediaType);
    if (!imdbId) return res.status(404).json({ error: 'No IMDB ID found for this title' });
    res.json({ imdbId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/riven/torrents/search
// Body: { imdbId, mediaType ('movie'|'tv'), season }
// For TV, queries E01-E03 in parallel to surface season packs and individual eps
router.post('/torrents/search', async (req, res) => {
  const { imdbId, mediaType, season } = req.body;
  if (!imdbId) return res.status(400).json({ error: 'imdbId required' });

  try {
    // Fetch from Torrentio and Zilean in parallel
    let torrentioFetch;
    if (mediaType === 'tv') {
      const s = season || 1;
      torrentioFetch = Promise.allSettled([
        fetchTorrentio(imdbId, 'tv', s, 1),
        fetchTorrentio(imdbId, 'tv', s, 2),
        fetchTorrentio(imdbId, 'tv', s, 3),
      ]).then(results => {
        const seen = new Set();
        const out = [];
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          for (const stream of r.value) {
            const h = (stream.infoHash || '').toLowerCase();
            if (!h || seen.has(h)) continue;
            seen.add(h);
            out.push(stream);
          }
        }
        return out;
      });
    } else {
      torrentioFetch = fetchTorrentio(imdbId, 'movie');
    }

    const torrentioRaw = await Promise.resolve(torrentioFetch).catch(() => []);
    const streams = parseStreams(Array.isArray(torrentioRaw) ? torrentioRaw : []);

    // Batch RD cache check (null = endpoint unavailable → show unknown status)
    const hashes = [...new Set(streams.map(s => s.infoHash).filter(Boolean))];
    const cacheMap = await checkRdCache(hashes);
    const cacheAvailable = cacheMap !== null;
    for (const s of streams) {
      const entry = cacheMap?.[s.infoHash];
      // isCached: true = cached, false = not cached, null = unknown (RD unavailable)
      s.isCached = cacheAvailable ? (entry?.cached === true) : null;
      s.rdFileCount = entry?.fileCount || 0;
      s.fileCount = s.rdFileCount || s.titleFileCount || 0;
    }

    // Sort: cached first → unknown → uncached → largest size → alphabetical
    streams.sort((a, b) => {
      const rank = v => v === true ? 0 : v === null ? 1 : 2;
      const cr = rank(a.isCached) - rank(b.isCached);
      if (cr !== 0) return cr;
      if ((b.sizeMb || 0) !== (a.sizeMb || 0)) return (b.sizeMb || 0) - (a.sizeMb || 0);
      return (a.releaseName || '').localeCompare(b.releaseName || '');
    });

    res.json({ streams });
  } catch (err) {
    logger.warn('Torrent search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/riven/torrents/add
// Body: { imdbId, mediaType, magnet, infoHash, season, episode }
// Orchestrates: find/add item in Riven → start_session → select_files → update_attributes → complete_session
router.post('/torrents/add', async (req, res) => {
  const { imdbId, mediaType, magnet, infoHash, season, episode } = req.body;
  if (!imdbId || !magnet) return res.status(400).json({ error: 'imdbId and magnet required' });

  let sessionId = null;

  try {
    // 1. Look up internal Riven item ID by searching for the IMDB ID
    async function lookupRivenId() {
      try {
        const searchRes = await rivenFetch('GET', '/items', { query: { search: imdbId, limit: 10 } });
        const list = Array.isArray(searchRes) ? searchRes : (searchRes?.items || []);
        const match = list.find(i => i.imdb_id === imdbId);
        if (match) return match.id;
      } catch {}
      return null;
    }

    let rivenItemId = await lookupRivenId();

    if (!rivenItemId) {
      // Add item to Riven then look it up
      try {
        await rivenFetch('POST', '/items/add', { query: { imdb_ids: imdbId } });
      } catch (addErr) {
        logger.warn('Riven add item error (non-fatal):', addErr.message);
      }
      // Give Riven a moment to process, then look up
      await new Promise(r => setTimeout(r, 1500));
      rivenItemId = await lookupRivenId();
    }

    if (!rivenItemId) throw new Error('Could not find or add item in Riven — try again in a few seconds');

    // 2. Start scraping session — item_id (internal Riven ID) and magnet are QUERY PARAMS
    const sessionRes = await rivenFetch('POST', '/scrape/scrape/start_session', {
      query: { item_id: rivenItemId, magnet },
    });
    sessionId = sessionRes.session_id;

    if (!sessionId) throw new Error('No session_id returned from Riven');

    // 3. Build Container from torrent_info.files
    // torrent_info.files: { "1": { filename, path, bytes, selected }, ... }
    const rawFiles = sessionRes.torrent_info?.files || {};

    // Build Container: { file_id_str: { file_id, filename, filesize } }
    // Only include video files (skip .nfo, .txt, .srt, etc.)
    const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|mov|wmv|flv|webm)$/i;
    const allFiles = Object.entries(rawFiles)
      .filter(([, f]) => VIDEO_EXT.test(f.filename || f.path || ''))
      .map(([id, f]) => ({
        id,
        filename: f.filename || (f.path || '').split('/').pop(),
        filesize: f.bytes || 0,
      }));

    // For TV: try to pick just the matching episode(s); fallback to all video files
    let selectedFiles = allFiles;
    if (mediaType === 'tv' && season && episode) {
      const epMatch = allFiles.filter(f => {
        const m = f.filename.match(/[Ss](\d\d?)[Ee](\d\d?)/);
        return m && parseInt(m[1]) === parseInt(season) && parseInt(m[2]) === parseInt(episode);
      });
      if (epMatch.length > 0) selectedFiles = epMatch;
    }

    // Fallback: use all raw files if no video files found
    if (selectedFiles.length === 0) {
      selectedFiles = Object.entries(rawFiles).map(([id, f]) => ({
        id,
        filename: f.filename || (f.path || '').split('/').pop(),
        filesize: f.bytes || 0,
      }));
    }

    // Build Container body
    const containerBody = {};
    for (const f of selectedFiles) {
      containerBody[f.id] = { file_id: parseInt(f.id), filename: f.filename, filesize: f.filesize };
    }

    await rivenFetch('POST', `/scrape/scrape/select_files/${sessionId}`, {
      body: containerBody,
    });

    // 4. Update attributes
    let updateBody;
    if (mediaType === 'tv') {
      // ShowFileData: { season_int: { episode_int: DebridFile } }
      const showData = {};
      for (const f of selectedFiles) {
        const m = f.filename.match(/[Ss](\d\d?)[Ee](\d\d?)/);
        const s = m ? parseInt(m[1]) : (parseInt(season) || 1);
        const e = m ? parseInt(m[2]) : (parseInt(episode) || 1);
        if (!showData[s]) showData[s] = {};
        showData[s][e] = { file_id: parseInt(f.id), filename: f.filename, filesize: f.filesize };
      }
      updateBody = showData;
    } else {
      // DebridFile for movies
      const f = selectedFiles[0] || { id: 0, filename: '', filesize: 0 };
      updateBody = { file_id: parseInt(f.id), filename: f.filename, filesize: f.filesize };
    }

    await rivenFetch('POST', `/scrape/scrape/update_attributes/${sessionId}`, {
      body: updateBody,
    });

    // 5. Complete session
    try {
      await rivenFetch('POST', `/scrape/scrape/complete_session/${sessionId}`);
    } catch {}

    res.json({ ok: true, message: 'Torrent added to Riven successfully', sessionId });
  } catch (err) {
    logger.warn('Riven add torrent error:', err.message);
    // Abort session if it was started
    if (sessionId) {
      try { await rivenFetch('POST', `/scrape/scrape/abort_session/${sessionId}`); } catch {}
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
