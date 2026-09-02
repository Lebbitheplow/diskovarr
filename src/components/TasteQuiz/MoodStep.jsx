import React, { useState, useEffect } from 'react'
import { tasteApi } from '../../services/api'

// `selected` is an array of taste entries ({ kind: 'mood', ... }); each card
// toggles a mood on or off. A mood's sentiment comes from the backend and is
// shown subtly on the card ("more of this" / "less of this").
export default function MoodStep({ selected, onChange }) {
  const [moods, setMoods] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await tasteApi.suggest('mood')
        if (!cancelled) setMoods(data.results || [])
      } catch {
        if (!cancelled) setMoods([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const isSelected = (mood) => selected.some(e => e.entity_id === mood.id)

  const toggle = (mood) => {
    if (isSelected(mood)) {
      onChange(selected.filter(e => e.entity_id !== mood.id))
    } else {
      onChange([...selected, {
        kind: 'mood',
        sentiment: mood.sentiment,
        entity_id: mood.id,
        entity_name: mood.id,
      }])
    }
  }

  if (loading) {
    return <div className="taste-quiz-hint">Loading moods...</div>
  }

  return (
    <div className="taste-mood-grid">
      {moods.map(mood => (
        <button
          key={mood.id}
          type="button"
          className={'taste-mood-card' + (isSelected(mood) ? ' selected' : '')}
          onClick={() => toggle(mood)}
          aria-pressed={isSelected(mood)}
        >
          <div className="taste-mood-label">{mood.label}</div>
          <div className="taste-mood-desc">{mood.description}</div>
          <div className="taste-mood-sentiment">
            {mood.sentiment === 'avoid' ? 'Less of this' : 'More of this'}
          </div>
        </button>
      ))}
    </div>
  )
}
