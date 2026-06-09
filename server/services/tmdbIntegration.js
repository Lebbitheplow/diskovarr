const https = require('node:https');
const zlib = require('node:zlib');
const db = require('../db/database');

const BASE = 'https://api.themoviedb.org/3';

function getApiKey() {
  return db.getSetting('tmdb_api_key', null) || process.env.TMDB_API_KEY || null;
}

function decompressBody(buf, enc) {
  const looksGzipped = (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
  if (looksGzipped(buf)) {
    for (let pass = 0; pass < 4 && looksGzipped(buf); pass++) {
      buf = gunzipResilient(buf);
    }
  } else if (enc === 'deflate') {
    buf = zlib.inflateSync(buf);
  } else if (enc === 'br') {
    buf = zlib.brotliDecompressSync(buf);
  }
  return buf;
}

function gunzipResilient(buf) {
  let lastErr = null;
  for (let trim = 0; trim <= 4; trim++) {
    try {
      return zlib.gunzipSync(buf.subarray(0, buf.length - trim));
    } catch (e) {
      lastErr = e;
      if (e.code !== 'Z_BUF_ERROR') throw e;
    }
  }
  throw lastErr || new Error('gunzip failed');
}

class TmdbApiError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.name = 'TmdbApiError';
    this.statusCode = statusCode;
    this.details = details || null;
  }
}

class ExpiredSessionError extends TmdbApiError {
  constructor() {
    super('TMDB session has expired or been revoked', 401);
    this.name = 'ExpiredSessionError';
  }
}

class RateLimitError extends TmdbApiError {
  constructor(retryAfter) {
    super(`TMDB rate limit exceeded${retryAfter ? `, retry after ${retryAfter}s` : ''}`, 429, { retryAfter });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

function tmdbRequest(method, path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = getApiKey();
    if (!apiKey) return reject(new Error('TMDB API key not configured'));

    const headers = {
      'accept-encoding': 'gzip, deflate, identity',
      'accept': 'application/json',
    };

    let urlPath = path;
    if (opts.sessionId) {
      const sep = path.includes('?') ? '&' : '?';
      urlPath = `${path}${sep}session_id=${opts.sessionId}`;
    }

    const sep = urlPath.includes('?') ? '&' : '?';
    const url = `${BASE}${urlPath}${sep}api_key=${apiKey}`;

    if (body) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }

    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 15000,
    }, res => {
      const status = res.statusCode;
      const retryAfter = res.headers['retry-after']
        ? parseInt(res.headers['retry-after'], 10)
        : null;

      if (status === 401) {
        res.resume();
        return reject(new ExpiredSessionError());
      }
      if (status === 429) {
        res.resume();
        return reject(new RateLimitError(retryAfter));
      }
      if (status === 404) {
        res.resume();
        return resolve(null);
      }
      if (status < 200 || status >= 300) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          reject(new TmdbApiError(
            `TMDB API error ${status}: ${raw.slice(0, 200)}`,
            status,
            raw ? safeJson(raw) : null
          ));
        });
        return;
      }

      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          let buf = Buffer.concat(chunks);
          buf = decompressBody(buf, enc);
          const text = buf.toString('utf8');
          resolve(text ? safeJson(text) : null);
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });

    req.on('timeout', () => req.destroy(new Error(`TMDB request timeout for ${path}`)));
    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return str; }
}

// ── OAuth Flow ────────────────────────────────────────────────────────────────

async function createRequestToken() {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('TMDB API key not configured');
  const res = await tmdbRequest('GET', '/authentication/token/new');
  if (!res || !res.request_token) {
    throw new Error('Failed to create TMDB request token: ' + JSON.stringify(res));
  }
  const expiresAt = res.expires_at
    ? new Date(res.expires_at).getTime()
    : Date.now() + 600_000;
  return { requestToken: res.request_token, expiresAt };
}

async function requestTokenToSession(requestToken) {
  const res = await tmdbRequest('POST', '/authentication/session/new', {
    request_token: requestToken,
  });
  if (!res || !res.session_id) {
    throw new Error('Failed to create TMDB session: ' + JSON.stringify(res));
  }
  const sessionId = res.session_id;
  // session/new only returns session_id; the account id must be fetched separately.
  const account = await tmdbRequest('GET', '/account', null, { sessionId });
  if (!account || account.id == null) {
    throw new Error('Failed to fetch TMDB account: ' + JSON.stringify(account));
  }
  return { sessionId, accountId: account.id };
}

async function deleteSession(sessionId) {
  await tmdbRequest('DELETE', '/authentication/session', { session_id: sessionId });
}

async function getAccountInfo(accountId, sessionId) {
  const res = await tmdbRequest('GET', `/account/${accountId}`, null, { sessionId });
  return res;
}

// ── Ratings ───────────────────────────────────────────────────────────────────

async function setRating(sessionId, mediaType, tmdbId, value) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const res = await tmdbRequest('POST', `/${type}/${tmdbId}/rating`, { value }, { sessionId });
  return res;
}

async function deleteRating(sessionId, mediaType, tmdbId) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  await tmdbRequest('DELETE', `/${type}/${tmdbId}/rating`, null, { sessionId });
}

module.exports = {
  tmdbRequest,
  createRequestToken,
  requestTokenToSession,
  deleteSession,
  getAccountInfo,
  setRating,
  deleteRating,
  ExpiredSessionError,
  RateLimitError,
  TmdbApiError,
};
