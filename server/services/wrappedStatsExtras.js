/**
 * Wrapped "fun extras" math — birth decade, percentiles and show buddy.
 * Pure functions over plain values, split from wrappedStats.js for file size
 * and unit-testability (re-exported there).
 */

/**
 * wrapperr-style "estimated birth decade": weight each dated entity by
 * minutes × plays × log10(age+1) (older, harder-to-reach titles weigh more),
 * find the title-year at which cumulative weight crosses 50% ("nostalgia peak"),
 * assume the viewer was ~18 then. Needs ≥5 dated entities to say anything.
 */
function computeBirthDecade(entities, wrappedYear) {
  const dated = [...entities.values()].filter((e) => e.year && e.year >= 1800 && e.year <= wrappedYear + 1);
  if (dated.length < 5) return { eligible: false };

  let total = 0;
  const weightedItems = dated.map((e) => {
    const age = Math.min(100, Math.max(0, wrappedYear - e.year));
    const weight = (e.seconds / 60) * e.plays * Math.max(0.1, Math.log10(age + 1));
    total += weight;
    return { year: e.year, weight, seconds: e.seconds };
  }).sort((a, b) => a.year - b.year);

  let cum = 0;
  let peakYear = weightedItems[weightedItems.length - 1].year;
  for (const item of weightedItems) {
    cum += item.weight;
    if (cum >= total / 2) { peakYear = item.year; break; }
  }
  const birthYear = peakYear - 18;
  const decade = Math.floor(birthYear / 10) * 10;
  // "Taste age": how old someone whose taste formed at the nostalgia peak
  // would be in the wrapped year (assuming taste forms around 18).
  const age = wrappedYear - birthYear;

  // Raw (unweighted) seconds share per title-decade, for a little chart.
  const distTotals = new Map();
  let distSum = 0;
  for (const item of weightedItems) {
    const d = Math.floor(item.year / 10) * 10;
    distTotals.set(d, (distTotals.get(d) || 0) + item.seconds);
    distSum += item.seconds;
  }
  const distribution = [...distTotals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dec, seconds]) => ({ decade: dec, pct: Math.round((seconds / distSum) * 100) }));

  return { eligible: true, decade, peakYear, age, distribution };
}

/** 1-indexed rank → "top X%" (never 0, capped at 100). */
function percentileOfRank(rank, count) {
  if (!count) return null;
  return Math.min(100, Math.max(1, Math.ceil((rank / count) * 100)));
}

/**
 * The other user whose watch time on the show is closest to mine.
 * watchers: Map userId → seconds for that show.
 */
function pickShowBuddy(userId, watchers) {
  const mine = watchers.get(userId);
  if (mine == null) return null;
  let best = null;
  for (const [uid, seconds] of watchers) {
    if (uid === userId) continue;
    const diff = Math.abs(seconds - mine);
    if (!best || diff < best.diff) best = { userId: uid, theirSeconds: seconds, diff };
  }
  if (!best) return null;
  return { userId: best.userId, theirSeconds: best.theirSeconds, mySeconds: mine };
}

module.exports = { computeBirthDecade, percentileOfRank, pickShowBuddy };
