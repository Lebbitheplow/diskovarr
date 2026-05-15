import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'

export default function SearchableDropdown({
  options = [],
  value = '',
  onChange,
  placeholder = 'Select...',
  label,
  clearLabel = 'All',
  noResultsLabel = 'No results found',
}) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const containerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const selectedName = useMemo(() => {
    if (!value) return ''
    const found = options.find(u => u.id === value)
    return found ? found.name : value
  }, [value, options])

  const filtered = useMemo(() => {
    if (!input.trim()) return options
    const q = input.toLowerCase()
    return options.filter(u => u.name.toLowerCase().includes(q))
  }, [options, input])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  
  useEffect(() => {
    if (highlightIdx >= 0 && listRef.current) {
      const el = listRef.current.children[highlightIdx]
      if (el) el.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightIdx])

  const handleToggle = useCallback(() => {
    setOpen(p => {
      if (!p) {
        setInput('')
        setHighlightIdx(-1)
      }
      return !p
    })
  }, [])

  const handleSelect = useCallback((id) => {
    onChange(id)
    setOpen(false)
    setInput('')
    setHighlightIdx(-1)
  }, [onChange])

  const handleClear = useCallback((e) => {
    e.stopPropagation()
    onChange('')
  }, [onChange])

  const handleKeyDown = useCallback((e) => {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx(p => Math.min(p + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx(p => Math.max(p - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlightIdx >= 0 && filtered[highlightIdx]) {
        handleSelect(filtered[highlightIdx].id)
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }, [open, filtered, highlightIdx, handleSelect])

  return (
    <div className="searchable-dropdown" ref={containerRef}>
      <button
        className={`searchable-dropdown-trigger${value ? ' active' : ''}${open ? ' open' : ''}`}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        type="button"
      >
        <span className="searchable-dropdown-label">{label}</span>
        <span className="searchable-dropdown-value">
          {value ? selectedName : placeholder}
        </span>
        {value && (
          <span className="searchable-dropdown-clear" onClick={handleClear} title="Clear filter">&times;</span>
        )}
        <span className="searchable-dropdown-caret" />
      </button>

      {open && (
        <div className="searchable-dropdown-panel">
          <div className="searchable-dropdown-input-wrap">
            <input
              ref={inputRef}
              className="searchable-dropdown-input"
              type="text"
              placeholder="Search users..."
              value={input}
              onChange={e => { setInput(e.target.value); setHighlightIdx(-1); }}
              onKeyDown={handleKeyDown}
            />
          </div>

          <div ref={listRef} className="searchable-dropdown-list">
            <button
              className={`searchable-dropdown-item${!value ? ' selected' : ''}`}
              onClick={() => handleSelect('')}
            >
              {clearLabel}
            </button>

            {filtered.map((item, idx) => (
              <button
                key={item.id}
                className={`searchable-dropdown-item${value === item.id ? ' selected' : ''}${highlightIdx === idx ? ' highlighted' : ''}`}
                onClick={() => handleSelect(item.id)}
              >
                {item.name}
              </button>
            ))}

            {filtered.length === 0 && (
              <div className="searchable-dropdown-empty">{noResultsLabel}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
