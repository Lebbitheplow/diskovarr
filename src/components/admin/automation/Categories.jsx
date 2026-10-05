import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { adminAutomation } from '../../../services/adminApi'

// Category packs: Kometa-style automatic collections. Each pack is one switch
// that creates and maintains a family of collections (Newly Released, Best of
// each decade, one per studio / network, holiday rows) on Plex and Jellyfin.
const VISIBILITY_LABELS = {
  home: 'Everyone’s home',
  owner_home: 'Owner’s home',
  recommended: 'Recommended tab',
  library: 'Library only',
}
const MEDIA_LABELS = { movie: 'Movies', tv: 'TV' }

function CollectionList({ pack, rows, preview }) {
  const { t } = useTranslation()
  if (rows.length === 0) {
    return <p style={{ color: 'var(--text-muted)', margin: '10px 0 0' }}>{preview ? t('Nothing in the library qualifies yet.') : t('No collections yet.')}</p>
  }
  return (
    <div className="library-list" style={{ marginTop: 12, maxHeight: 340, overflowY: 'auto' }}>
      {rows.map(c => (
        <div key={`${c.packKey}:${c.media}`} className={`library-item ${pack.id === 'seasonal' && !c.inSeason ? 'library-item-disabled' : ''}`}>
          <div className="library-item-info" style={{ minWidth: 0 }}>
            <span className="library-item-name">
              {c.title}
              <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t(MEDIA_LABELS[c.media] || c.media)}</span>
              {pack.id === 'seasonal' && c.inSeason && (
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent, #e5a00d)' }}>◆ {t('In season')}</span>
              )}
            </span>
            <span className="library-item-count" style={{ display: 'block' }}>
              {pack.id === 'seasonal' ? `${c.start} – ${c.end} · ` : ''}
              {t('{{n}} in library', { n: c.count ?? c.itemCount ?? 0 })}
              {c.lastError ? <span style={{ color: 'var(--error, #e57373)' }}> · {c.lastError}</span> : null}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function PackCard({ pack, visibilities, onToast, onChanged }) {
  const { t } = useTranslation()
  const [form, setForm] = useState(pack.config)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  const isSeasonal = pack.id === 'seasonal'
  const dirty = form.visibility !== pack.config.visibility
    || Number(form.minItems) !== pack.config.minItems
    || (pack.config.limit !== undefined && Number(form.limit) !== pack.config.limit)

  const run = async (fn, done) => {
    setBusy(true)
    try {
      await fn()
      if (done) onToast(done)
      onChanged()
    } catch (e) {
      onToast(e.response?.data?.error || e.message || 'Request failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  const settings = () => ({
    visibility: form.visibility,
    minItems: Number(form.minItems) || 1,
    ...(pack.config.limit !== undefined ? { limit: Number(form.limit) || pack.config.limit } : {}),
  })

  const enable = () => run(
    () => adminAutomation.updateCategory(pack.id, { ...settings(), enabled: true }),
    t('{{name}} enabled — building collections in the background', { name: t(pack.label) })
  )

  const disable = () => {
    const deleteCollections = window.confirm(t('Also delete the {{name}} collections from your media server?\n\nOK = delete them. Cancel = keep them (Diskovarr just stops managing them).', { name: t(pack.label) }))
    return run(
      () => adminAutomation.updateCategory(pack.id, { enabled: false, deleteCollections }),
      t('{{name}} disabled', { name: t(pack.label) })
    )
  }

  const showPreview = async () => {
    setOpen(true)
    setPreview(null)
    try {
      const { data } = await adminAutomation.previewCategory(pack.id)
      setPreview(data.collections || [])
    } catch (e) {
      onToast(e.response?.data?.error || e.message || 'Preview failed', 'error')
      setOpen(false)
    }
  }

  const enabled = pack.config.enabled
  const active = isSeasonal ? pack.collections.filter(c => c.inSeason).length : pack.collections.length

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">
            {t(pack.label)}
            <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 400, color: enabled ? 'var(--accent, #e5a00d)' : 'var(--text-muted)' }}>
              {pack.syncing ? t('syncing…')
                : !enabled ? t('off')
                : isSeasonal ? t('{{n}} in season now', { n: active })
                : t('{{n}} collections', { n: active })}
            </span>
          </h2>
          <p className="section-desc">{t(pack.description)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {enabled
            ? <button className="btn-admin" onClick={disable} disabled={busy}>{t('Disable')}</button>
            : <button className="btn-admin btn-primary" onClick={enable} disabled={busy}>{t('Enable')}</button>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="conn-field-group">
          <label className="conn-field-label">{t('Show on')}</label>
          <select className="conn-select" value={form.visibility} onChange={(e) => setForm(f => ({ ...f, visibility: e.target.value }))}>
            {visibilities.map(v => <option key={v} value={v}>{t(VISIBILITY_LABELS[v] || v)}</option>)}
          </select>
        </div>
        {!isSeasonal && pack.id !== 'basic' && (
          <div className="conn-field-group">
            <label className="conn-field-label">{t('Minimum titles')}</label>
            <input type="number" min="1" className="conn-input" style={{ maxWidth: 90 }} value={form.minItems} onChange={(e) => setForm(f => ({ ...f, minItems: e.target.value }))} />
          </div>
        )}
        {pack.config.limit !== undefined && (
          <div className="conn-field-group">
            <label className="conn-field-label">{t('Titles per collection')}</label>
            <input type="number" min="10" max="500" className="conn-input" style={{ maxWidth: 90 }} value={form.limit} onChange={(e) => setForm(f => ({ ...f, limit: e.target.value }))} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
          {dirty && (
            <button className="btn-admin btn-primary" disabled={busy}
              onClick={() => run(() => adminAutomation.updateCategory(pack.id, settings()), enabled ? t('Saved — applying in the background') : t('Saved'))}>
              {t('Save')}
            </button>
          )}
          {enabled && !dirty && (
            <button className="btn-admin" disabled={busy || pack.syncing}
              onClick={() => run(() => adminAutomation.syncCategory(pack.id), t('Sync started'))}>
              {t('Sync now')}
            </button>
          )}
          {!isSeasonal && !dirty && (
            <button className="btn-admin" onClick={showPreview} disabled={busy}>{t('Preview')}</button>
          )}
          {(enabled || isSeasonal) && (
            <button className="btn-admin" onClick={() => { setPreview(null); setOpen(o => !o) }}>
              {open && !preview ? t('Hide') : isSeasonal ? t('Show calendar') : t('Show collections')}
            </button>
          )}
        </div>
      </div>

      {open && preview === null && !isSeasonal && !enabled && <p style={{ color: 'var(--text-muted)', margin: '10px 0 0' }}>{t('Loading preview…')}</p>}
      {open && preview !== null && (
        <>
          <p className="section-desc" style={{ marginTop: 12, marginBottom: 0 }}>{t('Preview: {{n}} collections would be managed with the saved settings.', { n: preview.length })}</p>
          <CollectionList pack={pack} rows={preview} preview />
        </>
      )}
      {open && preview === null && (enabled || isSeasonal) && <CollectionList pack={pack} rows={pack.collections} />}
    </div>
  )
}

export default function Categories({ onToast }) {
  const { t } = useTranslation()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(async () => {
    try {
      const res = await adminAutomation.getCategories()
      setData(res.data)
      setError(null)
    } catch (e) {
      setError(e.response?.data?.error || e.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Keep polling while a background sync is running.
  const syncing = !!data?.packs?.some(p => p.syncing)
  useEffect(() => {
    if (!syncing) return undefined
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [syncing, load])

  // A sync kicked off by a save starts just after the response, so look again shortly.
  const changed = () => { load(); setTimeout(load, 1500) }

  if (error) return <p style={{ color: 'var(--error, #e57373)' }}>{error}</p>
  if (!data) return <p style={{ color: 'var(--text-muted)' }}>{t('Loading categories…')}</p>

  return (
    <>
      <div className="admin-section">
        <h2 className="section-title">{t('Categories')}</h2>
        <p className="section-desc">
          {t('Automatic collections for your libraries, the way Kometa’s defaults build them. Studio, network, decade and basic collections are smart collections, so new titles join on their own; seasonal rows come and go with the calendar. A collection that already exists under the same name (for example one Kometa made) is taken over rather than duplicated — remove that pack from Kometa’s config first so the two don’t fight over it.')}
        </p>
        {!data.plexConfigured && !data.jellyfinEnabled && (
          <p style={{ color: 'var(--error, #e57373)' }}>{t('No media server is configured.')}</p>
        )}
      </div>
      {data.packs.map(pack => (
        <PackCard key={`${pack.id}-${JSON.stringify(pack.config)}`} pack={pack} visibilities={data.visibilities} onToast={onToast} onChanged={changed} />
      ))}
    </>
  )
}
