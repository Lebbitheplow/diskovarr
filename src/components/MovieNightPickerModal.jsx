import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { movieNightApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'

// Modal shown from DetailModal's "+ Movie Night" action. Lists the groups the
// current user belongs to and lets them drop this title into one. In-house
// personas are chosen from within a group's own page (they're group-scoped),
// so the picker adds as "yourself" and links out for persona picks.
export default function MovieNightPickerModal({ item, onClose }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { success, error: toastError } = useToast()
  const [groups, setGroups] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    movieNightApi.getGroups()
      .then(({ data }) => { if (active) setGroups(data.groups || []) })
      .catch(e => { if (active) { toastError(e?.message || t('Failed to load groups')); onClose() } })
    return () => { active = false }
  }, [onClose, toastError, t])

  const selected = useMemo(() => (groups || []).find(g => g.id === selectedId), [groups, selectedId])

  const handleAdd = useCallback(async () => {
    if (!selected) return
    setBusy(true)
    try {
      const { data } = await movieNightApi.addEntry(selected.id, {
        mediaType: item.mediaType || (item.type === 'show' ? 'tv' : 'movie'),
        tmdbId: item.tmdbId ?? null,
        ratingKey: item.ratingKey ?? null,
        title: item.title || item.name,
        year: item.year ?? null,
        thumb: item.thumb ?? null,
      })
      success(data.deduped ? t('Already in {{group}}', { group: selected.name }) : t('Added to {{group}}', { group: selected.name }))
      onClose()
    } catch (e) {
      toastError(e?.message || t('Failed to add to Movie Night'))
    } finally {
      setBusy(false)
    }
  }, [selected, item, success, toastError, onClose, t])

  return (
    <Modal isOpen onClose={onClose}>
      <div className="mn-wizard">
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: '1.2rem' }}>{t('Add to Movie Night')}</h2>
          <p className="mn-sub" style={{ margin: 0 }}>
            {item.title || item.name}{item.year ? ` (${item.year})` : ''}
          </p>
        </div>
        {groups == null ? (
          <div className="mn-empty">{t('Loading...')}</div>
        ) : groups.length === 0 ? (
          <div className="mn-empty">
            <span className="mn-empty-emoji">🎬</span>
            {t("You're not in any Movie Night groups yet.")}
            <div style={{ marginTop: 12 }}>
              <button className="btn-page" onClick={() => { onClose(); navigate('/movie-night') }}>{t('Create a group')}</button>
            </div>
          </div>
        ) : (
          <>
            <div className="mn-field">
              <label>{t('Choose a group')}</label>
              <div className="mn-grid" style={{ gap: 8 }}>
                {groups.map(g => (
                  <button
                    key={g.id}
                    type="button"
                    className={`mn-mode-card${selectedId === g.id ? ' active' : ''}`}
                    style={{ textAlign: 'left', padding: '10px 12px' }}
                    onClick={() => setSelectedId(g.id)}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '1.2rem' }}>{g.themeEmoji || '🎬'}</span>
                      <strong>{g.name}</strong>
                      <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{g.memberCount} 👤</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="mn-wizard-actions">
              <button className="btn-page" onClick={onClose} disabled={busy}>{t('Cancel')}</button>
              <button className="mn-btn-primary" onClick={handleAdd} disabled={!selected || busy}>
                {busy ? t('Adding...') : t('Add to group')}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
