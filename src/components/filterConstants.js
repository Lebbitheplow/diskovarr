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
