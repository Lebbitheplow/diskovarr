import React, { useState, useEffect, useRef, useCallback } from 'react'
import { tasteApi } from '../../services/api'

// `selected` is an array of taste entries ({ kind: 'title', ... }); tapping a
// poster in the results grid toggles it as a loved title.
export default function TitlesStep({ selected, onChange }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const timerRef = useRef(null)

  const fetchResults = useCallback(async (q) => {
    if (q.length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const { data } = await tasteApi.suggest('title', q)
      setResults(data.results || [])
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    clearTimeout(timerRef.current)
    // fetchResults clears results for queries < 2 chars; debounce both paths
    // through it so no setState runs synchronously in the effect body.
    timerRef.current = setTimeout(() => fetchResults(query.trim()), 300)
    return () => clearTimeout(timerRef.current)
  }, [query, fetchResults])

  const isSelected = (item) =>
    selected.some(e => e.entity_id === String(item.tmdbId) && e.media_type === item.mediaType)

  const toggle = (item) => {
    if (isSelected(item)) {
      onChange(selected.filter(e => !(e.entity_id === String(item.tmdbId) && e.media_type === item.mediaType)))
    } else {
      onChange([...selected, {
        kind: 'title',
        sentiment: 'love',
        entity_id: String(item.tmdbId),
        entity_name: item.title,
        media_type: item.mediaType,
      }])
    }
  }

  const remove = (entry) => {
    onChange(selected.filter(e => !(e.entity_id === entry.entity_id && e.media_type === entry.media_type)))
  }

  return (
    <>
      <input
        type="text"
        className="taste-search-input"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search movies & shows you love..."
      />
      {searching && <p className="taste-quiz-hint" style={{ marginTop: '8px' }}>Searching...</p>}
      {results.length > 0 && (
        <div className="taste-title-grid">
          {results.map(item => (
            <button
              key={`${item.mediaType}-${item.tmdbId}`}
              type="button"
              className={'taste-title-card' + (isSelected(item) ? ' selected' : '')}
              onClick={() => toggle(item)}
              aria-pressed={isSelected(item)}
              title={item.title}
            >
              {item.posterUrl ? (
                <img className="taste-title-poster" src={item.posterUrl} alt="" loading="lazy" />
              ) : (
                <div className="taste-title-poster taste-result-thumb-placeholder">{item.title?.charAt(0) || '?'}</div>
              )}
              {isSelected(item) && <span className="taste-title-check">♥</span>}
              <span className="taste-title-name">{item.title}</span>
              <span className="taste-title-meta">
                {[item.year, item.mediaType === 'tv' ? 'TV' : 'Movie'].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div className="taste-chip-row" style={{ marginTop: '14px' }}>
          {selected.map(entry => (
            <div key={`${entry.media_type}-${entry.entity_id}`} className="taste-selected-chip">
              <span>{entry.entity_name}</span>
              <button type="button" onClick={() => remove(entry)} aria-label={`Remove ${entry.entity_name}`}>✕</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
