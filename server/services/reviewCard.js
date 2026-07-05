/**
 * Server-side social share cards for reviews.
 *
 * Layout/rasterization plumbing (satori + resvg, fonts, colors, image inlining)
 * lives in cardKit.js and is shared with the wrapped cards.
 *
 * Two variants are produced:
 *   - og     : 1200×630, the standard Open Graph / Twitter `summary_large_image`.
 *   - square : 1080×1080, for Instagram Stories/Posts and mobile sharing.
 *
 * Spoiler reviews never render their text here — the snippet is replaced with a
 * "Spoiler Review" badge so spoilers can't leak through a public image.
 */
const { COLORS, accentHex, fetchAsDataUri, truncate, el, txt, brandLogoUri, rasterize } = require('./cardKit');

// ── Star row (drawn as an SVG, not an emoji font) ───────────────────────────────
function starRowDataUri(rating, accent) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  const size = 30, gap = 6, count = 5;
  const w = count * size + (count - 1) * gap;
  const star = (cx, cy, r, fill) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const ang = (Math.PI / 5) * i - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.42;
      pts.push(`${(cx + rad * Math.cos(ang)).toFixed(1)},${(cy + rad * Math.sin(ang)).toFixed(1)}`);
    }
    return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
  };
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${size}" viewBox="0 0 ${w} ${size}">`;
  svg += `<defs><clipPath id="half"><rect x="0" y="0" width="${size / 2}" height="${size}"/></clipPath></defs>`;
  for (let i = 0; i < count; i++) {
    const cx = i * (size + gap) + size / 2;
    const cy = size / 2;
    const r = size / 2;
    if (i < full) {
      svg += star(cx, cy, r, accent);
    } else if (i === full && half) {
      svg += star(cx, cy, r, COLORS.border);
      svg += `<g clip-path="url(#half)" transform="translate(${i * (size + gap)},0)">${star(size / 2, cy, r, accent)}</g>`;
    } else {
      svg += star(cx, cy, r, COLORS.border);
    }
  }
  svg += `</svg>`;
  return { uri: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, w, h: size };
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Card tree ────────────────────────────────────────────────────────────────
function buildTree({ posterUri, avatarUri, username, title, year, rating, reviewText, spoiler, dateTs, square, accent }) {
  const stars = starRowDataUri(rating, accent);
  const posterW = square ? 300 : 280;
  const posterH = Math.round(posterW * 1.5);

  const header = el('div', { display: 'flex', alignItems: 'center', gap: 16 }, [
    avatarUri
      ? el('img', { width: 56, height: 56, borderRadius: 28, objectFit: 'cover' }, undefined, avatarUri)
      : el('div', {
          width: 56, height: 56, borderRadius: 28, backgroundColor: accent, color: '#000',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 600,
        }, (username || '?')[0].toUpperCase()),
    el('div', { display: 'flex', flexDirection: 'column' }, [
      txt({ fontSize: 30, fontWeight: 600, color: COLORS.text }, username || 'Someone'),
      txt({ fontSize: 20, color: COLORS.textMuted }, fmtDate(dateTs)),
    ]),
  ]);

  const titleLine = txt(
    { fontSize: square ? 42 : 40, fontWeight: 600, color: COLORS.text, lineHeight: 1.15 },
    year ? `${title} (${year})` : title
  );

  const starsRow = el('img', { width: stars.w, height: stars.h }, undefined, stars.uri);

  const body = spoiler
    ? el('div', {
        display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderRadius: 12,
        backgroundColor: 'rgba(229,160,13,0.12)', border: `1px solid ${accent}`, color: accent,
        fontSize: 26, fontWeight: 600,
      }, [
        // simple warning triangle
        el('img', { width: 30, height: 30 }, undefined,
          `data:image/svg+xml;base64,${Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24"><path d="M12 2 L22 20 H2 Z" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/><rect x="11" y="8" width="2" height="6" fill="${accent}"/><rect x="11" y="16" width="2" height="2" fill="${accent}"/></svg>`
          ).toString('base64')}`),
        'Spoiler Review',
      ])
    : txt(
        { fontSize: square ? 30 : 28, color: COLORS.textDim, lineHeight: 1.4 },
        truncate(reviewText, square ? 180 : 200) || 'No written review.'
      );

  const branding = el('div', { display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto' }, [
    el('img', { width: 30, height: 30 }, undefined, brandLogoUri(accent)),
    txt({ fontSize: 24, fontWeight: 600, color: COLORS.text }, 'Diskovarr'),
  ]);

  const rightCol = el('div', {
    display: 'flex', flexDirection: 'column', gap: square ? 22 : 20, flex: 1,
  }, [header, titleLine, starsRow, body, branding]);

  const poster = posterUri
    ? el('img', { width: posterW, height: posterH, borderRadius: 14, objectFit: 'cover' }, undefined, posterUri)
    : el('div', {
        width: posterW, height: posterH, borderRadius: 14, backgroundColor: COLORS.card,
        border: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: COLORS.textMuted, fontSize: 22,
      }, 'No poster');

  return el('div', {
    display: 'flex',
    flexDirection: square ? 'column' : 'row',
    width: '100%', height: '100%', padding: square ? 64 : 60, gap: square ? 40 : 56,
    backgroundColor: COLORS.bg, alignItems: square ? 'center' : 'flex-start',
    fontFamily: 'Inter',
  }, [poster, rightCol]);
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Render a PNG buffer for a review card.
 * @param cardData normalized review data: { username, avatar, title, year, rating,
 *                 reviewText, spoiler, dateTs, posterPath }
 * @param variant 'og' | 'square'
 */
async function renderPng(cardData, variant = 'og') {
  const square = variant === 'square';
  const width = square ? 1080 : 1200;
  const height = square ? 1080 : 630;
  const accent = accentHex();

  const [posterUri, avatarUri] = await Promise.all([
    fetchAsDataUri(cardData.posterPath),
    fetchAsDataUri(cardData.avatar),
  ]);

  const tree = buildTree({ ...cardData, posterUri, avatarUri, square, accent });
  return rasterize(tree, width, height);
}

module.exports = { renderPng };
