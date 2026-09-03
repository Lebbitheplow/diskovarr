import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { adminTuberr } from '../../../services/adminApi'

const TOGGLES = [
  { key: 'writeNfo', label: 'Write .nfo sidecar', hint: 'Kodi-style episode metadata next to the file (Jellyfin reads it natively; Plex uses it with an XBMC agent).' },
  { key: 'embedMetadata', label: 'Embed metadata & thumbnail', hint: 'yt-dlp --embed-metadata --embed-thumbnail so players show the real title instead of “Episode N”.' },
  { key: 'embedSubs', label: 'Embed English subtitles', hint: 'Download and embed available subtitles (--write-subs --sub-langs en --embed-subs).' },
  { key: 'sponsorblock', label: 'Remove sponsor segments', hint: 'Cut SponsorBlock “sponsor” segments from the file (--sponsorblock-remove sponsor).' },
]

// Download options panel (T13) — persisted via PUT /admin/tuberr/config.
export default function DownloadOptions({ onToast }) {
  const { t } = useTranslation()
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    adminTuberr.getConfig()
      .then(({ data }) => {
        if (cancelled) return
        setForm({
          writeNfo: !!data?.writeNfo,
          embedMetadata: data?.embedMetadata !== false,
          embedSubs: !!data?.embedSubs,
          sponsorblock: !!data?.sponsorblock,
          maxConcurrent: Number(data?.maxConcurrent) > 0 ? Number(data.maxConcurrent) : 2,
        })
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load options') })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    if (!form) return
    setSaving(true)
    try {
      await adminTuberr.setConfig({ ...form, maxConcurrent: Math.max(1, Math.min(8, Number(form.maxConcurrent) || 1)) })
      onToast?.(t('Download options saved'))
    } catch (e) {
      onToast?.(e.message || 'Failed to save options', 'error')
    } finally { setSaving(false) }
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">{t('Download options')}</h2>
          <p className="section-desc" style={{ margin: 0 }}>{t('Applied to new downloads. Metadata options fix generic episode titles in Plex and Jellyfin.')}</p>
        </div>
        <button className="btn-admin btn-primary" onClick={save} disabled={saving || !form}>{saving ? t('Saving…') : t('Save')}</button>
      </div>
      {error && <p style={{ color: '#ef4444', fontSize: '0.85rem' }}>{error}</p>}
      {!form && !error && <p style={{ color: 'var(--text-muted)' }}>{t('Loading…')}</p>}
      {form && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {TOGGLES.map(opt => (
            <div key={opt.key} className="conn-toggle-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div>
                <span className="conn-toggle-label">{t(opt.label)}</span>
                <span className="conn-hint" style={{ display: 'block' }}>{t(opt.hint)}</span>
              </div>
              <label className="slide-toggle">
                <input type="checkbox" checked={!!form[opt.key]} onChange={(e) => setForm(f => ({ ...f, [opt.key]: e.target.checked }))} />
                <span className="slide-track" />
              </label>
            </div>
          ))}
          <div className="conn-field-group" style={{ maxWidth: 220 }}>
            <label className="conn-field-label">{t('Max concurrent downloads')}</label>
            <input type="number" min="1" max="8" className="conn-input" value={form.maxConcurrent}
              onChange={(e) => setForm(f => ({ ...f, maxConcurrent: e.target.value }))} />
            <span className="conn-hint">{t('YouTube throttles aggressive parallel fetches — 2 is a safe default.')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
