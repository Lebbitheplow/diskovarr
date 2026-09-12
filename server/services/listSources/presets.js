// Curated presets for the list editor. TMDB-backed presets work with the app's
// existing key. Streaming top 10s come from FlixPatrol (needs FlareSolverr to
// pass its Cloudflare check) — the same charts Agregarr's "networks" source
// uses — with TMDB discover-by-network/provider charts as a no-scrape
// alternative. Trakt presets need the trakt_client_id credential.
const tmdbList = require('./tmdbList');
const trakt = require('./trakt');
const imdb = require('./imdb');
const flixpatrol = require('./flixpatrol');
const anilist = require('./anilist');

const FLIX = 'Streaming Top 10 (FlixPatrol)';

const PRESETS = [
  // ── TMDB charts ──
  { key: 'tmdb_trending_movies_week', label: 'TMDB Trending Movies (This Week)', group: 'TMDB', mediaType: 'movie', chart: '/trending/movie/week', limit: 100 },
  { key: 'tmdb_trending_tv_week', label: 'TMDB Trending Shows (This Week)', group: 'TMDB', mediaType: 'tv', chart: '/trending/tv/week', limit: 100 },
  { key: 'tmdb_trending_movies_day', label: 'TMDB Trending Movies (Today)', group: 'TMDB', mediaType: 'movie', chart: '/trending/movie/day', limit: 100 },
  { key: 'tmdb_trending_tv_day', label: 'TMDB Trending Shows (Today)', group: 'TMDB', mediaType: 'tv', chart: '/trending/tv/day', limit: 100 },
  { key: 'tmdb_popular_movies', label: 'TMDB Popular Movies', group: 'TMDB', mediaType: 'movie', chart: '/movie/popular', limit: 100 },
  { key: 'tmdb_top_rated_movies', label: 'TMDB Top Rated Movies', group: 'TMDB', mediaType: 'movie', chart: '/movie/top_rated', limit: 250 },
  { key: 'tmdb_popular_tv', label: 'TMDB Popular Shows', group: 'TMDB', mediaType: 'tv', chart: '/tv/popular', limit: 100 },
  { key: 'tmdb_top_rated_tv', label: 'TMDB Top Rated Shows', group: 'TMDB', mediaType: 'tv', chart: '/tv/top_rated', limit: 250 },
  { key: 'tmdb_now_playing', label: 'TMDB Now Playing (Theaters)', group: 'TMDB', mediaType: 'movie', chart: '/movie/now_playing', limit: 40 },
  { key: 'tmdb_upcoming', label: 'TMDB Upcoming Movies', group: 'TMDB', mediaType: 'movie', chart: '/movie/upcoming', limit: 40 },

  // ── FlixPatrol streaming top 10s (global page; Hulu/Peacock are US-only) ──
  { key: 'flix_netflix_movies', label: 'Netflix Top 10 Movies', group: FLIX, mediaType: 'movie', flixpatrol: { platform: 'netflix', region: 'global' }, limit: 10 },
  { key: 'flix_netflix_tv', label: 'Netflix Top 10 Shows', group: FLIX, mediaType: 'tv', flixpatrol: { platform: 'netflix', region: 'global' }, limit: 10 },
  { key: 'flix_hbo_movies', label: 'HBO Max Top 10 Movies', group: FLIX, mediaType: 'movie', flixpatrol: { platform: 'hbo', region: 'global' }, limit: 10 },
  { key: 'flix_hbo_tv', label: 'HBO Max Top 10 Shows', group: FLIX, mediaType: 'tv', flixpatrol: { platform: 'hbo', region: 'global' }, limit: 10 },
  { key: 'flix_disney_movies', label: 'Disney+ Top 10 Movies', group: FLIX, mediaType: 'movie', flixpatrol: { platform: 'disney', region: 'global' }, limit: 10 },
  { key: 'flix_disney_tv', label: 'Disney+ Top 10 Shows', group: FLIX, mediaType: 'tv', flixpatrol: { platform: 'disney', region: 'global' }, limit: 10 },
  { key: 'flix_paramount_movies', label: 'Paramount+ Top 10 Movies', group: FLIX, mediaType: 'movie', flixpatrol: { platform: 'paramount', region: 'global' }, limit: 10 },
  { key: 'flix_paramount_tv', label: 'Paramount+ Top 10 Shows', group: FLIX, mediaType: 'tv', flixpatrol: { platform: 'paramount', region: 'global' }, limit: 10 },
  { key: 'flix_prime_movies', label: 'Prime Video Top 10 Movies', group: FLIX, mediaType: 'movie', flixpatrol: { platform: 'amazon_prime', region: 'global' }, limit: 10 },
  { key: 'flix_prime_tv', label: 'Prime Video Top 10 Shows', group: FLIX, mediaType: 'tv', flixpatrol: { platform: 'amazon_prime', region: 'global' }, limit: 10 },
  { key: 'flix_appletv_movies', label: 'Apple TV+ Top 10 Movies', group: FLIX, mediaType: 'movie', flixpatrol: { platform: 'apple_tv', region: 'global' }, limit: 10 },
  { key: 'flix_appletv_tv', label: 'Apple TV+ Top 10 Shows', group: FLIX, mediaType: 'tv', flixpatrol: { platform: 'apple_tv', region: 'global' }, limit: 10 },
  { key: 'flix_hulu_movies', label: 'Hulu Top 10 Movies (US)', group: FLIX, mediaType: 'movie', flixpatrol: { platform: 'hulu', region: 'united-states' }, limit: 10 },
  { key: 'flix_hulu_tv', label: 'Hulu Top 10 Shows (US)', group: FLIX, mediaType: 'tv', flixpatrol: { platform: 'hulu', region: 'united-states' }, limit: 10 },
  { key: 'flix_peacock_movies', label: 'Peacock Top 10 Movies (US)', group: FLIX, mediaType: 'movie', flixpatrol: { platform: 'peacock', region: 'united-states' }, limit: 10 },
  { key: 'flix_peacock_tv', label: 'Peacock Top 10 Shows (US)', group: FLIX, mediaType: 'tv', flixpatrol: { platform: 'peacock', region: 'united-states' }, limit: 10 },

  // ── Network top 10 (TV via TMDB network ids — no scraping) ──
  { key: 'netflix_top_tv', label: 'Netflix Top 10 Shows (TMDB)', group: 'Network Top 10 (TMDB)', mediaType: 'tv', chart: '/discover/tv?with_networks=213&sort_by=popularity.desc', limit: 10 },
  { key: 'hbo_top_tv', label: 'HBO / Max Top 10 Shows (TMDB)', group: 'Network Top 10 (TMDB)', mediaType: 'tv', chart: '/discover/tv?with_networks=49|3186&sort_by=popularity.desc', limit: 10 },
  { key: 'disney_top_tv', label: 'Disney+ Top 10 Shows (TMDB)', group: 'Network Top 10 (TMDB)', mediaType: 'tv', chart: '/discover/tv?with_networks=2739&sort_by=popularity.desc', limit: 10 },
  { key: 'appletv_top_tv', label: 'Apple TV+ Top 10 Shows (TMDB)', group: 'Network Top 10 (TMDB)', mediaType: 'tv', chart: '/discover/tv?with_networks=2552&sort_by=popularity.desc', limit: 10 },
  { key: 'prime_top_tv', label: 'Prime Video Top 10 Shows (TMDB)', group: 'Network Top 10 (TMDB)', mediaType: 'tv', chart: '/discover/tv?with_networks=1024&sort_by=popularity.desc', limit: 10 },
  { key: 'hulu_top_tv', label: 'Hulu Top 10 Shows (TMDB)', group: 'Network Top 10 (TMDB)', mediaType: 'tv', chart: '/discover/tv?with_networks=453&sort_by=popularity.desc', limit: 10 },
  { key: 'paramount_top_tv', label: 'Paramount+ Top 10 Shows (TMDB)', group: 'Network Top 10 (TMDB)', mediaType: 'tv', chart: '/discover/tv?with_networks=4330&sort_by=popularity.desc', limit: 10 },
  { key: 'peacock_top_tv', label: 'Peacock Top 10 Shows (TMDB)', group: 'Network Top 10 (TMDB)', mediaType: 'tv', chart: '/discover/tv?with_networks=3353&sort_by=popularity.desc', limit: 10 },

  // ── Streaming top 10 (movies via TMDB watch providers, US region — no scraping) ──
  { key: 'netflix_top_movies', label: 'Netflix Top 10 Movies (TMDB)', group: 'Streaming Top 10 (TMDB)', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=8&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'max_top_movies', label: 'Max Top 10 Movies (TMDB)', group: 'Streaming Top 10 (TMDB)', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=1899&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'disney_top_movies', label: 'Disney+ Top 10 Movies (TMDB)', group: 'Streaming Top 10 (TMDB)', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=337&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'prime_top_movies', label: 'Prime Video Top 10 Movies (TMDB)', group: 'Streaming Top 10 (TMDB)', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=9&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'appletv_top_movies', label: 'Apple TV+ Top 10 Movies (TMDB)', group: 'Streaming Top 10 (TMDB)', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=350&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'hulu_top_movies', label: 'Hulu Top 10 Movies (TMDB)', group: 'Streaming Top 10 (TMDB)', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=15&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'paramount_top_movies', label: 'Paramount+ Top 10 Movies (TMDB)', group: 'Streaming Top 10 (TMDB)', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=531&watch_region=US&sort_by=popularity.desc', limit: 10 },

  // ── IMDb charts (via the Servarr mirror — movies only) ──
  { key: 'imdb_top_250', label: 'IMDb Top 250 Movies', group: 'IMDb', mediaType: 'movie', imdbChart: 'top', limit: 250 },
  { key: 'imdb_moviemeter', label: 'IMDb Most Popular Movies', group: 'IMDb', mediaType: 'movie', imdbChart: 'moviemeter', limit: 100 },

  // ── AniList ──
  { key: 'anilist_popular_tv', label: 'AniList Most Popular Anime (Series)', group: 'AniList', mediaType: 'tv', anilistChart: 'popular', limit: 5000 },
  { key: 'anilist_popular_movies', label: 'AniList Most Popular Anime (Movies)', group: 'AniList', mediaType: 'movie', anilistChart: 'popular', limit: 1000 },

  // ── Trakt charts (need Trakt client ID) ──
  { key: 'trakt_trending_movies', label: 'Trakt Trending Movies', group: 'Trakt', mediaType: 'movie', traktChart: 'trending', requiresCredential: 'trakt_client_id', limit: 100 },
  { key: 'trakt_popular_movies', label: 'Trakt Popular Movies', group: 'Trakt', mediaType: 'movie', traktChart: 'popular', requiresCredential: 'trakt_client_id', limit: 100 },
  { key: 'trakt_anticipated_movies', label: 'Trakt Anticipated Movies', group: 'Trakt', mediaType: 'movie', traktChart: 'anticipated', requiresCredential: 'trakt_client_id', limit: 100 },
  { key: 'trakt_trending_shows', label: 'Trakt Trending Shows', group: 'Trakt', mediaType: 'tv', traktChart: 'trending', requiresCredential: 'trakt_client_id', limit: 100 },
  { key: 'trakt_popular_shows', label: 'Trakt Popular Shows', group: 'Trakt', mediaType: 'tv', traktChart: 'popular', requiresCredential: 'trakt_client_id', limit: 100 },
  { key: 'trakt_anticipated_shows', label: 'Trakt Anticipated Shows', group: 'Trakt', mediaType: 'tv', traktChart: 'anticipated', requiresCredential: 'trakt_client_id', limit: 100 },
];

function byKey(key) {
  return PRESETS.find(p => p.key === key) || null;
}

function getPresets() {
  return PRESETS.map(({ key, label, group, mediaType, requiresCredential, limit, flixpatrol: fp }) =>
    ({ key, label, group, mediaType, requiresCredential: requiresCredential || null, limit, needsFlareSolverr: !!fp }));
}

// `limit` is the list's own cap (max items); the preset limit is the chart's
// natural size, so the smaller of the two wins.
async function fetchPreset(preset, { limit } = {}) {
  const cap = Math.min(limit || preset.limit, preset.limit);
  if (preset.chart) return tmdbList.fetchChart(preset.chart, preset.mediaType, { limit: cap });
  if (preset.flixpatrol) {
    return flixpatrol.fetchEntries({ ...preset.flixpatrol, mediaType: preset.mediaType }, { limit: cap });
  }
  if (preset.anilistChart) return anilist.fetchPopular({ mediaType: preset.mediaType }, { limit: cap });
  if (preset.imdbChart) {
    const entries = await imdb.fetchEntries({ kind: 'chart', chart: preset.imdbChart }, { limit: cap });
    return entries.map(e => ({ ...e, mediaType: preset.mediaType }));
  }
  if (preset.traktChart) {
    return trakt.fetchEntries({ kind: 'chart', mediaType: preset.mediaType, chart: preset.traktChart }, { limit: cap });
  }
  throw new Error(`Preset ${preset.key} has no fetcher`);
}

module.exports = { byKey, getPresets, fetchPreset };
