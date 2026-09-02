import React, { useState, useEffect } from 'react'
import { tasteApi } from '../../services/api'

// Each chip cycles neutral → love → avoid → neutral. `value` is a map of
// genre name → sentiment ('love' | 'avoid'); unset means neutral.
export default function GenreStep({ value, onChange }) {
  const [genres, setGenres] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await tasteApi.suggest('genre')
        if (!cancelled) setGenres(data.results || [])
      } catch {
        if (!cancelled) setGenres([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const cycle = (name) => {
    const next = { ...value }
    if (value[name] === 'love') next[name] = 'avoid'
    else if (value[name] === 'avoid') delete next[name]
    else next[name] = 'love'
    onChange(next)
  }

  if (loading) {
    return <div className="taste-quiz-hint">Loading genres...</div>
  }

  return (
    <>
      <div className="taste-chip-row">
        {genres.map(({ name }) => {
          const sentiment = value[name]
          return (
            <button
              key={name}
              type="button"
              className={'taste-genre-chip' + (sentiment ? ' ' + sentiment : '')}
              onClick={() => cycle(name)}
              aria-pressed={!!sentiment}
            >
              {sentiment === 'love' ? '♥ ' : sentiment === 'avoid' ? '⊘ ' : ''}{name}
            </button>
          )
        })}
      </div>
      <p className="taste-quiz-hint" style={{ marginTop: '14px' }}>
        ♥ means more of this, ⊘ means less. Leave anything you don't care about untouched.
      </p>
    </>
  )
}
