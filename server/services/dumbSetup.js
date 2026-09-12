'use strict';

// Guided DUMB Traktless setup — orchestrates the Admin → Setup wizard.
//
// The wizard collects: where DUMB is (or installs it), which debrid provider
// and key to use, which optional apps to add, and how the symlink library
// should reach Plex. `apply()` then hands DUMB a provisioning plan (it does the
// installs and wires Riven ↔ Diskovarr), polls DUMB until it finishes, and
// finally attaches the symlink folders to Plex. Progress is kept in memory and
// mirrored to the `dumb_setup_state` setting so a page reload can resume.

const os = require('os');
const db = require('../db/database');
const dumb = require('./dumbClient');
const installer = require('./dumbInstaller');
const plexLib = require('./plexLibrarySetup');

const STATE_KEY = 'dumb_setup_state';
const POLL_MS = 4000;
const POLL_TIMEOUT_MS = 45 * 60 * 1000; // installs from source can take a while

const PROVIDERS = {
  alldebrid: { label: 'AllDebrid', validate: validateAllDebrid },
  realdebrid: { label: 'Real-Debrid', validate: validateRealDebrid },
};

let job = null;

// ── Debrid key validation ──────────────────────────────────────────────────────

async function validateAllDebrid(key) {
  const res = await fetch(`https://api.alldebrid.com/v4/user?agent=diskovarr&apikey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => ({}));
  if (body.status !== 'success') {
    const code = body?.error?.code || `HTTP ${res.status}`;
    throw new Error(code === 'AUTH_BAD_APIKEY' ? 'AllDebrid rejected this API key' : `AllDebrid: ${body?.error?.message || code}`);
  }
  const u = body.data?.user || {};
  return { provider: 'alldebrid', username: u.username, premium: !!u.isPremium, expiresAt: u.premiumUntil ? new Date(u.premiumUntil * 1000).toISOString() : null };
}

async function validateRealDebrid(key) {
  const res = await fetch('https://api.real-debrid.com/rest/1.0/user', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
  if (res.status === 401) throw new Error('Real-Debrid rejected this API token');
  if (!res.ok) throw new Error(`Real-Debrid: HTTP ${res.status}`);
  const u = await res.json();
  return { provider: 'realdebrid', username: u.username, premium: u.type === 'premium', expiresAt: u.expiration || null };
}

async function validateDebrid(provider, key) {
  const p = PROVIDERS[String(provider || '').toLowerCase()];
  if (!p) throw new Error('Unknown debrid provider');
  if (!key || !String(key).trim()) throw new Error(`${p.label} API key is required`);
  return p.validate(String(key).trim());
}

// ── Detection ──────────────────────────────────────────────────────────────────

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

function diskovarrUrlGuess() {
  const port = process.env.PORT || 3232;
  // DUMB runs with host networking, so loopback works when Diskovarr is on the
  // same host (systemd). From a Diskovarr container, DUMB needs the LAN address.
  return process.env.DISKOVARR_IN_DOCKER === '1' ? `http://${lanAddress()}:${port}` : `http://127.0.0.1:${port}`;
}

function savedState() {
  try { return JSON.parse(db.getSetting(STATE_KEY, 'null')) || null; } catch { return null; }
}

function persistState(state) {
  db.setSetting(STATE_KEY, JSON.stringify(state));
}

async function detect() {
  const cfg = dumb.getConfig();
  const candidates = [cfg.url, dumb.DEFAULT_URL, 'http://127.0.0.1:8001'].filter(Boolean);
  let probe = null;
  for (const url of [...new Set(candidates)]) {
    const p = await dumb.probe({ ...cfg, url });
    if (!probe || (p.reachable && !probe.reachable)) probe = p;
    if (p.reachable) break;
  }
  const [docker, container, libraries] = await Promise.all([
    installer.dockerStatus(),
    installer.containerStatus().catch(() => ({ exists: false })),
    plexLib.listLibraries().catch(() => null),
  ]);
  const plexConfigured = !!(db.getSetting('plex_url', '') || process.env.PLEX_URL) && !!(db.getSetting('plex_token', '') || process.env.PLEX_TOKEN);
  const tautulliConnected = !!(db.getSetting('tautulli_url', '') || process.env.TAUTULLI_URL);
  return {
    dumb: {
      ...probe,
      configuredUrl: cfg.url,
      username: cfg.username,
      hasPassword: !!cfg.password,
      defaultUrl: dumb.DEFAULT_URL,
    },
    docker: { ...docker, container, image: installer.DEFAULT_IMAGE, installDir: installer.DEFAULT_DIR },
    diskovarr: {
      url: db.getSetting('app_public_url', '') || diskovarrUrlGuess(),
      urlGuess: diskovarrUrlGuess(),
      hasApiKey: !!db.getSetting('diskovarr_api_key', ''),
      hasTmdbKey: !!db.getSetting('tmdb_api_key', ''),
      plexConfigured,
      connections: {
        riven: db.getSetting('riven_enabled', '0') === '1' && !!db.getSetting('riven_url', ''),
        sonarr: db.getSetting('sonarr_enabled', '0') === '1' && !!db.getSetting('sonarr_url', ''),
        radarr: db.getSetting('radarr_enabled', '0') === '1' && !!db.getSetting('radarr_url', ''),
        tautulli: tautulliConnected,
        overseerr: db.getSetting('overseerr_enabled', '0') === '1' && !!db.getSetting('overseerr_url', ''),
      },
      // Plex has no watch-history API of its own — Diskovarr needs Tautulli for
      // it. A Plex admin without Tautulli gets it installed as part of the stack.
      tautulliRequired: tautulliRequired(),
    },
    plex: { configured: plexConfigured, libraries: libraries || [] },
    providers: Object.entries(PROVIDERS).map(([key, p]) => ({ key, label: p.label })),
    job: job || savedState(),
  };
}

// ── Apply ──────────────────────────────────────────────────────────────────────

function ensureDiskovarrApiKey() {
  let key = db.getSetting('diskovarr_api_key', '');
  if (!key) {
    key = require('crypto').randomBytes(32).toString('hex');
    db.setSetting('diskovarr_api_key', key);
  }
  return key;
}

function step(key, label, status = 'running', detail = '') {
  const existing = job.steps.find(s => s.key === key);
  if (existing) Object.assign(existing, { status, detail, updatedAt: Date.now() });
  else job.steps.push({ key, label, status, detail, updatedAt: Date.now() });
  persistState(job);
}

function finish(ok, error) {
  job.running = false;
  job.ok = ok;
  job.finishedAt = Date.now();
  if (error) job.errors.push(error);
  persistState(job);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForDumbJob() {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await dumb.provisionStatus().catch(() => last);
    if (last) {
      job.remote = last;
      persistState(job);
      if (last.running === false) return last;
    }
    await sleep(POLL_MS);
  }
  throw new Error('Timed out waiting for DUMB to finish provisioning');
}

function tautulliRequired() {
  const plexConfigured = !!(db.getSetting('plex_url', '') || process.env.PLEX_URL) && !!(db.getSetting('plex_token', '') || process.env.PLEX_TOKEN);
  const tautulliConnected = !!(db.getSetting('tautulli_url', '') || process.env.TAUTULLI_URL);
  return plexConfigured && !tautulliConnected;
}

function buildPlan(input) {
  const provider = String(input.debrid?.provider || '').toLowerCase();
  if (!PROVIDERS[provider]) throw new Error('Choose AllDebrid or Real-Debrid');
  if (!input.debrid?.apiKey) throw new Error(`${PROVIDERS[provider].label} API key is required`);
  const diskovarrUrl = String(input.diskovarrUrl || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(diskovarrUrl)) throw new Error('Diskovarr URL (as DUMB reaches it) must start with http:// or https://');
  const services = Array.isArray(input.services) ? input.services.map(String) : [];
  if (tautulliRequired() && !services.includes('tautulli')) services.push('tautulli');
  const plexUrl = db.getSetting('plex_url', '') || process.env.PLEX_URL || '';
  const plexToken = db.getSetting('plex_token', '') || process.env.PLEX_TOKEN || '';
  return {
    debrid: { provider, api_key: String(input.debrid.apiKey).trim() },
    diskovarr: { url: diskovarrUrl, api_key: ensureDiskovarrApiKey() },
    services,
    tmdb_api_key: db.getSetting('tmdb_api_key', '') || '',
    plex: plexUrl && plexToken ? { url: plexUrl, token: plexToken } : null,
    library_path: String(input.libraryPath || '').trim() || '/mnt/debrid/library',
  };
}

// Plex step. `plex.mode`: 'auto' attaches folders + applies prefs; anything
// else records instructions only. `hostPathPrefix` maps DUMB's container
// /mnt/debrid to the path Plex sees (host path for a native Plex).
async function applyPlexStep(plexInput, paths) {
  const prefix = String(plexInput?.hostPathPrefix || '').replace(/\/$/, '');
  const map = (p) => (prefix ? p.replace(/^\/mnt\/debrid/, prefix) : p);
  const mapped = { movies: map(paths.movies), shows: map(paths.shows) };
  const instructions = plexLib.instructions(mapped);
  if (plexInput?.mode !== 'auto') return { mode: 'manual', paths: mapped, instructions };

  const result = { mode: 'auto', paths: mapped, libraries: {}, instructions };
  for (const [type, key] of [['movie', 'movies'], ['show', 'shows']]) {
    const sectionId = plexInput[type === 'movie' ? 'movieSectionId' : 'showSectionId'];
    const visible = await plexLib.pathVisibleToPlex(mapped[key]);
    if (!visible) {
      result.libraries[type] = { ok: false, error: `Plex cannot see ${mapped[key]} yet — check the path mapping, then re-run the Plex step` };
      continue;
    }
    try {
      result.libraries[type] = { ok: true, ...(await plexLib.setupLibrary({ type, path: mapped[key], sectionId: sectionId || null })) };
    } catch (err) {
      result.libraries[type] = { ok: false, error: err.message };
    }
  }
  try { result.serverPrefs = await plexLib.applyServerPrefs(); } catch (err) { result.serverPrefsError = err.message; }
  return result;
}

async function apply(input) {
  if (job?.running) throw new Error('Setup is already running');
  const plan = buildPlan(input);
  job = { running: true, ok: null, startedAt: Date.now(), finishedAt: null, steps: [], errors: [], remote: null, result: null,
    plan: { provider: plan.debrid.provider, services: plan.services, libraryPath: plan.library_path, diskovarrUrl: plan.diskovarr.url } };
  persistState(job);

  (async () => {
    try {
      step('dumb', 'Send plan to DUMB');
      await dumb.provisionStart(plan);
      step('dumb', 'Send plan to DUMB', 'done');

      step('provision', 'DUMB installs and wires services');
      const remote = await waitForDumbJob();
      if (!remote.ok) throw new Error((remote.errors || []).join('; ') || 'DUMB provisioning failed');
      step('provision', 'DUMB installs and wires services', 'done');

      step('connections', 'Point Diskovarr requests at DUMB');
      const rivenUrl = remote.result?.riven?.url;
      if (rivenUrl) db.setSetting('riven_url', rivenUrl);
      db.setSetting('riven_enabled', '1');
      db.setSetting('dumb_request_mode', 'pull');
      db.setSetting('default_request_service', 'riven');
      step('connections', 'Point Diskovarr requests at DUMB', 'done');

      step('plex', 'Attach symlink library to Plex');
      const paths = remote.result?.paths || { movies: `${plan.library_path}/movies`, shows: `${plan.library_path}/shows` };
      const plex = await applyPlexStep(input.plex, paths);
      const plexFailed = plex.mode === 'auto' && Object.values(plex.libraries).some(l => !l.ok);
      step('plex', 'Attach symlink library to Plex', plexFailed ? 'warning' : 'done',
        plexFailed ? Object.values(plex.libraries).filter(l => !l.ok).map(l => l.error).join('; ') : (plex.mode === 'manual' ? 'Manual instructions ready' : ''));

      job.result = { paths, plex, remote: remote.result || null };
      finish(true);
    } catch (err) {
      const current = job.steps.find(s => s.status === 'running');
      if (current) step(current.key, current.label, 'error', err.message);
      finish(false, err.message);
    }
  })();

  return job;
}

// Re-run just the Plex attachment (e.g. after fixing a path mapping).
async function rerunPlex(plexInput) {
  const state = job || savedState();
  const paths = state?.result?.paths;
  if (!paths) throw new Error('Run the setup first so the library paths are known');
  const plex = await applyPlexStep(plexInput, paths);
  if (job) { job.result = { ...job.result, plex }; persistState(job); }
  else persistState({ ...state, result: { ...state.result, plex } });
  return plex;
}

function status() { return job || savedState(); }

function reset() { job = null; db.setSetting(STATE_KEY, 'null'); }

module.exports = {
  PROVIDERS, validateDebrid, detect, buildPlan, tautulliRequired, apply, applyPlexStep, rerunPlex, status, reset,
  ensureDiskovarrApiKey, diskovarrUrlGuess,
  _setJob: (j) => { job = j; },
};
