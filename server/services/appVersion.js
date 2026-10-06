// Version + release notes, sourced from git tags and GitHub releases so nothing
// has to be bumped by hand. The installed version comes from (in order):
//   1. DISKOVARR_VERSION — baked into the Docker image from the release tag
//   2. `git describe --tags` — source checkouts (the nearest v* tag behind HEAD)
//   3. server/package.json — last resort only
// Release notes and the latest version come from the GitHub releases API.
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('./logger');

const REPO = 'Lebbitheplow/diskovarr';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const RELEASES_TTL = 6 * 60 * 60 * 1000;
const GIT_TTL = 5 * 60 * 1000;

const clean = v => String(v || '').trim().replace(/^v/i, '');

let _gitCache = { checkedAt: 0, version: null };

function gitVersion() {
  if (Date.now() - _gitCache.checkedAt < GIT_TTL) return _gitCache.version;
  let version = null;
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    version = clean(tag) || null;
  } catch { /* no git binary, no .git dir, or no tags */ }
  _gitCache = { checkedAt: Date.now(), version };
  return version;
}

function currentVersion() {
  return clean(process.env.DISKOVARR_VERSION) || gitVersion() || require('../package.json').version;
}

function compareVersions(a, b) {
  const pa = clean(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = clean(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function isNewerVersion(latest, current) {
  return !!latest && compareVersions(latest, current) > 0;
}

// ── GitHub releases (6h cache, shared by the update check and the changelog) ──

let _releaseCache = { checkedAt: 0, releases: [] };

async function getReleases() {
  if (Date.now() - _releaseCache.checkedAt < RELEASES_TTL) return _releaseCache.releases;
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { 'User-Agent': 'diskovarr-update-check', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const releases = (Array.isArray(data) ? data : [])
      .filter(r => !r.draft && !r.prerelease && clean(r.tag_name))
      .map(r => ({
        version: clean(r.tag_name),
        name: r.name || r.tag_name,
        date: (r.published_at || r.created_at || '').slice(0, 10),
        url: r.html_url,
        body: r.body || '',
      }))
      .sort((a, b) => compareVersions(b.version, a.version));
    _releaseCache = { checkedAt: Date.now(), releases };
  } catch (err) {
    logger.warn(`[version] GitHub release check failed: ${err.message}`);
    _releaseCache.checkedAt = Date.now(); // suppress retries for the TTL window, keep stale data
  }
  return _releaseCache.releases;
}

async function getUpdateStatus() {
  const current = currentVersion();
  const releases = await getReleases();
  const latest = releases[0]?.version || null;
  return { current, latest, updateAvailable: isNewerVersion(latest, current) };
}

// The installed release and the ones before it — never notes for a version
// this instance isn't running yet.
async function getChangelog(limit = 3) {
  const current = currentVersion();
  const releases = await getReleases();
  return {
    current,
    releases: releases.filter(r => compareVersions(r.version, current) <= 0).slice(0, limit),
  };
}

function _resetCaches() {
  _gitCache = { checkedAt: 0, version: null };
  _releaseCache = { checkedAt: 0, releases: [] };
}

module.exports = {
  currentVersion,
  compareVersions,
  isNewerVersion,
  getReleases,
  getUpdateStatus,
  getChangelog,
  _resetCaches,
};
