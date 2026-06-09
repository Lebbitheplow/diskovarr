import React, { useState } from 'react'
import { monitorsApi } from '../../services/monitorsApi'
import CriterionAutocomplete from './CriterionAutocomplete'
import { useToast } from '../../context/ToastContext'

const CRITERIA_TYPES = [
  { value: 'media_type', label: 'Media Type', autocomplete: false, options: ['Movie', 'TV'] },
  { value: 'genre', label: 'Genre', autocomplete: true },
  { value: 'cast', label: 'Cast Member', autocomplete: true },
  { value: 'director', label: 'Director', autocomplete: true },
  { value: 'writer', label: 'Writer', autocomplete: true },
  { value: 'producer', label: 'Producer', autocomplete: true },
  { value: 'studio', label: 'Studio', autocomplete: true },
  { value: 'network', label: 'Network', autocomplete: true },
  { value: 'collection', label: 'Collection', autocomplete: true },
  { value: 'keyword', label: 'Keyword', autocomplete: true },
  { value: 'country', label: 'Country', autocomplete: true },
  { value: 'language', label: 'Language', autocomplete: true },
  { value: 'production_company', label: 'Production Company', autocomplete: true },
]

export default function MonitorEditor({ monitor, onSave, onCancel, prefillName, prefillCriteria }) {
  const toast = useToast()
  const [name, setName] = useState(monitor?.name || prefillName || '')
  const [enabled, setEnabled] = useState(monitor?.enabled !== false)
  const [matchMode, setMatchMode] = useState(monitor?.matchMode || 'ALL')
  const [notifyPlex, setNotifyPlex] = useState(monitor?.notifyPlex !== false)
  const [notifyRequestable, setNotifyRequestable] = useState(monitor?.notifyRequestable !== false)
  const [criteria, setCriteria] = useState(monitor?.criteria || prefillCriteria || [])
  const [saving, setSaving] = useState(false)

  const addCriterion = () => {
    setCriteria(prev => [...prev, { type: 'genre', entityName: '' }])
  }

  const removeCriterion = (idx) => {
    setCriteria(prev => prev.filter((_, i) => i !== idx))
  }

  const updateCriterion = (idx, field, value) => {
    setCriteria(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c))
  }

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Monitor name is required')
      return
    }
    const validCriteria = criteria.filter(c => c.type && c.entityName?.trim())
    if (validCriteria.length === 0) {
      toast.error('At least one criterion is required')
      return
    }
    setSaving(true)
    try {
      if (monitor) {
        await monitorsApi.updateMonitor(monitor.id, {
          name: name.trim(),
          enabled,
          matchMode,
          notifyPlex,
          notifyRequestable,
        })
        for (const c of validCriteria) {
          await monitorsApi.addCriteria(monitor.id, {
            type: c.type,
            entityId: c.entityId || null,
            entityName: c.entityName.trim(),
          })
        }
      } else {
        await monitorsApi.createMonitor({
          name: name.trim(),
          enabled,
          matchMode,
          notifyPlex,
          notifyRequestable,
          criteria: validCriteria,
        })
      }
      toast.success(monitor ? 'Monitor updated' : 'Monitor created')
      onSave()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    }
    setSaving(false)
  }

  return (
    <div className="modal-backdrop open" onClick={onCancel}>
      <div className="modal-card monitor-editor" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onCancel}>&times;</button>
        <h2 className="monitor-editor-title">{monitor ? 'Edit Monitor' : 'Create Monitor'}</h2>

        <div className="monitor-editor-body">
          <div className="monitor-field">
            <label>Monitor Name</label>
            <input
              type="text"
              className="monitor-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Horror Movies With Favorite Actors"
              autoFocus
            />
          </div>

          <div className="monitor-field">
            <label>Status</label>
            <label className="slide-toggle">
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              <span className="slide-track" />
            </label>
          </div>

          <div className="monitor-field">
            <label>Notification Types</label>
            <div className="monitor-notif-types">
              <label className="monitor-checkbox">
                <input type="checkbox" checked={notifyPlex} onChange={e => setNotifyPlex(e.target.checked)} />
                <span>Notify when added to Plex</span>
              </label>
              <label className="monitor-checkbox">
                <input type="checkbox" checked={notifyRequestable} onChange={e => setNotifyRequestable(e.target.checked)} />
                <span>Notify when available to request</span>
              </label>
            </div>
          </div>

          <div className="monitor-field">
            <label>Match Mode</label>
            <div className="monitor-match-mode">
              <button
                className={`chip-sm${matchMode === 'ALL' ? ' active' : ''}`}
                onClick={() => setMatchMode('ALL')}
              >
                Match ALL criteria
              </button>
              <button
                className={`chip-sm${matchMode === 'ANY' ? ' active' : ''}`}
                onClick={() => setMatchMode('ANY')}
              >
                Match ANY criteria
              </button>
            </div>
          </div>

          <div className="monitor-field">
            <label>Criteria</label>
            <div className="monitor-criteria">
              {criteria.map((c, idx) => (
                <div key={idx} className="monitor-criterion-row">
                  <select
                    className="criterion-select"
                    value={c.type}
                    onChange={e => updateCriterion(idx, 'type', e.target.value)}
                  >
                    {CRITERIA_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>

                  {c.type === 'media_type' ? (
                    <select
                      className="criterion-select"
                      value={c.entityName}
                      onChange={e => updateCriterion(idx, 'entityName', e.target.value)}
                    >
                      <option value="">Select type...</option>
                      <option value="movie">Movie</option>
                      <option value="tv">TV Series</option>
                    </select>
                  ) : (
                    <CriterionAutocomplete
                      type={c.type}
                      value={c.entityName}
                      onChange={val => updateCriterion(idx, 'entityName', val)}
                      placeholder={`Enter ${c.type}...`}
                    />
                  )}

                  <button
                    className="criterion-remove"
                    onClick={() => removeCriterion(idx)}
                    title="Remove criterion"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>

            <button className="monitor-add-criterion" onClick={addCriterion}>
              + Add Criterion
            </button>
          </div>
        </div>

        <div className="monitor-editor-actions">
          <button className="btn-admin" onClick={onCancel}>Cancel</button>
          <button className="btn-admin btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : monitor ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
