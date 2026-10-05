// Seasonal list sources: one movie list per holiday / heritage month, each
// active only inside its date window (MM-DD, may wrap the new year). The
// holidays, windows and source lists mirror Kometa's "seasonal" defaults so a
// library moving off Kometa keeps the same rows. A holiday combines several
// sources (IMDb lists, TMDB collections/movies/keywords, MDBList lists); they
// are concatenated in that order and a failing source never sinks the rest.
const tmdbService = require('../tmdb');
const imdb = require('./imdb');
const mdblist = require('./mdblist');
const criteria = require('./criteria');

const HOLIDAYS = [
  { key: 'years', name: "New Year's Day", start: '12-26', end: '01-04', imdbLists: ['ls066838460'] },
  { key: 'valentine', name: "Valentine's Day", start: '02-01', end: '02-29', imdbLists: ['ls032692441', 'ls000094398', 'ls057783436', 'ls064427905'] },
  { key: 'black_history', name: 'Black History Month', start: '02-01', end: '03-01', imdbLists: ['ls023525790'] },
  { key: 'women', name: "Women's History Month", start: '02-28', end: '03-31', keywords: ["women's rights", "women's suffrage", 'feminism'] },
  { key: 'patrick', name: "St. Patrick's Day", start: '03-01', end: '03-18', imdbLists: ['ls067580975'] },
  { key: 'easter', name: 'Easter', start: '03-20', end: '04-30', imdbLists: ['ls062665509', 'ls051733651'] },
  { key: 'aapi', name: 'Asian American & Pacific Islander Heritage Month', start: '04-30', end: '05-31', mdblists: [{ user: 'k0meta', slug: 'asian-american-pacific-islander-heritage-month' }] },
  { key: 'mother', name: "Mother's Day", start: '05-05', end: '05-10', keywords: ['motherhood', 'pregnancy'] },
  { key: 'memorial', name: 'Memorial Day', start: '05-18', end: '06-07', imdbLists: ['ls526590990'] },
  { key: 'lgbtq', name: 'LGBTQ+ Pride Month', start: '05-31', end: '06-30', imdbLists: ['ls080580859'] },
  { key: 'father', name: "Father's Day", start: '06-15', end: '06-20', keywords: ['fatherhood'] },
  { key: 'independence', name: 'Independence Day', start: '06-23', end: '07-11', imdbLists: ['ls561449172', 'ls541213215', 'ls068664510', 'ls080925875'] },
  { key: 'labor', name: 'Labor Day', start: '09-01', end: '09-10', imdbLists: ['ls002014923'] },
  { key: 'latinx', name: 'Latinx Heritage Month', start: '09-15', end: '10-15', mdblists: [{ user: 'k0meta', slug: 'latinx-heritage-month' }] },
  {
    key: 'halloween', name: 'Halloween', start: '10-01', end: '10-31',
    imdbLists: ['ls546214737', 'ls023118929', 'ls000099714'],
    // Hotel Transylvania, Addams Family (+animated), Conjuring, Halloween,
    // Nightmare on Elm Street, The Mummy, Alien, Ghostbusters, Hocus Pocus
    tmdbCollections: [185103, 11716, 750822, 313086, 91361, 8581, 1733, 8091, 2980, 751156],
    tmdbMovies: [23437],
  },
  { key: 'veteran', name: "Veteran's Day", start: '11-01', end: '11-30', imdbLists: ['ls526590990', 'ls565595526'] },
  { key: 'thanksgiving', name: 'Thanksgiving', start: '11-01', end: '11-30', keywords: ['thanksgiving'] },
  // MDBList needs an API key; the keyword keeps the row alive without one.
  { key: 'christmas', name: 'Christmas', start: '12-01', end: '12-31', mdblists: [{ user: 'k0meta', slug: 'christmas-extravaganza' }], keywords: ['christmas'] },
  { key: 'disabilities', name: 'Day of Persons with Disabilities', start: '12-02', end: '12-04', keywords: ['disability'] },
];

function byKey(key) {
  return HOLIDAYS.find(h => h.key === key) || null;
}

// Same title Kometa gives the collection ("Halloween Movies"), so an existing
// one is adopted instead of duplicated.
function titleFor(holiday) {
  return `${holiday.name} Movies`;
}

async function fetchEntries(holiday, { limit = 500 } = {}) {
  const out = [];
  const errors = [];
  let attempted = 0;
  const run = async (fn) => {
    attempted++;
    try { out.push(...await fn()); } catch (e) { errors.push(e.message); }
  };

  for (const listId of holiday.imdbLists || []) {
    await run(() => imdb.fetchEntries({ kind: 'list', listId }, { limit }));
  }
  for (const id of holiday.tmdbCollections || []) {
    await run(async () => {
      const col = await tmdbService.tmdbFetchPublic(`/collection/${id}`);
      return (col?.parts || []).map(p => ({
        tmdbId: p.id, title: p.title || null, mediaType: 'movie',
        year: parseInt((p.release_date || '').slice(0, 4)) || null,
      }));
    });
  }
  for (const id of holiday.tmdbMovies || []) out.push({ tmdbId: id, mediaType: 'movie' });
  for (const parsed of holiday.mdblists || []) {
    await run(async () => (await mdblist.fetchEntries(parsed, { limit })).filter(e => e.mediaType !== 'tv'));
  }
  if ((holiday.keywords || []).length > 0) {
    // One keyword at a time: an unknown keyword only drops itself.
    for (const keyword of holiday.keywords) {
      await run(() => criteria.fetchEntries(
        { criteria: [{ type: 'keyword', entityName: keyword }], matchMode: 'ANY', mediaType: 'movie' },
        { limit: 100 }
      ));
    }
  }

  if (out.length === 0 && attempted > 0 && errors.length === attempted) {
    throw new Error(`No source for "${holiday.name}" could be fetched: ${errors[0]}`);
  }
  return out.slice(0, limit);
}

module.exports = { HOLIDAYS, byKey, titleFor, fetchEntries };
