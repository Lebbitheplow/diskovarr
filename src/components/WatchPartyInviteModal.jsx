import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { movieNightApi, watchPartyApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { posterUrl } from '../utils/media'
import { isPlexRatingKey } from '../hooks/useCastPlayer'

// Shown from DetailModal's "Watch Together" action: pick who to invite, then
// land on the party page where everyone chooses the TV they are watching on.
export default function WatchPartyInviteModal({ item, onClose }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { error: toastError } = useToast()
  const [users, setUsers] = useState(null)
  const [picked, setPicked] = useState(() => new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    movieNightApi.getMemberCandidates()
      .then(({ data }) => { if (active) setUsers((data.users || []).filter(u => String(u.user_id) !== String(user?.id))) })
      .catch(() => { if (active) setUsers([]) })
    return () => { active = false }
  }, [user?.id])

  const toggle = useCallback((userId) => {
    setPicked(prev => {
      const next = new Set(prev)
      if (!next.delete(userId)) next.add(userId)
      return next
    })
  }, [])

  const handleCreate = useCallback(async () => {
    setBusy(true)
    try {
      const { data } = await watchPartyApi.create({ ratingKey: item.ratingKey, userIds: [...picked] })
      onClose()
      navigate(`/watch-party/${data.party.id}`)
    } catch (e) {
      toastError(e.response?.data?.error || e.message || t('Could not create the watch party'))
      setBusy(false)
    }
  }, [item.ratingKey, picked, onClose, navigate, toastError, t])

  return (
    <Modal isOpen onClose={onClose}>
      <div className="wp-invite">
        <h2>{t('Watch Together')}</h2>
        <p className="mn-sub" style={{ marginBottom: 12 }}>
          {t('Everyone plays {{title}} in their own {{app}} app, and Diskovarr keeps you in sync.', { title: item.title, app: isPlexRatingKey(item.ratingKey) ? 'Plex' : 'Jellyfin' })}
        </p>
        <div className="mn-field">
          <label>{t('Who is watching with you?')}</label>
          <div className="wp-user-list">
            {users == null && <span className="mn-field-hint">{t('Loading...')}</span>}
            {users?.length === 0 && <span className="mn-field-hint">{t('No other users yet.')}</span>}
            {(users || []).map(u => (
              <label key={u.user_id} className={'wp-user-option' + (picked.has(u.user_id) ? ' selected' : '')}>
                <input type="checkbox" checked={picked.has(u.user_id)} onChange={() => toggle(u.user_id)} />
                {u.thumb
                  ? <img className="mn-avatar" src={posterUrl(u.thumb)} alt="" />
                  : <span className="mn-avatar">{(u.username || '?')[0].toUpperCase()}</span>}
                <span>{u.username || u.user_id}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="mn-wizard-actions" style={{ marginTop: 14 }}>
          <button className="btn-page" onClick={onClose} disabled={busy}>{t('Cancel')}</button>
          <button className="mn-btn-primary" onClick={handleCreate} disabled={busy}>
            {busy ? t('Creating...') : picked.size ? t('Send invites') : t('Continue')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
