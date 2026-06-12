import React, { useState, useEffect, useCallback } from 'react'
import {
  adminStatus,
  adminTheme,
  adminSettings,
  adminSync,
  adminConnections,
  adminCompat,
} from '../../services/adminApi'

import { useTheme } from '../../context/ThemeContext'
import { useTranslation } from 'react-i18next'

const PRESET_COLORS = [
  { label: 'Plex Gold',   hex: '#e5a00d' },
  { label: 'Netflix Red', hex: '#e50914' },
  { label: 'Neon Blue',   hex: '#00b4d8' },
  { label: 'Purple',      hex: '#9b5de5' },
  { label: 'Green',       hex: '#06d6a0' },
  { label: 'Pink',        hex: '#f72585' },
  { label: 'Orange',      hex: '#fb5607' },
  { label: 'White',       hex: '#e0e0e0' },
]

function formatTimestamp(ts) {
  if (!ts) return 'Never'
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now - d
  const diffMin = Math.floor(diffMs / 60000)
  const diffHrs = Math.floor(diffMin / 60)
  const diffDays = Math.floor(diffHrs / 24)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHrs < 24) return `${diffHrs}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString()
}

// ── App Options Section ────────────────────────────────────────
function AppOptionsSection({ appPublicUrl, onAppPublicUrlChange }) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  const showToast = useCallback((msg, isError) => {
    setToast({ msg, isError })
    setTimeout(() => setToast(null), 3000)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await adminConnections.save({ app_public_url: appPublicUrl })
      showToast('App URL saved')
    } catch (err) {
      showToast(err.message || 'Failed to save URL', true)
    } finally {
      setSaving(false)
    }
  }

  const handleFocus = (e) => {
    if (!appPublicUrl) {
      e.target.value = 'https://'
      e.target.select()
    }
  }

  const handleBlur = (e) => {
    if (e.target.value === 'https://') {
      onAppPublicUrlChange('')
    }
  }

  return (
    <>
      {toast && (
        <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>
          {toast.msg}
        </div>
      )}
      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">{t('App Options')}</h2>
            <p className="section-desc">
              {t('Configure general application options. The Public URL is used for the Discord bot avatar and link destination.')}
            </p>
          </div>
        </div>
        <div className="conn-field-group" style={{ flex: 1, minWidth: 0, marginBottom: 12 }}>
          <label className="conn-field-label">
            {t('App Public URL')}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>&nbsp;— required for Discord bot avatar</span>
          </label>
          <div className="conn-input-wrap">
            <input
              type="url"
              className="conn-input"
              style={{ maxWidth: 380 }}
              placeholder={t('https://diskovarr.yourdomain.com')}
              value={appPublicUrl}
              onChange={(e) => onAppPublicUrlChange(e.target.value)}
              onFocus={handleFocus}
              onBlur={handleBlur}
            />
          </div>
          <span className="conn-hint">
            The externally reachable URL of this Diskovarr instance (e.g. <code style={{ fontSize: '0.75rem' }}>{t('https://diskovarr.yourdomain.com')}</code>).
          </span>
        </div>
        <div className="admin-actions">
          <button className="btn-admin btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </>
  )
}

// ── Theme Color Section ────────────────────────────────────────
function ThemeColorSection({ themeColor, onThemeColorChange }) {
  const { t } = useTranslation()
  const [color, setColor] = useState(themeColor)
  const [applying, setApplying] = useState(false)
  const { setThemeColor: applyTheme } = useTheme()

  // Sync local color when the prop changes (render-phase adjustment).
  const [prevThemeColor, setPrevThemeColor] = useState(themeColor)
  if (themeColor !== prevThemeColor) {
    setPrevThemeColor(themeColor)
    setColor(themeColor)
  }

  const handleApply = async () => {
    setApplying(true)
    try {
      await adminTheme.setColor(color)
      onThemeColorChange(color)
      applyTheme(color)
    } catch (err) {
      alert(err.message || 'Failed to apply color')
    } finally {
      setApplying(false)
    }
  }

  const handleSwatchClick = (hex) => {
    setColor(hex)
  }

  const handleCustomInput = (e) => {
    setColor(e.target.value)
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">{t('Theme Color')}</h2>
          <p className="section-desc">
            {t('Pick an accent color. Changes apply immediately across the whole app.')}
          </p>
        </div>
      </div>
      <div className="color-picker-row">
        <div className="color-preview-strip" id="color-swatches">
          {PRESET_COLORS.map((p) => (
            <div
              key={p.hex}
              className={`color-swatch ${color.toLowerCase() === p.hex.toLowerCase() ? 'active' : ''}`}
              style={{ background: p.hex }}
              title={p.label}
              onClick={() => handleSwatchClick(p.hex)}
            />
          ))}
        </div>
        <div className="color-wheel-wrap">
          <label htmlFor="custom-color-input">{t('Custom')}</label>
          <input type="color" id="custom-color-input" value={color} onChange={handleCustomInput} title={t('Pick any color')} />
        </div>
        <button className="btn-admin btn-primary" id="btn-apply-color" onClick={handleApply} disabled={applying}>
          {applying ? 'Applying...' : 'Apply'}
        </button>
      </div>
    </div>
  )
}

// ── Library Sync Section ───────────────────────────────────────
function LibrarySyncSection({ stats, syncStatus, autoSync, onSyncNow, onAutoSyncChange, onToast }) {
  const { t } = useTranslation()
  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">{t('Library Sync')}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="conn-toggle-row" style={{ margin: 0 }}>
            <span className="conn-toggle-sublabel" style={{ color: '#fff', fontSize: 12 }}>Auto-Sync (every 2h)</span>
            <label className="slide-toggle">
              <input
                type="checkbox"
                checked={autoSync}
                onChange={(e) => onAutoSyncChange(e.target.checked)}
              />
              <span className="slide-track" />
            </label>
          </div>
          <div className={`status-badge ${syncStatus === 'syncing' ? 'status-syncing' : 'status-idle'}`}>
            {syncStatus === 'syncing' && <span className="sync-spinner" />}
            <span>{syncStatus === 'syncing' ? 'Syncing…' : 'Idle'}</span>
          </div>
        </div>
      </div>
      <div className="admin-grid">
        <div className="stat-card">
          <div className="stat-label">{t('Movies')}</div>
          <div className="stat-value">{stats.movies.toLocaleString()}</div>
          <div className="stat-sub">
            {t('Last sync:')} <span>{formatTimestamp(stats.lastSyncMovies)}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">TV &amp; Anime</div>
          <div className="stat-value">{stats.tv.toLocaleString()}</div>
          <div className="stat-sub">
            {t('Last sync:')} <span>{formatTimestamp(stats.lastSyncTV)}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('Total')}</div>
          <div className="stat-value">{(stats.movies + stats.tv).toLocaleString()}</div>
        </div>
      </div>
      {syncStatus === 'syncing' && (
        <div className="sync-progress-msg">Syncing libraries… TV &amp; Anime can take up to 2 minutes.</div>
      )}
      <div className="admin-actions">
        <button className="btn-admin btn-primary" onClick={onSyncNow} disabled={syncStatus === 'syncing'}>
          <span>↻</span> {t('Sync Library Now')}
        </button>
      </div>
      {stats.lastSyncError && (
        <div className="error-banner" style={{ marginTop: 16 }}>Last sync error: {stats.lastSyncError}</div>
      )}
      <LibrarySelectionSection onToast={onToast} />
    </div>
  )
}

// ── Library Selection Section ──────────────────────────────────
function LibrarySelectionSection({ onToast }) {
  const { t } = useTranslation()
  const [libraries, setLibraries] = useState([])
  const [localSections, setLocalSections] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)

  const loadLibraries = useCallback(async () => {
    try {
      setRefreshing(true)
      const res = await adminSync.getLibraries()
      const sections = res.data.sections || []
      setLibraries(sections)
      setLocalSections(sections.map(s => ({ id: s.id, enabled: s.enabled })))
      setHasChanges(false)
    } catch (err) {
      onToast?.(err.message || 'Failed to load library sections', 'error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [onToast])

  useEffect(() => {
    ;(async () => { await loadLibraries() })()
  }, [loadLibraries])

  const openModal = useCallback(() => {
    // Reset pending edits to the last saved state before opening
    setLocalSections(libraries.map(s => ({ id: s.id, enabled: s.enabled })))
    setHasChanges(false)
    setModalOpen(true)
  }, [libraries])

  const handleToggle = useCallback((id) => {
    setLocalSections(prev =>
      prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s)
    )
    setHasChanges(true)
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await adminSync.setLibraries(localSections)
      const res = await adminSync.getLibraries()
      setLibraries(res.data.sections || [])
      setLocalSections((res.data.sections || []).map(s => ({ id: s.id, enabled: s.enabled })))
      setHasChanges(false)
      setModalOpen(false)
      onToast?.('Library sync settings saved')
    } catch (err) {
      onToast?.(err.message || 'Failed to save library settings', 'error')
    } finally {
      setSaving(false)
    }
  }, [localSections, onToast])

  const handleRefresh = useCallback(async () => {
    await loadLibraries()
    onToast?.('Library list refreshed')
  }, [loadLibraries, onToast])

  if (loading) return null

  const enabledCount = libraries.filter(l => l.enabled).length

  return (
    <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
      <div className="admin-section-header">
        <div>
          <h3 className="section-title" style={{ fontSize: '1rem' }}>{t('Synced Libraries')}</h3>
          <p className="section-desc">
            {t('Choose which Plex libraries to sync. Only enabled libraries are included in sync operations. Removing a library deletes its synced data.')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn-admin btn-primary"
            onClick={openModal}
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
          >
            {t('Add/Edit Libraries')}
          </button>
        </div>
      </div>
      <div style={{ padding: '4px 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        {libraries.length === 0
          ? 'No Movie or TV libraries found from Plex. Ensure your Plex connection is configured in the Connections tab.'
          : `${enabledCount} of ${libraries.length} ${libraries.length === 1 ? 'library' : 'libraries'} synced.`}
      </div>

      {modalOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => !saving && setModalOpen(false)}
        >
          <div
            style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, width: 'min(560px, 92vw)', border: '1px solid var(--border)', position: 'relative', maxHeight: '88vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => !saving && setModalOpen(false)}
              style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}
              title={t('Close')}
            >
              &times;
            </button>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '0 0 16px', paddingRight: 24 }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{t('Add/Edit Libraries')}</h3>
              <button
                className="btn-admin"
                onClick={handleRefresh}
                disabled={refreshing}
                style={{ fontSize: '0.8rem', padding: '4px 10px' }}
              >
                {refreshing ? 'Refreshing...' : '↻ Refresh'}
              </button>
            </div>
            {libraries.length === 0 ? (
              <div style={{ padding: '12px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                {t('No Movie or TV libraries found from Plex. Ensure your Plex connection is configured in the Connections tab.')}
              </div>
            ) : (
              <div className="library-list">
                {libraries.map(lib => {
                  const local = localSections.find(s => s.id === lib.id) || { enabled: false }
                  return (
                    <div className="library-item" key={lib.id}>
                      <div className="library-item-info">
                        <span className={`library-type-badge ${lib.type === 'movie' ? 'type-movie' : 'type-tv'}`}>
                          {lib.type === 'movie' ? 'Movie' : 'TV'}
                        </span>
                        <span className="library-item-name">{lib.title}</span>
                        {lib.enabled && lib.itemCount > 0 && (
                          <span className="library-item-count">{lib.itemCount.toLocaleString()} items</span>
                        )}
                        {!local.enabled && (
                          <span className="library-item-disabled">{t('Not synced')}</span>
                        )}
                      </div>
                      <div className="library-item-controls">
                        <label className="slide-toggle">
                          <input
                            type="checkbox"
                            checked={local.enabled}
                            onChange={() => handleToggle(lib.id)}
                          />
                          <span className="slide-track" />
                        </label>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="admin-actions" style={{ marginTop: 20 }}>
              <button
                className="btn-admin"
                onClick={() => setModalOpen(false)}
                disabled={saving}
              >
                {t('Cancel')}
              </button>
              {libraries.length > 0 && (
                <button
                  className="btn-admin btn-primary"
                  onClick={handleSave}
                  disabled={!hasChanges || saving}
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Verbose Logging Section ────────────────────────────────────
function VerboseLoggingSection({ enabled, onChange }) {
  const { t } = useTranslation()
  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">{t('Verbose Logging')}</h2>
          <p className="section-desc" style={{ marginTop: 4 }}>
            {t('When enabled, Diskovarr writes detailed HTTP request logs and debug output. Basic info/warn/error logs are always written.')}
            <br />
            {t('View with:')} <code style={{ fontSize: '0.78rem', background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)' }}>{t('sudo journalctl -u diskovarr -f')}</code>
            &nbsp;or&nbsp;
            <code style={{ fontSize: '0.78rem', background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)' }}>{t('docker logs diskovarr -f')}</code>
          </p>
        </div>
        <label className="slide-toggle" style={{ flexShrink: 0 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} />
          <span className="slide-track" />
        </label>
      </div>
    </div>
  )
}

// ── API Key Section ────────────────────────────────────────────
function ApiKeySection({ hasKey, onRegenerate, resetToken }) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const [fetchedKey, setFetchedKey] = useState('')
  const [regenerating, setRegenerating] = useState(false)

  // Clear fetched key whenever a regeneration completes (token bumped by parent).
  // Render-phase adjustment (React's alternative to a state-resetting effect).
  const [prevResetToken, setPrevResetToken] = useState(resetToken)
  if (resetToken !== prevResetToken) {
    setPrevResetToken(resetToken)
    setFetchedKey('')
    setVisible(false)
  }

  const handleToggleVisible = async () => {
    if (!visible && !fetchedKey) {
      try {
        const res = await adminConnections.reveal()
        setFetchedKey(res.data.diskovarrApiKey || '')
      } catch { /* ignore */ }
    }
    setVisible(v => !v)
  }

  const handleRegenerate = async () => {
    setRegenerating(true)
    try {
      await adminSettings.generateApiKey()
      onRegenerate()
    } catch (err) {
      alert(err.message || 'Failed to regenerate key')
    } finally {
      setRegenerating(false)
    }
  }

  const handleCopy = async () => {
    try {
      let key = fetchedKey
      if (!key) {
        const res = await adminConnections.reveal()
        key = res.data.diskovarrApiKey || ''
      }
      await navigator.clipboard.writeText(key)
    } catch { /* ignore */ }
  }

  return (
    <div className="admin-section">
      <div className="section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h2 className="section-title">{t('API Key')}</h2>
      </div>
      <p className="section-desc">
        Use this key to authenticate external applications with Diskovarr's API. Send it as an <code>Authorization: Bearer &lt;key&gt;</code> {t('or')} <code>{t('X-Api-Key')}</code> {t('header. The key grants admin-level access to all API endpoints.')}
      </p>
      <div className="conn-block-fields">
        <div className="conn-field-group" style={{ flex: 1, minWidth: 240, maxWidth: 520 }}>
          <span className="conn-field-label">{t('API Key')}</span>
          <div className="conn-input-wrap">
            <input
              type={visible ? 'text' : 'password'}
              id="settings-api-key"
              className="conn-input"
              readOnly
              value={visible && fetchedKey ? fetchedKey : hasKey ? '••••••••' : ''}
              placeholder={t('No key generated yet')}
              style={{ cursor: 'text' }}
            />
            <div className="conn-input-btns">
              {hasKey && (
                <>
                  <button type="button" className="conn-input-icon-btn" onClick={handleToggleVisible} title={t('Show / hide')} />
                  <button type="button" className="conn-input-icon-btn is-copy" onClick={handleCopy} title={t('Copy to clipboard')} />
                </>
              )}
            </div>
          </div>
        </div>
        <button className="btn-admin btn-primary" onClick={handleRegenerate} disabled={regenerating}>
          {regenerating ? 'Generating...' : hasKey ? 'Regenerate Key' : 'Generate API Key'}
        </button>
      </div>
      <p style={{ marginTop: 1.25, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        {t('View the full API endpoint reference in the')}
        <a href="https://diskovarr.com/#api-reference" target="_blank" rel="noopener" style={{ color: 'var(--accent)', textDecoration: 'none' }}>documentation &rarr;</a>
      </p>
    </div>
  )
}

// ── Overseerr Compat Section ───────────────────────────────────
function OverseerrCompatSection({ enabled, onToggle, apiKey, onRegenerate }) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  const handleRegenerate = async () => {
    setRegenerating(true)
    try {
      await adminCompat.regenerateKey()
      onRegenerate()
    } catch (err) {
      alert(err.message || 'Failed to regenerate key')
    } finally {
      setRegenerating(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey)
    } catch { /* ignore */ }
  }

  return (
    <div className="admin-section">
      <div className="section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h2 className="section-title">{t('Overseerr Compat API')}</h2>
        <div className="conn-toggle-wrap">
          <span className="conn-toggle-label" id="lbl-agregarr-enabled">
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
          <label className="slide-toggle" title={t('Enable the Overseerr-compatible API shim')}>
            <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
            <span className="slide-track" />
          </label>
        </div>
      </div>
      <p className="section-desc">
        {t('Exposes an Overseerr-compatible API at')} <code>{t('/api/v1/')}</code> {t('for DUMB, Agregarr, Homarr, and any other app that speaks the Overseerr API. Use the key below as the')} <code>{t('X-Api-Key')}</code> {t('header.')}
      </p>
      <div className="conn-block-fields">
        <div className="conn-field-group" style={{ flex: 1, minWidth: 240, maxWidth: 520 }}>
          <span className="conn-field-label">{t('Compat Key')}</span>
          <div className="conn-input-wrap">
            <input
              type={visible ? 'text' : 'password'}
              id="compat-api-key"
              className="conn-input"
              readOnly
              value={visible && apiKey ? apiKey : apiKey ? '••••••••' : ''}
              placeholder={t('No key generated yet')}
              autoComplete="off"
              style={{ cursor: 'text' }}
            />
            <div className="conn-input-btns">
              {apiKey && (
                <>
                  <button type="button" className="conn-input-icon-btn" onClick={() => setVisible(!visible)} title={t('Show / hide')} />
                  <button type="button" className="conn-input-icon-btn is-copy" onClick={handleCopy} title={t('Copy to clipboard')} />
                </>
              )}
            </div>
          </div>
        </div>
        <button
          className={`btn-admin ${apiKey ? 'btn-danger' : 'btn-primary'}`}
          onClick={handleRegenerate}
          disabled={regenerating}
        >
          {regenerating ? 'Generating...' : apiKey ? 'Regenerate Key' : 'Generate Key'}
        </button>
      </div>
      {/* Service accounts created by Agregarr */}
      <div id="agregarr-svc-users" style={{ margin: '16px 0 0', padding: '14px 16px', borderTop: '1px solid var(--border)', display: 'none' }}>
        <p style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)', margin: '0 0 10px' }}>
          {t('Service Accounts')} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(auto-created by Agregarr)</span>
        </p>
        <div id="agregarr-svc-users-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}></div>
      </div>
    </div>
  )
}

// ── Default Landing Page Section ───────────────────────────────
function DefaultLandingPageSection({ value, onChange }) {
  const { t } = useTranslation()
  const isExplore = value === 'explore'
  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">{t('Default Landing Page')}</h2>
          <p className="section-desc" style={{ marginTop: 4 }}>
            {t('Set the page all users land on after logging in. Individual users can override this in their own settings.')}
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '4px 0' }}>
        <span className={!isExplore ? 'service-label-active' : 'service-label-inactive'}>{t('Diskovarr')}</span>
        <label className="slide-toggle slide-toggle-always-on">
          <input type="checkbox" checked={isExplore} onChange={(e) => onChange(e.target.checked ? 'explore' : 'home')} />
          <span className="slide-track" />
        </label>
        <span className={isExplore ? 'service-label-active' : 'service-label-inactive'}>{t('Diskovarr Requests')}</span>
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────
export default function GeneralSettings({ onDataLoaded, onToast }) {
  const { t } = useTranslation()
  const [appPublicUrl, setAppPublicUrl] = useState('')
  const [themeColor, setThemeColor] = useState('#e5a00d')
  const [stats, setStats] = useState({
    movies: 0, tv: 0, lastSyncMovies: null, lastSyncTV: null, lastSyncError: null,
  })
  const [syncStatus, setSyncStatus] = useState(null)
  const [autoSync, setAutoSync] = useState(false)
  const [verboseLogging, setVerboseLogging] = useState(false)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [apiKeyResetToken, setApiKeyResetToken] = useState(0)
  const [compatEnabled, setCompatEnabled] = useState(false)
  const [compatApiKey, setCompatApiKey] = useState('')
  const [defaultLandingPage, setDefaultLandingPage] = useState('home')
  const [loading, setLoading] = useState(true)

  const pollStatus = useCallback(async () => {
    try {
      const res = await adminStatus.get()
      const s = res.data
      setSyncStatus(s.syncInProgress ? 'syncing' : null)
      if (s.stats) {
        setStats({
          movies: s.stats.library?.movies || 0,
          tv: s.stats.library?.tv || 0,
          lastSyncMovies: s.stats.library?.lastSyncMovies || null,
          lastSyncTV: s.stats.library?.lastSyncTV || null,
          lastSyncError: s.lastSyncError || null,
        })
      }
      setAutoSync(s.autoSyncEnabled ?? false)
      setVerboseLogging(s.verboseLogging ?? false)
      setHasApiKey(s.hasApiKey ?? false)
      if (s.themeColor) setThemeColor(s.themeColor)
      if (s.compatEnabled !== undefined) setCompatEnabled(s.compatEnabled)
      if (s.compatApiKey) setCompatApiKey(s.compatApiKey)
      if (s.defaultLandingPage) setDefaultLandingPage(s.defaultLandingPage)
      onDataLoaded?.(s)
    } catch { /* ignore polling errors */ }
  }, [onDataLoaded])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await adminStatus.get()
        if (cancelled) return
        const s = res.data
        setSyncStatus(s.syncInProgress ? 'syncing' : null)
        setStats({
          movies: s.stats?.library?.movies || 0,
          tv: s.stats?.library?.tv || 0,
          lastSyncMovies: s.stats?.library?.lastSyncMovies || null,
          lastSyncTV: s.stats?.library?.lastSyncTV || null,
          lastSyncError: s.lastSyncError || null,
        })
        setAutoSync(s.autoSyncEnabled ?? false)
        setVerboseLogging(s.verboseLogging ?? false)
        setHasApiKey(s.hasApiKey ?? false)
        setAppPublicUrl(s.appPublicUrl || '')
        if (s.themeColor) setThemeColor(s.themeColor)
        if (s.compatEnabled !== undefined) setCompatEnabled(s.compatEnabled)
        if (s.compatApiKey) setCompatApiKey(s.compatApiKey)
        if (s.defaultLandingPage) setDefaultLandingPage(s.defaultLandingPage)
        onDataLoaded?.(s)
        setLoading(false)
        if (s.syncInProgress) {
          const interval = setInterval(pollStatus, 2000)
          return () => clearInterval(interval)
        }
      } catch (err) {
        if (!cancelled) {
          onToast?.(err.message || 'Failed to load settings', 'error')
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [onDataLoaded, onToast, pollStatus])

  const handleSyncNow = useCallback(async () => {
    setSyncStatus('syncing')
    try {
      await adminSync.start()
      onToast?.('Library sync started')
      const interval = setInterval(pollStatus, 2000)
      setTimeout(() => clearInterval(interval), 120000)
    } catch (err) {
      setSyncStatus(null)
      onToast?.(err.message || 'Failed to start sync', 'error')
    }
  }, [onToast, pollStatus])

  const handleAutoSyncChange = useCallback(async (checked) => {
    try {
      if (checked) await adminSync.autoEnable()
      else await adminSync.autoDisable()
      setAutoSync(checked)
      onToast?.(checked ? 'Auto-sync enabled' : 'Auto-sync disabled')
    } catch (err) {
      onToast?.(err.message || 'Failed to toggle auto-sync', 'error')
    }
  }, [onToast])

  const handleVerboseLoggingChange = useCallback(async (checked) => {
    try {
      await adminSettings.setLogging(checked)
      setVerboseLogging(checked)
      onToast?.(checked ? 'Verbose logging enabled' : 'Verbose logging disabled')
    } catch (err) {
      onToast?.(err.message || 'Failed to toggle logging', 'error')
    }
  }, [onToast])

  const handleApiKeyRegenerate = useCallback(async () => {
    try {
      await adminSettings.generateApiKey()
      setHasApiKey(true)
      setApiKeyResetToken(t => t + 1)
      onToast?.('API key regenerated')
    } catch (err) {
      onToast?.(err.message || 'Failed to regenerate key', 'error')
    }
  }, [onToast])

  const handleCompatToggle = useCallback(async (checked) => {
    try {
      await adminCompat.enable(checked)
      setCompatEnabled(checked)
      onToast?.(checked ? 'Compat API enabled' : 'Compat API disabled')
    } catch (err) {
      onToast?.(err.message || 'Failed to toggle compat', 'error')
    }
  }, [onToast])

  const handleDefaultLandingPageChange = useCallback(async (val) => {
    try {
      await adminConnections.save({ landing_page: val })
      setDefaultLandingPage(val)
      onToast?.(`Default landing page set to ${val}`)
    } catch (err) {
      onToast?.(err.message || 'Failed to save landing page', 'error')
    }
  }, [onToast])

  const handleCompatRegenerate = useCallback(async () => {
    try {
      await adminCompat.regenerateKey()
      onToast?.('Compat key regenerated')
      const res = await adminStatus.get()
      if (res.data.compatApiKey) setCompatApiKey(res.data.compatApiKey)
    } catch (err) {
      onToast?.(err.message || 'Failed to regenerate key', 'error')
    }
  }, [onToast])

  if (loading) return <div className="admin-section"><p style={{ color: 'var(--text-muted)' }}>{t('Loading settings...')}</p></div>

  return (
    <>
      <AppOptionsSection
        appPublicUrl={appPublicUrl}
        onAppPublicUrlChange={setAppPublicUrl}
      />
      <DefaultLandingPageSection
        value={defaultLandingPage}
        onChange={handleDefaultLandingPageChange}
      />
      <ThemeColorSection
        themeColor={themeColor}
        onThemeColorChange={setThemeColor}
      />
      <LibrarySyncSection
        stats={stats}
        syncStatus={syncStatus}
        autoSync={autoSync}
        onSyncNow={handleSyncNow}
        onAutoSyncChange={handleAutoSyncChange}
        onToast={onToast}
      />
      <VerboseLoggingSection
        enabled={verboseLogging}
        onChange={handleVerboseLoggingChange}
      />
      <ApiKeySection
        hasKey={hasApiKey}
        onRegenerate={handleApiKeyRegenerate}
        resetToken={apiKeyResetToken}
      />
      <OverseerrCompatSection
        enabled={compatEnabled}
        onToggle={handleCompatToggle}
        apiKey={compatApiKey}
        onRegenerate={handleCompatRegenerate}
      />
    </>
  )
}
