import React, { useState } from 'react'
import ToggleSwitch from './ToggleSwitch'

const CONTENT_RATING_ORDER = ['G','PG','PG-13','R','NC-17','TV-G','TV-PG','TV-14','TV-MA']
const SCORE_THRESHOLDS = [
  { label: '★ 9+', value: 9 },
  { label: '★ 8+', value: 8 },
  { label: '★ 7+', value: 7 },
  { label: '★ 6+', value: 6 },
]

export default function FilterBar({
  availableGenres, availableContentRatings,
  filterGenres, filterYearFrom, filterYearTo, filterContentRatings, filterMinScore,
  hideLibrary,
  onGenres, onYearFrom, onYearTo, onContentRatings, onMinScore, onHideLibrary,
}) {
  const [panel, setPanel] = useState(null)

  const toggle = (key) => setPanel(p => p === key ? null : key)
  const toggleGenre = (g) => onGenres(filterGenres.includes(g) ? filterGenres.filter(x => x !== g) : [...filterGenres, g])
  const toggleContentRating = (r) => onContentRatings(filterContentRatings.includes(r) ? filterContentRatings.filter(x => x !== r) : [...filterContentRatings, r])

  const yearActive = filterYearFrom || filterYearTo
  const yearLabel = filterYearFrom && filterYearTo
    ? `${filterYearFrom} – ${filterYearTo}`
    : filterYearFrom ? `After ${filterYearFrom}`
    : filterYearTo ? `Before ${filterYearTo}` : ''

  const contentRatings = CONTENT_RATING_ORDER.filter(r => availableContentRatings.includes(r))

  return (
    <div className="filter-bar">
      <div className="filter-chips-row">
        {/* Genre */}
        <button
          className={`filter-chip${filterGenres.length > 0 ? ' active' : ''}${panel === 'genre' ? ' open' : ''}`}
          onClick={() => toggle('genre')}
        >
          {filterGenres.length > 0 ? `Genre · ${filterGenres.length}` : 'Genre'}
          <span className="filter-chip-caret" />
        </button>

        {/* Year */}
        <button
          className={`filter-chip${yearActive ? ' active' : ''}${panel === 'year' ? ' open' : ''}`}
          onClick={() => toggle('year')}
        >
          {yearActive ? yearLabel : 'Year'}
          <span className="filter-chip-caret" />
        </button>

        {/* Score */}
        <button
          className={`filter-chip${filterMinScore ? ' active' : ''}${panel === 'score' ? ' open' : ''}`}
          onClick={() => toggle('score')}
        >
          {filterMinScore ? `★ ${filterMinScore}+` : 'Score'}
          <span className="filter-chip-caret" />
        </button>

        {/* Content rating — only shown when data available */}
        {contentRatings.length > 0 && (
          <button
            className={`filter-chip${filterContentRatings.length > 0 ? ' active' : ''}${panel === 'content' ? ' open' : ''}`}
            onClick={() => toggle('content')}
          >
            {filterContentRatings.length > 0 ? `Rated · ${filterContentRatings.join(', ')}` : 'Rated'}
            <span className="filter-chip-caret" />
          </button>
        )}

        <div className="filter-chip-divider" />

        <ToggleSwitch checked={hideLibrary} onChange={onHideLibrary} label="Hide in library" />
      </div>

      {/* Genre panel */}
      {panel === 'genre' && (
        <div className="filter-panel">
          {availableGenres.length === 0
            ? <span className="filter-panel-empty">Loading genres…</span>
            : availableGenres.map(g => (
              <button
                key={g}
                className={`filter-pill${filterGenres.includes(g) ? ' active' : ''}`}
                onClick={() => toggleGenre(g)}
              >
                {filterGenres.includes(g) && <span className="filter-pill-check">✓</span>}
                {g}
              </button>
            ))
          }
          {filterGenres.length > 0 && (
            <button className="filter-panel-clear" onClick={() => onGenres([])}>Clear</button>
          )}
        </div>
      )}

      {/* Year panel */}
      {panel === 'year' && (
        <div className="filter-panel filter-panel-year">
          <label className="filter-year-label">
            <span>Start year</span>
            <input
              className="filter-year-input"
              type="number"
              min="1900"
              max={new Date().getFullYear()}
              placeholder="e.g. 1990"
              value={filterYearFrom}
              onChange={e => onYearFrom(e.target.value)}
            />
          </label>
          <span className="filter-year-dash">→</span>
          <label className="filter-year-label">
            <span>End year</span>
            <input
              className="filter-year-input"
              type="number"
              min="1900"
              max={new Date().getFullYear()}
              placeholder={String(new Date().getFullYear())}
              value={filterYearTo}
              onChange={e => onYearTo(e.target.value)}
            />
          </label>
          {yearActive && (
            <button className="filter-panel-clear" style={{ alignSelf: 'flex-end' }} onClick={() => { onYearFrom(''); onYearTo('') }}>Clear</button>
          )}
        </div>
      )}

      {/* Score panel */}
      {panel === 'score' && (
        <div className="filter-panel">
          {SCORE_THRESHOLDS.map(({ label, value }) => (
            <button
              key={value}
              className={`filter-pill${filterMinScore === value ? ' active' : ''}`}
              onClick={() => onMinScore(filterMinScore === value ? null : value)}
            >
              {filterMinScore === value && <span className="filter-pill-check">✓</span>}
              {label}
            </button>
          ))}
          {filterMinScore && (
            <button className="filter-panel-clear" onClick={() => onMinScore(null)}>Clear</button>
          )}
        </div>
      )}

      {/* Content rating panel */}
      {panel === 'content' && (
        <div className="filter-panel">
          {contentRatings.map(r => (
            <button
              key={r}
              className={`filter-pill filter-pill-rating${filterContentRatings.includes(r) ? ' active' : ''}`}
              onClick={() => toggleContentRating(r)}
            >
              {filterContentRatings.includes(r) && <span className="filter-pill-check">✓</span>}
              {r}
            </button>
          ))}
          {filterContentRatings.length > 0 && (
            <button className="filter-panel-clear" onClick={() => onContentRatings([])}>Clear</button>
          )}
        </div>
      )}
    </div>
  )
}
