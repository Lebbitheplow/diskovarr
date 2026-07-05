/**
 * Wrapped "Diskovarr personality" — assigns each user an archetype from their
 * genre profile (like Spotify Wrapped's Listening Personality) plus a few
 * behavioral trait chips. Pure functions over payload data.
 */

// Genre keyword → family. Matched against lowercased library genre names.
const FAMILY_KEYWORDS = {
  quest: ['adventure', 'fantasy'],
  scifi: ['science fiction', 'sci-fi'],
  thrill: ['horror', 'thriller', 'suspense'],
  sleuth: ['mystery', 'crime', 'film noir', 'film-noir'],
  comedy: ['comedy', 'stand-up'],
  heart: ['drama', 'romance'],
  scholar: ['documentary', 'history', 'biography', 'news'],
  dreamer: ['animation', 'family', 'kids', 'children', 'anime'],
  action: ['action', 'war', 'western', 'martial arts', 'sport'],
  maestro: ['music', 'musical', 'concert'],
  spectator: ['reality', 'game show', 'talk show', 'food', 'home and garden', 'travel'],
};

const PERSONAS = {
  quest: {
    title: 'The Adventurer',
    blurb: "Adventurers can't stay in one world for long. You chase quests, maps, dragons and destiny — ambitious, curious, and always up for one more journey before bed.",
  },
  scifi: {
    title: 'The Voyager',
    blurb: "Voyagers live a few centuries ahead of everyone else. You're drawn to big ideas, strange futures and the question 'what if?' — an explorer of possibility.",
  },
  thrill: {
    title: 'The Thrill Seeker',
    blurb: 'Thrill Seekers watch through their fingers and love every second. You chase the jump scare, the slow dread, the twist — fear is just excitement wearing a mask.',
  },
  sleuth: {
    title: 'The Detective',
    blurb: "Detectives don't watch stories — they solve them. You clock every clue, suspect everyone, and call the twist twenty minutes early. Impossible to fool.",
  },
  comedy: {
    title: 'The Comedian',
    blurb: 'Comedians know the fastest way through a long day is laughing at it. You collect bits, quote whole scenes from memory, and believe timing is everything.',
  },
  heart: {
    title: 'The Romantic',
    blurb: "Romantics feel it all — the longing looks, the grand gestures, the endings that wreck you. You watch with your whole heart and wouldn't have it any other way.",
  },
  scholar: {
    title: 'The Scholar',
    blurb: 'Scholars treat the screen like a library. You watch to understand — real stories, real history, real people — and leave every credits roll a little wiser.',
  },
  dreamer: {
    title: 'The Dreamer',
    blurb: 'Dreamers never handed in their sense of wonder. You love color, heart and worlds where anything can happen — living proof that growing up is optional.',
  },
  action: {
    title: 'The Daredevil',
    blurb: 'Daredevils like their stories loud. Car chases, last stands, one-liners before the explosion — you came for spectacle and you will not be apologizing.',
  },
  maestro: {
    title: 'The Maestro',
    blurb: "Maestros feel stories in rhythm. You're pulled to music, performance and showmanship — for you, the screen has always been a stage.",
  },
  spectator: {
    title: 'The Insider',
    blurb: 'Insiders love real people and real drama. Competitions, confessionals, eliminations — you know the players, the feuds, and exactly who deserves to win.',
  },
  omnivore: {
    title: 'The Omnivore',
    blurb: 'Omnivores refuse to pick a lane. Horror on Monday, romance on Tuesday, a documentary at 2 AM — your taste is a buffet and you are eating well.',
  },
};

// If the top family holds less than this share of genre-weighted time, the
// user has no dominant lane and gets The Omnivore.
const DOMINANCE_THRESHOLD = 0.3;

function familyOf(genreName) {
  const g = String(genreName || '').toLowerCase();
  for (const [family, keywords] of Object.entries(FAMILY_KEYWORDS)) {
    if (keywords.some((k) => g.includes(k))) return family;
  }
  return null;
}

/** Behavioral trait chips (max 3, in priority order). */
function computeTraits({ time, totals, decade, year }) {
  const traits = [];
  const peak = time?.peakHour;
  if (peak != null && (peak >= 21 || peak <= 4)) {
    traits.push({ key: 'night-owl', label: 'Night Owl', desc: 'most active after dark' });
  } else if (peak != null && peak >= 5 && peak <= 11) {
    traits.push({ key: 'early-bird', label: 'Early Bird', desc: 'watching before the world wakes up' });
  }
  if (time?.streak && time.streak.days >= 7) {
    traits.push({ key: 'marathoner', label: 'Marathoner', desc: `a ${time.streak.days}-day streak` });
  } else if (time?.bingeDay && time.bingeDay.seconds >= 6 * 3600) {
    traits.push({ key: 'binger', label: 'Binger', desc: 'six-hour sittings, no regrets' });
  }
  if ((totals?.completionRate ?? 0) >= 90) {
    traits.push({ key: 'completionist', label: 'Completionist', desc: 'finishes what they start' });
  }
  const movieShare = totals?.seconds ? (totals.movies?.seconds || 0) / totals.seconds : 0;
  if (movieShare > 0.6) {
    traits.push({ key: 'movie-buff', label: 'Movie Buff', desc: 'features over episodes' });
  } else if (movieShare < 0.25 && totals?.shows?.count > 0) {
    traits.push({ key: 'series-devotee', label: 'Series Devotee', desc: 'in it for the long arcs' });
  }
  if (decade?.eligible && year - decade.peakYear >= 25) {
    traits.push({ key: 'time-traveler', label: 'Time Traveler', desc: 'lives in the classics' });
  }
  return traits.slice(0, 3);
}

/**
 * Assign the archetype from seconds-weighted genre families.
 * @param payloadBits { genres: [{name, seconds}], time, totals, decade, year }
 */
function computePersonality({ genres = [], time, totals, decade, year }) {
  const familyTotals = new Map();
  let weighted = 0;
  for (const g of genres) {
    const family = familyOf(g.name);
    if (!family) continue;
    familyTotals.set(family, (familyTotals.get(family) || 0) + (g.seconds || 0));
    weighted += g.seconds || 0;
  }
  let key = 'omnivore';
  if (weighted > 0) {
    const [topFamily, topSeconds] = [...familyTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topSeconds / weighted >= DOMINANCE_THRESHOLD) key = topFamily;
  }
  const persona = PERSONAS[key];
  return {
    key,
    title: persona.title,
    blurb: persona.blurb,
    traits: computeTraits({ time, totals, decade, year }),
  };
}

module.exports = { computePersonality, PERSONAS };
