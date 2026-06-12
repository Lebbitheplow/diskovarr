// Letterboxd lists. No public API: list pages are scraped for film slugs, then
// each film page carries its TMDB id (data-tmdb-id). Slug→TMDB resolutions are
// cached for the process lifetime since film ids never change.
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0';

const slugCache = new Map(); // film slug -> { tmdbId, mediaType } | null

function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)letterboxd\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/([^/]+)\/list\/([^/]+)\/?/);
  if (m && m[1] !== 'film') return { user: m[1], slug: m[2] };
  return null;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Letterboxd returned ${res.status} for ${url}`);
  return res.text();
}

function extractFilmSlugs(html) {
  const out = [];
  const seen = new Set();
  const re = /data-film-slug="([^"]+)"|data-target-link="\/film\/([^/"]+)\//g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1] || m[2];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

async function resolveSlug(slug) {
  if (slugCache.has(slug)) return slugCache.get(slug);
  const html = await fetchHtml(`https://letterboxd.com/film/${slug}/`).catch(() => null);
  let hit = null;
  if (html) {
    const id = html.match(/data-tmdb-id="(\d+)"/);
    const type = html.match(/data-tmdb-type="(movie|tv)"/);
    if (id) hit = { tmdbId: Number(id[1]), mediaType: type ? type[1] : 'movie' };
  }
  slugCache.set(slug, hit);
  return hit;
}

async function fetchEntries(parsed, { limit = 500 } = {}) {
  const slugs = [];
  for (let page = 1; page <= 20 && slugs.length < limit; page++) {
    const url = `https://letterboxd.com/${encodeURIComponent(parsed.user)}/list/${encodeURIComponent(parsed.slug)}/page/${page}/`;
    const html = await fetchHtml(url);
    if (!html) {
      if (page === 1) throw new Error('Letterboxd list not found');
      break;
    }
    const pageSlugs = extractFilmSlugs(html).filter(s => !slugs.includes(s));
    if (pageSlugs.length === 0) break;
    slugs.push(...pageSlugs);
  }
  const out = [];
  for (const slug of slugs.slice(0, limit)) {
    const hit = await resolveSlug(slug);
    if (hit) out.push({ ...hit, title: slug.replace(/-/g, ' ') });
    // Polite pacing on uncached film-page fetches only
    if (!slugCache.has(slug)) await new Promise(r => setTimeout(r, 150));
  }
  if (slugs.length > 0 && out.length === 0) {
    throw new Error('Could not resolve any Letterboxd films to TMDB (layout may have changed)');
  }
  return out;
}

module.exports = { parseUrl, fetchEntries };
