'use strict';

// HTTP client for Riven, the media manager bundled in DUMB.
//
// Riven listens on 127.0.0.1:8082 by default and authenticates with an
// `X-API-KEY` header. The key (and the Real-Debrid key) can be stored in
// settings or read from Riven's own settings.json when Diskovarr shares the
// host with DUMB. This module also owns the "reset" flow used by the queue and
// issue pages: Riven's own /items/reset blacklists the active torrent and wipes
// the item's files and state; a follow-up /items/retry puts it straight back on
// the queue instead of waiting for Riven's periodic library retry.

const fs = require('fs');
const db = require('../db/database');
const tmdb = require('../services/tmdb');

const RIVEN_SETTINGS_PATH = process.env.RIVEN_SETTINGS_PATH || '/opt/riven/settings.json';
const DEFAULT_URL = 'http://127.0.0.1:8082';
const TIMEOUT_MS = 30000;

class RivenError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'RivenError';
    this.status = status;
  }
}

function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(RIVEN_SETTINGS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function getRivenUrl() {
  return (db.getSetting('riven_url', '') || DEFAULT_URL).replace(/\/$/, '');
}

// Stored override first, then Riven's settings.json as a fallback.
function getRivenApiKey() {
  return db.getSetting('riven_api_key', '') || readSettingsFile()?.api_key || '';
}

function getRdApiKey() {
  return db.getSetting('riven_rd_api_key', '') || readSettingsFile()?.downloaders?.real_debrid?.api_key || '';
}

function isRivenEnabled() {
  return ['1', 'true'].includes(db.getSetting('riven_enabled', '0'));
}

async function rivenFetch(method, pathname, { body, query, timeout } = {}) {
  const apiKey = getRivenApiKey();
  if (!apiKey) throw new RivenError('Riven API key not configured', 0);
  let url = `${getRivenUrl()}/api/v1${pathname}`;
  if (query) url += '?' + new URLSearchParams(query).toString();
  const opts = {
    method,
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeout || TIMEOUT_MS),
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new RivenError(`Riven unreachable at ${getRivenUrl()}: ${err.message}`, 0);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const payload = await res.json();
      const raw = payload.detail || payload.message || payload.error || '';
      detail = Array.isArray(raw) ? raw.map(e => e.msg || JSON.stringify(e)).join('; ') : String(raw);
    } catch { /* non-JSON error body */ }
    throw new RivenError(`Riven API ${res.status}${detail ? ': ' + detail : ''}`, res.status);
  }
  return res.json();
}

// ── Items ─────────────────────────────────────────────────────────────────────

// Riven item ids (show_tvdb123, season_tvdb123_s1, episode_tvdb456) can't be
// derived from a TMDB id, so every reset starts by fetching the item tree.
// Returns null when Riven doesn't know the title (or knows it as another type).
async function getItemByTmdb(tmdbId, mediaType) {
  const wantType = mediaType === 'movie' ? 'movie' : 'show';
  let item;
  try {
    item = await rivenFetch('GET', `/items/${encodeURIComponent(String(tmdbId))}`, { query: { use_tmdb_id: 'true' } });
  } catch (err) {
    if (err.status === 404) return null;
    // Riven's TMDB lookup ignores the media type, but TMDB movie and TV ids are
    // separate namespaces — Doctor Who (1963) is TV 121, The Two Towers is
    // movie 121 — so a library holding both answers 500 "Multiple rows".
    // Resolve the IMDb id and search by that instead.
    if (err.status !== 500) throw err;
    return getItemByImdb(tmdbId, wantType);
  }
  if (String(item?.type || '').toLowerCase() !== wantType) return null;
  return item;
}

// IMDb ids are unique across movies and shows. Riven's /items?search=tt…
// matches imdb_id exactly; the type filter keeps seasons/episodes out.
async function getItemByImdb(tmdbId, wantType) {
  const details = await tmdb.getItemDetails(tmdbId, wantType === 'movie' ? 'movie' : 'tv').catch(() => null);
  const imdbId = details?.imdbId;
  if (!imdbId) throw new RivenError(`Could not resolve an IMDb id for TMDB ${tmdbId} to look it up in Riven`, 502);
  const listing = await rivenFetch('GET', '/items', { query: { search: imdbId, type: wantType, limit: '10' } });
  const match = (listing?.items || []).find(it =>
    String(it.type || '').toLowerCase() === wantType
    && (String(it.tmdb_id ?? '') === String(tmdbId) || String(it.imdb_id || '').toLowerCase() === imdbId.toLowerCase()));
  if (!match) return null;
  // The listing is the compact form — fetch the tree by Riven id.
  return rivenFetch('GET', `/items/${encodeURIComponent(match.id)}`);
}

function cleanDate(value) {
  return value && value !== 'None' ? value : null;
}

// Compact tree for the UI: ids, numbers and states only.
function summarizeItem(item) {
  const episode = (e) => ({
    id: e.id,
    number: Number(e.episode_number ?? e.number),
    title: e.title || null,
    state: e.state || null,
    airedAt: cleanDate(e.aired_at),
  });
  const seasons = (item.seasons || [])
    .map(s => ({
      id: s.id,
      number: Number(s.season_number ?? s.number),
      state: s.state || null,
      episodes: (s.episodes || []).map(episode).sort((a, b) => a.number - b.number),
    }))
    .sort((a, b) => a.number - b.number);
  return {
    id: item.id,
    title: item.title || null,
    type: String(item.type || '').toLowerCase(),
    state: item.state || null,
    imdbId: item.imdb_id || null,
    seasons,
  };
}

// Map a selection to Riven ids on a summarizeItem() tree. `seasons` is a list of season numbers,
// `episodes` a list of { season, episode }. An empty selection (or a movie)
// targets the whole item. A selected season already resets its episodes, so
// episode picks inside it are dropped.
function resolveTargets(summary, { seasons = [], episodes = [] } = {}) {
  if (summary.type === 'movie' || (seasons.length === 0 && episodes.length === 0)) {
    return [{ id: summary.id, label: summary.type === 'movie' ? summary.title || 'Movie' : 'Entire show' }];
  }
  const bySeason = new Map(summary.seasons.map(s => [s.number, s]));
  const targets = [];
  const seen = new Set();
  const seasonNumbers = new Set();
  for (const n of seasons) {
    const s = bySeason.get(Number(n));
    if (!s) throw new RivenError(`Season ${n} is not in Riven`, 404);
    seasonNumbers.add(s.number);
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    targets.push({ id: s.id, label: `Season ${s.number}` });
  }
  for (const pick of episodes) {
    const s = bySeason.get(Number(pick?.season));
    if (!s) throw new RivenError(`Season ${pick?.season} is not in Riven`, 404);
    if (seasonNumbers.has(s.number)) continue;
    const e = s.episodes.find(x => x.number === Number(pick.episode));
    if (!e) throw new RivenError(`S${s.number}E${pick.episode} is not in Riven`, 404);
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    targets.push({ id: e.id, label: `S${s.number}E${e.number}` });
  }
  return targets;
}

// Reset then retry. Riven's reset cancels any running job for the item,
// blacklists the active stream (the torrent it downloaded) and clears the
// item's files, symlinks and scrape history. Retry re-emits the item so the
// state machine picks it up immediately.
async function resetItems(ids) {
  if (!ids.length) throw new RivenError('Nothing to reset', 400);
  const joined = ids.join(',');
  await rivenFetch('POST', '/items/reset', { query: { ids: joined } });
  await rivenFetch('POST', '/items/retry', { query: { ids: joined } });
  return ids;
}

async function resetByTmdb({ tmdbId, mediaType, seasons = [], episodes = [] }) {
  const item = await getItemByTmdb(tmdbId, mediaType);
  if (!item) throw new RivenError('This title is not in Riven', 404);
  const targets = resolveTargets(summarizeItem(item), { seasons, episodes });
  await resetItems(targets.map(t => t.id));
  return { item: { id: item.id, title: item.title || null }, targets };
}

// "Request missing seasons" for a show Riven already tracks. Riven ignores a
// repeat request for a known show, and seasons it gave up scraping sit in
// Indexed forever, so the request is delivered as a retry of the incomplete
// seasons instead (no reset — nothing is blacklisted or removed). Returns null
// when Riven doesn't have the show.
async function retrySeasonsByTmdb({ tmdbId, seasons = [] }) {
  const item = await getItemByTmdb(tmdbId, 'tv');
  if (!item) return null;
  const wanted = new Set(seasons.map(Number));
  const targets = summarizeItem(item).seasons
    .filter(s => wanted.has(s.number) && s.state !== 'Completed')
    .map(s => ({ id: s.id, label: `Season ${s.number}` }));
  if (targets.length > 0) {
    await rivenFetch('POST', '/items/retry', { query: { ids: targets.map(t => t.id).join(',') } });
  }
  return { item: { id: item.id, title: item.title || null }, targets };
}

// ── Removal ───────────────────────────────────────────────────────────────────

// Every torrent directory an item's files live in (`folder` is the torrent's
// name under the debrid mount). A show's episodes can span several torrents.
function collectFolders(item) {
  const folders = new Set();
  const visit = (node) => {
    if (node?.folder) folders.add(node.folder);
    for (const child of node?.seasons || node?.episodes || []) visit(child);
  };
  visit(item);
  return [...folders];
}

// Remove a movie/show from Riven entirely: /items/remove cancels its jobs,
// deletes its library symlinks and drops it (with seasons and episodes) from
// Riven's database, so Riven stops tracking it. The debrid torrent is NOT
// touched by Riven — the returned `folders` let the caller delete those.
// Returns null when Riven doesn't know the title.
async function removeByTmdb({ tmdbId, mediaType }) {
  const item = await getItemByTmdb(tmdbId, mediaType);
  if (!item) return null;
  const folders = collectFolders(item);
  await rivenFetch('DELETE', '/items/remove', { query: { ids: item.id } });
  return { id: item.id, title: item.title || null, folders };
}

// The debrid account Riven downloads with, from Riven's own settings.
// Returns { provider, apiKey } or null when no supported downloader is enabled.
async function getDebridAccount() {
  const payload = await rivenFetch('GET', '/settings/get/downloaders');
  const downloaders = payload?.downloaders || {};
  if (downloaders.all_debrid?.enabled && downloaders.all_debrid.api_key) {
    return { provider: 'alldebrid', apiKey: downloaders.all_debrid.api_key };
  }
  if (downloaders.real_debrid?.enabled && downloaders.real_debrid.api_key) {
    return { provider: 'realdebrid', apiKey: downloaders.real_debrid.api_key };
  }
  return null;
}

module.exports = {
  DEFAULT_URL, RivenError,
  getRivenUrl, getRivenApiKey, getRdApiKey, isRivenEnabled, rivenFetch,
  getItemByTmdb, summarizeItem, resolveTargets, resetItems, resetByTmdb,
  retrySeasonsByTmdb, collectFolders, removeByTmdb, getDebridAccount,
};
