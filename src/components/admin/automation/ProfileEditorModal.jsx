import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminAutomation } from '../../../services/adminApi'

// Field catalog mirrors VALID_CRITERIA_FIELDS on the server.
const NUM_OPS = [
  { value: 'gt', label: 'more than' },
  { value: 'gte', label: 'at least' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'at most' },
  { value: 'eq', label: 'exactly' },
]
const TEXT_OPS = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'contains', label: 'contains' },
]
const LIST_OPS = [
  { value: 'contains', label: 'includes any of' },
  { value: 'not_contains', label: 'includes none of' },
]

const FIELDS = [
  { value: 'added_days_ago', label: 'Added to library (days ago)', kind: 'number', unit: 'days', defaultOp: 'gt' },
  { value: 'last_played_days_ago', label: 'Not played in (days — includes never played)', kind: 'number', unit: 'days', defaultOp: 'gt' },
  { value: 'never_played', label: 'Never played', kind: 'bool' },
  { value: 'plays', label: 'Total plays (all users)', kind: 'number', defaultOp: 'lt' },
  { value: 'audience_rating', label: 'Audience rating (0–10)', kind: 'number', defaultOp: 'lt' },
  { value: 'critic_rating', label: 'Critic rating (0–10)', kind: 'number', defaultOp: 'lt' },
  { value: 'content_rating', label: 'Content rating (G/PG/R/TV-MA…)', kind: 'text', defaultOp: 'eq' },
  { value: 'genre', label: 'Genre', kind: 'list' },
  { value: 'actor', label: 'Cast member', kind: 'list' },
  { value: 'director', label: 'Director', kind: 'list' },
  { value: 'writer', label: 'Writer', kind: 'list' },
  { value: 'producer', label: 'Producer', kind: 'list' },
  { value: 'studio', label: 'Studio / Network', kind: 'text', defaultOp: 'contains' },
  { value: 'country', label: 'Country', kind: 'list' },
  { value: 'collection', label: 'Collection', kind: 'list' },
  { value: 'label', label: 'Label', kind: 'list' },
  { value: 'edition', label: 'Edition', kind: 'text', defaultOp: 'eq' },
  { value: 'video_resolution', label: 'Resolution', kind: 'resolution', defaultOp: 'eq' },
  { value: 'file_size_gb', label: 'File size (GB)', kind: 'number', defaultOp: 'gt' },
  { value: 'runtime_minutes', label: 'Runtime (minutes)', kind: 'number', defaultOp: 'gt' },
  { value: 'year', label: 'Release year', kind: 'number', defaultOp: 'lt' },
]

const RESOLUTIONS = ['4k', '1080', '720', '480', 'sd']

const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 1000,
  background: 'rgba(0,0,0,0.75)', display: 'flex',
  alignItems: 'center', justifyContent: 'center',
}
const modalStyle = {
  background: 'var(--bg-secondary)', borderRadius: 14, padding: 28,
  width: 'min(760px, 95vw)', border: '1px solid var(--border)',
  position: 'relative', maxHeight: '92vh', overflowY: 'auto',
}

function fieldDef(value) { return FIELDS.find(f => f.value === value) || FIELDS[0] }

function CriterionRow({ criterion, onChange, onRemove, t }) {
  const def = fieldDef(criterion.field)
  const ops = def.kind === 'number' ? NUM_OPS : def.kind === 'list' ? LIST_OPS : TEXT_OPS

  const handleFieldChange = (field) => {
    const newDef = fieldDef(field)
    onChange({
      field,
      op: newDef.kind === 'bool' ? 'eq' : (newDef.defaultOp || (newDef.kind === 'list' ? 'contains' : 'eq')),
      value: newDef.kind === 'bool' ? true : '',
    })
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      <select className="conn-select" style={{ maxWidth: 270 }} value={criterion.field} onChange={(e) => handleFieldChange(e.target.value)}>
        {FIELDS.map(f => <option key={f.value} value={f.value}>{t(f.label)}</option>)}
      </select>
      {def.kind !== 'bool' && (
        <select className="conn-select" style={{ maxWidth: 160 }} value={criterion.op} onChange={(e) => onChange({ ...criterion, op: e.target.value })}>
          {ops.map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
        </select>
      )}
      {def.kind === 'number' && (
        <input type="number" className="conn-input" style={{ maxWidth: 110 }} value={criterion.value}
          onChange={(e) => onChange({ ...criterion, value: e.target.value })} placeholder={def.unit || ''} />
      )}
      {def.kind === 'text' && (
        <input type="text" className="conn-input" style={{ maxWidth: 220 }} value={criterion.value}
          onChange={(e) => onChange({ ...criterion, value: e.target.value })} placeholder={t('value')} />
      )}
      {def.kind === 'list' && (
        <input type="text" className="conn-input" style={{ minWidth: 200, flex: 1 }} value={criterion.value}
          onChange={(e) => onChange({ ...criterion, value: e.target.value })} placeholder={t('comma-separated, e.g. Horror, Thriller')} />
      )}
      {def.kind === 'resolution' && (
        <select className="conn-select" style={{ maxWidth: 110 }} value={criterion.value} onChange={(e) => onChange({ ...criterion, value: e.target.value })}>
          <option value="">{t('choose…')}</option>
          {RESOLUTIONS.map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}
        </select>
      )}
      {def.kind === 'bool' && (
        <select className="conn-select" style={{ maxWidth: 110 }} value={String(criterion.value)} onChange={(e) => onChange({ ...criterion, op: 'eq', value: e.target.value === 'true' })}>
          <option value="true">{t('yes')}</option>
          <option value="false">{t('no')}</option>
        </select>
      )}
      <button className="btn-admin btn-sm btn-danger" onClick={onRemove}>&times;</button>
    </div>
  )
}

// list-kind values are edited as comma strings; convert for the API
function serializeCriteria(criteria) {
  return criteria.map(c => {
    const def = fieldDef(c.field)
    if (def.kind === 'list' && typeof c.value === 'string') {
      return { ...c, value: c.value.split(',').map(s => s.trim()).filter(Boolean) }
    }
    if (def.kind === 'number') return { ...c, value: Number(c.value) }
    return c
  })
}

function deserializeCriteria(criteria) {
  return (criteria || []).map(c => (Array.isArray(c.value) ? { ...c, value: c.value.join(', ') } : c))
}

export default function ProfileEditorModal({ profile, onClose, onSaved, onToast }) {
  const { t } = useTranslation()
  const editing = !!profile
  const [form, setForm] = useState({
    name: profile?.name || '',
    mode: profile?.mode || 'dry_run',
    mediaType: profile?.mediaType || 'movie',
    gracePeriodDays: profile?.gracePeriodDays ?? 7,
    maxDeletionsPerRun: profile?.maxDeletionsPerRun ?? 10,
    arrImportExclusion: profile?.arrImportExclusion ?? true,
  })
  const [criteria, setCriteria] = useState(deserializeCriteria(profile?.criteria))
  const [exclusions, setExclusions] = useState({
    watchlisted: profile?.exclusions?.watchlisted !== false,
    collections: (profile?.exclusions?.collections || []).join(', '),
    labels: (profile?.exclusions?.labels || []).join(', '),
    minAgeDays: profile?.exclusions?.minAgeDays || '',
  })
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)

  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const buildPayload = () => ({
    ...form,
    gracePeriodDays: Number(form.gracePeriodDays) || 0,
    maxDeletionsPerRun: Number(form.maxDeletionsPerRun) || 10,
    criteria: serializeCriteria(criteria),
    exclusions: {
      watchlisted: exclusions.watchlisted,
      collections: exclusions.collections.split(',').map(s => s.trim()).filter(Boolean),
      labels: exclusions.labels.split(',').map(s => s.trim()).filter(Boolean),
      ...(Number(exclusions.minAgeDays) > 0 ? { minAgeDays: Number(exclusions.minAgeDays) } : {}),
    },
  })

  const handlePreview = async () => {
    if (criteria.length === 0) return onToast(t('Add at least one criterion first'), 'error')
    setPreviewing(true)
    setPreview(null)
    try {
      const { data } = await adminAutomation.previewDraft(buildPayload())
      setPreview(data)
    } catch (e) {
      setPreview({ error: e.message })
    } finally {
      setPreviewing(false)
    }
  }

  const handleSave = async () => {
    if (!form.name.trim()) return onToast(t('Name is required'), 'error')
    if (criteria.length === 0) return onToast(t('Add at least one criterion — an empty profile matches nothing'), 'error')
    setSaving(true)
    try {
      const payload = buildPayload()
      if (editing) await adminAutomation.updateProfile(profile.id, payload)
      else await adminAutomation.createProfile(payload)
      onToast(editing ? t('Profile updated') : t('Profile created (dry-run by default)'))
      onSaved()
    } catch (e) {
      onToast(e.message || 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  const totalGb = preview?.matches ? preview.matches.reduce((s, m) => s + (m.fileSize || 0), 0) / 1e9 : 0

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={modalStyle}>
        <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 16, cursor: 'pointer' }}>&times;</button>
        <h2 className="section-title" style={{ marginBottom: 16 }}>{editing ? t('Edit Deletion Profile') : t('New Deletion Profile')}</h2>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
          <div className="conn-field-group" style={{ flex: 1, minWidth: 200 }}>
            <label className="conn-field-label">{t('Name')}</label>
            <input type="text" className="conn-input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('e.g. Never watched after 6 months')} />
          </div>
          <div className="conn-field-group">
            <label className="conn-field-label">{t('Applies to')}</label>
            <select className="conn-select" value={form.mediaType} onChange={(e) => set('mediaType', e.target.value)}>
              <option value="movie">{t('Movies')}</option>
              <option value="show">{t('TV Shows')}</option>
            </select>
          </div>
          <div className="conn-field-group">
            <label className="conn-field-label">{t('Mode')}</label>
            <select className="conn-select" value={form.mode} onChange={(e) => set('mode', e.target.value)}>
              <option value="dry_run">{t('Dry run — report only')}</option>
              <option value="review">{t('Review — I approve each batch')}</option>
              <option value="auto">{t('Automatic — delete after grace period')}</option>
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label className="conn-field-label" style={{ marginBottom: 6, display: 'block' }}>
            {t('Match when ALL of these are true')}
          </label>
          {criteria.map((c, i) => (
            <CriterionRow
              key={i}
              criterion={c}
              t={t}
              onChange={(next) => setCriteria(prev => prev.map((p, j) => j === i ? next : p))}
              onRemove={() => setCriteria(prev => prev.filter((_, j) => j !== i))}
            />
          ))}
          <button className="btn-admin btn-sm" onClick={() => setCriteria(prev => [...prev, { field: 'added_days_ago', op: 'gt', value: '' }])}>
            {t('+ Add criterion')}
          </button>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }}>
          <label className="conn-field-label" style={{ marginBottom: 6, display: 'block' }}>{t('Never delete (exclusions)')}</label>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="conn-toggle-row" style={{ margin: 0 }}>
              <span className="conn-toggle-sublabel">{t('On any user watchlist')}</span>
              <label className="slide-toggle">
                <input type="checkbox" checked={exclusions.watchlisted} onChange={(e) => setExclusions(prev => ({ ...prev, watchlisted: e.target.checked }))} />
                <span className="slide-track" />
              </label>
            </div>
            <div className="conn-field-group">
              <label className="conn-field-label">{t('In collections')}</label>
              <input type="text" className="conn-input" style={{ maxWidth: 200 }} placeholder={t('comma-separated')} value={exclusions.collections} onChange={(e) => setExclusions(prev => ({ ...prev, collections: e.target.value }))} />
            </div>
            <div className="conn-field-group">
              <label className="conn-field-label">{t('With labels')}</label>
              <input type="text" className="conn-input" style={{ maxWidth: 180 }} placeholder={t('comma-separated')} value={exclusions.labels} onChange={(e) => setExclusions(prev => ({ ...prev, labels: e.target.value }))} />
            </div>
            <div className="conn-field-group">
              <label className="conn-field-label">{t('Added less than (days) ago')}</label>
              <input type="number" min="0" className="conn-input" style={{ maxWidth: 90 }} value={exclusions.minAgeDays} onChange={(e) => setExclusions(prev => ({ ...prev, minAgeDays: e.target.value }))} />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
          {form.mode === 'auto' && (
            <div className="conn-field-group">
              <label className="conn-field-label">{t('Grace period (days after first match)')}</label>
              <input type="number" min="0" className="conn-input" style={{ maxWidth: 90 }} value={form.gracePeriodDays} onChange={(e) => set('gracePeriodDays', e.target.value)} />
            </div>
          )}
          <div className="conn-field-group">
            <label className="conn-field-label">{t('Max deletions per run')}</label>
            <input type="number" min="1" className="conn-input" style={{ maxWidth: 90 }} value={form.maxDeletionsPerRun} onChange={(e) => set('maxDeletionsPerRun', e.target.value)} />
          </div>
          <div className="conn-toggle-row" style={{ margin: 0, alignSelf: 'flex-end' }}>
            <span className="conn-toggle-sublabel">{t('Block re-download in Radarr/Sonarr')}</span>
            <label className="slide-toggle">
              <input type="checkbox" checked={form.arrImportExclusion} onChange={(e) => set('arrImportExclusion', e.target.checked)} />
              <span className="slide-track" />
            </label>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <button className="btn-admin" onClick={handlePreview} disabled={previewing}>
            {previewing ? t('Evaluating…') : t('Preview matches')}
          </button>
          {preview?.error && <div style={{ marginTop: 8, color: 'var(--error, #e57373)', fontSize: 12 }}>{preview.error}</div>}
          {preview?.matches && (
            <div style={{ marginTop: 10, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                <strong>{preview.matches.length}</strong> {t('matches')}
                {totalGb > 0 && <> · {totalGb.toFixed(1)} GB</>}
                {preview.excluded > 0 && <span style={{ color: 'var(--text-muted)' }}> · {preview.excluded} {t('protected by exclusions')}</span>}
              </div>
              {preview.matches.slice(0, 50).map(m => (
                <div key={m.ratingKey} style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                  <strong>{m.title}</strong> {m.year ? `(${m.year})` : ''}
                  <span style={{ color: 'var(--text-muted)' }}> — {m.reasons.join('; ')}{m.fileSize ? ` · ${(m.fileSize / 1e9).toFixed(1)} GB` : ''}</span>
                </div>
              ))}
              {preview.matches.length > 50 && <div style={{ fontSize: 12, color: 'var(--text-muted)', paddingTop: 4 }}>+{preview.matches.length - 50} {t('more')}</div>}
            </div>
          )}
        </div>

        <div className="admin-actions">
          <button className="btn-admin" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn-admin btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? t('Saving...') : editing ? t('Save changes') : t('Create profile')}
          </button>
        </div>
      </div>
    </div>
  )
}
