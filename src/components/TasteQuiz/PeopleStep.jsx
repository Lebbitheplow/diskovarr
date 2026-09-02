import React, { useState, useEffect, useRef, useCallback } from 'react'
import { tasteApi } from '../../services/api'

// `selected` is an array of taste entries ({ kind: 'person', ... }); picking a
// search result adds them as a favorite actor/director chip.
export default function PeopleStep({ selected, onChange }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const timerRef = useRef(null)
  const dropdownRef = useRef(null)
  const inputRef = useRef(null)

  const fetchResults = useCallback(async (q) => {
    if (q.length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const { data } = await tasteApi.suggest('person', q)
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

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) &&
          inputRef.current && !inputRef.current.contains(e.target)) {
        setResults([])
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const isSelected = (item) => selected.some(e => e.entity_id === String(item.tmdbId))

  const add = (item) => {
    if (isSelected(item)) return
    onChange([...selected, {
      kind: 'person',
      sentiment: 'love',
      entity_id: String(item.tmdbId),
      entity_name: item.name,
    }])
    setQuery('')
    setResults([])
  }

  const remove = (entry) => {
    onChange(selected.filter(e => e.entity_id !== entry.entity_id))
  }

  return (
    <>
      <div className="taste-search-wrap">
        <input
          ref={inputRef}
          type="text"
          className="taste-search-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search actors & directors..."
        />
        {results.length > 0 && (
          <div ref={dropdownRef} className="taste-result-list">
            {results.map(item => (
              <div
                key={item.tmdbId}
                className={'taste-result-row' + (isSelected(item) ? ' selected' : '')}
                onMouseDown={e => { e.preventDefault(); add(item) }}
              >
                {item.profileUrl ? (
                  <img className="taste-result-thumb round" src={item.profileUrl} alt="" loading="lazy" />
                ) : (
                  <div className="taste-result-thumb round taste-result-thumb-placeholder">{item.name?.charAt(0) || '?'}</div>
                )}
                <div className="taste-result-text">
                  <div className="taste-result-title">{item.name}</div>
                  {item.knownFor?.length > 0 && (
                    <div className="taste-result-meta">{item.knownFor.join(', ')}</div>
                  )}
                </div>
                {isSelected(item) && <span className="taste-result-meta">Added</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {searching && <p className="taste-quiz-hint" style={{ marginTop: '8px' }}>Searching...</p>}
      {selected.length > 0 && (
        <div className="taste-chip-row" style={{ marginTop: '14px' }}>
          {selected.map(entry => (
            <div key={entry.entity_id} className="taste-selected-chip">
              <span>{entry.entity_name}</span>
              <button type="button" onClick={() => remove(entry)} aria-label={`Remove ${entry.entity_name}`}>✕</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
