export const CONTENT_RATING_ORDER = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA']

const EARLIEST_DECADE = 1920
export function buildDecadeOptions() {
  const currentDecade = Math.floor(new Date().getFullYear() / 10) * 10
  const options = [{ label: 'Any', value: '' }]
  for (let d = currentDecade; d >= EARLIEST_DECADE; d -= 10) {
    options.push({ label: `${d}s`, value: String(d) })
  }
  return options
}

export const DECADES = buildDecadeOptions()
export const SCORE_VALUES = [0, 5, 6, 7, 7.5, 8, 8.5, 9, 9.5, 10]

export const SORT_OPTIONS = [
  { value: 'rating', label: 'Highest Rated' },
  { value: 'critic_rating', label: 'Critic Rating' },
  { value: 'content_rating', label: 'Content Rating' },
  { value: 'added', label: 'Recently Added' },
  { value: 'last_episode', label: 'Last Episode Added' },
  { value: 'release_desc', label: 'Release Date (Newest)' },
  { value: 'release_asc', label: 'Release Date (Oldest)' },
  { value: 'year_desc', label: 'Newest First' },
  { value: 'year_asc', label: 'Oldest First' },
  { value: 'duration_desc', label: 'Longest' },
  { value: 'duration_asc', label: 'Shortest' },
  { value: 'unwatched', label: 'Unwatched First' },
  { value: 'user_rating', label: 'Your Rating' },
  { value: 'date_viewed', label: 'Recently Viewed' },
  { value: 'plays', label: 'Most Played' },
  { value: 'title', label: 'A–Z' },
]

export const TYPE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'show', label: 'TV Shows' },
  { value: 'anime', label: 'Anime' },
]

// Tag-style facet filters (multi-select). `searchable` fields are high-cardinality (people)
// and require typing; the rest load their full value list when the panel opens.
export const FACET_FIELDS = [
  { field: 'genre', label: 'Genre', searchable: false },
  { field: 'country', label: 'Country', searchable: false },
  { field: 'collection', label: 'Collection', searchable: false },
  { field: 'studio', label: 'Studio', searchable: false },
  { field: 'edition', label: 'Edition', searchable: false },
  { field: 'label', label: 'Label', searchable: false },
  { field: 'director', label: 'Director', searchable: true },
  { field: 'actor', label: 'Actor', searchable: true },
  { field: 'writer', label: 'Writer', searchable: true },
  { field: 'producer', label: 'Producer', searchable: true },
]
