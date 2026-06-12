import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

// Multi-select checkbox filter for the admin watch-history user list.
// `value` is an array of included user ids. Checked = include in results,
// unchecked = exclude. Default state (all checked) is managed by the parent.
export default function UserMultiSelect({
  options = [],
  value = [],
  onChange,
  label = 'Users',
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const containerRef = useRef(null)
  const inputRef = useRef(null)

  const included = useMemo(() => new Set(value.map(String)), [value])
  const allIds = useMemo(() => options.map(o => String(o.id)), [options])

  const filtered = useMemo(() => {
    if (!input.trim()) return options
    const q = input.toLowerCase()
    return options.filter(u => (u.name || '').toLowerCase().includes(q))
  }, [options, input])

  const allChecked = options.length > 0 && included.size >= allIds.length
  const noneChecked = included.size === 0

  const summary = allChecked
    ? 'All users'
    : noneChecked
      ? 'No users'
      : `${included.size} selected`

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  const handleToggle = useCallback(() => {
    setOpen(p => { if (!p) setInput(''); return !p })
  }, [])

  const toggleUser = useCallback((id) => {
    const next = new Set(included)
    const key = String(id)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(Array.from(next))
  }, [included, onChange])

  const selectAll = useCallback(() => onChange([...allIds]), [allIds, onChange])
  const selectNone = useCallback(() => onChange([]), [onChange])

  return (
    <div className="searchable-dropdown user-multiselect" ref={containerRef}>
      <button
        className={`searchable-dropdown-trigger${!allChecked ? ' active' : ''}${open ? ' open' : ''}`}
        onClick={handleToggle}
        type="button"
      >
        <span className="searchable-dropdown-label">{label}</span>
        <span className="searchable-dropdown-value">{summary}</span>
        <span className="searchable-dropdown-caret" />
      </button>

      {open && (
        <div className="searchable-dropdown-panel">
          <div className="searchable-dropdown-input-wrap">
            <input
              ref={inputRef}
              className="searchable-dropdown-input"
              type="text"
              placeholder={t('Search users...')}
              value={input}
              onChange={e => setInput(e.target.value)}
            />
          </div>

          <div className="user-multiselect-toolbar">
            <button type="button" className="user-multiselect-link" onClick={selectAll}>{t('Select all')}</button>
            <button type="button" className="user-multiselect-link" onClick={selectNone}>{t('Clear all')}</button>
          </div>

          <div className="searchable-dropdown-list">
            {filtered.map((item) => {
              const checked = included.has(String(item.id))
              return (
                <label key={item.id} className={`user-multiselect-item${checked ? ' checked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleUser(item.id)}
                  />
                  <span className="user-multiselect-name">{item.name}</span>
                </label>
              )
            })}

            {filtered.length === 0 && (
              <div className="searchable-dropdown-empty">{t('No users found')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
