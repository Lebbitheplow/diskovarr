// Pure (episode, video) scoring — no DB access. matcher.js drives the greedy
// assignment; channelDetect.js probes candidate channels with the same math.

const AUTO_THRESHOLD = 0.70;
const MIN_DURATION_SEC = 120; // filters Shorts/teasers
const NEARBY_DAYS = 3;        // "same upload" window for date-only acceptance

const WEIGHTS = { title: 0.45, number: 0.20, date: 0.20, position: 0.10, duration: 0.05 };
// Some TVDB series only have generic episode titles ("Episode 1", "Part 3").
// Title similarity carries no signal there, so its weight shifts to the
// explicit-number and date signals instead.
const GENERIC_TITLE_WEIGHTS = { title: 0, number: 0.55, date: 0.30, position: 0.10, duration: 0.05 };

// Videos that are clearly not the episode itself lose a flat 0.3.
const NON_EPISODE_RE = /\b(?:trailer|teaser|preview|clip|reaction|announcement|behind the scenes)\b/i;
const NON_EPISODE_PENALTY = 0.3;
// Partial-credit for a video segment that equals one segment of a multi-part
// episode title ("Sonic Riders" in "Sonic Riders: SnapCube's … Necessity of Change").
const SEGMENT_MATCH_SCORE = 0.85;

// Video titles are usually "<episode> - <series> (<acronym>)" or
// "<series>: <counter>: <episode>"; score each piece separately.
const SEGMENT_SPLIT_RE = /\s+[-–—|]\s+|:\s+|\s*\/\/\s*/;
const NOISE_TOKENS_RE = /\b(?:official|full episode|full|complete|remastered|avgn|4k|hd)\b/g;
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'with', 's', 'vs', 'for', 'at', 'by']);
// Parenthetical/bracketed platform or format tags: "(NES)", "(SEGA Genesis)", "[4K]"
const PLATFORM_TAG_RE = new RegExp('^(?:' + [
  'nes', 'snes', 'famicom', 'super famicom', 'n64', 'nintendo(?: \\w+)*', 'gamecube', 'game cube', 'wii(?: u)?', 'switch',
  'game ?boy(?: \\w+)*', 'gba', 'gbc', 'gb', 'ds', '3ds', 'virtual boy',
  'sega(?: \\w+)*', 'genesis', 'mega drive', 'master system', 'game gear', '32x', 'sega cd', 'saturn', 'dreamcast',
  'playstation(?: ?\\d)?', 'ps[1-5x]?', 'psp', 'ps ?vita', 'xbox(?: \\w+)*',
  'pc', 'dos', 'ms-?dos', 'mac', 'amiga', 'commodore ?64', 'c64', 'apple ?ii', 'zx spectrum',
  'atari(?: \\w+)*', 'jaguar', 'lynx', 'arcade', 'turbografx(?:-?16)?', 'tg-?16', 'pc engine', 'neo ?geo(?: \\w+)*',
  '3do', 'cd-?i', 'philips cd-?i', 'intellivision', 'colecovision', 'vectrex',
  '4k', 'hd', '1080p', '720p', '60 ?fps', 'remastered', 'full', 'complete', 'uncut', 'extended', 're-?upload',
].join('|') + ')$', 'i');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b0+(?=\d)/g, '') // "#07" ≡ "#7", "Part 03" ≡ "Part 3"
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenericEpisodeTitle(title) {
  return !normalize(title) || /^(?:episode|ep|part|pt|chapter)?\s*#?\d+$/.test(normalize(title));
}

function stripTags(raw) {
  return String(raw || '').replace(/[([]([^)\]]{1,40})[)\]]/g, (m, inner) =>
    (PLATFORM_TAG_RE.test(inner.trim()) ? ' ' : m));
}

function removePhrase(text, phrase) {
  if (!phrase) return text;
  return ` ${text} `.split(` ${phrase} `).join(' ').replace(/\s+/g, ' ').trim();
}

// "Angry Video Game Nerd" → ["avgn"]; both the all-words and the ≥2-letter-words
// variants are returned when they differ ("Dragon Ball Z Abridged" → dbza, dba).
function acronymsOf(seriesTitle) {
  const words = normalize(seriesTitle).split(' ').filter(Boolean);
  const all = words.map(w => w[0]).join('');
  const long = words.filter(w => w.length >= 2).map(w => w[0]).join('');
  return [...new Set([all, long])].filter(a => a.length >= 2);
}

// Strips series/channel branding, the series acronym, platform tags and
// episode-numbering noise from a title so what remains is comparable between
// the TVDB episode title and the video title.
function stripNoise(title, seriesTitle, channelTitle) {
  let t = normalize(stripTags(title));
  for (const brand of [seriesTitle, channelTitle]) t = removePhrase(t, normalize(brand));
  for (const acronym of acronymsOf(seriesTitle)) t = removePhrase(t, acronym);
  return t.replace(/\b(?:ep|episode|part|pt|chapter)\s*\d+\b/g, ' ')
    .replace(/\bs\d{1,2}\s*e\d{1,3}\b/g, ' ')
    .replace(NOISE_TOKENS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return text.split(' ').filter(Boolean);
}

function contentTokens(text) {
  return tokens(text).filter(t => !STOPWORDS.has(t));
}

// Containment is only meaningful for titles with some substance: two content
// words, or a single word of at least 5 characters ("Garfield", "EarthBound").
function substantial(text) {
  const ct = contentTokens(text);
  return ct.length >= 2 || (ct.length === 1 && ct[0].length >= 5);
}

function tokenSetScore(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// When every content token of the episode title appears in the video title,
// that's a strong match even if the video title carries extra noise ("with
// Scott the Woz", guest names) that dilutes Jaccard/Dice. Scaled by 0.95 so an
// exact title still wins ties.
function containmentScore(cleanEp, cleanVideo) {
  if (!substantial(cleanEp)) return 0;
  const epTokens = contentTokens(cleanEp);
  const videoTokens = new Set(tokens(cleanVideo));
  const hits = epTokens.filter(t => videoTokens.has(t)).length;
  return (hits / epTokens.length) * 0.95;
}

function diceBigram(a, b) {
  const grams = (s) => {
    const out = new Map();
    const t = s.replace(/\s+/g, ' ');
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of ga) { inter += Math.min(n, gb.get(g) || 0) * 2; total += n; }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : inter / total;
}

function similarity(cleanEp, cleanVideo) {
  if (!cleanEp || !cleanVideo) return 0;
  return Math.max(tokenSetScore(cleanEp, cleanVideo), diceBigram(cleanEp, cleanVideo), containmentScore(cleanEp, cleanVideo));
}

function segmentsOf(title, ctx) {
  return String(title || '').split(SEGMENT_SPLIT_RE)
    .map(s => stripNoise(s, ctx.seriesTitle, ctx.channelTitle))
    .filter(Boolean);
}

// 1.0 when any video segment equals the cleaned episode title; otherwise the
// best of whole-title similarity, per-segment similarity, and a partial
// credit when a video segment equals one segment of a multi-part episode title.
function titleScore(episodeTitle, videoTitle, ctx) {
  const cleanEp = stripNoise(episodeTitle, ctx.seriesTitle, ctx.channelTitle);
  if (!cleanEp) return 0;
  const cleanVideo = stripNoise(videoTitle, ctx.seriesTitle, ctx.channelTitle);
  let best = similarity(cleanEp, cleanVideo);
  const epSegments = segmentsOf(episodeTitle, ctx);
  for (const seg of segmentsOf(videoTitle, ctx)) {
    if (seg === cleanEp) return 1;
    best = Math.max(best, similarity(cleanEp, seg));
    if (epSegments.length > 1 && substantial(seg) && epSegments.includes(seg)) {
      best = Math.max(best, SEGMENT_MATCH_SCORE);
    }
  }
  return best;
}

function extractEpisodeNumber(videoTitle, description) {
  const sources = [videoTitle, (description || '').slice(0, 200)];
  for (const src of sources) {
    const t = String(src || '');
    let m = /\bs(\d{1,2})\s*[.e]\s*(\d{1,3})\b/i.exec(t);
    if (m) return { season: Number(m[1]), episode: Number(m[2]) };
    m = /\b(?:ep|episode|part|pt|chapter)\.?\s*(\d{1,3})\b/i.exec(t);
    if (m) return { episode: Number(m[1]) };
    m = /[|\-–—]\s*#?(\d{1,3})\s*$/.exec(t.trim());
    if (m) return { episode: Number(m[1]) };
  }
  return null;
}

function dateScore(publishedAt, airDate) {
  if (!publishedAt || !airDate) return 0.5;
  const pub = Date.parse(publishedAt);
  const air = Date.parse(airDate + 'T12:00:00Z');
  if (!Number.isFinite(pub) || !Number.isFinite(air)) return 0.5;
  const days = Math.abs(pub - air) / 86400000;
  return Math.exp(-((days / 7) ** 2));
}

function daysBetween(publishedAt, airDate) {
  const pub = Date.parse(publishedAt || '');
  const air = Date.parse((airDate || '') + 'T12:00:00Z');
  if (!Number.isFinite(pub) || !Number.isFinite(air)) return Infinity;
  return Math.abs(pub - air) / 86400000;
}

// For each episode key "S:E", the single usable video published within ±3 days
// of its air date (if exactly one exists). Lets generic-title episodes accept a
// video that carries no number: the date alone is unambiguous then.
function nearbyVideoIndex(episodes, videos) {
  const index = new Map();
  for (const ep of episodes) {
    if (!ep.air_date) continue;
    const near = videos.filter(v => v.status === 'ok'
      && !(v.duration_sec > 0 && v.duration_sec < MIN_DURATION_SEC)
      && daysBetween(v.published_at, ep.air_date) <= NEARBY_DAYS);
    if (near.length === 1) index.set(`${ep.season}:${ep.episode}`, near[0].video_id);
  }
  return index;
}

function scorePair(episode, video, ctx) {
  if (video.status !== 'ok') return 0;
  const generic = isGenericEpisodeTitle(episode.episode_title);
  const weights = generic ? GENERIC_TITLE_WEIGHTS : WEIGHTS;
  const title = generic ? 0 : titleScore(episode.episode_title, video.title, ctx);

  // Generic TVDB titles usually carry the series' absolute number ("Episode 11"
  // for S02E01) — that, not the per-season number, is what video titles use.
  let expectedEpisode = episode.episode;
  if (generic) {
    const titleNum = /(\d{1,4})$/.exec(normalize(episode.episode_title));
    if (titleNum) expectedEpisode = Number(titleNum[1]);
  }

  const extracted = extractEpisodeNumber(video.title, video.description);
  let number = 0.5;
  if (extracted) {
    if (extracted.season !== undefined && extracted.season !== episode.season) number = 0;
    else if (extracted.episode === expectedEpisode) number = 1;
    else {
      // A number larger than the season has episodes is an absolute counter
      // ("Episode 48" on a 14-episode season) — not evidence against the match.
      const seasonCount = ctx.seasonCounts ? ctx.seasonCounts.get(episode.season) : undefined;
      number = (extracted.season === undefined && seasonCount && extracted.episode > seasonCount) ? 0.5 : 0;
    }
  }

  const date = dateScore(video.published_at, episode.air_date);

  let position = 0.5;
  if (video.playlist_id && video.position >= 0 && ctx.seasonIndexOf) {
    const idx = ctx.seasonIndexOf.get(`${episode.season}:${episode.episode}`);
    position = idx !== undefined && idx === video.position ? 1 : 0;
  }

  let duration = 1;
  if (video.duration_sec > 0) {
    if (video.duration_sec < MIN_DURATION_SEC) duration = 0;
    else if (ctx.runtimeSec > 0) {
      const ratio = video.duration_sec / ctx.runtimeSec;
      duration = ratio >= 0.4 && ratio <= 2.5 ? 1 : 0;
    }
  }

  let total = weights.title * title + weights.number * number + weights.date * date +
    weights.position * position + weights.duration * duration;

  const nonEpisode = NON_EPISODE_RE.test(video.title || '') && !NON_EPISODE_RE.test(episode.episode_title || '');
  if (nonEpisode) total = Math.max(0, total - NON_EPISODE_PENALTY);

  // Generic title, no number in the video, but it is the only upload around
  // the air date: accept at exactly the threshold.
  if (generic && !extracted && !nonEpisode && date >= 0.9 && ctx.soleNearbyVideo && duration > 0
      && ctx.soleNearbyVideo.get(`${episode.season}:${episode.episode}`) === video.video_id) {
    total = Math.max(total, AUTO_THRESHOLD);
  }
  return total;
}

module.exports = {
  scorePair, titleScore, normalize, stripNoise, extractEpisodeNumber, dateScore, nearbyVideoIndex,
  isGenericEpisodeTitle, acronymsOf, AUTO_THRESHOLD, MIN_DURATION_SEC, NEARBY_DAYS,
};
