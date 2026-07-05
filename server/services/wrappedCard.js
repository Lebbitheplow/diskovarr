/**
 * Server-side share cards for Diskovarr Wrapped — one card per stat category,
 * rendered with satori + resvg via the shared cardKit. Variants match the
 * review cards: og (1200×630) and square (1080×1080).
 *
 * The tree builders receive ctx = { p (user payload), g (global payload),
 * accent, square, images } and return a satori VDOM for the content area;
 * the header (avatar + "{name}'s {year} Wrapped") and Diskovarr branding
 * footer are shared chrome.
 */
const { COLORS, accentHex, fetchAsDataUri, truncate, el, txt, brandLogoUri, rasterize } = require('./cardKit');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const hoursOf = (s) => Math.round((s || 0) / 3600);
const fmtInt = (n) => (n || 0).toLocaleString('en-US');
const fmtHour = (h) => (h == null ? '' : `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`);
const fmtDay = (iso) => new Date(`${iso}T12:00:00`)
  .toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

// ── Shared building blocks ────────────────────────────────────────────────────

function avatarEl(uri, name, accent, size = 56) {
  return uri
    ? el('img', { width: size, height: size, borderRadius: size / 2, objectFit: 'cover' }, undefined, uri)
    : el('div', {
        width: size, height: size, borderRadius: size / 2, backgroundColor: accent, color: '#000',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: Math.round(size * 0.46), fontWeight: 600,
      }, (name || '?')[0].toUpperCase());
}

function bigStat(value, label, accent, size = 150) {
  return el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center' }, [
    txt({ fontSize: size, fontWeight: 600, color: accent, lineHeight: 1 }, String(value)),
    txt({ fontSize: 30, color: COLORS.textDim, marginTop: 8 }, label),
  ]);
}

function miniStat(value, label) {
  return el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center' }, [
    txt({ fontSize: 44, fontWeight: 600, color: COLORS.text }, String(value)),
    txt({ fontSize: 20, color: COLORS.textMuted, marginTop: 2 }, label),
  ]);
}

function hbar(label, pct, valueText, accent, width) {
  return el('div', { display: 'flex', flexDirection: 'column', width }, [
    el('div', { display: 'flex', justifyContent: 'space-between', marginBottom: 6 }, [
      txt({ fontSize: 26, fontWeight: 600, color: COLORS.text }, label),
      txt({ fontSize: 24, color: COLORS.textDim }, valueText),
    ]),
    el('div', { display: 'flex', width: '100%', height: 18, borderRadius: 9, backgroundColor: COLORS.card }, [
      el('div', {
        width: `${Math.max(3, pct)}%`, height: 18, borderRadius: 9, backgroundColor: accent, display: 'flex',
      }, []),
    ]),
  ]);
}

function posterEl(uri, w) {
  const h = Math.round(w * 1.5);
  return uri
    ? el('img', { width: w, height: h, borderRadius: 12, objectFit: 'cover' }, undefined, uri)
    : el('div', {
        width: w, height: h, borderRadius: 12, backgroundColor: COLORS.card,
        border: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: COLORS.textMuted, fontSize: 18,
      }, 'No poster');
}

function rankedList(items, accent, { width, unit = 'h', startRank = 1 }) {
  return el('div', { display: 'flex', flexDirection: 'column', gap: 12, width }, items.map((it, i) =>
    el('div', { display: 'flex', alignItems: 'center', gap: 12 }, [
      txt({ fontSize: 26, fontWeight: 600, color: accent, width: 34 }, `${startRank + i}`),
      txt({ fontSize: 26, color: COLORS.text, flex: 1 }, truncate(it.title, 32)),
      txt({ fontSize: 22, color: COLORS.textMuted }, unit === 'h' ? `${hoursOf(it.seconds)}h` : `${it.plays}×`),
    ])
  ));
}

// Spotify-style "one big #1" layout shared by the movies and shows cards:
// large poster + big title, with the runners-up and totals as support.
function topOneTree({ p, accent, square }, items, posterUri, kind) {
  const top = items[0];
  if (!top) return txt({ fontSize: 34, color: COLORS.textMuted, margin: 'auto' }, `No ${kind}s this year`);
  const totals = kind === 'movie' ? p.totals.movies : p.totals.shows;
  const totalLine = kind === 'movie'
    ? `${fmtInt(totals.count)} movies · ${fmtInt(hoursOf(totals.seconds))}h this year`
    : `${fmtInt(totals.count)} shows · ${fmtInt(totals.episodes)} episodes · ${fmtInt(hoursOf(totals.seconds))}h this year`;
  return el('div', { display: 'flex', gap: square ? 30 : 52, flex: 1, justifyContent: 'center', alignItems: 'center', flexDirection: square ? 'column' : 'row' }, [
    posterEl(posterUri, square ? 240 : 230),
    el('div', { display: 'flex', flexDirection: 'column', alignItems: square ? 'center' : 'flex-start', gap: 10 }, [
      txt({ fontSize: 34, fontWeight: 600, color: accent }, '#1'),
      txt({ fontSize: square ? 46 : 50, fontWeight: 600, color: COLORS.text, lineHeight: 1.12 }, truncate(top.title, 40)),
      txt({ fontSize: 26, color: COLORS.textDim }, `${fmtInt(hoursOf(top.seconds))}h · ${fmtInt(top.plays)} plays`),
      rankedList(items.slice(1, 4).map((it, i) => ({ ...it, _rank: i + 2 })), accent, { width: square ? 420 : 440, startRank: 2 }),
      txt({ fontSize: 22, color: COLORS.textMuted, marginTop: 6 }, totalLine),
    ]),
  ]);
}

// ── Category trees ────────────────────────────────────────────────────────────

const TREES = {
  hero({ p, accent, square }) {
    const t = p.totals;
    return el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: square ? 44 : 30, flex: 1, justifyContent: 'center' }, [
      bigStat(fmtInt(hoursOf(t.seconds)), 'hours watched', accent, square ? 190 : 150),
      el('div', { display: 'flex', gap: 70 }, [
        miniStat(fmtInt(t.plays), 'plays'),
        miniStat(fmtInt(t.distinctTitles), 'titles'),
        miniStat(fmtInt(t.movies.count), 'movies'),
        miniStat(fmtInt(t.shows.count), 'shows'),
      ]),
    ]);
  },

  movies(ctx) { return topOneTree(ctx, ctx.p.topMovies.bySeconds, ctx.images.topPoster, 'movie'); },

  shows(ctx) { return topOneTree(ctx, ctx.p.topShows.bySeconds, ctx.images.topPoster, 'show'); },

  oldest({ p, accent, square, images }) {
    const o = p.oldest;
    if (!o) return txt({ fontSize: 34, color: COLORS.textMuted, margin: 'auto' }, 'No dated titles this year');
    return el('div', { display: 'flex', gap: square ? 36 : 56, flex: 1, justifyContent: 'center', alignItems: 'center', flexDirection: square ? 'column' : 'row' }, [
      posterEl(images.topPoster, square ? 230 : 210),
      el('div', { display: 'flex', flexDirection: 'column', alignItems: square ? 'center' : 'flex-start', gap: 8 }, [
        txt({ fontSize: 30, color: COLORS.textDim }, 'The oldest thing you watched'),
        txt({ fontSize: square ? 150 : 130, fontWeight: 600, color: accent, lineHeight: 1 }, String(o.year)),
        txt({ fontSize: 36, fontWeight: 600, color: COLORS.text }, truncate(o.title, 34)),
        txt({ fontSize: 26, color: COLORS.textMuted }, `${p.year - o.year} years old when you pressed play`),
      ]),
    ]);
  },

  genres({ p, accent, square }) {
    const top = p.genres.slice(0, 5);
    const max = top.length ? top[0].seconds : 1;
    return el('div', { display: 'flex', flexDirection: 'column', gap: 20, flex: 1, justifyContent: 'center', alignItems: 'center' }, [
      txt({ fontSize: 30, color: COLORS.textDim }, 'Your year looked a lot like'),
      txt({ fontSize: square ? 96 : 84, fontWeight: 600, color: accent, lineHeight: 1.05 }, top.length ? top[0].name : '—'),
      el('div', { display: 'flex', flexDirection: 'column', gap: 18, marginTop: 10 },
        top.slice(1).map((g) => hbar(g.name, Math.round((g.seconds / max) * 100), `${g.pct}%`, accent, square ? 700 : 760))),
    ]);
  },

  time({ p, accent, square }) {
    const months = p.time.months;
    const max = Math.max(...months, 1);
    const chartH = square ? 300 : 240;
    const bars = el('div', { display: 'flex', alignItems: 'flex-end', gap: square ? 16 : 20, height: chartH }, months.map((s, i) =>
      el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }, [
        el('div', {
          width: square ? 48 : 52, height: Math.max(6, Math.round((s / max) * (chartH - 40))),
          borderRadius: 8, backgroundColor: i === months.indexOf(max) ? accent : COLORS.border, display: 'flex',
        }, []),
        txt({ fontSize: 18, color: COLORS.textMuted }, MONTHS[i]),
      ])
    ));
    return el('div', { display: 'flex', flexDirection: 'column', gap: 34, flex: 1, justifyContent: 'center', alignItems: 'center' }, [
      bars,
      txt({ fontSize: 30, color: COLORS.textDim },
        p.time.peakWeekday != null ? `Most active on ${WEEKDAYS[p.time.peakWeekday]}s around ${fmtHour(p.time.peakHour)}` : ''),
    ]);
  },

  binge({ p, accent, square }) {
    const b = p.time.bingeDay;
    const s = p.time.streak;
    return el('div', { display: 'flex', gap: square ? 60 : 100, flex: 1, justifyContent: 'center', alignItems: 'center', flexDirection: square ? 'column' : 'row' }, [
      b ? el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }, [
        bigStat(fmtInt(hoursOf(b.seconds)), 'hours in one day', accent, 120),
        txt({ fontSize: 28, color: COLORS.textDim }, `${fmtDay(b.date)} — your biggest binge`),
      ]) : txt({ fontSize: 30, color: COLORS.textMuted }, 'No binge day'),
      s ? el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }, [
        bigStat(fmtInt(s.days), s.days === 1 ? 'day streak' : 'days in a row', accent, 120),
        txt({ fontSize: 28, color: COLORS.textDim }, `${fmtDay(s.start)} – ${fmtDay(s.end)}`),
      ]) : txt({ fontSize: 30, color: COLORS.textMuted }, 'No streak'),
    ]);
  },

  percentile({ p, accent }) {
    const pc = p.percentile;
    const fan = pc.topShow;
    return el('div', { display: 'flex', flexDirection: 'column', gap: 26, flex: 1, justifyContent: 'center', alignItems: 'center' }, [
      bigStat(`Top ${pc.viewer}%`, `of all ${fmtInt(pc.userCount)} viewers on this server`, accent, 130),
      txt({ fontSize: 30, color: COLORS.textDim }, `#${pc.rank} by hours watched`),
      fan && fan.watcherCount > 1
        ? txt({ fontSize: 28, color: COLORS.textDim }, `Top ${fan.pct}% of ${truncate(fan.title, 30)} fans (#${fan.rank} of ${fan.watcherCount})`)
        : txt({ fontSize: 28, color: COLORS.textMuted }, ''),
    ]);
  },

  decade({ p, accent, square }) {
    const d = p.decade;
    if (!d.eligible) return txt({ fontSize: 34, color: COLORS.textMuted, margin: 'auto' }, 'Not enough titles this year');
    // Fallback for payloads cached before `age` existed.
    const age = d.age ?? (p.year - (d.peakYear - 18));
    const max = Math.max(...d.distribution.map((x) => x.pct), 1);
    return el('div', { display: 'flex', flexDirection: 'column', gap: 26, flex: 1, justifyContent: 'center', alignItems: 'center' }, [
      txt({ fontSize: 34, color: COLORS.textDim }, 'Your taste age is'),
      txt({ fontSize: square ? 170 : 150, fontWeight: 600, color: accent, lineHeight: 1 }, String(age)),
      el('div', { display: 'flex', alignItems: 'flex-end', gap: 14, height: 110 }, d.distribution.map((x) =>
        el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }, [
          el('div', { width: 44, height: Math.max(5, Math.round((x.pct / max) * 80)), borderRadius: 6, backgroundColor: x.decade === Math.floor(d.peakYear / 10) * 10 ? accent : COLORS.border, display: 'flex' }, []),
          txt({ fontSize: 16, color: COLORS.textMuted }, `${String(x.decade).slice(2)}s`),
        ])
      )),
      txt({ fontSize: 24, color: COLORS.textMuted }, `Nostalgia peak: ${d.peakYear} · taste born in the ${d.decade}s`),
    ]);
  },

  buddy({ p, accent, images }) {
    const b = p.buddy;
    if (!b) return txt({ fontSize: 34, color: COLORS.textMuted, margin: 'auto' }, 'No show buddy this year');
    return el('div', { display: 'flex', flexDirection: 'column', gap: 30, flex: 1, justifyContent: 'center', alignItems: 'center' }, [
      el('div', { display: 'flex', gap: 30, alignItems: 'center' }, [
        avatarEl(images.myAvatar, p.user.name, accent, 130),
        txt({ fontSize: 60, color: accent, fontWeight: 600 }, '+'),
        avatarEl(images.buddyAvatar, b.userName, accent, 130),
      ]),
      txt({ fontSize: 36, fontWeight: 600, color: COLORS.text }, `You & ${b.userName}`),
      txt({ fontSize: 28, color: COLORS.textDim }, `Show buddies on ${truncate(b.showTitle, 34)}`),
      txt({ fontSize: 24, color: COLORS.textMuted }, `${fmtInt(hoursOf(b.mySeconds))}h you · ${fmtInt(hoursOf(b.theirSeconds))}h them`),
    ]);
  },

  personality({ p, accent, square }) {
    const per = p.personality;
    if (!per) return txt({ fontSize: 34, color: COLORS.textMuted, margin: 'auto' }, 'No personality this year');
    return el('div', { display: 'flex', flexDirection: 'column', gap: 22, flex: 1, justifyContent: 'center', alignItems: 'center' }, [
      txt({ fontSize: 30, color: COLORS.textDim }, 'Your Diskovarr personality is'),
      txt({ fontSize: square ? 88 : 78, fontWeight: 600, color: accent, lineHeight: 1.05 }, per.title),
      txt({ fontSize: 26, color: COLORS.textDim, lineHeight: 1.45, maxWidth: square ? 820 : 900, textAlign: 'center' }, truncate(per.blurb, 220)),
      per.traits.length
        ? el('div', { display: 'flex', gap: 14, marginTop: 8 }, per.traits.map((tr) =>
            txt({
              padding: '10px 24px', borderRadius: 24, border: `1px solid ${accent}`,
              color: accent, fontSize: 24, fontWeight: 600,
            }, tr.label)))
        : txt({ fontSize: 1, color: COLORS.bg }, ''),
    ]);
  },

  reviews({ p, accent, square }) {
    const r = p.reviews;
    if (!r) return txt({ fontSize: 34, color: COLORS.textMuted, margin: 'auto' }, 'No reviews this year');
    const line = (label, review) => review
      ? el('div', { display: 'flex', alignItems: 'center', gap: 14 }, [
          txt({ fontSize: 24, color: COLORS.textMuted, width: 220 }, label),
          txt({ fontSize: 26, fontWeight: 600, color: COLORS.text }, truncate(review.title, 28)),
          txt({ fontSize: 24, color: accent }, `${review.rating}★`),
        ])
      : null;
    return el('div', { display: 'flex', flexDirection: 'column', gap: 24, flex: 1, justifyContent: 'center', alignItems: 'center' }, [
      bigStat(fmtInt(r.count), r.count === 1 ? 'review written' : 'reviews written', accent, square ? 150 : 130),
      txt({ fontSize: 28, color: COLORS.textDim }, `Average rating ${r.avgRating}★`),
      el('div', { display: 'flex', flexDirection: 'column', gap: 14, marginTop: 6 }, [
        line('Favorite:', r.highest),
        line('Harshest take:', r.lowest),
        line('Most loved:', r.mostLoved),
      ].filter(Boolean)),
    ]);
  },

  activity({ p, accent }) {
    const a = p.activity;
    return el('div', { display: 'flex', flexDirection: 'column', gap: 40, flex: 1, justifyContent: 'center', alignItems: 'center' }, [
      txt({ fontSize: 34, fontWeight: 600, color: COLORS.text }, 'Your year on Diskovarr'),
      el('div', { display: 'flex', gap: 80 }, [
        bigStat(fmtInt(a.requests), 'requests', accent, 90),
        bigStat(fmtInt(a.reviews), 'reviews', accent, 90),
        bigStat(a.avgRating != null ? `${a.avgRating}★` : '—', 'avg rating', accent, 90),
        bigStat(fmtInt(a.reactionsReceived), 'reactions', accent, 90),
      ]),
    ]);
  },

  leaderboard({ p, g, accent, images }) {
    const rows = (g ? g.leaderboard : []).slice(0, 5);
    return el('div', { display: 'flex', flexDirection: 'column', gap: 18, flex: 1, justifyContent: 'center', alignItems: 'center' }, [
      txt({ fontSize: 32, fontWeight: 600, color: COLORS.text }, 'Server leaderboard'),
      ...rows.map((u, i) => el('div', {
        display: 'flex', alignItems: 'center', gap: 18, width: 760, padding: '10px 22px', borderRadius: 14,
        backgroundColor: u.userId === p.user.id ? 'rgba(255,255,255,0.07)' : COLORS.card,
        border: `1px solid ${u.userId === p.user.id ? accent : COLORS.border}`,
      }, [
        txt({ fontSize: 30, fontWeight: 600, color: accent, width: 44 }, `${i + 1}`),
        avatarEl(images.leaderAvatars[i], u.userName, accent, 48),
        txt({ fontSize: 28, fontWeight: 600, color: COLORS.text, flex: 1 }, truncate(u.userName, 24)),
        txt({ fontSize: 26, color: COLORS.textDim }, `${fmtInt(hoursOf(u.seconds))}h`),
      ])),
    ]);
  },
};

const CATEGORIES = Object.keys(TREES);

// ── Chrome + render ───────────────────────────────────────────────────────────

function buildCard(ctx) {
  const { p, accent, square, images, category } = ctx;
  const header = el('div', { display: 'flex', alignItems: 'center', gap: 16 }, [
    avatarEl(images.myAvatar, p.user.name, accent, 56),
    el('div', { display: 'flex', flexDirection: 'column' }, [
      txt({ fontSize: 30, fontWeight: 600, color: COLORS.text }, `${p.user.name}'s ${p.year} Wrapped`),
      txt({ fontSize: 20, color: COLORS.textMuted }, categoryLabel(category)),
    ]),
  ]);
  const branding = el('div', { display: 'flex', alignItems: 'center', gap: 10 }, [
    el('img', { width: 30, height: 30 }, undefined, brandLogoUri(accent)),
    txt({ fontSize: 24, fontWeight: 600, color: COLORS.text }, 'Diskovarr'),
  ]);
  return el('div', {
    display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
    padding: square ? 60 : 50, gap: 20, backgroundColor: COLORS.bg, fontFamily: 'Inter',
  }, [header, TREES[category](ctx), branding]);
}

function categoryLabel(category) {
  return {
    hero: 'A year in hours', movies: 'Top movie', shows: 'Top show',
    oldest: 'Blast from the past', genres: 'Top genres',
    time: 'When the watching happened', binge: 'Binges & streaks',
    percentile: 'Viewer ranking', decade: 'Taste age', buddy: 'Show buddy',
    personality: 'Diskovarr personality', reviews: 'The critic',
    activity: 'Diskovarr activity', leaderboard: 'Server leaderboard',
  }[category] || 'Wrapped';
}

/**
 * Render a PNG for one Wrapped stat category.
 * @param data { payload, global } from wrappedStats.getWrappedBySlug
 * @param category one of CATEGORIES
 * @param variant 'og' | 'square'
 */
async function renderPng(data, category, variant = 'og') {
  if (!TREES[category]) throw new Error(`Unknown wrapped category: ${category}`);
  const square = variant === 'square';
  const accent = accentHex();
  const p = data.payload;
  const g = data.global;

  const images = { myAvatar: await fetchAsDataUri(p.user.thumb) };
  if (category === 'movies') {
    images.topPoster = await fetchAsDataUri(p.topMovies.bySeconds[0]?.thumb);
  } else if (category === 'shows') {
    images.topPoster = await fetchAsDataUri(p.topShows.bySeconds[0]?.thumb);
  } else if (category === 'oldest') {
    images.topPoster = await fetchAsDataUri(p.oldest?.thumb);
  } else if (category === 'buddy' && p.buddy) {
    images.buddyAvatar = await fetchAsDataUri(p.buddy.userThumb);
  } else if (category === 'leaderboard') {
    images.leaderAvatars = await Promise.all(
      (g ? g.leaderboard : []).slice(0, 5).map((u) => fetchAsDataUri(u.userThumb))
    );
  }
  images.leaderAvatars = images.leaderAvatars || [];

  const tree = buildCard({ p, g, accent, square, images, category });
  return rasterize(tree, square ? 1080 : 1200, square ? 1080 : 630);
}

module.exports = { renderPng, CATEGORIES };
