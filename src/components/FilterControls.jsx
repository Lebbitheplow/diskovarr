import React, { useState, useCallback, useEffect, useRef } from 'react'
import { discoverApi } from '../services/api'
import {
  CONTENT_RATING_ORDER, DECADES, SCORE_VALUES, SORT_OPTIONS, TYPE_OPTIONS, FACET_FIELDS,
} from './filterConstants'

const FACET_LABEL = Object.fromEntries(FACET_FIELDS.map(f => [f.field, f.label]))
const FACET_SEARCHABLE = Object.fromEntries(FACET_FIELDS.map(f => [f.field, f.searchable]))
const isFacet = key => key in FACET_LABEL

// Categories tucked behind the "More filters" dropdown (Type/Genre/Score live as inline chips).
const MORE_ORDER = [
  'decade', 'year', 'rated',
  'country', 'collection', 'studio', 'edition', 'label',
  'director', 'actor', 'writer', 'producer',
  'release', 'duration',
]

const CATEGORY_LABEL = {
  type: 'Type', genre: 'Genre', score: 'Min Score', decade: 'Decade',
  year: 'Year', rated: 'Content Rating', release: 'Release Date', duration: 'Runtime',
  ...FACET_LABEL,
}

// A multi-select value editor backed by the /discover/facets endpoint.
function FacetEditor({ field, searchable, selected, onToggle, onClear }) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef(null)

  const fetchOptions = useCallback(async (q) => {
    if (searchable && !q.trim()) { setOptions([]); return }
    setLoading(true)
    try {
      const { data } = await discoverApi.getFacets(field, q)
      setOptions(data.values || [])
    } catch {
      setOptions([])
    } finally {
      setLoading(false)
    }
  }, [field, searchable])

  useEffect(() => {
    ;(async () => { await fetchOptions('') })()
    return () => clearTimeout(debounceRef.current)
  }, [fetchOptions])

  const handleQuery = useCallback((e) => {
    const v = e.target.value
    setQuery(v)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchOptions(v), 200)
  }, [fetchOptions])

  const isActive = useCallback((v) => [...selected].some(s => s.toLowerCase() === v.toLowerCase()), [selected])
  const selectedArr = [...selected]
  const inactiveOptions = options.filter(o => !isActive(o))

  return (
    <div className="filter-editor filter-editor-facet">
      <input
        type="text"
        className="filter-editor-search"
        placeholder={searchable ? `Type to search ${field}s…` : `Filter ${field}s…`}
        value={query}
        onChange={handleQuery}
        autoComplete="off"
      />
      <div className="filter-editor-pills">
        {selectedArr.map(v => (
          <button key={`sel-${v}`} className="filter-pill active" onClick={() => onToggle(field, v)}>
            <span className="filter-pill-check">✓</span>{v}
          </button>
        ))}
        {loading ? (
          <span className="filter-panel-empty">Loading…</span>
        ) : searchable && !query.trim() ? (
          selectedArr.length === 0 && <span className="filter-panel-empty">Type to search</span>
        ) : inactiveOptions.length === 0 && selectedArr.length === 0 ? (
          <span className="filter-panel-empty">No matches</span>
        ) : (
          inactiveOptions.map(v => (
            <button key={v} className="filter-pill" onClick={() => onToggle(field, v)}>{v}</button>
          ))
        )}
      </div>
      {selectedArr.length > 0 && (
        <button className="filter-panel-clear" onClick={() => onClear(field)}>Clear</button>
      )}
    </div>
  )
}

export default function FilterControls({
  search, onSearchChange, onSearchClear,
  type, onType,
  decade, onDecade,
  minScore, onScoreChange, onScoreCommit, onScoreClear,
  sort, onSort,
  contentRatings, availableContentRatings, onToggleContentRating, onClearContentRatings,
  tags, onToggleTag, onClearTag,
  year, onYear,
  releaseFrom, releaseTo, onReleaseFrom, onReleaseTo,
  durationMin, durationMax, onDurationMin, onDurationMax,
  onRangeCommit, onClearAll,
}) {
  const [openMenu, setOpenMenu] = useState(null) // 'type'|'genre'|'score'|'more'|'sort'|null
  const [moreCategory, setMoreCategory] = useState(null)
  const barRef = useRef(null)

  // Close any open popover when clicking outside the filter bar.
  useEffect(() => {
    if (!openMenu) return
    const handler = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) {
        setOpenMenu(null)
        setMoreCategory(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenu])

  const toggle = useCallback((key) => {
    setOpenMenu(o => (o === key ? null : key))
    setMoreCategory(null)
  }, [])

  const commitOnEnter = useCallback((e) => { if (e.key === 'Enter') onRangeCommit() }, [onRangeCommit])

  // Short summary shown next to a category in the More menu (and to decide its active dot).
  const summary = useCallback((key) => {
    if (key === 'type') return type !== 'all' ? TYPE_OPTIONS.find(t => t.value === type)?.label : ''
    if (key === 'genre') return tags.genre?.size ? (tags.genre.size === 1 ? [...tags.genre][0] : `${tags.genre.size} selected`) : ''
    if (key === 'score') return minScore > 0 ? `${minScore}+` : ''
    if (key === 'decade') return decade ? DECADES.find(d => d.value === decade)?.label : ''
    if (key === 'year') return year || ''
    if (key === 'rated') return contentRatings.length ? contentRatings.join(', ') : ''
    if (key === 'release') return (releaseFrom || releaseTo) ? `${releaseFrom || '…'} → ${releaseTo || '…'}` : ''
    if (key === 'duration') return (durationMin || durationMax) ? `${durationMin || '0'}–${durationMax || '∞'}m` : ''
    if (isFacet(key)) {
      const set = tags[key]
      return set?.size ? (set.size === 1 ? [...set][0] : `${set.size} selected`) : ''
    }
    return ''
  }, [type, tags, minScore, decade, year, contentRatings, releaseFrom, releaseTo, durationMin, durationMax])

  // The value editor for a category — reused by both the inline chips and the More drill-down.
  const renderEditor = (key) => {
    if (isFacet(key)) {
      return (
        <FacetEditor
          field={key} searchable={FACET_SEARCHABLE[key]}
          selected={tags[key] || new Set()} onToggle={onToggleTag} onClear={onClearTag}
        />
      )
    }
    if (key === 'type') {
      return (
        <div className="filter-editor filter-editor-pills">
          {TYPE_OPTIONS.map(t => (
            <button key={t.value} className={`filter-pill${type === t.value ? ' active' : ''}`} onClick={() => onType(t.value)}>
              {type === t.value && <span className="filter-pill-check">✓</span>}{t.label}
            </button>
          ))}
        </div>
      )
    }
    if (key === 'decade') {
      return (
        <div className="filter-editor filter-editor-pills">
          {DECADES.map(d => (
            <button key={d.value || 'any'} className={`filter-pill${decade === d.value ? ' active' : ''}`} onClick={() => onDecade(d.value)}>
              {decade === d.value && d.value && <span className="filter-pill-check">✓</span>}{d.label}
            </button>
          ))}
        </div>
      )
    }
    if (key === 'score') {
      return (
        <div className="filter-editor" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
          <input type="range" min="0" max="9" step="1" value={SCORE_VALUES.indexOf(minScore)} className="rating-slider" onChange={onScoreChange} onBlur={onScoreCommit} />
          <div className="rating-ticks">{SCORE_VALUES.map((v, i) => <span key={i}>{v === 0 ? 'Any' : v}</span>)}</div>
          {minScore > 0 && <button className="filter-panel-clear" onClick={onScoreClear}>Clear</button>}
        </div>
      )
    }
    if (key === 'rated') {
      return (
        <div className="filter-editor filter-editor-pills">
          {CONTENT_RATING_ORDER.filter(r => availableContentRatings.includes(r)).map(r => (
            <button key={r} className={`filter-pill filter-pill-rating${contentRatings.includes(r) ? ' active' : ''}`} onClick={() => onToggleContentRating(r)}>
              {contentRatings.includes(r) && <span className="filter-pill-check">✓</span>}{r}
            </button>
          ))}
          {contentRatings.length > 0 && <button className="filter-panel-clear" onClick={onClearContentRatings}>Clear</button>}
        </div>
      )
    }
    if (key === 'year') {
      return (
        <div className="filter-editor" style={{ gap: '8px', alignItems: 'center' }}>
          <input type="number" className="filter-editor-search" style={{ width: '120px' }} placeholder="e.g. 1999"
            value={year} onChange={e => onYear(e.target.value)} onBlur={onRangeCommit} onKeyDown={commitOnEnter} />
          {year && <button className="filter-panel-clear" onClick={() => { onYear(''); onRangeCommit() }}>Clear</button>}
        </div>
      )
    }
    if (key === 'release') {
      return (
        <div className="filter-editor" style={{ gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" className="filter-editor-search" value={releaseFrom} onChange={e => onReleaseFrom(e.target.value)} onBlur={onRangeCommit} />
          <span className="filter-editor-dash">to</span>
          <input type="date" className="filter-editor-search" value={releaseTo} onChange={e => onReleaseTo(e.target.value)} onBlur={onRangeCommit} />
          {(releaseFrom || releaseTo) && <button className="filter-panel-clear" onClick={() => { onReleaseFrom(''); onReleaseTo(''); onRangeCommit() }}>Clear</button>}
        </div>
      )
    }
    if (key === 'duration') {
      return (
        <div className="filter-editor" style={{ gap: '8px', alignItems: 'center' }}>
          <input type="number" className="filter-editor-search" style={{ width: '80px' }} placeholder="Min" value={durationMin} onChange={e => onDurationMin(e.target.value)} onBlur={onRangeCommit} onKeyDown={commitOnEnter} />
          <span className="filter-editor-dash">–</span>
          <input type="number" className="filter-editor-search" style={{ width: '80px' }} placeholder="Max" value={durationMax} onChange={e => onDurationMax(e.target.value)} onBlur={onRangeCommit} onKeyDown={commitOnEnter} />
          <span className="filter-editor-dash">min</span>
          {(durationMin || durationMax) && <button className="filter-panel-clear" onClick={() => { onDurationMin(''); onDurationMax(''); onRangeCommit() }}>Clear</button>}
        </div>
      )
    }
    return null
  }

  // Inline common-filter chip with its own popover editor. Plain function (not a component)
  // so the editor inside isn't remounted — and its search state lost — on parent re-renders.
  const renderCommonChip = (id, fallback) => {
    const sum = summary(id)
    return (
      <div className="filter-dd">
        <button className={`filter-chip${sum ? ' active' : ''}${openMenu === id ? ' open' : ''}`} onClick={() => toggle(id)}>
          {sum ? `${fallback} · ${sum}` : fallback}
          <span className="filter-chip-caret" />
        </button>
        {openMenu === id && <div className="filter-popover">{renderEditor(id)}</div>}
      </div>
    )
  }

  // Categories available in the More menu (content rating only when ratings exist in the pool).
  const moreCategories = MORE_ORDER.filter(k => k !== 'rated' || availableContentRatings.length > 0)
  const moreActiveCount = moreCategories.filter(k => summary(k)).length

  // Removable chips for every applied filter.
  const appliedChips = []
  if (type !== 'all') appliedChips.push({ id: 'type', label: `Type: ${TYPE_OPTIONS.find(t => t.value === type)?.label}`, remove: () => onType('all') })
  if (decade) appliedChips.push({ id: 'decade', label: `Decade: ${DECADES.find(d => d.value === decade)?.label}`, remove: () => onDecade('') })
  if (year) appliedChips.push({ id: 'year', label: `Year: ${year}`, remove: () => { onYear(''); onRangeCommit() } })
  if (minScore > 0) appliedChips.push({ id: 'score', label: `Score: ${minScore}+`, remove: onScoreClear })
  contentRatings.forEach(r => appliedChips.push({ id: `rated-${r}`, label: `Rated: ${r}`, remove: () => onToggleContentRating(r) }))
  FACET_FIELDS.forEach(({ field, label }) => {
    ;[...(tags[field] || [])].forEach(v => appliedChips.push({ id: `${field}-${v}`, label: `${label}: ${v}`, remove: () => onToggleTag(field, v) }))
  })
  if (releaseFrom || releaseTo) appliedChips.push({ id: 'release', label: `Release: ${releaseFrom || '…'}→${releaseTo || '…'}`, remove: () => { onReleaseFrom(''); onReleaseTo(''); onRangeCommit() } })
  if (durationMin || durationMax) appliedChips.push({ id: 'duration', label: `Runtime: ${durationMin || '0'}–${durationMax || '∞'}m`, remove: () => { onDurationMin(''); onDurationMax(''); onRangeCommit() } })

  return (
    <div className="filter-bar" id="filter-bar" ref={barRef}>
      {/* Search input — always visible at the top */}
      <div className="search-input-wrap">
        <svg className="search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" />
          <line x1="12.5" y1="12.5" x2="17" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          type="search" id="filter-search" className="filter-search"
          placeholder="Search titles in library…" autoComplete="off" spellCheck="false"
          value={search} onChange={onSearchChange}
        />
        <button className={'search-clear' + (search ? ' visible' : '')} aria-label="Clear search" onClick={onSearchClear}>✕</button>
      </div>

      {/* Trigger row: common chips + More + Sort */}
      <div className="filter-chips-row">
        {renderCommonChip('type', 'Type')}
        {renderCommonChip('genre', 'Genre')}
        {renderCommonChip('score', 'Score')}

        {/* More filters — nested drill-down menu */}
        <div className="filter-dd">
          <button className={`filter-chip${moreActiveCount > 0 ? ' active' : ''}${openMenu === 'more' ? ' open' : ''}`} onClick={() => toggle('more')}>
            {moreActiveCount > 0 ? `More · ${moreActiveCount}` : '+ More filters'}
            <span className="filter-chip-caret" />
          </button>
          {openMenu === 'more' && (
            <div className="filter-popover filter-popover-menu">
              {moreCategory === null ? (
                moreCategories.map(key => {
                  const sum = summary(key)
                  return (
                    <button key={key} className={`filter-menu-row${sum ? ' has-value' : ''}`} onClick={() => setMoreCategory(key)}>
                      <span className="filter-menu-row-label">{CATEGORY_LABEL[key]}</span>
                      <span className="filter-menu-row-value">{sum}</span>
                      <span className="filter-menu-row-arrow">›</span>
                    </button>
                  )
                })
              ) : (
                <>
                  <button className="filter-menu-back" onClick={() => setMoreCategory(null)}>
                    ‹ Back · {CATEGORY_LABEL[moreCategory]}
                  </button>
                  {renderEditor(moreCategory)}
                </>
              )}
            </div>
          )}
        </div>

        {/* Sort */}
        <div className="filter-dd filter-dd-sort">
          <button className={`filter-chip${openMenu === 'sort' ? ' open' : ''}`} onClick={() => toggle('sort')}>
            ↕ {SORT_OPTIONS.find(s => s.value === sort)?.label || 'Sort'}
            <span className="filter-chip-caret" />
          </button>
          {openMenu === 'sort' && (
            <div className="filter-popover">
              <div className="filter-menu-list">
                {SORT_OPTIONS.map(s => (
                  <button key={s.value} className={`filter-menu-option${sort === s.value ? ' active' : ''}`} onClick={() => { onSort(s.value); setOpenMenu(null) }}>
                    {sort === s.value && <span className="filter-pill-check">✓</span>}{s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Applied filters */}
      {appliedChips.length > 0 && (
        <div className="applied-filters">
          {appliedChips.map(c => (
            <button key={c.id} className="applied-chip" onClick={c.remove} title="Remove filter">
              {c.label}<span className="applied-chip-x">✕</span>
            </button>
          ))}
          <button className="applied-clear" onClick={onClearAll}>Clear all</button>
        </div>
      )}
    </div>
  )
}
