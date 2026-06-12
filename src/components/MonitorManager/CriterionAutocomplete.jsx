import React, { useState, useEffect, useRef, useCallback } from 'react'
import { monitorsApi } from '../../services/monitorsApi'
import { useTranslation } from 'react-i18next'

const DEBOUNCE_MS = 280

export default function CriterionAutocomplete({ type, value, onChange, placeholder }) {
  const { t } = useTranslation()
  const [input, setInput] = useState(value || '')
  const [options, setOptions] = useState([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [loading, setLoading] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const timerRef = useRef(null)
  const dropdownRef = useRef(null)
  const inputRef = useRef(null)

  // Re-sync local input when the controlled `value` prop changes (render-phase, no effect)
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setInput(value || '')
  }

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const fetchOptions = useCallback(async (query) => {
    if (!query || query.length < 1) {
      setOptions([])
      return
    }
    setLoading(true)
    try {
      const { data } = await monitorsApi.suggestCriteria({ type, q: query, limit: 20 })
      setOptions(data.values || [])
    } catch {
      setOptions([])
    }
    setLoading(false)
  }, [type])

  const handleInput = (e) => {
    const val = e.target.value
    setInput(val)
    setShowDropdown(true)
    setHighlighted(-1)

    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => fetchOptions(val), DEBOUNCE_MS)
  }

  const handleFocus = () => {
    setShowDropdown(true)
    if (input.length >= 1 && options.length === 0) {
      fetchOptions(input)
    }
  }

  const selectOption = (opt) => {
    setInput(opt)
    onChange(opt)
    setShowDropdown(false)
    setHighlighted(-1)
  }

  const handleKeyDown = (e) => {
    if (!showDropdown || options.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted(prev => Math.min(prev + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && highlighted >= 0) {
      e.preventDefault()
      selectOption(options[highlighted])
    } else if (e.key === 'Escape') {
      setShowDropdown(false)
    }
  }

  const visibleOptions = showDropdown && options.length > 0

  return (
    <div className="criterion-autocomplete" ref={dropdownRef}>
      <input
        ref={inputRef}
        type="text"
        className="criterion-input"
        value={input}
        onChange={handleInput}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || 'Type to search...'}
      />
      {loading && <span className="criterion-loading">{t('Searching...')}</span>}
      {visibleOptions && (
        <div className="criterion-dropdown">
          {options.map((opt, i) => (
            <div
              key={opt}
              className={`criterion-option${i === highlighted ? ' highlighted' : ''}`}
              onMouseDown={() => selectOption(opt)}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
