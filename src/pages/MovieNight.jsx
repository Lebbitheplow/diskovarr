import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { movieNightApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useTranslation, Trans } from 'react-i18next'
import Modal from '../components/Modal'
import UserMultiSelect from '../components/UserMultiSelect'
import { posterUrl } from '../utils/media'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const MODES = [
  { id: 'rolling', emoji: '🔁', desc: 'Pick' },
  { id: 'scheduled', emoji: '📅', desc: 'One night' },
  { id: 'recurring', emoji: '🗓️', desc: 'Themes' },
]

function Avatar({ src, name, emoji, size = 28 }) {
  const style = { width: size, height: size }
  if (emoji) return <span className="mn-avatar mn-avatar-emoji" style={style} aria-hidden="true">{emoji}</span>
  if (src) return <img className="mn-avatar" style={style} src={posterUrl(src)} alt="" />
  return <span className="mn-avatar" style={style}>{(name || '?')[0].toUpperCase()}</span>
}

function ModeBadge({ mode }) {
  const { t } = useTranslation()
  const label = mode === 'scheduled' ? t('Scheduled') : mode === 'recurring' ? t('Recurring') : t('Rolling')
  return <span className={`mn-badge mode-${mode}`}>{label}</span>
}

function GroupCard({ group }) {
  const { t } = useTranslation()
  return (
    <Link to={`/movie-night/${group.id}`} className="mn-card">
      <div className="mn-card-collage">
        {group.posterCollage?.length
          ? group.posterCollage.map((p, i) => <img key={i} src={posterUrl(p)} alt="" loading="lazy" />)
          : <div className="mn-collage-empty">{group.themeEmoji || '🎬'}</div>}
      </div>
      <div className="mn-card-body">
        <div className="mn-card-head">
          {group.themeEmoji && <span className="mn-card-emoji">{group.themeEmoji}</span>}
          <span className="mn-card-name">{group.name}</span>
          {group.isHost && <span className="mn-badge mn-host">{t('Host')}</span>}
        </div>
        <div className="mn-card-meta">
          <ModeBadge mode={group.mode} />
          <span className="mn-badge">{group.memberCount} 👤</span>
          {group.tonightTheme && <span className="mn-badge mode-recurring">🌙 {group.tonightTheme.name}</span>}
        </div>
        <div className="mn-card-avatars">
          {group.members.slice(0, 5).map(m => <Avatar key={m.userId} src={m.avatar} name={m.username} />)}
          {group.memberCount > 5 && <span className="mn-avatar" style={{ fontSize: '0.65rem' }}>+{group.memberCount - 5}</span>}
        </div>
        {group.nextUp && (
          <div className="mn-card-next">
            {t('Tonight')}? <strong>{group.nextUp.forName ? `${group.nextUp.forName}: ` : ''}</strong>{group.nextUp.title}
          </div>
        )}
      </div>
    </Link>
  )
}

function CreateGroupModal({ onClose, candidates, onCreated }) {
  const { t } = useTranslation()
  const { success, error: toastError } = useToast()
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🎬')
  const [mode, setMode] = useState('rolling')
  const [eventAt, setEventAt] = useState('')
  const [rotateMode, setRotateMode] = useState(true)
  const [memberIds, setMemberIds] = useState([])
  const [personas, setPersonas] = useState([])
  const [personaDraft, setPersonaDraft] = useState({ displayName: '', avatarEmoji: '' })
  const [saving, setSaving] = useState(false)

  const addPersona = useCallback(() => {
    const displayName = personaDraft.displayName.trim()
    if (!displayName) return
    setPersonas(prev => [...prev, { displayName, avatarEmoji: personaDraft.avatarEmoji.trim() || null }])
    setPersonaDraft({ displayName: '', avatarEmoji: '' })
  }, [personaDraft])

  const handleCreate = useCallback(async () => {
    if (!name.trim()) { toastError(t('Give your group a name')); return }
    setSaving(true)
    try {
      await movieNightApi.createGroup({
        name: name.trim(),
        themeEmoji: emoji.trim() || null,
        mode,
        eventAt: mode === 'scheduled' && eventAt ? Math.floor(new Date(eventAt).getTime() / 1000) : null,
        rotateMode: mode === 'rolling' ? rotateMode : false,
        memberIds,
        personas,
      })
      success(t('Movie Night created'))
      onCreated()
    } catch (e) {
      toastError(e?.message || t('Failed to create group'))
    } finally {
      setSaving(false)
    }
  }, [name, emoji, mode, eventAt, rotateMode, memberIds, personas, success, toastError, onCreated, t])

  return (
    <Modal isOpen onClose={onClose}>
      <div className="mn-wizard">
        <h2 style={{ margin: 0, fontSize: '1.3rem' }}>{t('New Movie Night')}</h2>

        <div className="mn-field">
          <label>{t('Name')}</label>
          <div className="mn-add-inline">
            <input className="mn-input mn-emoji-input" value={emoji} onChange={e => setEmoji(e.target.value)} maxLength={4} placeholder="🎬" aria-label={t('Emoji')} />
            <input className="mn-input" style={{ flex: 1 }} value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder={t('Friday Night Flicks')} autoFocus />
          </div>
        </div>

        <div className="mn-field">
          <label>{t('Mode')}</label>
          <div className="mn-mode-cards">
            {MODES.map(m => (
              <button key={m.id} type="button" className={`mn-mode-card${mode === m.id ? ' active' : ''}`} onClick={() => setMode(m.id)}>
                <span className="mn-mode-emoji">{m.emoji}</span>
                <span className="mn-mode-name">{t(m.id === 'rolling' ? 'Rolling' : m.id === 'scheduled' ? 'Scheduled' : 'Recurring')}</span>
                <span className="mn-mode-desc">{t(m.desc)}</span>
              </button>
            ))}
          </div>
        </div>

        {mode === 'scheduled' && (
          <div className="mn-field">
            <label>{t('When is the night?')}</label>
            <input type="datetime-local" className="mn-input" value={eventAt} onChange={e => setEventAt(e.target.value)} />
          </div>
        )}

        {mode === 'rolling' && (
          <label className="mn-add-inline" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={rotateMode} onChange={e => setRotateMode(e.target.checked)} />
            <span style={{ fontSize: '0.86rem' }}>{t('Rotate who picks each night')}</span>
          </label>
        )}

        <div className="mn-field">
          <label>{t('Members')}</label>
          <UserMultiSelect options={candidates} value={memberIds} onChange={setMemberIds} label={t('Invite members')} />
        </div>

        <div className="mn-field">
          <label>{t('In-house voters (personas)')}</label>
          <span className="mn-field-hint">{t('Extra voters for people sharing an account — kids, partners, the dog.')}</span>
          <div className="mn-chips-row" style={{ marginTop: 6 }}>
            {personas.map((p, i) => (
              <span key={i} className="mn-chip">
                <span>{p.avatarEmoji || '🙂'}</span> {p.displayName}
                <button className="mn-chip-x" onClick={() => setPersonas(prev => prev.filter((_, idx) => idx !== i))} aria-label={t('Remove')}>×</button>
              </span>
            ))}
          </div>
          <div className="mn-persona-add">
            <input className="mn-input mn-emoji-input" placeholder="🙂" value={personaDraft.avatarEmoji} onChange={e => setPersonaDraft(p => ({ ...p, avatarEmoji: e.target.value }))} maxLength={4} aria-label={t('Emoji')} />
            <input className="mn-input" style={{ flex: 1, minWidth: 120 }} placeholder={t('Name')} value={personaDraft.displayName} onChange={e => setPersonaDraft(p => ({ ...p, displayName: e.target.value }))} maxLength={40}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPersona() } }} />
            <button type="button" className="btn-page" onClick={addPersona}>{t('Add')}</button>
          </div>
        </div>

        <div className="mn-wizard-actions">
          <button className="btn-page" onClick={onClose} disabled={saving}>{t('Cancel')}</button>
          <button className="mn-btn-primary" onClick={handleCreate} disabled={saving || !name.trim()}>
            {saving ? t('Creating...') : t('Create Movie Night')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export default function MovieNight() {
  const { t } = useTranslation()
  const { error: toastError } = useToast()
  const [groups, setGroups] = useState(null)
  const [nights, setNights] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [candidates, setCandidates] = useState([])

  const load = useCallback(async () => {
    try {
      const [{ data: g }, { data: n }] = await Promise.all([
        movieNightApi.getGroups(),
        movieNightApi.getNightly(),
      ])
      setGroups(g.groups || [])
      setNights(n.nights || [])
    } catch (e) {
      toastError(e?.message || t('Failed to load Movie Nights'))
      setGroups([])
    }
  }, [toastError, t])

  useEffect(() => { (async () => { await load() })() }, [load])
  useEffect(() => {
    movieNightApi.getMemberCandidates().then(({ data }) => setCandidates(data.users || [])).catch(() => {})
  }, [])

  const userOptions = useMemo(() => candidates.map(u => ({ id: u.user_id, name: u.username || u.user_id })), [candidates])

  return (
    <div className="mn-page">
      <div className="mn-header">
        <h1 className="mn-title">🎬 {t('Movie Night')}</h1>
        <div className="mn-header-actions">
          <button className="mn-btn-primary" onClick={() => setShowCreate(true)}>+ {t('New Movie Night')}</button>
        </div>
      </div>
      <p className="mn-sub">{t('Gather your people, nominate films, vote, and let the night pick itself.')}</p>

      {nights.length > 0 && (
        <div className="mn-tonight">
          {nights.map(n => (
            <Link key={`${n.groupId}-${n.theme?.id || n.eventAt}`} to={`/movie-night/${n.groupId}`} className="mn-tonight-chip">
              <span className="mn-tonight-emoji">{n.themeEmoji || '🌙'}</span>
              <span>{t('Tonight')}: {n.theme?.name || n.name}</span>
            </Link>
          ))}
        </div>
      )}

      {groups == null ? (
        <div className="mn-empty">{t('Loading...')}</div>
      ) : groups.length === 0 ? (
        <div className="mn-empty">
          <span className="mn-empty-emoji">🍿</span>
          <Trans i18nKey="No Movie Nights yet. Create one to start nominating with your people." t={t} />
          <div style={{ marginTop: 14 }}>
            <button className="mn-btn-primary" onClick={() => setShowCreate(true)}>+ {t('New Movie Night')}</button>
          </div>
        </div>
      ) : (
        <div className="mn-grid">
          {groups.map(g => <GroupCard key={g.id} group={g} />)}
        </div>
      )}

      {showCreate && (
        <CreateGroupModal
          onClose={() => setShowCreate(false)}
          candidates={userOptions}
          onCreated={() => { setShowCreate(false); load() }}
        />
      )}
    </div>
  )
}
