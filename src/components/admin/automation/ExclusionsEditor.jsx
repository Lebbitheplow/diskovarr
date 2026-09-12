import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminAutomation } from '../../../services/adminApi'

// Editable list of { tmdbId, mediaType, title } exclusions. Used for the
// per-list exclusions in the list editor and for the global exclusion list.
// Titles are looked up through /automation/lookup when an id is added.
export default function ExclusionsEditor({ value = [], onChange, defaultMediaType = 'movie' }) {
  const { t } = useTranslation()
  const [tmdbId, setTmdbId] = useState('')
  const [mediaType, setMediaType] = useState(defaultMediaType)
  const [looking, setLooking] = useState(false)
  const [error, setError] = useState(null)

  const add = async () => {
    const id = Number(String(tmdbId).trim())
    if (!id) return setError(t('Enter a TMDB id'))
    if (value.some(e => e.tmdbId === id && e.mediaType === mediaType)) return setError(t('Already excluded'))
    setLooking(true)
    setError(null)
    let title = null
    try {
      const { data } = await adminAutomation.lookup(id, mediaType)
      title = data.year ? `${data.title} (${data.year})` : data.title
    } catch (e) {
      // Unknown to TMDB is still a valid exclusion; keep the bare id.
      if (e.response?.status !== 404) setError(e.response?.data?.error || e.message)
    }
    onChange([...value, { tmdbId: id, mediaType, ...(title ? { title } : {}) }])
    setTmdbId('')
    setLooking(false)
  }

  const remove = (idx) => onChange(value.filter((_, i) => i !== idx))

  return (
    <div>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {value.map((e, i) => (
            <span key={`${e.mediaType}-${e.tmdbId}`} className="btn-admin btn-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'default' }}
              title={`${e.mediaType === 'tv' ? 'TV' : 'Movie'} · TMDB ${e.tmdbId}`}>
              <span style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{e.mediaType === 'tv' ? 'TV' : t('Movie')}</span>
              {e.title || `#${e.tmdbId}`}
              <button onClick={() => remove(i)} aria-label={t('Remove')} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, lineHeight: 1 }}>&times;</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="conn-select" style={{ maxWidth: 110, flex: 'none' }} value={mediaType} onChange={(e) => setMediaType(e.target.value)}>
          <option value="movie">{t('Movie')}</option>
          <option value="tv">{t('TV')}</option>
        </select>
        <input type="number" min="1" className="conn-input" style={{ maxWidth: 140 }} placeholder={t('TMDB id')} value={tmdbId}
          onChange={(e) => { setTmdbId(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        <button className="btn-admin btn-sm" onClick={add} disabled={looking || !tmdbId}>{looking ? t('Looking up…') : t('+ Exclude')}</button>
        {error && <span style={{ color: 'var(--error, #e57373)', fontSize: 12 }}>{error}</span>}
      </div>
      <span className="conn-hint" style={{ display: 'block', marginTop: 4 }}>{t('The TMDB id is the number in a themoviedb.org title URL.')}</span>
    </div>
  )
}
