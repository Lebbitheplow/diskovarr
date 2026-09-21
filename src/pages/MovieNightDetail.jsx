import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { movieNightApi, searchApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from 'react-i18next'
import Modal from '../components/Modal'
import UserMultiSelect from '../components/UserMultiSelect'
import MovieNightComments, { IdentityPicker } from '../components/MovieNightComments'
import { posterUrl } from '../utils/media'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function Avatar({ src, name, emoji, size = 28 }) {
  const style = { width: size, height: size }
  if (emoji) return <span className="mn-avatar mn-avatar-emoji" style={style} aria-hidden="true">{emoji}</span>
  if (src) return <img className="mn-avatar" style={style} src={posterUrl(src)} alt="" />
  return <span className="mn-avatar" style={style}>{(name || '?')[0].toUpperCase()}</span>
}

function ModeBadge({ mode, eventAt }) {
  const { t } = useTranslation()
  const label = mode === 'scheduled' ? t('Scheduled') : mode === 'recurring' ? t('Recurring') : t('Rolling')
  const when = mode === 'scheduled' && eventAt ? new Date(eventAt * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null
  return (
    <span className={`mn-badge mode-${mode}`}>
      {mode === 'scheduled' ? '📅 ' : mode === 'recurring' ? '🗓️ ' : '🔁 '}{label}{when ? ` · ${when}` : ''}
    </span>
  )
}

// ── Add entry: search the library/TMDB and drop a title into the group ──────
function AddEntryBar({ groupId, personas, onAdded }) {
  const { t } = useTranslation()
  const { error: toastError } = useToast()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const [personaId, setPersonaId] = useState(null)
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    const handle = setTimeout(() => {
      if (!query.trim()) { setResults([]); setOpen(false); return }
      setSearching(true)
      searchApi.search(query.trim(), 1)
        .then(({ data }) => { setResults((data.results || []).slice(0, 12)); setOpen(true) })
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 350)
    return () => clearTimeout(handle)
  }, [query])

  const add = useCallback(async (item) => {
    setBusyId(item.tmdbId || `${item.title}-${item.year}`)
    try {
      const { data } = await movieNightApi.addEntry(groupId, {
        mediaType: item.mediaType || 'movie',
        tmdbId: item.tmdbId ?? null,
        ratingKey: item.ratingKey ?? null,
        title: item.title,
        year: item.year ?? null,
        thumb: item.posterUrl ?? null,
        personaId: personaId || undefined,
      })
      onAdded(data.entry, data.deduped)
      if (data.deduped) toastError(t('Already in the list'))
      setQuery(''); setResults([]); setOpen(false)
    } catch (e) {
      toastError(e?.message || t('Failed to add'))
    } finally { setBusyId(null) }
  }, [groupId, personaId, onAdded, toastError, t])

  return (
    <div style={{ position: 'relative' }}>
      <div className="mn-add-inline" style={{ gap: 8 }}>
        <input
          className="mn-input"
          style={{ flex: 1 }}
          placeholder={t('Search a title to nominate…')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
        />
        {personas.length > 0 && <IdentityPicker personas={personas} personaId={personaId} onChange={setPersonaId} label={t('As…')} />}
      </div>
      {searching && <div style={{ padding: '6px 10px', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{t('Searching…')}</div>}
      {open && results.length > 0 && (
        <div className="mn-persona-list" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, bottom: 'auto', zIndex: 40, maxHeight: 320 }}>
          {results.map((item, i) => (
            <button
              key={`${item.tmdbId || ''}-${item.title}-${i}`}
              type="button"
              className="mn-persona-option"
              onClick={() => add(item)}
              disabled={!!busyId}
            >
              {item.posterUrl
                ? <img src={posterUrl(item.posterUrl)} alt="" style={{ width: 28, height: 42, objectFit: 'cover', borderRadius: 4, background: 'var(--bg-secondary)' }} />
                : <span className="mn-avatar" style={{ width: 28, height: 42, borderRadius: 4 }}>{(item.title || '?')[0]}</span>}
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{item.title}</span>
                <span className="mn-persona-sub">{[item.year, item.mediaType === 'tv' ? t('TV') : t('Movie')].filter(Boolean).join(' · ')}</span>
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontWeight: 600 }}>{busyId === (item.tmdbId || `${item.title}-${item.year}`) ? '…' : '+ ' + t('Nominate')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── One nominated title with votes, actions and comments ────────────────────
function EntryRow({ entry, personas, isPrivileged, isHost, me, myVote, onVote, onWatched, onCancel }) {
  const { t } = useTranslation()
  const [showComments, setShowComments] = useState(false)
  const [personaId, setPersonaId] = useState(null)
  const [commentCount, setCommentCount] = useState(entry.commentCount || 0)

  const canManage = isPrivileged || isHost || entry.addedBy === me
  const upActive = myVote === 1
  const downActive = myVote === -1

  return (
    <div className={`mn-entry ${entry.status === 'watched' ? 'watched' : ''} ${entry.status === 'cancelled' ? 'cancelled' : ''}`}>
      {entry.thumb
        ? <img className="mn-entry-poster" src={posterUrl(entry.thumb)} alt="" loading="lazy" />
        : <div className="mn-entry-poster" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>{entry.title?.[0] || '?'}</div>}
      <div className="mn-entry-main">
        <div className="mn-entry-title">
          {entry.title} {entry.year && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({entry.year})</span>}
          {entry.mediaType === 'tv' && <span className="mn-badge">TV</span>}
          {entry.status === 'watched' && <span className="mn-watched-tag">✓ {t('Watched')}</span>}
        </div>
        <div className="mn-entry-sub">
          <span>{t('Added by')} <strong style={{ color: 'var(--text-primary)' }}>{entry.persona?.name || entry.addedByUsername}</strong></span>
          {entry.persona && <span className="mn-badge">{entry.persona.emoji || '🙂'} {entry.persona.name}</span>}
        </div>
        <div className="mn-entry-actions">
          {commentCount > 0 || showComments ? (
            <button className="mn-link-btn" onClick={() => setShowComments(s => !s)}>
              💬 {commentCount} {commentCount === 1 ? t('comment') : t('comments')}
            </button>
          ) : (
            <button className="mn-link-btn" onClick={() => setShowComments(true)}>💬 {t('Comment')}</button>
          )}
          {canManage && entry.status === 'active' && (
            <button className="mn-link-btn" onClick={() => onWatched(entry)}>{t('✓ Watched')}</button>
          )}
          {canManage && entry.status === 'active' && (
            <button className="mn-link-btn danger" onClick={() => onCancel(entry)}>{t('Remove')}</button>
          )}
          {canManage && entry.status !== 'active' && (
            <button className="mn-link-btn" onClick={() => onCancel(entry, 'active')}>{t('Restore')}</button>
          )}
        </div>
        {showComments && (
          <div className="mn-comments-wrap" key={entry.id}>
            <MovieNightComments entryId={entry.id} personas={personas} onCountChange={(d) => setCommentCount(c => Math.max(0, c + d))} />
          </div>
        )}
      </div>
      {entry.status === 'active' && (
        <div className="mn-votes">
          <button className={`mn-vote-btn up${upActive ? ' active' : ''}`} onClick={() => onVote(entry, upActive ? 0 : 1, personaId)} aria-label={t('Upvote')}>▲</button>
          <span className={`mn-vote-net ${entry.netVotes > 0 ? 'pos' : entry.netVotes < 0 ? 'neg' : ''}`}>{entry.netVotes > 0 ? `+${entry.netVotes}` : entry.netVotes}</span>
          <button className={`mn-vote-btn down${downActive ? ' active' : ''}`} onClick={() => onVote(entry, downActive ? 0 : -1, personaId)} aria-label={t('Downvote')}>▼</button>
          {personas.length > 0 && <IdentityPicker personas={personas} personaId={personaId} onChange={setPersonaId} />}
        </div>
      )}
    </div>
  )
}

// ── Host-only group settings ────────────────────────────────────────────────
function SettingsModal({ group, onClose, onSaved }) {
  const { t } = useTranslation()
  const { success, error: toastError } = useToast()
  const [name, setName] = useState(group.name)
  const [emoji, setEmoji] = useState(group.themeEmoji || '')
  const [mode, setMode] = useState(group.mode)
  const [eventAt, setEventAt] = useState(group.eventAt ? new Date(group.eventAt * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')
  const [rotateMode, setRotateMode] = useState(!!group.rotateMode)
  const [busy, setBusy] = useState(false)

  const save = useCallback(async () => {
    setBusy(true)
    try {
      await movieNightApi.updateGroup(group.id, {
        name: name.trim(), themeEmoji: emoji.trim() || null, mode,
        eventAt: mode === 'scheduled' && eventAt ? Math.floor(new Date(eventAt).getTime() / 1000) : null,
        rotateMode: mode === 'rolling' ? rotateMode : false,
      })
      success(t('Saved'))
      onSaved()
    } catch (e) { toastError(e?.message || t('Failed to save')); } finally { setBusy(false) }
  }, [group.id, name, emoji, mode, eventAt, rotateMode, success, toastError, onSaved, t])

  const destroy = useCallback(async () => {
    if (!window.confirm(t('Delete this Movie Night? This cannot be undone.'))) return
    setBusy(true)
    try { await movieNightApi.deleteGroup(group.id); success(t('Movie Night deleted')); window.location.assign('/movie-night') }
    catch (e) { toastError(e?.message || t('Failed to delete')); setBusy(false) }
  }, [group.id, success, toastError, t])

  return (
    <Modal isOpen onClose={onClose}>
      <div className="mn-wizard">
        <h2 style={{ margin: 0, fontSize: '1.2rem' }}>{t('Group settings')}</h2>
        <div className="mn-field">
          <label>{t('Name')}</label>
          <div className="mn-add-inline">
            <input className="mn-input mn-emoji-input" value={emoji} onChange={e => setEmoji(e.target.value)} maxLength={4} aria-label={t('Emoji')} />
            <input className="mn-input" style={{ flex: 1 }} value={name} onChange={e => setName(e.target.value)} maxLength={80} />
          </div>
        </div>
        <div className="mn-field">
          <label>{t('Mode')}</label>
          <div className="mn-mode-cards">
            {['rolling', 'scheduled', 'recurring'].map(m => (
              <button key={m} type="button" className={`mn-mode-card${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
                <span className="mn-mode-emoji">{m === 'rolling' ? '🔁' : m === 'scheduled' ? '📅' : '🗓️'}</span>
                <span className="mn-mode-name">{t(m === 'rolling' ? 'Rolling' : m === 'scheduled' ? 'Scheduled' : 'Recurring')}</span>
              </button>
            ))}
          </div>
        </div>
        {mode === 'scheduled' && (
          <div className="mn-field"><label>{t('When is the night?')}</label>
            <input type="datetime-local" className="mn-input" value={eventAt} onChange={e => setEventAt(e.target.value)} /></div>
        )}
        {mode === 'rolling' && (
          <label className="mn-add-inline" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={rotateMode} onChange={e => setRotateMode(e.target.checked)} />
            <span style={{ fontSize: '0.86rem' }}>{t('Rotate who picks each night')}</span>
          </label>
        )}
        <div className="mn-wizard-actions" style={{ justifyContent: 'space-between' }}>
          <button className="btn-page" style={{ color: '#f87171', borderColor: 'rgba(248,113,113,0.4)' }} onClick={destroy} disabled={busy}>{t('Delete group')}</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-page" onClick={onClose} disabled={busy}>{t('Cancel')}</button>
            <button className="mn-btn-primary" onClick={save} disabled={busy}>{t('Save')}</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export default function MovieNightDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { user } = useAuth()
  const { error: toastError } = useToast()

  const [group, setGroup] = useState(null)
  const [members, setMembers] = useState([])
  const [personas, setPersonas] = useState([])
  const [themes, setThemes] = useState([])
  const [nextPick, setNextPick] = useState(null)
  const [entries, setEntries] = useState(null)
  const [status, setStatus] = useState('active')
  const [voteState, setVoteState] = useState({})
  const [candidates, setCandidates] = useState([])
  const [showSettings, setShowSettings] = useState(false)

  const loadAll = useCallback(async () => {
    try {
      const [{ data: g }, { data: e }, { data: n }] = await Promise.all([
        movieNightApi.getGroup(id),
        movieNightApi.getEntries(id, { status }),
        movieNightApi.getNext(id).catch(() => ({ data: {} })),
      ])
      setGroup(g.group); setMembers(g.members || []); setPersonas(g.personas || []); setThemes(g.themes || [])
      setEntries(e.entries || [])
      setNextPick(g.group?.rotateMode ? n : null)
    } catch (err) {
      if (err?.status === 403 || err?.status === 404) { toastError(t('Group not found')); navigate('/movie-night'); return }
      toastError(err?.message || t('Failed to load'))
    }
  }, [id, status, navigate, toastError, t])

  useEffect(() => { (async () => { await loadAll() })() }, [loadAll])
  useEffect(() => { movieNightApi.getMemberCandidates().then(({ data }) => setCandidates(data.users || [])).catch(() => {}) }, [])

  const isHost = !!group?.isHost
  const isPrivileged = !!(user?.isAdmin || user?.isElevated || user?.isPrivileged)
  const userOptions = useMemo(() => candidates.map(u => ({ id: u.user_id, name: u.username || u.user_id })), [candidates])

  // Server sends our own (persona-less) vote with each entry; persona votes are
  // tracked only for this session's interactions and overlay the server value.
  const myVoteFor = useCallback((entry) => {
    const k = `${entry.id}|self`
    return k in voteState ? voteState[k] : entry.userVote
  }, [voteState])

  const handleVote = useCallback(async (entry, vote, personaId) => {
    try {
      const { data } = await movieNightApi.vote(entry.id, { vote, personaId: personaId || undefined })
      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, netVotes: data.netVotes } : e))
      if (!personaId) setVoteState(prev => ({ ...prev, [`${entry.id}|self`]: data.userVote }))
    } catch (e) { toastError(e?.message || t('Vote failed')) }
  }, [toastError, t])

  const handleWatched = useCallback(async (entry) => {
    try {
      const { data } = await movieNightApi.markWatched(entry.id)
      setEntries(prev => status === 'active' ? prev.filter(e => e.id !== entry.id) : prev.map(e => e.id === entry.id ? data.entry : e))
      if (group?.rotateMode) { const { data: n } = await movieNightApi.getNext(id).catch(() => ({ data: {} })); setNextPick(n) }
    } catch (e) { toastError(e?.message || t('Failed')) }
  }, [group, status, id, toastError, t])

  const handleCancel = useCallback(async (entry, to = 'cancelled') => {
    try {
      const { data } = await movieNightApi.updateEntry(entry.id, { status: to })
      if (to === 'cancelled') setEntries(prev => prev.filter(e => e.id !== entry.id))
      else setEntries(prev => prev.map(e => e.id === entry.id ? data.entry : e))
    } catch (e) { toastError(e?.message || t('Failed')) }
  }, [toastError, t])

  const handleAdded = useCallback((entry, deduped) => {
    if (deduped) return
    setEntries(prev => (prev && status === 'active' ? [entry, ...prev] : prev))
  }, [status])

  const handleRotate = useCallback(async () => {
    try {
      await movieNightApi.rotate(id)
      const { data: n } = await movieNightApi.getNext(id)
      setNextPick(n)
    }
    catch (e) { toastError(e?.message || t('Failed')) }
  }, [id, toastError, t])

  // member / persona / theme management
  const addMember = useCallback(async (ids) => {
    const toAdd = ids.filter(x => !members.some(m => String(m.user_id) === String(x)))
    for (const uid of toAdd) { try { await movieNightApi.addMember(id, uid) } catch (e) { toastError(e?.message) } }
    const { data } = await movieNightApi.getGroup(id); setMembers(data.members || [])
  }, [id, members, toastError])
  const removeMember = useCallback(async (uid) => {
    const { data } = await movieNightApi.removeMember(id, uid); setMembers(data.members || [])
  }, [id])

  const [personaDraft, setPersonaDraft] = useState({ displayName: '', avatarEmoji: '' })
  const addPersona = useCallback(async () => {
    if (!personaDraft.displayName.trim()) return
    try { await movieNightApi.addPersona(id, { displayName: personaDraft.displayName.trim(), avatarEmoji: personaDraft.avatarEmoji.trim() || null })
      setPersonaDraft({ displayName: '', avatarEmoji: '' })
      const { data } = await movieNightApi.getGroup(id); setPersonas(data.personas || [])
    } catch (e) { toastError(e?.message || t('Failed')) }
  }, [id, personaDraft, toastError, t])
  const removePersona = useCallback(async (pid) => {
    try { await movieNightApi.deletePersona(pid); const { data } = await movieNightApi.getGroup(id); setPersonas(data.personas || []) }
    catch (e) { toastError(e?.message || t('Failed')) }
  }, [id, toastError, t])

  const [themeDraft, setThemeDraft] = useState({ weekday: '', name: '', genreFilter: '' })
  const addTheme = useCallback(async () => {
    if (!themeDraft.name.trim()) return
    try { await movieNightApi.addTheme(id, { weekday: themeDraft.weekday === '' ? null : Number(themeDraft.weekday), name: themeDraft.name.trim(), genreFilter: themeDraft.genreFilter.trim() || null })
      setThemeDraft({ weekday: '', name: '', genreFilter: '' })
      const { data } = await movieNightApi.getGroup(id); setThemes(data.themes || [])
    } catch (e) { toastError(e?.message || t('Failed')) }
  }, [id, themeDraft, toastError, t])
  const toggleTheme = useCallback(async (theme) => {
    try { await movieNightApi.updateTheme(theme.id, { active: !theme.active }); const { data } = await movieNightApi.getGroup(id); setThemes(data.themes || []) }
    catch (e) { toastError(e?.message || t('Failed')) }
  }, [id, toastError, t])
  const removeTheme = useCallback(async (tid) => {
    try { await movieNightApi.deleteTheme(tid); const { data } = await movieNightApi.getGroup(id); setThemes(data.themes || []) }
    catch (e) { toastError(e?.message || t('Failed')) }
  }, [id, toastError, t])

  if (!group) return <div className="mn-page"><div className="mn-empty">{t('Loading...')}</div></div>

  const todayIdx = new Date().getDay()
  const tonightTheme = themes.find(th => th.active && th.weekday === todayIdx)

  return (
    <div className="mn-page">
      <div style={{ marginBottom: 8 }}><Link to="/movie-night" style={{ color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '0.85rem' }}>← {t('Movie Night')}</Link></div>
      <div className="mn-detail-hero">
        <div className="mn-detail-hero-emoji">{group.themeEmoji || '🎬'}</div>
        <div className="mn-detail-hero-main">
          <h1>{group.name} {isHost && <button className="mn-link-btn" onClick={() => setShowSettings(true)}>⚙ {t('Settings')}</button>}</h1>
          <div className="mn-detail-hero-meta">
            <ModeBadge mode={group.mode} eventAt={group.eventAt} />
            {group.rotateMode && <span className="mn-badge">🔁 {t('Rotation on')}</span>}
            <span>{members.length} {t('members')}</span>
          </div>
          <div className="mn-chips-row" style={{ marginTop: 10 }}>
            {members.map(m => (
              <span key={m.user_id} className="mn-chip">
                <Avatar src={m.thumb} name={m.username} size={20} /> {m.username}
                {m.role === 'host' && <span className="mn-badge mn-host" style={{ padding: '0 6px' }}>{t('Host')}</span>}
                {isHost && m.user_id !== user?.id && m.role !== 'host' && (
                  <button className="mn-chip-x" onClick={() => removeMember(m.user_id)} aria-label={t('Remove')}>×</button>
                )}
              </span>
            ))}
            {isHost && <UserMultiSelect options={userOptions} value={members.map(m => m.user_id)} onChange={addMember} label={`+ ${t('Add')}`} />}
          </div>
        </div>
      </div>

      {tonightTheme && <div className="mn-tonight-banner">🌙 {t('Tonight is')} <strong>{tonightTheme.name}</strong>{tonightTheme.genre_filter ? ` · ${tonightTheme.genre_filter}` : ''}</div>}

      {group.rotateMode && nextPick?.entry && (
        <div className="mn-rotation">
          <span className="mn-rotation-label">{t('Next up')}</span>
          <span className="mn-rotation-pick">
            {nextPick.entry.thumb && <img className="mn-rotation-poster" src={posterUrl(nextPick.entry.thumb)} alt="" />}
            <span>{nextPick.entry.title} {nextPick.entry.year && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({nextPick.entry.year})</span>}</span>
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {nextPick.forName && <span style={{ fontSize: '0.85rem' }}>{t('Chosen by')} <strong>{nextPick.forName}</strong>{nextPick.fallback && <span className="mn-rotation-fallback"> · {t('top pick')}</span>}</span>}
            {isHost && <button className="mn-link-btn" onClick={handleRotate}>↻ {t('Skip')}</button>}
          </span>
        </div>
      )}

      <div className="mn-toolbar">
        <div className="mn-tabs">
          {['active', 'watched', 'all'].map(s => (
            <button key={s} className={`mn-tab${status === s ? ' active' : ''}`} onClick={() => setStatus(s)}>{t(s === 'active' ? 'Upcoming' : s === 'watched' ? 'Watched' : 'All')}</button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', flex: 1, maxWidth: 420 }}>
          <AddEntryBar groupId={id} personas={personas} onAdded={handleAdded} />
        </div>
      </div>

      <div className="mn-entries">
        {entries == null ? <div className="mn-empty">{t('Loading...')}</div>
          : entries.length === 0 ? <div className="mn-empty"><span className="mn-empty-emoji">🍿</span>{t('Nothing nominated yet. Search above to start the pile.')}</div>
          : entries.map(entry => (
            <EntryRow
              key={entry.id}
              entry={entry}
              personas={personas}
              isHost={isHost}
              isPrivileged={isPrivileged}
              me={user?.id}
              myVote={myVoteFor(entry)}
              onVote={handleVote}
              onWatched={handleWatched}
              onCancel={handleCancel}
            />
          ))}
      </div>

      <div className="mn-sections">
        <section className="mn-section">
          <h2>🙂 {t('In-house voters')} <span className="mn-count">({personas.length})</span></h2>
          <div className="mn-chips-row">
            {personas.map(p => (
              <span key={p.id} className="mn-chip">
                <span>{p.avatar_emoji || '🙂'}</span> {p.display_name}
                <button className="mn-chip-x" onClick={() => removePersona(p.id)} aria-label={t('Remove')}>×</button>
              </span>
            ))}
            <span className="mn-add-inline">
              <input className="mn-input mn-emoji-input" placeholder="🙂" maxLength={4} value={personaDraft.avatarEmoji} onChange={e => setPersonaDraft(p => ({ ...p, avatarEmoji: e.target.value }))} aria-label={t('Emoji')} />
              <input className="mn-input" placeholder={t('Name')} maxLength={40} style={{ minWidth: 120 }} value={personaDraft.displayName} onChange={e => setPersonaDraft(p => ({ ...p, displayName: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPersona() } }} />
              <button className="btn-page" onClick={addPersona}>{t('Add')}</button>
            </span>
          </div>
        </section>

        {group.mode === 'recurring' && (
          <section className="mn-section">
            <h2>🗓️ {t('Weekly themes')} <span className="mn-count">({themes.length})</span></h2>
            {themes.map(th => (
              <div key={th.id} className={`mn-theme-row${th.active ? '' : ' inactive'}`}>
                <span className="mn-theme-weekday">{th.weekday != null ? t(WEEKDAYS[th.weekday]) : t('Any night')}</span>
                <span className="mn-theme-name">{th.name}</span>
                {th.genre_filter && <span className="mn-theme-genre">{th.genre_filter}</span>}
                <button className="mn-link-btn" onClick={() => toggleTheme(th)}>{th.active ? t('Disable') : t('Enable')}</button>
                <button className="mn-link-btn danger" onClick={() => removeTheme(th.id)}>{t('Delete')}</button>
              </div>
            ))}
            <div className="mn-theme-row">
              <select className="mn-select" value={themeDraft.weekday} onChange={e => setThemeDraft(d => ({ ...d, weekday: e.target.value }))}>
                <option value="">{t('Any night')}</option>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{t(d)}</option>)}
              </select>
              <input className="mn-input" style={{ flex: 1, minWidth: 120 }} placeholder={t('Theme name')} value={themeDraft.name} onChange={e => setThemeDraft(d => ({ ...d, name: e.target.value }))} maxLength={60} />
              <input className="mn-input" style={{ minWidth: 110 }} placeholder={t('Genre (optional)')} value={themeDraft.genreFilter} onChange={e => setThemeDraft(d => ({ ...d, genreFilter: e.target.value }))} maxLength={60} />
              <button className="btn-page" onClick={addTheme}>{t('Add')}</button>
            </div>
          </section>
        )}
      </div>

      {showSettings && <SettingsModal group={group} onClose={() => setShowSettings(false)} onSaved={() => { setShowSettings(false); loadAll() }} />}
    </div>
  )
}
