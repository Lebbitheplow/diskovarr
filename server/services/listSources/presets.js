// Curated presets for the list editor. TMDB-backed presets work with the app's
// existing key; network/streaming "top 10" presets use TMDB discover by network
// (TV) or watch provider (movies) — same idea as Agregarr's network charts.
// Trakt presets need the trakt_client_id credential.
const tmdbList = require('./tmdbList');
const trakt = require('./trakt');
const imdb = require('./imdb');

const PRESETS = [
  // ── TMDB charts ──
  { key: 'tmdb_popular_movies', label: 'TMDB Popular Movies', group: 'TMDB', mediaType: 'movie', chart: '/movie/popular', limit: 20 },
  { key: 'tmdb_top_rated_movies', label: 'TMDB Top Rated Movies', group: 'TMDB', mediaType: 'movie', chart: '/movie/top_rated', limit: 50 },
  { key: 'tmdb_popular_tv', label: 'TMDB Popular Shows', group: 'TMDB', mediaType: 'tv', chart: '/tv/popular', limit: 20 },
  { key: 'tmdb_top_rated_tv', label: 'TMDB Top Rated Shows', group: 'TMDB', mediaType: 'tv', chart: '/tv/top_rated', limit: 50 },
  { key: 'tmdb_now_playing', label: 'TMDB Now Playing (Theaters)', group: 'TMDB', mediaType: 'movie', chart: '/movie/now_playing', limit: 20 },
  { key: 'tmdb_upcoming', label: 'TMDB Upcoming Movies', group: 'TMDB', mediaType: 'movie', chart: '/movie/upcoming', limit: 20 },

  // ── Network top 10 (TV via TMDB network ids) ──
  { key: 'netflix_top_tv', label: 'Netflix Top 10 Shows', group: 'Network Top 10', mediaType: 'tv', chart: '/discover/tv?with_networks=213&sort_by=popularity.desc', limit: 10 },
  { key: 'hbo_top_tv', label: 'HBO / Max Top 10 Shows', group: 'Network Top 10', mediaType: 'tv', chart: '/discover/tv?with_networks=49|3186&sort_by=popularity.desc', limit: 10 },
  { key: 'disney_top_tv', label: 'Disney+ Top 10 Shows', group: 'Network Top 10', mediaType: 'tv', chart: '/discover/tv?with_networks=2739&sort_by=popularity.desc', limit: 10 },
  { key: 'appletv_top_tv', label: 'Apple TV+ Top 10 Shows', group: 'Network Top 10', mediaType: 'tv', chart: '/discover/tv?with_networks=2552&sort_by=popularity.desc', limit: 10 },
  { key: 'prime_top_tv', label: 'Prime Video Top 10 Shows', group: 'Network Top 10', mediaType: 'tv', chart: '/discover/tv?with_networks=1024&sort_by=popularity.desc', limit: 10 },
  { key: 'hulu_top_tv', label: 'Hulu Top 10 Shows', group: 'Network Top 10', mediaType: 'tv', chart: '/discover/tv?with_networks=453&sort_by=popularity.desc', limit: 10 },
  { key: 'paramount_top_tv', label: 'Paramount+ Top 10 Shows', group: 'Network Top 10', mediaType: 'tv', chart: '/discover/tv?with_networks=4330&sort_by=popularity.desc', limit: 10 },
  { key: 'peacock_top_tv', label: 'Peacock Top 10 Shows', group: 'Network Top 10', mediaType: 'tv', chart: '/discover/tv?with_networks=3353&sort_by=popularity.desc', limit: 10 },

  // ── Streaming top 10 (movies via TMDB watch providers, US region) ──
  { key: 'netflix_top_movies', label: 'Netflix Top 10 Movies', group: 'Streaming Top 10', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=8&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'max_top_movies', label: 'Max Top 10 Movies', group: 'Streaming Top 10', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=1899&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'disney_top_movies', label: 'Disney+ Top 10 Movies', group: 'Streaming Top 10', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=337&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'prime_top_movies', label: 'Prime Video Top 10 Movies', group: 'Streaming Top 10', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=9&watch_region=US&sort_by=popularity.desc', limit: 10 },
  { key: 'appletv_top_movies', label: 'Apple TV+ Top 10 Movies', group: 'Streaming Top 10', mediaType: 'movie', chart: '/discover/movie?with_watch_providers=350&watch_region=US&sort_by=popularity.desc', limit: 10 },

  // ── IMDb charts (via the Servarr mirror — movies only) ──
  { key: 'imdb_top_250', label: 'IMDb Top 250 Movies', group: 'IMDb', mediaType: 'movie', imdbChart: 'top', limit: 250 },
  { key: 'imdb_moviemeter', label: 'IMDb Most Popular Movies', group: 'IMDb', mediaType: 'movie', imdbChart: 'moviemeter', limit: 100 },

  // ── Trakt charts (need Trakt client ID) ──
  { key: 'trakt_trending_movies', label: 'Trakt Trending Movies', group: 'Trakt', mediaType: 'movie', traktChart: 'trending', requiresCredential: 'trakt_client_id', limit: 20 },
  { key: 'trakt_popular_movies', label: 'Trakt Popular Movies', group: 'Trakt', mediaType: 'movie', traktChart: 'popular', requiresCredential: 'trakt_client_id', limit: 20 },
  { key: 'trakt_anticipated_movies', label: 'Trakt Anticipated Movies', group: 'Trakt', mediaType: 'movie', traktChart: 'anticipated', requiresCredential: 'trakt_client_id', limit: 20 },
  { key: 'trakt_trending_shows', label: 'Trakt Trending Shows', group: 'Trakt', mediaType: 'tv', traktChart: 'trending', requiresCredential: 'trakt_client_id', limit: 20 },
  { key: 'trakt_popular_shows', label: 'Trakt Popular Shows', group: 'Trakt', mediaType: 'tv', traktChart: 'popular', requiresCredential: 'trakt_client_id', limit: 20 },
  { key: 'trakt_anticipated_shows', label: 'Trakt Anticipated Shows', group: 'Trakt', mediaType: 'tv', traktChart: 'anticipated', requiresCredential: 'trakt_client_id', limit: 20 },
];

function byKey(key) {
  return PRESETS.find(p => p.key === key) || null;
}

function getPresets() {
  return PRESETS.map(({ key, label, group, mediaType, requiresCredential, limit }) =>
    ({ key, label, group, mediaType, requiresCredential: requiresCredential || null, limit }));
}

async function fetchPreset(preset, { limit } = {}) {
  const cap = Math.min(limit || preset.limit, preset.limit);
  if (preset.chart) return tmdbList.fetchChart(preset.chart, preset.mediaType, { limit: cap });
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
