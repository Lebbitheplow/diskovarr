// FlixPatrol streaming top 10s (the data behind Agregarr's "networks" source).
// flixpatrol.com sits behind a Cloudflare JS challenge, so pages are fetched
// through a FlareSolverr instance when one is configured (Automation → list
// source credentials, default http://localhost:8191) and directly otherwise.
//
// Two page layouts are parsed:
//   global  https://flixpatrol.com/top10
//           <h2>TOP TV Shows on Netflix on <date></h2> + one table
//   country https://flixpatrol.com/top10/streaming/{region}/
//           <h2>Hulu TOP 10 in the United States on <date></h2>
//           + <h3>TOP 10 Overall|Movies|TV Shows</h3> tables
// Rows carry only a title (and sometimes a year in the slug); entries are
// resolved to TMDB by title search downstream.
const db = require('../../db/database');

const BASE = 'https://flixpatrol.com';
const PAGE_TTL_MS = 30 * 60 * 1000;
const pageCache = new Map(); // url -> { html, fetchedAt }

// Preset platform ids → the heading name FlixPatrol uses.
const PLATFORMS = {
  netflix: 'Netflix',
  hbo: 'HBO Max',
  disney: 'Disney+',
  hulu: 'Hulu',
  paramount: 'Paramount+',
  amazon_prime: 'Amazon Prime',
  apple_tv: 'Apple TV',
  peacock: 'Peacock',
};

function getFlareSolverrUrl() {
  const v = db.getSetting('flaresolverr_url', null);
  if (v === null || v === undefined) return process.env.FLARESOLVERR_URL || 'http://localhost:8191';
  return String(v).trim();
}

function pageUrl(region) {
  return region && region !== 'global' ? `${BASE}/top10/streaming/${encodeURIComponent(region)}/` : `${BASE}/top10`;
}

async function fetchViaFlareSolverr(url, solverUrl) {
  const res = await fetch(`${solverUrl.replace(/\/$/, '')}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 }),
    signal: AbortSignal.timeout(90000),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.status !== 'ok') throw new Error(`FlareSolverr: ${json?.message || `HTTP ${res.status}`}`);
  if (json.solution?.status && json.solution.status >= 400) throw new Error(`FlixPatrol returned ${json.solution.status}`);
  return json.solution?.response || '';
}

async function fetchDirect(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`FlixPatrol returned ${res.status} (configure FlareSolverr to pass its Cloudflare check)`);
  return res.text();
}

async function fetchPage(region) {
  const url = pageUrl(region);
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.fetchedAt < PAGE_TTL_MS) return hit.html;
  const solver = getFlareSolverrUrl();
  const html = solver ? await fetchViaFlareSolverr(url, solver) : await fetchDirect(url);
  if (!html || !/flixpatrol/i.test(html)) throw new Error('FlixPatrol returned an unexpected page');
  pageCache.set(url, { html, fetchedAt: Date.now() });
  return html;
}

const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const decode = s => s
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// Rows of one <table>: [{ title, year }] in ranking order.
function parseTable(tableHtml) {
  const out = [];
  const seen = new Set();
  const rowRe = /<tr[\s>][\s\S]*?<\/tr>/g;
  let m;
  while ((m = rowRe.exec(tableHtml)) !== null) {
    const row = m[0];
    const href = row.match(/href="\/title\/([^"/]+)\/?"/);
    if (!href) continue;
    const slug = href[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    let title = (row.match(/<img[^>]*\salt="([^"]+)"/) || [])[1];
    if (!title) {
      const a = row.match(/<a[^>]*href="\/title\/[^"]+"[^>]*>([\s\S]*?)<\/a>/);
      title = a ? stripTags(a[1]) : null;
    }
    if (!title) continue;
    const year = parseInt((slug.match(/-(19|20)(\d{2})$/) || []).slice(1).join('')) || null;
    out.push({ title: decode(title), year });
  }
  return out;
}

const sectionsOf = html => html.split(/(?=<h2[\s>])/).slice(1);
const headingOf = section => stripTags(decode((section.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || ['', ''])[1]));

/**
 * Parse a FlixPatrol page for one platform. Returns [{ title, year, mediaType }],
 * mediaType 'movie' | 'tv' | null (country "Overall" table when no typed table
 * exists). `mediaType` selects which typed table to read; null = both/overall.
 */
function parseTop10(html, { platform, mediaType = null } = {}) {
  const name = PLATFORMS[platform] || platform;
  const nameRe = new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i');
  const results = [];
  for (const section of sectionsOf(html)) {
    const heading = headingOf(section);
    if (!nameRe.test(heading) || /by (country|day)/i.test(heading)) continue;

    // Global layout: "TOP TV Shows on Netflix on …" / "TOP Movies on Netflix on …"
    const global = heading.match(/^TOP (TV Shows|Movies) on /i);
    if (global) {
      const type = /^TOP TV/i.test(heading) ? 'tv' : 'movie';
      if (mediaType && mediaType !== type) continue;
      const table = section.match(/<table[\s\S]*?<\/table>/);
      if (table) results.push(...parseTable(table[0]).map(e => ({ ...e, mediaType: type })));
      continue;
    }

    // Country layout: "<Platform> TOP 10 in <Country> on …" with h3 sub-tables
    if (!/TOP 10 in /i.test(heading)) continue;
    const blocks = section.split(/(?=<h3[\s>])/).slice(1);
    const typed = { movie: null, tv: null, overall: null };
    for (const block of blocks) {
      const h3 = headingOf(block.replace(/<h3/, '<h2').replace(/<\/h3>/, '</h2>')).toLowerCase();
      const table = block.match(/<table[\s\S]*?<\/table>/);
      if (!table) continue;
      if (h3.includes('movie')) typed.movie = table[0];
      else if (h3.includes('tv')) typed.tv = table[0];
      else if (h3.includes('overall')) typed.overall = table[0];
    }
    const wanted = mediaType ? [mediaType] : ['movie', 'tv'];
    let any = false;
    for (const type of wanted) {
      if (!typed[type]) continue;
      any = true;
      results.push(...parseTable(typed[type]).map(e => ({ ...e, mediaType: type })));
    }
    if (!any && typed.overall) results.push(...parseTable(typed.overall).map(e => ({ ...e, mediaType: null })));
  }
  return results;
}

// Preset fetcher: { platform, region } → entries for resolveEntries().
async function fetchEntries({ platform, region = 'global', mediaType = null }, { limit = 10 } = {}) {
  if (!PLATFORMS[platform]) throw new Error(`Unknown FlixPatrol platform: ${platform}`);
  const html = await fetchPage(region);
  const entries = parseTop10(html, { platform, mediaType });
  if (entries.length === 0) {
    throw new Error(`FlixPatrol has no ${PLATFORMS[platform]} chart on the ${region} page` +
      (region === 'global' ? ' (try a country region such as united-states)' : ''));
  }
  return entries.slice(0, limit);
}

module.exports = { fetchEntries, parseTop10, PLATFORMS, pageUrl };
