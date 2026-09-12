import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { adminAutomation } from '../../../services/adminApi'

// Plex home / Recommended layout per library: every hub Plex manages for the
// section (built-ins like "Recently Added" plus promoted collections) with its
// promotion flags and order. Saving stores built-in hubs in the layout setting,
// writes collection order/visibility back to their monitored lists, and
// applies the result to Plex.
const FLAGS = [
  { key: 'own', label: 'Owner home' },
  { key: 'shared', label: 'Users’ home' },
  { key: 'rec', label: 'Recommended' },
]

function SectionEditor({ section, onToast, onSaved }) {
  const { t } = useTranslation()
  // The parent re-keys this editor on every reload, so the initial state is
  // always the latest snapshot.
  const [items, setItems] = useState(section.hubs)
  const [saving, setSaving] = useState(false)

  const move = (idx, dir) => {
    const next = [...items]
    const to = idx + dir
    if (to < 0 || to >= next.length) return
    ;[next[idx], next[to]] = [next[to], next[idx]]
    setItems(next)
  }

  const toggle = (idx, key) => {
    setItems(prev => prev.map((h, i) => i === idx ? { ...h, [key]: !h[key] } : h))
  }

  const save = async () => {
    setSaving(true)
    try {
      const { data } = await adminAutomation.saveHubLayout(section.id, items.map(h => ({
        identifier: h.identifier, listId: h.listId || null, own: !!h.own, shared: !!h.shared, rec: !!h.rec,
      })))
      onToast(t('Layout applied: {{moved}} moved, {{flagged}} updated', { moved: data.moved ?? 0, flagged: data.flagged ?? 0 }))
      onSaved()
    } catch (e) {
      onToast(e.response?.data?.error || e.message || 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">{section.title}</h2>
          <p className="section-desc">{t('Top to bottom is the order on the Plex home and in Recommended. Collections from monitored lists carry their list’s name; other collections (e.g. Kometa’s) can be ordered but keep their own visibility.')}</p>
        </div>
        <button className="btn-admin btn-primary" onClick={save} disabled={saving}>{saving ? t('Applying…') : t('Save & apply')}</button>
      </div>
      {section.error && <p style={{ color: 'var(--error, #e57373)' }}>{section.error}</p>}
      <div className="library-list">
        {items.map((h, idx) => (
          <div key={h.identifier} className="library-item">
            <div className="library-item-info" style={{ minWidth: 0 }}>
              <span className="library-item-name">
                {h.title}
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  {h.listName ? `${t('list')} · ${h.listName}` : h.isCollection ? t('collection') : t('Plex hub')}
                </span>
              </span>
              <span className="library-item-count" style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>{h.identifier}</span>
            </div>
            <div className="library-item-controls" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {FLAGS.map(f => (
                <label key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-secondary)', opacity: h.isCollection && !h.listId ? 0.5 : 1 }}
                  title={h.isCollection && !h.listId ? t('Not managed by Diskovarr') : ''}>
                  <input type="checkbox" checked={!!h[f.key]} disabled={h.isCollection && !h.listId} onChange={() => toggle(idx, f.key)} />
                  {t(f.label)}
                </label>
              ))}
              <button className="btn-admin btn-sm" onClick={() => move(idx, -1)} disabled={idx === 0} aria-label={t('Move up')}>&#9650;</button>
              <button className="btn-admin btn-sm" onClick={() => move(idx, 1)} disabled={idx === items.length - 1} aria-label={t('Move down')}>&#9660;</button>
            </div>
          </div>
        ))}
        {items.length === 0 && !section.error && <p style={{ color: 'var(--text-muted)' }}>{t('No managed hubs in this library.')}</p>}
      </div>
    </div>
  )
}

export default function HomeLayout({ onToast }) {
  const { t } = useTranslation()
  const [sections, setSections] = useState(null)
  const [error, setError] = useState(null)
  const [version, setVersion] = useState(0)

  const load = useCallback(async () => {
    try {
      const { data } = await adminAutomation.getHubLayout()
      setSections(data.sections || [])
      setError(null)
    } catch (e) {
      setError(e.response?.data?.error || e.message)
      setSections([])
    }
    setVersion(v => v + 1)
  }, [])

  useEffect(() => { load() }, [load])

  const applyAll = async () => {
    try {
      await adminAutomation.applyHubLayout()
      onToast(t('Layout re-applied to Plex'))
      load()
    } catch (e) {
      onToast(e.response?.data?.error || e.message || 'Apply failed', 'error')
    }
  }

  if (sections === null) return <p style={{ color: 'var(--text-muted)' }}>{t('Loading Plex hubs…')}</p>

  return (
    <>
      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">{t('Plex Home Layout')}</h2>
            <p className="section-desc">{t('Which rows appear on the Plex home and Recommended tab of each library, and in what order. Re-applied after every list sync so Plex keeps the layout.')}</p>
          </div>
          <button className="btn-admin" onClick={applyAll}>{t('Re-apply now')}</button>
        </div>
        {error && <p style={{ color: 'var(--error, #e57373)' }}>{error}</p>}
        {sections.length === 0 && !error && <p style={{ color: 'var(--text-muted)' }}>{t('No Plex libraries found (is Plex configured?).')}</p>}
      </div>
      {sections.map(s => <SectionEditor key={`${s.id}-${version}`} section={s} onToast={onToast} onSaved={load} />)}
    </>
  )
}
