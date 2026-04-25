import React, { useState, useEffect, useCallback } from 'react'
import {
  adminStatus,
  adminTheme,
  adminSettings,
  adminSync,
  adminConnections,
  adminAgregarr,
  adminCompat,
} from '../../services/adminApi'
import { useTheme } from '../../context/ThemeContext'

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

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••'
  return key.slice(0, 6) + '••••••••' + key.slice(-4)
}

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
            <h2 className="section-title">App Options</h2>
            <p className="section-desc">
              Configure general application options. The Public URL is used for the Discord bot avatar and link destination.
            </p>
          </div>
        </div>
        <div className="conn-field-group" style={{ flex: 1, minWidth: 0, marginBottom: 12 }}>
          <label className="conn-field-label">
            App Public URL
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>&nbsp;— required for Discord bot avatar</span>
          </label>
          <div className="conn-input-wrap">
            <input
              type="url"
              className="conn-input"
              style={{ maxWidth: 380 }}
              placeholder="https://diskovarr.yourdomain.com"
              value={appPublicUrl}
              onChange={(e) => onAppPublicUrlChange(e.target.value)}
              onFocus={handleFocus}
              onBlur={handleBlur}
            />
          </div>
          <span className="conn-hint">
            The externally reachable URL of this Diskovarr instance (e.g. <code style={{ fontSize: '0.75rem' }}>https://diskovarr.yourdomain.com</code>).
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
  const [color, setColor] = useState(themeColor)
  const [applying, setApplying] = useState(false)
  const { setThemeColor: applyTheme } = useTheme()

  useEffect(() => { setColor(themeColor) }, [themeColor])

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
          <h2 className="section-title">Theme Color</h2>
          <p className="section-desc">
            Pick an accent color. Changes apply immediately across the whole app.
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
          <label htmlFor="custom-color-input">Custom</label>
          <input type="color" id="custom-color-input" value={color} onChange={handleCustomInput} title="Pick any color" />
        </div>
        <button className="btn-admin btn-primary" id="btn-apply-color" onClick={handleApply} disabled={applying}>
          {applying ? 'Applying...' : 'Apply'}
        </button>
      </div>
    </div>
  )
}

// ── Library Sync Section ───────────────────────────────────────
function LibrarySyncSection({ stats, syncStatus, autoSync, onSyncNow, onAutoSyncChange }) {
  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">Library Sync</h2>
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
          <div className="stat-label">Movies</div>
          <div className="stat-value">{stats.movies.toLocaleString()}</div>
          <div className="stat-sub">
            Last sync: <span>{formatTimestamp(stats.lastSyncMovies)}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">TV &amp; Anime</div>
          <div className="stat-value">{stats.tv.toLocaleString()}</div>
          <div className="stat-sub">
            Last sync: <span>{formatTimestamp(stats.lastSyncTV)}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total</div>
          <div className="stat-value">{(stats.movies + stats.tv).toLocaleString()}</div>
        </div>
      </div>
      {syncStatus === 'syncing' && (
        <div className="sync-progress-msg">Syncing libraries… TV &amp; Anime can take up to 2 minutes.</div>
      )}
      <div className="admin-actions">
        <button className="btn-admin btn-primary" onClick={onSyncNow} disabled={syncStatus === 'syncing'}>
          <span>↻</span> Sync Library Now
        </button>
      </div>
      {stats.lastSyncError && (
        <div className="error-banner" style={{ marginTop: 16 }}>Last sync error: {stats.lastSyncError}</div>
      )}
    </div>
  )
}

// ── Verbose Logging Section ────────────────────────────────────
function VerboseLoggingSection({ enabled, onChange }) {
  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">Verbose Logging</h2>
          <p className="section-desc" style={{ marginTop: 4 }}>
            When enabled, Diskovarr writes detailed HTTP request logs and debug output. Basic info/warn/error logs are always written.
            <br />
            View with: <code style={{ fontSize: '0.78rem', background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)' }}>sudo journalctl -u diskovarr -f</code>
            &nbsp;or&nbsp;
            <code style={{ fontSize: '0.78rem', background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)' }}>docker logs diskovarr -f</code>
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
function ApiKeySection({ apiKey, hasKey, onRegenerate }) {
  const [visible, setVisible] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

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
      await navigator.clipboard.writeText(apiKey)
    } catch { /* ignore */ }
  }

  return (
    <div className="admin-section">
      <div className="section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h2 className="section-title">API Key</h2>
      </div>
      <p className="section-desc">
        Use this key to authenticate external applications with Diskovarr's API. Send it as an <code>Authorization: Bearer &lt;key&gt;</code> or <code>X-Api-Key</code> header. The key grants admin-level access to all API endpoints.
      </p>
      <div className="conn-block-fields">
        <div className="conn-field-group" style={{ flex: 1, minWidth: 240, maxWidth: 520 }}>
          <span className="conn-field-label">API Key</span>
          <div className="conn-input-wrap">
            <input
              type={visible ? 'text' : 'password'}
              id="settings-api-key"
              className="conn-input"
              readOnly
              value={hasKey ? '••••••••' : ''}
              placeholder="No key generated yet"
              style={{ cursor: 'text' }}
            />
            <div className="conn-input-btns">
              {hasKey && (
                <>
                  <button type="button" className="conn-input-icon-btn" onClick={() => setVisible(!visible)} title="Show / hide" />
                  <button type="button" className="conn-input-icon-btn is-copy" onClick={handleCopy} title="Copy to clipboard" />
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
        View the full API endpoint reference in the
        <a href="https://diskovarr.com/#api-reference" target="_blank" rel="noopener" style={{ color: 'var(--accent)', textDecoration: 'none' }}>documentation &rarr;</a>
      </p>
    </div>
  )
}

// ── Overseerr Compat Section ───────────────────────────────────
function OverseerrCompatSection({ enabled, onToggle, apiKey, onRegenerate }) {
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
        <h2 className="section-title">Overseerr Compat API</h2>
        <div className="conn-toggle-wrap">
          <span className="conn-toggle-label" id="lbl-agregarr-enabled">
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
          <label className="slide-toggle" title="Enable the Overseerr-compatible API shim">
            <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
            <span className="slide-track" />
          </label>
        </div>
      </div>
      <p className="section-desc">
        Exposes an Overseerr-compatible API at <code>/api/v1/</code> for DUMB, Agregarr, Homarr, and any other app that speaks the Overseerr API. Use the key below as the <code>X-Api-Key</code> header.
      </p>
      <div className="conn-block-fields">
        <div className="conn-field-group" style={{ flex: 1, minWidth: 240, maxWidth: 520 }}>
          <span className="conn-field-label">Compat Key</span>
          <div className="conn-input-wrap">
            <input
              type={visible ? 'text' : 'password'}
              id="compat-api-key"
              className="conn-input"
              readOnly
              value={apiKey ? '••••••••' : ''}
              placeholder="No key generated yet"
              autoComplete="off"
              style={{ cursor: 'text' }}
            />
            <div className="conn-input-btns">
              {apiKey && (
                <>
                  <button type="button" className="conn-input-icon-btn" onClick={() => setVisible(!visible)} title="Show / hide" />
                  <button type="button" className="conn-input-icon-btn is-copy" onClick={handleCopy} title="Copy to clipboard" />
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
          Service Accounts <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(auto-created by Agregarr)</span>
        </p>
        <div id="agregarr-svc-users-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}></div>
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────
export default function GeneralSettings({ onDataLoaded, onToast }) {
  const [appPublicUrl, setAppPublicUrl] = useState('')
  const [themeColor, setThemeColor] = useState('#e5a00d')
  const [stats, setStats] = useState({
    movies: 0, tv: 0, lastSyncMovies: null, lastSyncTV: null, lastSyncError: null,
  })
  const [syncStatus, setSyncStatus] = useState(null)
  const [autoSync, setAutoSync] = useState(false)
  const [verboseLogging, setVerboseLogging] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [compatEnabled, setCompatEnabled] = useState(false)
  const [compatApiKey, setCompatApiKey] = useState('')
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
      onToast?.('API key regenerated')
      // Reload status to get new key
      const res = await adminStatus.get()
      if (res.data.apiKey) setApiKey(res.data.apiKey)
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

  if (loading) return <div className="admin-section"><p style={{ color: 'var(--text-muted)' }}>Loading settings...</p></div>

  return (
    <>
      <AppOptionsSection
        appPublicUrl={appPublicUrl}
        onAppPublicUrlChange={setAppPublicUrl}
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
      />
      <VerboseLoggingSection
        enabled={verboseLogging}
        onChange={handleVerboseLoggingChange}
      />
      <ApiKeySection
        apiKey={apiKey}
        hasKey={hasApiKey}
        onRegenerate={handleApiKeyRegenerate}
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
