import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { adminAutomation } from '../../../services/adminApi'
import ExclusionsEditor from './ExclusionsEditor'

// Same criteria vocabulary as Content Monitors (server validates against
// listSources.CRITERIA_TYPES) — values resolve against TMDB at sync time.
const CRITERIA_TYPES = [
  { value: 'genre', label: 'Genre', hint: 'e.g. Horror' },
  { value: 'cast', label: 'Cast Member', hint: 'e.g. Toni Collette' },
  { value: 'director', label: 'Director', hint: 'e.g. Denis Villeneuve' },
  { value: 'writer', label: 'Writer', hint: 'person name' },
  { value: 'producer', label: 'Producer', hint: 'person name' },
  { value: 'studio', label: 'Studio', hint: 'e.g. A24' },
  { value: 'network', label: 'Network', hint: 'e.g. Netflix, HBO' },
  { value: 'production_company', label: 'Production Company', hint: 'company name' },
  { value: 'collection', label: 'Collection', hint: 'e.g. The Lord of the Rings' },
  { value: 'keyword', label: 'Keyword', hint: 'e.g. kaiju, time travel' },
  { value: 'country', label: 'Country', hint: 'e.g. South Korea or KR' },
  { value: 'language', label: 'Language', hint: 'e.g. Korean or ko' },
]

const COLLECTION_SORTS = [
  { value: 'list', label: 'List order' },
  { value: 'release_desc', label: 'Release date (newest first)' },
  { value: 'release_asc', label: 'Release date (oldest first)' },
  { value: 'title', label: 'Title' },
  { value: 'added_desc', label: 'Date added (newest first)' },
  { value: 'rating_desc', label: 'Rating (highest first)' },
]

const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 1000,
  background: 'rgba(0,0,0,0.75)', display: 'flex',
  alignItems: 'center', justifyContent: 'center',
}
const modalStyle = {
  background: 'var(--bg-secondary)', borderRadius: 14, padding: 28,
  width: 'min(680px, 94vw)', border: '1px solid var(--border)',
  position: 'relative', maxHeight: '90vh', overflowY: 'auto',
}
const rowStyle = { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }
const dividerStyle = { borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }

// `plexConfigured` comes from /admin/status `sources.plex.configured`; the
// collection mirror is Plex-only until Jellyfin BoxSets land, so the toggle is
// disabled (with a hint) when there is no Plex server. Absent → assume enabled.
export default function ListEditorModal({ list, presets, onClose, onSaved, onToast, plexConfigured = true }) {
  const { t } = useTranslation()
  const editing = !!list
  const [sourceMode, setSourceMode] = useState(
    list?.criteria?.length ? 'criteria' : list?.presetKey ? 'preset' : 'url'
  )
  const [criteria, setCriteria] = useState(list?.criteria || [])
  const [matchMode, setMatchMode] = useState(list?.matchMode || 'ALL')
  const [exclusions, setExclusions] = useState(list?.exclusions || [])
  const [form, setForm] = useState({
    name: list?.name || '',
    url: list?.url || '',
    presetKey: list?.presetKey || '',
    mediaType: list?.mediaType || 'all',
    approvalMode: list?.approvalMode || 'auto',
    syncIntervalHours: list?.syncIntervalHours ?? 24,
    maxRequestsPerRun: list?.maxRequestsPerRun ?? 10,
    maxItems: list?.maxItems ?? 0,
    seasonMode: list?.seasonMode || 'all',
    collectionEnabled: list?.collectionEnabled || false,
    collectionName: list?.collectionName || '',
    collectionVisibility: list?.collectionVisibility || 'library',
    collectionUnwatchedOnly: list?.collectionUnwatchedOnly || false,
    collectionSort: list?.collectionSort || 'list',
    collectionSummary: list?.collectionSummary || '',
    homeOrder: list?.homeOrder ?? 0,
    libraryOrder: list?.libraryOrder ?? 0,
  })
  const [preview, setPreview] = useState(null)
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)

  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const presetGroups = useMemo(() => {
    const groups = new Map()
    for (const p of presets) {
      if (!groups.has(p.group)) groups.set(p.group, [])
      groups.get(p.group).push(p)
    }
    return [...groups.entries()]
  }, [presets])

  const handlePresetChange = (key) => {
    const preset = presets.find(p => p.key === key)
    setForm(prev => ({
      ...prev,
      presetKey: key,
      url: '',
      name: prev.name || preset?.label || '',
      mediaType: preset ? (preset.mediaType === 'tv' ? 'tv' : 'movie') : prev.mediaType,
      maxItems: prev.maxItems || (preset?.limit && preset.limit <= 250 ? preset.limit : prev.maxItems),
    }))
    setPreview(null)
  }

  const cleanCriteria = () => criteria
    .map(c => ({ type: c.type, entityName: String(c.entityName || '').trim() }))
    .filter(c => c.entityName)

  const handleValidate = async () => {
    setValidating(true)
    setPreview(null)
    try {
      const payload = sourceMode === 'criteria'
        ? { criteria: cleanCriteria(), matchMode, mediaType: form.mediaType }
        : sourceMode === 'preset' ? { presetKey: form.presetKey } : { url: form.url }
      const { data } = await adminAutomation.validateList(payload)
      setPreview(data)
    } catch (e) {
      setPreview({ error: e.response?.data?.error || e.message })
    } finally {
      setValidating(false)
    }
  }

  const handleSave = async () => {
    if (!form.name.trim()) return onToast(t('Name is required'), 'error')
    if (sourceMode === 'preset' && !form.presetKey) return onToast(t('Choose a preset'), 'error')
    if (sourceMode === 'url' && !form.url.trim()) return onToast(t('Paste a list URL'), 'error')
    if (sourceMode === 'criteria' && cleanCriteria().length === 0) return onToast(t('Add at least one criterion'), 'error')
    setSaving(true)
    try {
      const payload = {
        ...form,
        presetKey: sourceMode === 'preset' ? form.presetKey : null,
        url: sourceMode === 'url' ? form.url.trim() : null,
        criteria: sourceMode === 'criteria' ? cleanCriteria() : null,
        matchMode,
        exclusions,
        syncIntervalHours: Number(form.syncIntervalHours) || 24,
        maxRequestsPerRun: Number(form.maxRequestsPerRun),
        maxItems: Number(form.maxItems) || 0,
        homeOrder: Number(form.homeOrder) || 0,
        libraryOrder: Number(form.libraryOrder) || 0,
      }
      if (editing) await adminAutomation.updateList(list.id, payload)
      else await adminAutomation.createList(payload)
      onToast(editing ? t('List updated') : t('List added'))
      onSaved()
    } catch (e) {
      onToast(e.response?.data?.error || e.message || 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  const isTv = form.mediaType !== 'movie'

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={modalStyle}>
        <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 16, cursor: 'pointer' }}>&times;</button>
        <h2 className="section-title" style={{ marginBottom: 16 }}>{editing ? t('Edit List') : t('Add Monitored List')}</h2>

        <div className="conn-field-group" style={{ marginBottom: 12 }}>
          <label className="conn-field-label">{t('Name')}</label>
          <input type="text" className="conn-input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('e.g. IMDb Top 250')} />
        </div>

        {!editing && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button className={`btn-admin btn-sm ${sourceMode === 'preset' ? 'btn-primary' : ''}`} onClick={() => setSourceMode('preset')}>{t('Preset')}</button>
            <button className={`btn-admin btn-sm ${sourceMode === 'url' ? 'btn-primary' : ''}`} onClick={() => setSourceMode('url')}>{t('Paste URL')}</button>
            <button className={`btn-admin btn-sm ${sourceMode === 'criteria' ? 'btn-primary' : ''}`} onClick={() => setSourceMode('criteria')}>{t('Criteria')}</button>
          </div>
        )}

        {sourceMode === 'criteria' ? (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <label className="conn-field-label" style={{ margin: 0 }}>{t('Request content matching')}</label>
              <select className="conn-select" style={{ maxWidth: 150, flex: 'none' }} value={matchMode} onChange={(e) => setMatchMode(e.target.value)}>
                <option value="ALL">{t('ALL criteria')}</option>
                <option value="ANY">{t('ANY criterion')}</option>
              </select>
            </div>
            {criteria.map((c, i) => {
              const def = CRITERIA_TYPES.find(ct => ct.value === c.type) || CRITERIA_TYPES[0]
              return (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <select className="conn-select" style={{ maxWidth: 200, flex: 'none' }} value={c.type}
                    onChange={(e) => { setCriteria(prev => prev.map((p, j) => j === i ? { type: e.target.value, entityName: '' } : p)); setPreview(null) }}>
                    {CRITERIA_TYPES.map(ct => <option key={ct.value} value={ct.value}>{t(ct.label)}</option>)}
                  </select>
                  <input type="text" className="conn-input" style={{ minWidth: 180, flex: 1 }} value={c.entityName || ''}
                    placeholder={t(def.hint)}
                    onChange={(e) => { setCriteria(prev => prev.map((p, j) => j === i ? { ...p, entityName: e.target.value } : p)); setPreview(null) }} />
                  <button className="btn-admin btn-sm btn-danger" onClick={() => setCriteria(prev => prev.filter((_, j) => j !== i))}>&times;</button>
                </div>
              )
            })}
            <button className="btn-admin btn-sm" onClick={() => setCriteria(prev => [...prev, { type: 'genre', entityName: '' }])}>
              {t('+ Add criterion')}
            </button>
            <span className="conn-hint" style={{ display: 'block', marginTop: 6 }}>
              {t('Same criteria as Content Monitors. Names are matched on TMDB at sync time — use Validate to check them.')}
            </span>
          </div>
        ) : sourceMode === 'preset' ? (
          <div className="conn-field-group" style={{ marginBottom: 12 }}>
            <label className="conn-field-label">{t('Preset')}</label>
            <select className="conn-select" value={form.presetKey} onChange={(e) => handlePresetChange(e.target.value)} disabled={editing}>
              <option value="">{t('Choose a preset…')}</option>
              {presetGroups.map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map(p => (
                    <option key={p.key} value={p.key}>
                      {p.label}{p.requiresCredential ? ` (${t('needs credential')})` : ''}{p.needsFlareSolverr ? ` (${t('needs FlareSolverr')})` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        ) : (
          <div className="conn-field-group" style={{ marginBottom: 12 }}>
            <label className="conn-field-label">{t('List URL(s)')}</label>
            <textarea className="conn-input" rows={2} value={form.url} onChange={(e) => { set('url', e.target.value); setPreview(null) }}
              placeholder="https://trakt.tv/users/…/lists/…  ·  https://letterboxd.com/…/list/…  ·  https://www.imdb.com/list/ls…" style={{ resize: 'vertical', fontFamily: 'inherit' }} />
            <span className="conn-hint">{t('Supported: Trakt, IMDb, TMDB, Letterboxd, MDBList, AniList. One URL per line to combine several lists in order.')}</span>
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <button className="btn-admin btn-sm" onClick={handleValidate}
            disabled={validating || (sourceMode === 'criteria' ? cleanCriteria().length === 0 : sourceMode === 'preset' ? !form.presetKey : !form.url)}>
            {validating ? t('Checking…') : t('Validate & preview')}
          </button>
          {preview?.error && <span style={{ marginLeft: 10, color: 'var(--error, #e57373)', fontSize: 12 }}>{preview.error}</span>}
          {preview?.ok && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              {t('Found')} {preview.preview.length}{preview.preview.length >= 20 ? '+' : ''} {t('items')}{preview.unresolved ? ` (${preview.unresolved} ${t('unresolved')})` : ''}:
              <span style={{ color: 'var(--text-muted)' }}> {preview.preview.slice(0, 8).map(i => i.title).filter(Boolean).join(' · ')}…</span>
            </div>
          )}
        </div>

        <div style={rowStyle}>
          <div className="conn-field-group">
            <label className="conn-field-label">{t('Media type')}</label>
            <select className="conn-select" value={form.mediaType} onChange={(e) => set('mediaType', e.target.value)}>
              <option value="all">{t('Movies + TV')}</option>
              <option value="movie">{t('Movies only')}</option>
              <option value="tv">{t('TV only')}</option>
            </select>
          </div>
          <div className="conn-field-group">
            <label className="conn-field-label">{t('Max items')}</label>
            <input type="number" min="0" className="conn-input" style={{ maxWidth: 90 }} value={form.maxItems} onChange={(e) => set('maxItems', e.target.value)} />
            <span className="conn-hint">{t('Top N of the list; 0 = whole list')}</span>
          </div>
          <div className="conn-field-group">
            <label className="conn-field-label">{t('Sync every (hours)')}</label>
            <input type="number" min="1" className="conn-input" style={{ maxWidth: 90 }} value={form.syncIntervalHours} onChange={(e) => set('syncIntervalHours', e.target.value)} />
          </div>
        </div>

        <div style={rowStyle}>
          <div className="conn-field-group">
            <label className="conn-field-label">{t('New items')}</label>
            <select className="conn-select" value={form.approvalMode} onChange={(e) => set('approvalMode', e.target.value)}>
              <option value="auto">{t('Auto-approve & request')}</option>
              <option value="pending">{t('Queue for admin approval')}</option>
            </select>
          </div>
          <div className="conn-field-group">
            <label className="conn-field-label">{t('Max requests per sync')}</label>
            <input type="number" min="0" className="conn-input" style={{ maxWidth: 90 }} value={form.maxRequestsPerRun} onChange={(e) => set('maxRequestsPerRun', e.target.value)} />
            <span className="conn-hint">{t('0 = collection only, never request')}</span>
          </div>
          {isTv && (
            <div className="conn-field-group">
              <label className="conn-field-label">{t('Seasons to request')}</label>
              <select className="conn-select" value={form.seasonMode} onChange={(e) => set('seasonMode', e.target.value)}>
                <option value="all">{t('All seasons')}</option>
                <option value="first">{t('First season only')}</option>
                <option value="latest">{t('Latest season only')}</option>
              </select>
            </div>
          )}
        </div>

        <div style={dividerStyle}>
          <div className="conn-toggle-row" style={{ marginBottom: 8 }}>
            <span className="conn-toggle-label">
              {t('Create a Plex collection from this list')}
              {!plexConfigured && (
                <span className="conn-hint" style={{ display: 'block' }}>{t('Requires a configured Plex server — collections are not mirrored to Jellyfin yet.')}</span>
              )}
            </span>
            <label className="slide-toggle" title={!plexConfigured ? t('Plex is not configured') : ''}>
              <input type="checkbox" checked={form.collectionEnabled && plexConfigured} disabled={!plexConfigured} onChange={(e) => set('collectionEnabled', e.target.checked)} />
              <span className="slide-track" />
            </label>
          </div>
          {form.collectionEnabled && (
            <>
              <div style={rowStyle}>
                <div className="conn-field-group">
                  <label className="conn-field-label">{t('Collection name')}</label>
                  <input type="text" className="conn-input" placeholder={form.name || t('Defaults to list name')} value={form.collectionName} onChange={(e) => set('collectionName', e.target.value)} />
                </div>
                <div className="conn-field-group">
                  <label className="conn-field-label">{t('Show on')}</label>
                  <select className="conn-select" value={form.collectionVisibility} onChange={(e) => set('collectionVisibility', e.target.value)}>
                    <option value="home">{t('Everyone’s home + Recommended')}</option>
                    <option value="owner_home">{t('Owner’s home + Recommended')}</option>
                    <option value="recommended">{t('Library Recommended tab')}</option>
                    <option value="library">{t('Library only (no promotion)')}</option>
                  </select>
                </div>
              </div>
              <div style={rowStyle}>
                <div className="conn-field-group">
                  <label className="conn-field-label">{t('Item order')}</label>
                  <select className="conn-select" value={form.collectionSort} onChange={(e) => set('collectionSort', e.target.value)}>
                    {COLLECTION_SORTS.map(s => <option key={s.value} value={s.value}>{t(s.label)}</option>)}
                  </select>
                </div>
                <div className="conn-field-group">
                  <label className="conn-field-label">{t('Home position')}</label>
                  <input type="number" min="0" className="conn-input" style={{ maxWidth: 90 }} value={form.homeOrder} onChange={(e) => set('homeOrder', e.target.value)} />
                  <span className="conn-hint">{t('Row on the Plex home; 0 = leave')}</span>
                </div>
                <div className="conn-field-group">
                  <label className="conn-field-label">{t('Library position')}</label>
                  <input type="number" min="0" className="conn-input" style={{ maxWidth: 90 }} value={form.libraryOrder} onChange={(e) => set('libraryOrder', e.target.value)} />
                  <span className="conn-hint">{t('Order in the Collections tab; 0 = alphabetical')}</span>
                </div>
              </div>
              <div className="conn-toggle-row" style={{ marginBottom: 8 }}>
                <span className="conn-toggle-label">
                  {t('Only show titles the viewer hasn’t watched')}
                  <span className="conn-hint" style={{ display: 'block' }}>{t('Makes it a smart collection: each user sees only what they haven’t finished. Item order then follows the sort above (list order becomes newest release first).')}</span>
                </span>
                <label className="slide-toggle">
                  <input type="checkbox" checked={form.collectionUnwatchedOnly} onChange={(e) => set('collectionUnwatchedOnly', e.target.checked)} />
                  <span className="slide-track" />
                </label>
              </div>
              <div className="conn-field-group" style={{ marginBottom: 8 }}>
                <label className="conn-field-label">{t('Collection summary (optional)')}</label>
                <input type="text" className="conn-input" value={form.collectionSummary} onChange={(e) => set('collectionSummary', e.target.value)} placeholder={t('Shown on the collection in Plex')} />
              </div>
            </>
          )}
        </div>

        <div style={dividerStyle}>
          <label className="conn-field-label">{t('Exclude from this list')}</label>
          <span className="conn-hint" style={{ display: 'block', marginBottom: 8 }}>{t('Titles never requested or added to the collection by this list. Global exclusions apply on top.')}</span>
          <ExclusionsEditor value={exclusions} onChange={setExclusions} defaultMediaType={form.mediaType === 'tv' ? 'tv' : 'movie'} />
        </div>

        <div className="admin-actions">
          <button className="btn-admin" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn-admin btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? t('Saving...') : editing ? t('Save changes') : t('Add list')}
          </button>
        </div>
      </div>
    </div>
  )
}
