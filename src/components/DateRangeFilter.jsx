import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d) {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

function toUnixSeconds(d) {
  return Math.floor(d.getTime() / 1000)
}

function fromUnixSeconds(sec) {
  return new Date(sec * 1000)
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

function fmtShort(d) {
  return `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`
}

function buildGrid(year, month) {
  // Returns 42 cells (6 weeks) of Date objects, starting from the Sunday on/before day 1.
  const first = new Date(year, month, 1)
  const startDow = first.getDay()
  const start = new Date(year, month, 1 - startDow)
  const cells = []
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  }
  return cells
}

export default function DateRangeFilter({
  value = { from: null, to: null },
  onChange,
  label = 'Date',
  placeholder = 'Any date',
  clearLabel = 'Clear',
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState('range') // 'single' | 'range'
  const containerRef = useRef(null)

  const fromDate = value.from ? fromUnixSeconds(value.from) : null
  const toDate = value.to ? fromUnixSeconds(value.to) : null

  const initialMonth = fromDate || new Date()
  const [viewYear, setViewYear] = useState(initialMonth.getFullYear())
  const [viewMonth, setViewMonth] = useState(initialMonth.getMonth())

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  // When opening, jump to the month of `from` if set, else today. Render-phase
  // adjustment (React's recommended alternative to a state-syncing effect).
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      const anchor = fromDate || new Date()
      setViewYear(anchor.getFullYear())
      setViewMonth(anchor.getMonth())
      // Auto-detect mode based on existing value: distinct days = range, same day = single
      if (fromDate && toDate && !sameDay(fromDate, toDate)) setMode('range')
    }
  }

  const cells = useMemo(() => buildGrid(viewYear, viewMonth), [viewYear, viewMonth])
  const today = useMemo(() => new Date(), [])

  const triggerLabel = useMemo(() => {
    if (!fromDate && !toDate) return placeholder
    if (fromDate && toDate && !sameDay(fromDate, toDate)) {
      return `${fmtShort(fromDate)} – ${fmtShort(toDate)}`
    }
    return fmtShort(fromDate || toDate)
  }, [fromDate, toDate, placeholder])

  const handleCellClick = useCallback((d) => {
    if (mode === 'single') {
      onChange({ from: toUnixSeconds(startOfDay(d)), to: toUnixSeconds(endOfDay(d)) })
      setOpen(false)
      return
    }
    // range mode
    if (!fromDate || (fromDate && toDate)) {
      // start a fresh range
      onChange({ from: toUnixSeconds(startOfDay(d)), to: null })
    } else {
      // we have from but not to
      if (d < fromDate) {
        onChange({ from: toUnixSeconds(startOfDay(d)), to: null })
      } else {
        onChange({ from: value.from, to: toUnixSeconds(endOfDay(d)) })
        setOpen(false)
      }
    }
  }, [mode, fromDate, toDate, value.from, onChange])

  // Plain functions (not useCallback): the prev/next handlers read viewMonth to roll the year
  // over at the Dec/Jan boundary, which the React Compiler can't preserve as a manual memo.
  // Leaving them unmemoized lets the compiler optimize the whole component instead.
  const handlePrev = () => {
    if (viewMonth === 0) setViewYear(y => y - 1)
    setViewMonth(m => (m === 0 ? 11 : m - 1))
  }

  const handleNext = () => {
    if (viewMonth === 11) setViewYear(y => y + 1)
    setViewMonth(m => (m === 11 ? 0 : m + 1))
  }

  const handleClearTrigger = useCallback((e) => {
    e.stopPropagation()
    onChange({ from: null, to: null })
  }, [onChange])

  const handleClearPanel = useCallback(() => {
    onChange({ from: null, to: null })
    setOpen(false)
  }, [onChange])

  const hasValue = !!(value.from || value.to)

  return (
    <div className="date-range-filter" ref={containerRef}>
      <button
        type="button"
        className={`searchable-dropdown-trigger${hasValue ? ' active' : ''}${open ? ' open' : ''}`}
        onClick={() => setOpen(p => !p)}
      >
        <span className="searchable-dropdown-label">{label}</span>
        <span className="searchable-dropdown-value">{triggerLabel}</span>
        {hasValue && (
          <span className="searchable-dropdown-clear" onClick={handleClearTrigger} title="Clear date">&times;</span>
        )}
        <span className="searchable-dropdown-caret" />
      </button>

      {open && (
        <div className="date-range-panel">
          <div className="date-range-mode-toggle">
            <button
              type="button"
              className={`date-range-mode-btn${mode === 'single' ? ' active' : ''}`}
              onClick={() => setMode('single')}
            >Single date</button>
            <button
              type="button"
              className={`date-range-mode-btn${mode === 'range' ? ' active' : ''}`}
              onClick={() => setMode('range')}
            >Range</button>
          </div>

          <div className="date-range-header">
            <button type="button" className="date-range-nav-btn" onClick={handlePrev} aria-label="Previous month">‹</button>
            <span className="date-range-header-label">{MONTH_NAMES[viewMonth]} {viewYear}</span>
            <button type="button" className="date-range-nav-btn" onClick={handleNext} aria-label="Next month">›</button>
          </div>

          <div className="date-range-weekdays">
            {WEEKDAYS.map(w => <div key={w} className="date-range-weekday">{w}</div>)}
          </div>

          <div className="date-range-grid">
            {cells.map((d, i) => {
              const inMonth = d.getMonth() === viewMonth
              const isToday = sameDay(d, today)
              const isFromEndpoint = fromDate && sameDay(d, fromDate)
              const isToEndpoint = toDate && sameDay(d, toDate)
              const isEndpoint = isFromEndpoint || isToEndpoint
              let inRange = false
              if (mode === 'range' && fromDate && toDate && !sameDay(fromDate, toDate)) {
                inRange = d > fromDate && d < toDate
              }
              const cls = ['date-range-cell']
              if (!inMonth) cls.push('muted')
              if (isToday) cls.push('today')
              if (inRange) cls.push('in-range')
              if (isEndpoint) cls.push('endpoint')
              return (
                <button
                  key={i}
                  type="button"
                  className={cls.join(' ')}
                  onClick={() => handleCellClick(d)}
                >{d.getDate()}</button>
              )
            })}
          </div>

          <div className="date-range-footer">
            <span>{mode === 'range' ? (fromDate && !toDate ? 'Pick end date…' : 'Pick a range') : 'Pick a date'}</span>
            <button type="button" className="date-range-clear-btn" onClick={handleClearPanel}>{clearLabel}</button>
          </div>
        </div>
      )}
    </div>
  )
}
