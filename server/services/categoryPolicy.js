// Pure helpers behind category packs — Kometa-style automatic collections
// (Newly Released, Best of <decade>, one per studio / network, seasonal rows).
// Library packs are Plex smart collections, so Plex keeps their contents
// current by itself; this module only decides which collections should exist
// and what their filter, sort title and artwork are. No I/O.

// Poster art comes from Kometa's public default image set, which is keyed the
// same way the packs are.
const IMAGE_BASE = 'https://raw.githubusercontent.com/Kometa-Team/Default-Images/master';

const VISIBILITIES = ['home', 'owner_home', 'recommended', 'library'];

// sortSection is the library-tab ordering prefix ("!070_Pixar"): identical to
// Kometa's, so adopted collections keep their place and packs stay grouped.
const PACKS = {
  basic: {
    label: 'Basic',
    description: 'Newly Released (last 90 days) for movies and shows, plus New Episodes (aired in the last 7 days).',
    sortSection: '010',
    defaults: { visibility: 'recommended', minItems: 1 },
  },
  seasonal: {
    label: 'Seasonal',
    description: 'Holiday and heritage-month movie rows that appear only during their dates (Halloween in October, Christmas in December, …).',
    sortSection: '000',
    defaults: { visibility: 'home', minItems: 1 },
  },
  decade: {
    label: 'Decades',
    description: 'Best of each decade: the 100 top-rated titles per decade.',
    sortSection: '100',
    defaults: { visibility: 'library', minItems: 5, limit: 100 },
  },
  studio: {
    label: 'Studios',
    description: 'One collection per studio with enough titles in the library.',
    sortSection: '070',
    defaults: { visibility: 'library', minItems: 5 },
  },
  network: {
    label: 'Networks',
    description: 'One collection per TV network with enough shows in the library.',
    sortSection: '050',
    // High floor: anime carries every regional broadcaster as a network.
    defaults: { visibility: 'library', minItems: 10 },
  },
};
// Sync order; an earlier pack wins a title clash within a library (Kometa
// likewise skips the "Netflix" network when a "Netflix" studio exists).
const PACK_IDS = ['basic', 'seasonal', 'decade', 'studio', 'network'];

function normalizeConfig(pack, raw) {
  const def = PACKS[pack].defaults;
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {
    enabled: !!r.enabled,
    visibility: VISIBILITIES.includes(r.visibility) ? r.visibility : def.visibility,
    minItems: Math.max(1, parseInt(r.minItems) || def.minItems),
  };
  if (def.limit) out.limit = Math.min(500, Math.max(10, parseInt(r.limit) || def.limit));
  return out;
}

function sortTitle(pack, title) {
  return `!${PACKS[pack].sortSection}_${title}`;
}

function posterUrl(pack, key, title) {
  const enc = v => encodeURIComponent(String(v));
  switch (pack) {
    case 'basic': return `${IMAGE_BASE}/chart/color/${enc(title)}.jpg`;
    case 'seasonal': return `${IMAGE_BASE}/seasonal/${enc(key)}.jpg`;
    case 'decade': return `${IMAGE_BASE}/decade/best/${enc(key)}.jpg`;
    case 'studio': return `${IMAGE_BASE}/studio/${enc(key)}.jpg`;
    case 'network': return `${IMAGE_BASE}/network/color/${enc(key)}.jpg`;
    default: return null;
  }
}

// Plex library types: 1 movie, 2 show, 4 episode.
const PLEX_TYPE = { movie: 1, tv: 2 };

// Smart-collection filter for a rule. `>>=` is Plex's "in the last" operator
// and has to stay percent-encoded inside the collection URI.
//   rule: { kind: 'recent', days } | { kind: 'new_episodes', days }
//       | { kind: 'decade', decade, limit } | { kind: 'studio', value }
//       | { kind: 'network', id }
function filterPath({ sectionId, media, rule }) {
  const base = `/library/sections/${sectionId}/all?type=`;
  const type = PLEX_TYPE[media];
  switch (rule.kind) {
    case 'recent':
      return `${base}${type}&sort=originallyAvailableAt:desc&originallyAvailableAt%3E%3E=-${rule.days}d`;
    case 'new_episodes':
      return `${base}4&sort=originallyAvailableAt:desc&episode.originallyAvailableAt%3E%3E=-${rule.days}d`;
    case 'decade':
      // Movies carry a critic rating; shows only have the audience one.
      return `${base}${type}&sort=${media === 'tv' ? 'audienceRating' : 'rating'}:desc&decade=${rule.decade}&limit=${rule.limit}`;
    case 'studio':
      return `${base}${type}&sort=originallyAvailableAt:desc&studio=${encodeURIComponent(rule.value)}`;
    case 'network':
      return `${base}${type}&sort=originallyAvailableAt:desc&network=${encodeURIComponent(rule.id)}`;
    default:
      throw new Error(`Unknown category rule: ${rule.kind}`);
  }
}

// Type of the items the collection holds (New Episodes is episode-level).
function plexTypeFor(media, rule) {
  return rule.kind === 'new_episodes' ? 4 : PLEX_TYPE[media];
}

// A comma inside a Plex filter value means OR, so such studios can't be
// expressed as a single-studio filter.
function filterableName(name) {
  const s = String(name || '').trim();
  return !!s && !s.includes(',');
}

// Drop planned collections whose title is already taken in the same library.
// `taken` is a Set of "media:title" (lowercased) and is extended in place.
function dedupeTitles(planned, taken) {
  const kept = [];
  for (const p of planned) {
    const key = `${p.media}:${p.title.toLowerCase()}`;
    if (taken.has(key)) continue;
    taken.add(key);
    kept.push(p);
  }
  return kept;
}

module.exports = {
  PACKS, PACK_IDS, VISIBILITIES, IMAGE_BASE,
  normalizeConfig, sortTitle, posterUrl, filterPath, plexTypeFor, filterableName, dedupeTitles,
};
