import React, { useState, useEffect } from 'react'
import { tasteApi } from '../../services/api'
import GenreStep from './GenreStep'
import TitlesStep from './TitlesStep'
import PeopleStep from './PeopleStep'
import MoodStep from './MoodStep'
import './TasteQuiz.css'

const MAX_ENTRIES = 200

const STEPS = [
  { key: 'genres', title: 'What do you like to watch?', subtitle: 'Tap a genre to love it, tap again to avoid it. Every step is optional.' },
  { key: 'titles', title: 'Pick some favorites', subtitle: 'Search for movies and shows you love — they help the most.' },
  { key: 'people', title: 'Anyone you always watch?', subtitle: 'Add favorite actors and directors.' },
  { key: 'moods', title: 'What are you usually in the mood for?', subtitle: 'Pick any that fit. You can change all of this later in Settings.' },
  { key: 'review', title: 'All set?', subtitle: 'Here is what Diskovarr will use to tune your recommendations.' },
]

function ReviewStep({ entries }) {
  if (entries.length === 0) {
    return <p className="taste-quiz-hint">Nothing picked yet — you can go back and add a few things, or finish now and edit your taste profile in Settings anytime.</p>
  }
  const groups = [
    { label: 'Genres you love', items: entries.filter(e => e.kind === 'genre' && e.sentiment === 'love') },
    { label: 'Genres to avoid', items: entries.filter(e => e.kind === 'genre' && e.sentiment === 'avoid') },
    { label: 'Favorite titles', items: entries.filter(e => e.kind === 'title') },
    { label: 'Favorite people', items: entries.filter(e => e.kind === 'person') },
    { label: 'Moods', items: entries.filter(e => e.kind === 'mood') },
  ]
  return (
    <>
      {groups.filter(g => g.items.length > 0).map(g => (
        <div key={g.label} className="taste-review-group">
          <p className="taste-review-label">{g.label}</p>
          <div className="taste-chip-row">
            {g.items.map(e => (
              <div key={`${e.kind}-${e.entity_id || e.entity_name}-${e.media_type || ''}`} className="taste-selected-chip">
                <span>{e.entity_name}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

function TasteQuizInner({ onClose, initialEntries, onSaved, canSkip }) {
  const initial = initialEntries || []
  const [step, setStep] = useState(0)
  const [genres, setGenres] = useState(() => {
    const map = {}
    initial.filter(e => e.kind === 'genre').forEach(e => { map[e.entity_name] = e.sentiment })
    return map
  })
  const [titles, setTitles] = useState(() => initial.filter(e => e.kind === 'title'))
  const [people, setPeople] = useState(() => initial.filter(e => e.kind === 'person'))
  const [moods, setMoods] = useState(() => initial.filter(e => e.kind === 'mood'))
  const [otherEntries] = useState(() => initial.filter(e => !['genre', 'title', 'person', 'mood'].includes(e.kind)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handleEsc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [onClose])

  const buildEntries = () => [
    ...Object.entries(genres).map(([name, sentiment]) => ({ kind: 'genre', sentiment, entity_name: name })),
    ...titles,
    ...people,
    ...moods,
    ...otherEntries,
  ].slice(0, MAX_ENTRIES)

  const handleFinish = async () => {
    setSaving(true)
    setError('')
    const entries = buildEntries()
    try {
      await tasteApi.saveTaste(entries)
      if (onSaved) onSaved(entries)
    } catch (e) {
      setError(e?.message || 'Failed to save your taste profile. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = async () => {
    try {
      await tasteApi.skipQuiz()
    } catch { /* best-effort — don't trap the user in the modal */ }
    onClose()
  }

  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  return (
    <div className="modal-backdrop open" onClick={onClose}>
      <div className="modal-card taste-quiz-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        <div className="taste-quiz-body">
          <div className="taste-quiz-progress" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s.key} className={'taste-quiz-dot' + (i === step ? ' active' : i < step ? ' done' : '')} />
            ))}
            <span className="taste-quiz-step-count">Step {step + 1} of {STEPS.length}</span>
          </div>
          <div>
            <h2 className="taste-quiz-title">{current.title}</h2>
            <p className="taste-quiz-subtitle">{current.subtitle}</p>
          </div>
          <div className="taste-quiz-content">
            {current.key === 'genres' && <GenreStep value={genres} onChange={setGenres} />}
            {current.key === 'titles' && <TitlesStep selected={titles} onChange={setTitles} />}
            {current.key === 'people' && <PeopleStep selected={people} onChange={setPeople} />}
            {current.key === 'moods' && <MoodStep selected={moods} onChange={setMoods} />}
            {current.key === 'review' && <ReviewStep entries={buildEntries()} />}
          </div>
          {error && <p className="taste-quiz-error">{error}</p>}
          <div className="taste-quiz-footer">
            {canSkip && (
              <button type="button" className="taste-quiz-skip" onClick={handleSkip} disabled={saving}>
                Skip for now
              </button>
            )}
            <span className="taste-quiz-footer-spacer" />
            {step > 0 && (
              <button type="button" className="modal-btn modal-btn-watchlist" onClick={() => setStep(s => s - 1)} disabled={saving}>
                Back
              </button>
            )}
            {isLast ? (
              <button type="button" className="modal-btn modal-btn-primary" onClick={handleFinish} disabled={saving}>
                {saving ? 'Saving...' : 'Finish'}
              </button>
            ) : (
              <button type="button" className="modal-btn modal-btn-primary" onClick={() => setStep(s => s + 1)}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Multi-step taste quiz. Mounting is gated on `open` so each opening starts
// fresh from `initialEntries`. `canSkip` should be true only when the user has
// never answered or skipped the quiz (quiz_state === null).
export default function TasteQuizModal({ open, onClose, initialEntries, onSaved, canSkip }) {
  if (!open) return null
  return (
    <TasteQuizInner
      onClose={onClose}
      initialEntries={initialEntries}
      onSaved={onSaved}
      canSkip={canSkip}
    />
  )
}
