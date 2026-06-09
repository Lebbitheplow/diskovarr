const db = require('../db/database');

// Criterion types that match against array fields (case-insensitive)
const ARRAY_FIELDS = {
  genre: 'genres',
  cast: 'cast',
  director: 'directors',
  writer: 'writers',
  producer: 'producers',
  collection: 'collections',
  keyword: 'keywords',
  country: 'countries',
  production_company: 'productionCompanies',
};

const SCALAR_FIELDS = {
  studio: 'studio',
  network: 'networks',
  language: 'language',
};

// Every criterion type evaluateCriterion() knows how to match. Used to validate input at the API boundary.
const VALID_CRITERION_TYPES = new Set([
  'media_type', 'movie', 'tv_series', 'collection', 'genre', 'cast', 'director',
  'writer', 'producer', 'studio', 'network', 'keyword', 'country', 'language', 'production_company',
]);

function normalize(str) {
  return typeof str === 'string' ? str.trim().toLowerCase() : '';
}

function matchArray(contentField, criterionName) {
  const arr = contentField;
  if (!Array.isArray(arr)) return false;
  const target = normalize(criterionName);
  return arr.some(item => normalize(item).includes(target));
}

function matchScalar(contentField, criterionName) {
  if (Array.isArray(contentField)) {
    const target = normalize(criterionName);
    return contentField.some(item => normalize(item).includes(target));
  }
  return normalize(contentField).includes(normalize(criterionName));
}

// Evaluate a single criterion against a content item
function evaluateCriterion(criterion, content) {
  const { type, entityName, entityId } = criterion;

  switch (type) {
    case 'media_type': {
      const target = (entityName || '').toLowerCase();
      return content.mediaType === target;
    }

    case 'movie': {
      if (entityId) return String(content.tmdbId) === String(entityId) && content.mediaType === 'movie';
      return content.mediaType === 'movie';
    }

    case 'tv_series': {
      if (entityId) return String(content.tmdbId) === String(entityId) && content.mediaType === 'tv';
      return content.mediaType === 'tv';
    }

    case 'collection': {
      if (entityId) {
        const collections = content.collections || [];
        return collections.some(c => {
          const col = typeof c === 'object' ? c : { name: c };
          return col.name && normalize(col.name).includes(normalize(entityName));
        });
      }
      return matchArray(content.collections, entityName);
    }

    case 'genre':
      return matchArray(content.genres, entityName);

    case 'cast':
      return matchArray(content.cast, entityName);

    case 'director':
      return matchArray(content.directors, entityName);

    case 'writer':
      return matchArray(content.writers, entityName);

    case 'producer':
      return matchArray(content.producers, entityName);

    case 'studio':
      return matchScalar(content.studio, entityName);

    case 'network':
      return matchScalar(content.networks || content.studio, entityName);

    case 'keyword':
      return matchArray(content.keywords, entityName);

    case 'country':
      return matchArray(content.countries, entityName);

    case 'language':
      return matchScalar(content.language, entityName);

    case 'production_company':
      return matchArray(content.productionCompanies, entityName);

    default:
      return false;
  }
}

// Check if content matches a monitor's criteria
function matchMonitor(monitor, criteria, content) {
  if (criteria.length === 0) return { matched: false, matchedCriteria: [] };

  const results = criteria.map(c => ({
    criterion: c,
    matched: evaluateCriterion(c, content),
  }));

  const matchedCriteria = results.filter(r => r.matched);

  if (monitor.matchMode === 'ALL') {
    return {
      matched: results.length > 0 && results.every(r => r.matched),
      matchedCriteria,
    };
  }

  return {
    matched: matchedCriteria.length > 0,
    matchedCriteria,
  };
}

// Build a content object from a library item (Plex source)
function buildContentFromLibrary(item) {
  return {
    tmdbId: item.tmdbId,
    mediaType: item.type === 'show' ? 'tv' : 'movie',
    title: item.title,
    genres: item.genres || [],
    cast: item.cast || [],
    directors: item.directors || [],
    writers: item.writers || [],
    producers: item.producers || [],
    studio: item.studio || '',
    networks: item.studio ? [item.studio] : [],
    collections: item.collections || [],
    countries: item.countries || [],
    keywords: [],
    language: '',
    productionCompanies: [],
  };
}

// Build a content object from a TMDB cache entry
function buildContentFromTmdb(data) {
  const mediaType = data.media_type || (data.title && data.first_air_date ? 'tv' : 'movie');
  return {
    tmdbId: data.id,
    mediaType,
    title: data.title || data.name,
    genres: data.genres || [],
    cast: data.cast || [],
    directors: data.directors || [],
    writers: data.writers || [],
    producers: data.producers || [],
    studio: data.studio || '',
    networks: data.networks || [],
    collections: data.collections || [],
    countries: data.countries || [],
    keywords: data.keywords || [],
    language: data.language || '',
    productionCompanies: data.productionCompanies || data.production_companies || [],
  };
}

// Evaluate a single piece of content against all enabled monitors
async function evaluateContent(content, source) {
  if (!content.tmdbId) return [];

  const monitors = db.getAllEnabledMonitors();
  const matches = [];

  for (const monitor of monitors) {
    const criteria = db.getCriteria(monitor.id);
    if (criteria.length === 0) continue;

    const { matched, matchedCriteria } = matchMonitor(monitor, criteria, content);
    if (!matched) continue;

    const notificationType = source === 'plex' ? 'plex_added' : 'requestable';

    if (source === 'plex' && !monitor.notifyPlex) continue;
    if (source === 'tmdb' && !monitor.notifyRequestable) continue;

    if (db.hasNotified(monitor.id, content.tmdbId, content.mediaType, notificationType)) continue;

    matches.push({
      monitor,
      matchedCriteria,
      content,
      notificationType,
    });
  }

  return matches;
}

// Evaluate a batch of content items against all enabled monitors
async function evaluateBatch(contents, source) {
  const allMatches = [];
  for (const content of contents) {
    try {
      const matches = await evaluateContent(content, source);
      allMatches.push(...matches);
    } catch (err) {
      console.warn('[monitor] Failed to evaluate content against monitors:', err.message);
    }
  }
  return allMatches;
}

module.exports = {
  evaluateCriterion,
  matchMonitor,
  evaluateContent,
  evaluateBatch,
  buildContentFromLibrary,
  buildContentFromTmdb,
  VALID_CRITERION_TYPES,
};
