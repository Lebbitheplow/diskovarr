'use strict';

// HTTP client for the DUMB (Debrid Unlimited Media Bridge) control API.
//
// DUMB's API sits on 127.0.0.1:8000 inside its container; with the host
// networking its compose file uses, that is reachable from a Diskovarr running
// on the same box. Auth is DUMB's own JWT (username/password → bearer), cached
// for the token lifetime. The Traktless fork exposes /diskovarr/provision/*,
// which the guided setup drives; stock DUMB only has /diskovarr/status.

const db = require('../db/database');

const DEFAULT_URL = 'http://127.0.0.1:8000';
const TOKEN_TTL_MS = 50 * 60 * 1000; // DUMB access tokens live 60 min
const TIMEOUT_MS = 20000;

let _token = { value: '', url: '', expiresAt: 0 };

function getConfig() {
  return {
    url: (db.getSetting('dumb_url', '') || '').trim().replace(/\/$/, ''),
    username: db.getSetting('dumb_username', '') || '',
    password: db.getSetting('dumb_password', '') || '',
  };
}

function saveConfig({ url, username, password }) {
  if (url !== undefined) db.setSetting('dumb_url', String(url || '').trim().replace(/\/$/, ''));
  if (username !== undefined) db.setSetting('dumb_username', String(username || ''));
  if (password !== undefined && password !== '') db.setSetting('dumb_password', String(password));
  _token = { value: '', url: '', expiresAt: 0 };
}

class DumbError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'DumbError';
    this.status = status;
  }
}

async function rawFetch(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || TIMEOUT_MS) });
  } catch (err) {
    throw new DumbError(`DUMB unreachable at ${url}: ${err.message}`);
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body?.detail;
    const msg = typeof detail === 'string' ? detail
      : detail?.message ? detail.message
      : Array.isArray(detail) ? detail.map(e => e.msg || JSON.stringify(e)).join('; ')
      : body?.error || `HTTP ${res.status}`;
    throw new DumbError(msg, res.status);
  }
  return body;
}

// Unauthenticated: tells us whether DUMB wants a login at all.
async function authStatus(url) {
  return rawFetch(`${url}/auth/status`);
}

async function login(url, username, password) {
  if (!username || !password) throw new DumbError('DUMB username and password are required', 401);
  const body = await rawFetch(`${url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!body?.access_token) throw new DumbError('DUMB login returned no access token', 401);
  _token = { value: body.access_token, url, expiresAt: Date.now() + TOKEN_TTL_MS };
  return _token.value;
}

async function bearer(cfg) {
  if (_token.value && _token.url === cfg.url && _token.expiresAt > Date.now()) return _token.value;
  let status;
  try { status = await authStatus(cfg.url); } catch { status = null; }
  if (status && status.enabled === false) return '';
  return login(cfg.url, cfg.username, cfg.password);
}

// Authenticated request against the configured (or explicitly passed) DUMB.
async function request(method, path, { body, cfg, timeout } = {}) {
  const config = cfg || getConfig();
  if (!config.url) throw new DumbError('DUMB URL is not configured');
  const token = await bearer(config);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await rawFetch(`${config.url}${path}`, {
      method, headers, timeout, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // A stale cached token gets one transparent retry after re-login.
    if (err.status === 401 && token) {
      _token = { value: '', url: '', expiresAt: 0 };
      const fresh = await bearer(config);
      if (fresh) headers.Authorization = `Bearer ${fresh}`;
      return rawFetch(`${config.url}${path}`, {
        method, headers, timeout, body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    throw err;
  }
}

// ── Public surface ─────────────────────────────────────────────────────────────

// Cheap reachability probe: health needs no auth, capabilities tells us if this
// is the Traktless fork (its /process/capabilities carries `diskovarr: true`).
async function probe(cfg) {
  const config = cfg || getConfig();
  const url = config.url || DEFAULT_URL;
  const out = { url, reachable: false, authEnabled: null, loggedIn: false, traktless: false, provision: false, error: null };
  try {
    const health = await rawFetch(`${url}/health`, { timeout: 5000 });
    out.reachable = true;
    out.health = health?.status || null;
  } catch (err) {
    out.error = err.message;
    return out;
  }
  // Anything can answer /health; only DUMB answers /auth/status with an
  // `enabled` flag. Without it this is some other service on that port.
  try {
    const status = await authStatus(url);
    if (!status || typeof status.enabled !== 'boolean') throw new DumbError('no DUMB auth status');
    out.authEnabled = status.enabled;
    out.hasUsers = !!status.has_users;
  } catch (err) {
    out.reachable = false;
    out.error = `Something answers at ${url} but it is not the DUMB API (${err.message})`;
    return out;
  }
  try {
    const caps = await request('GET', '/process/capabilities', { cfg: { ...config, url }, timeout: 8000 });
    out.loggedIn = true;
    out.traktless = !!caps?.diskovarr;
  } catch (err) {
    out.error = err.message;
    out.authError = err.status === 401;
    return out;
  }
  try {
    const prov = await request('GET', '/diskovarr/provision/capabilities', { cfg: { ...config, url }, timeout: 8000 });
    out.provision = !!prov?.provision;
    out.capabilities = prov;
  } catch (err) {
    out.provision = false;
    if (err.status !== 404) out.error = err.message;
  }
  return out;
}

const provisionCapabilities = () => request('GET', '/diskovarr/provision/capabilities');
const provisionValidate = (plan) => request('POST', '/diskovarr/provision/validate', { body: plan });
const provisionStart = (plan) => request('POST', '/diskovarr/provision', { body: plan, timeout: 60000 });
const provisionStatus = () => request('GET', '/diskovarr/provision/status');
const diskovarrStatus = () => request('GET', '/diskovarr/status');
const processes = () => request('GET', '/process/processes');

module.exports = {
  DEFAULT_URL, DumbError,
  getConfig, saveConfig, probe, login, authStatus,
  provisionCapabilities, provisionValidate, provisionStart, provisionStatus, diskovarrStatus, processes,
  _resetToken: () => { _token = { value: '', url: '', expiresAt: 0 }; },
};
