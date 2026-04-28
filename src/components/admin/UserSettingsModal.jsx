import { useState, useEffect, useCallback } from 'react'
import { adminUserSettings } from '../../services/adminApi'
import adminApi from '../../services/adminApi'

const REGIONS = [
  { value: '', label: 'Default' },
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'CA', label: 'Canada' },
  { value: 'AU', label: 'Australia' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'ES', label: 'Spain' },
  { value: 'IT', label: 'Italy' },
  { value: 'JP', label: 'Japan' },
  { value: 'KR', label: 'South Korea' },
  { value: 'BR', label: 'Brazil' },
  { value: 'MX', label: 'Mexico' },
  { value: 'IN', label: 'India' },
]

const LANGUAGES = [
  { value: '', label: 'Default' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
]

const LANDING_PAGES = [
  { value: '', label: 'Default' },
  { value: 'discover', label: 'Discover' },
  { value: 'watchlist', label: 'Watchlist' },
  { value: 'requests', label: 'Requests' },
]

const NOTIF_TYPES = [
  { key: 'notify_approved',      label: 'Request approved' },
  { key: 'notify_denied',        label: 'Request denied' },
  { key: 'notify_available',     label: 'Request available in library' },
  { key: 'notify_pending',       label: 'New request pending (admin)' },
  { key: 'notify_auto_approved', label: 'Request auto-approved' },
  { key: 'notify_process_failed',label: 'Request processing error' },
  { key: 'notify_issue_new',     label: 'New issue reported' },
  { key: 'notify_issue_update',  label: 'Issue status updated' },
  { key: 'notify_issue_comment', label: 'Issue comment added' },
]

function Toggle({ checked, onChange, label, disabled }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <label className="slide-toggle">
        <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
        <span className="slide-track" />
      </label>
      {label && <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{label}</span>}
    </div>
  )
}

export default function UserSettingsModal({ userId, username, onClose, onToast, enabledProviders }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Request limit overrides
  const [overrideGlobal, setOverrideGlobal] = useState(false)
  const [movieUnlimited, setMovieUnlimited] = useState(false)
  const [movieCount, setMovieCount] = useState(1)
  const [movieDays, setMovieDays] = useState(7)
  const [seasonUnlimited, setSeasonUnlimited] = useState(false)
  const [seasonCount, setSeasonCount] = useState(1)
  const [seasonDays, setSeasonDays] = useState(7)

  // Auto-approve overrides
  const [autoApproveOverride, setAutoApproveOverride] = useState(false)
  const [autoApproveMovies, setAutoApproveMovies] = useState(false)
  const [autoApproveTv, setAutoApproveTv] = useState(false)

  // Admin privileges
  const [isAdmin, setIsAdmin] = useState(false)

  // Personalization
  const [region, setRegion] = useState('')
  const [language, setLanguage] = useState('')
  const [landingPage, setLandingPage] = useState('')

  // Auto-request
  const [autoRequestMovies, setAutoRequestMovies] = useState(false)
  const [autoRequestTv, setAutoRequestTv] = useState(false)

  // Notification delivery — Discord
  const [discordUserId, setDiscordUserId] = useState('')
  const [discordEnabled, setDiscordEnabled] = useState(false)
  const [discordWebhook, setDiscordWebhook] = useState('')

  // Notification delivery — Pushover
  const [pushoverUserKey, setPushoverUserKey] = useState('')
  const [pushoverEnabled, setPushoverEnabled] = useState(false)
  const [pushoverAppToken, setPushoverAppToken] = useState('')
  const [pushoverSound, setPushoverSound] = useState('')

  // Notification delivery — Telegram
  const [telegramEnabled, setTelegramEnabled] = useState(false)
  const [telegramChatId, setTelegramChatId] = useState('')
  const [telegramThreadId, setTelegramThreadId] = useState('')
  const [telegramSilent, setTelegramSilent] = useState(false)

  // Notification delivery — Pushbullet
  const [pushbulletEnabled, setPushbulletEnabled] = useState(false)
  const [pushbulletToken, setPushbulletToken] = useState('')

  // Notification delivery — Email
  const [emailEnabled, setEmailEnabled] = useState(false)

  // Notification type checkboxes
  const [notifTypes, setNotifTypes] = useState({
    notify_approved: true,
    notify_denied: true,
    notify_available: true,
    notify_pending: true,
    notify_auto_approved: true,
    notify_process_failed: true,
    notify_issue_new: true,
    notify_issue_update: true,
    notify_issue_comment: true,
  })

  const loadSettings = useCallback(async () => {
    try {
      const { data } = await adminUserSettings.get(userId)
      setOverrideGlobal(!!data.overrideGlobal)
      setMovieUnlimited(data.movieLimit === 0)
      setMovieCount(data.movieLimit > 0 ? data.movieLimit : 1)
      setMovieDays(data.movieWindowDays ?? 7)
      setSeasonUnlimited(data.seasonLimit === 0)
      setSeasonCount(data.seasonLimit > 0 ? data.seasonLimit : 1)
      setSeasonDays(data.tvWindowDays ?? 7)
      setAutoApproveOverride(data.auto_approve_movies !== null || data.auto_approve_tv !== null)
      setAutoApproveMovies(data.auto_approve_movies === 1 || data.auto_approve_movies === true)
      setAutoApproveTv(data.auto_approve_tv === 1 || data.auto_approve_tv === true)
      setIsAdmin(!!data.is_admin)
      setRegion(data.region || '')
      setLanguage(data.language || '')
      setLandingPage(data.landing_page || '')
      setAutoRequestMovies(!!data.auto_request_movies)
      setAutoRequestTv(!!data.auto_request_tv)

      const np = data.notificationPrefs || {}
      setDiscordUserId(np.discord_user_id || '')
      setDiscordEnabled(!!np.discord_enabled)
      setDiscordWebhook(np.discord_webhook || '')
      setPushoverUserKey(np.pushover_user_key || '')
      setPushoverEnabled(!!np.pushover_enabled)
      setPushoverAppToken(np.pushover_application_token || '')
      setPushoverSound(np.pushover_sound || '')
      setTelegramEnabled(!!np.telegram_enabled)
      setTelegramChatId(np.telegram_chat_id || '')
      setTelegramThreadId(np.telegram_message_thread_id || '')
      setTelegramSilent(!!np.telegram_send_silently)
      setPushbulletEnabled(!!np.pushbullet_enabled)
      setPushbulletToken(np.pushbullet_access_token || '')
      setEmailEnabled(!!np.email_enabled)
      setNotifTypes({
        notify_approved:       np.notify_approved       !== false,
        notify_denied:         np.notify_denied         !== false,
        notify_available:      np.notify_available      !== false,
        notify_pending:        np.notify_pending        !== false,
        notify_auto_approved:  np.notify_auto_approved  !== false,
        notify_process_failed: np.notify_process_failed !== false,
        notify_issue_new:      np.notify_issue_new      !== false,
        notify_issue_update:   np.notify_issue_update   !== false,
        notify_issue_comment:  np.notify_issue_comment  !== false,
      })
    } catch {
      if (onToast) onToast('Failed to load user settings', 'error')
    } finally {
      setLoading(false)
    }
  }, [userId, onToast])

  useEffect(() => {
    if (userId) loadSettings()
  }, [userId, loadSettings])

  const handleSubmit = async () => {
    setSaving(true)
    try {
      const amVal = autoApproveOverride ? (autoApproveMovies ? '1' : '0') : null
      const atVal = autoApproveOverride ? (autoApproveTv ? '1' : '0') : null

      await adminUserSettings.set(userId, {
        movieLimit: movieUnlimited ? 0 : movieCount,
        seasonLimit: seasonUnlimited ? 0 : seasonCount,
        movieWindowDays: movieDays,
        tvWindowDays: seasonDays,
        override_global: overrideGlobal ? '1' : '0',
        auto_approve_movies: amVal,
        auto_approve_tv: atVal,
        is_admin: isAdmin ? '1' : '0',
        region: region || null,
        language: language || null,
        auto_request_movies: autoRequestMovies ? '1' : '0',
        auto_request_tv: autoRequestTv ? '1' : '0',
        landing_page: landingPage || null,
        notificationPrefs: {
          ...notifTypes,
          discord_user_id: discordUserId || null,
          discord_enabled: discordEnabled,
          discord_webhook: discordWebhook || null,
          pushover_user_key: pushoverUserKey || null,
          pushover_enabled: pushoverEnabled,
          pushover_application_token: pushoverAppToken || null,
          pushover_sound: pushoverSound || null,
          telegram_chat_id: telegramChatId || null,
          telegram_message_thread_id: telegramThreadId || null,
          telegram_send_silently: telegramSilent,
          telegram_enabled: telegramEnabled,
          pushbullet_access_token: pushbulletToken || null,
          pushbullet_enabled: pushbulletEnabled,
          email_enabled: emailEnabled,
        },
      })
      if (onToast) onToast('User settings saved', 'success')
      onClose()
    } catch {
      if (onToast) onToast('Failed to save user settings', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose()
  }

  const syncWatched = async () => {
    try {
      await adminApi.post(`/sync/watched/${userId}`)
      if (onToast) onToast('Re-sync watched started', 'success')
    } catch {
      if (onToast) onToast('Failed to re-sync watched', 'error')
    }
  }

  const clearWatched = async () => {
    try {
      await adminApi.post(`/cache/clear/watched/${userId}`)
      if (onToast) onToast('Watched history cleared', 'success')
    } catch {
      if (onToast) onToast('Failed to clear watched', 'error')
    }
  }

  const clearDismissals = async () => {
    try {
      await adminApi.post(`/cache/clear/dismissals/${userId}`)
      if (onToast) onToast('Dismissals cleared', 'success')
    } catch {
      if (onToast) onToast('Failed to clear dismissals', 'error')
    }
  }

  const clearRequests = async () => {
    try {
      await adminApi.delete(`/users/${userId}/requests`)
      if (onToast) onToast('Requests cleared', 'success')
    } catch {
      if (onToast) onToast('Failed to clear requests', 'error')
    }
  }

  if (loading) return null

  const sectionLabel = {
    fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)',
    marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.75)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
      onClick={handleBackdropClick}
    >
      <div
        style={{
          background: 'var(--bg-secondary)', borderRadius: 14, padding: 28,
          width: 'min(560px, 92vw)', border: '1px solid var(--border)',
          position: 'relative', maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 14, right: 16, background: 'none',
            border: 'none', color: 'var(--text-secondary)', fontSize: 16, cursor: 'pointer',
          }}
        >
          &times;
        </button>

        <h3 style={{ margin: '0 0 4px', fontSize: '1.05rem' }}>User Settings</h3>
        <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
          {username} (ID: {userId})
        </p>

        {/* ── Request Limit Override ── */}
        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
          <div style={sectionLabel}>Request Limits</div>
          <div className="conn-toggle-row" style={{ marginBottom: 12 }}>
            <label className="slide-toggle">
              <input type="checkbox" checked={overrideGlobal} onChange={(e) => setOverrideGlobal(e.target.checked)} />
              <span className="slide-track" />
            </label>
            <span className="conn-toggle-label" style={{ fontWeight: 500 }}>Override global request limits</span>
          </div>

          {overrideGlobal && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingLeft: 4 }}>
              {/* Movies */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ minWidth: 84, fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>Movies</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)', userSelect: 'none' }}>
                  <input type="checkbox" className="themed-checkbox" checked={movieUnlimited} onChange={(e) => setMovieUnlimited(e.target.checked)} />
                  Unlimited
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: movieUnlimited ? 0.5 : 1, pointerEvents: movieUnlimited ? 'none' : 'auto' }}>
                  <div className="conn-field-group">
                    <label className="conn-field-label">Count</label>
                    <input type="number" min="1" max="9999" className="btn-admin limit-num" value={movieCount} onChange={(e) => setMovieCount(Math.min(9999, Math.max(1, Number(e.target.value))))} />
                  </div>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>movies per</span>
                  <div className="conn-field-group">
                    <label className="conn-field-label">Days</label>
                    <input type="number" min="1" max="365" className="btn-admin limit-num" value={movieDays} onChange={(e) => setMovieDays(Math.min(365, Math.max(1, Number(e.target.value))))} />
                  </div>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>days</span>
                </div>
              </div>
              {/* TV Seasons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ minWidth: 84, fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>TV Seasons</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)', userSelect: 'none' }}>
                  <input type="checkbox" className="themed-checkbox" checked={seasonUnlimited} onChange={(e) => setSeasonUnlimited(e.target.checked)} />
                  Unlimited
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: seasonUnlimited ? 0.5 : 1, pointerEvents: seasonUnlimited ? 'none' : 'auto' }}>
                  <div className="conn-field-group">
                    <label className="conn-field-label">Count</label>
                    <input type="number" min="1" max="9999" className="btn-admin limit-num" value={seasonCount} onChange={(e) => setSeasonCount(Math.min(9999, Math.max(1, Number(e.target.value))))} />
                  </div>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>seasons per</span>
                  <div className="conn-field-group">
                    <label className="conn-field-label">Days</label>
                    <input type="number" min="1" max="365" className="btn-admin limit-num" value={seasonDays} onChange={(e) => setSeasonDays(Math.min(365, Math.max(1, Number(e.target.value))))} />
                  </div>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>days</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Auto-approve Override ── */}
        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
          <div style={sectionLabel}>Auto-Approve Override</div>
          <div className="conn-toggle-row" style={{ marginBottom: 12 }}>
            <label className="slide-toggle">
              <input type="checkbox" checked={autoApproveOverride} onChange={(e) => setAutoApproveOverride(e.target.checked)} />
              <span className="slide-track" />
            </label>
            <span className="conn-toggle-label" style={{ fontWeight: 500 }}>Override global approval settings</span>
          </div>
          {autoApproveOverride && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 4 }}>
              <Toggle checked={autoApproveMovies} onChange={(e) => setAutoApproveMovies(e.target.checked)} label="Auto-approve movie requests" />
              <Toggle checked={autoApproveTv} onChange={(e) => setAutoApproveTv(e.target.checked)} label="Auto-approve TV show requests" />
            </div>
          )}
        </div>

        {/* ── Admin Privileges ── */}
        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
          <Toggle checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} label="Elevated privileges (queue access)" />
        </div>

        {/* ── Personalization ── */}
        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
          <div style={sectionLabel}>Personalization</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="conn-field-group" style={{ flex: 1, minWidth: 120 }}>
              <label className="conn-field-label">Region</label>
              <select className="conn-input" value={region} onChange={(e) => setRegion(e.target.value)}>
                {REGIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div className="conn-field-group" style={{ flex: 1, minWidth: 120 }}>
              <label className="conn-field-label">Language</label>
              <select className="conn-input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div className="conn-field-group" style={{ flex: 1, minWidth: 120 }}>
              <label className="conn-field-label">Landing Page</label>
              <select className="conn-input" value={landingPage} onChange={(e) => setLandingPage(e.target.value)}>
                {LANDING_PAGES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* ── Auto-Request Watchlist ── */}
        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
          <div style={sectionLabel}>Auto-Request Watchlist</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle checked={autoRequestMovies} onChange={(e) => setAutoRequestMovies(e.target.checked)} label="Auto-request movies from watchlist" />
            <Toggle checked={autoRequestTv} onChange={(e) => setAutoRequestTv(e.target.checked)} label="Auto-request TV shows from watchlist" />
          </div>
        </div>

        {/* ── Notification Delivery ── */}
        {(() => {
          // Only show notification delivery if at least one provider is enabled
          const isProviderEnabled = (id) => !enabledProviders || enabledProviders[id] !== false
          const hasAnyProvider = !enabledProviders || Object.values(enabledProviders).some(v => v === true)

          if (!hasAnyProvider) return null

          return (
            <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
              <div style={sectionLabel}>Notification Delivery</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {isProviderEnabled('discord') && (
                  <>
                    <div>
                      <label className="conn-field-label">Discord User ID</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input type="text" className="conn-input" style={{ maxWidth: 220 }} placeholder="Discord user ID" value={discordUserId} onChange={(e) => setDiscordUserId(e.target.value)} />
                        <Toggle checked={discordEnabled} onChange={(e) => setDiscordEnabled(e.target.checked)} label="Enable" />
                      </div>
                    </div>
                    <div>
                      <label className="conn-field-label">Discord Personal Webhook <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                      <input type="url" className="conn-input" style={{ maxWidth: 350 }} placeholder="https://discord.com/api/webhooks/..." value={discordWebhook} onChange={(e) => setDiscordWebhook(e.target.value)} />
                    </div>
                  </>
                )}
                {isProviderEnabled('pushover') && (
                  <>
                    <div>
                      <label className="conn-field-label">Pushover User Key</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input type="text" className="conn-input" style={{ maxWidth: 220 }} placeholder="Pushover user key" value={pushoverUserKey} onChange={(e) => setPushoverUserKey(e.target.value)} />
                        <Toggle checked={pushoverEnabled} onChange={(e) => setPushoverEnabled(e.target.checked)} label="Enable" />
                      </div>
                    </div>
                    <div>
                      <label className="conn-field-label">Pushover App Token <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional, use your own app)</span></label>
                      <input type="text" className="conn-input" style={{ maxWidth: 280 }} placeholder="App token" value={pushoverAppToken} onChange={(e) => setPushoverAppToken(e.target.value)} />
                    </div>
                    <div>
                      <label className="conn-field-label">Pushover Sound <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                      <select className="conn-input" style={{ maxWidth: 220 }} value={pushoverSound} onChange={(e) => setPushoverSound(e.target.value)}>
                        <option value="">Device Default</option>
                        <option value="pushover">Pushover</option>
                        <option value="bike">Bike</option>
                        <option value="bugle">Bugle</option>
                        <option value="cashregister">Cash Register</option>
                        <option value="cosmic">Cosmic</option>
                        <option value="falling">Falling</option>
                        <option value="gamelan">Gamelan</option>
                        <option value="incoming">Incoming</option>
                        <option value="magic">Magic</option>
                        <option value="pianobar">Piano Bar</option>
                        <option value="siren">Siren</option>
                        <option value="spacealarm">Space Alarm</option>
                        <option value="none">Silent</option>
                      </select>
                    </div>
                  </>
                )}
                {isProviderEnabled('telegram') && (
                  <>
                    <div>
                      <label className="conn-field-label">Telegram Chat ID</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input type="text" className="conn-input" style={{ maxWidth: 220 }} placeholder="Chat ID" value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} />
                        <Toggle checked={telegramEnabled} onChange={(e) => setTelegramEnabled(e.target.checked)} label="Enable" />
                      </div>
                    </div>
                    {telegramEnabled && (
                      <>
                        <div>
                          <label className="conn-field-label">Thread ID <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional, forum topics)</span></label>
                          <input type="text" className="conn-input" style={{ maxWidth: 220 }} placeholder="Thread ID" value={telegramThreadId} onChange={(e) => setTelegramThreadId(e.target.value)} />
                        </div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', cursor: 'pointer' }}>
                          <input type="checkbox" className="themed-checkbox" checked={telegramSilent} onChange={(e) => setTelegramSilent(e.target.checked)} />
                          Send silently (no sound)
                        </label>
                      </>
                    )}
                  </>
                )}
                {isProviderEnabled('pushbullet') && (
                  <div>
                    <label className="conn-field-label">Pushbullet Access Token</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input type="password" className="conn-input" style={{ maxWidth: 220 }} placeholder="o.YourToken" value={pushbulletToken} onChange={(e) => setPushbulletToken(e.target.value)} autoComplete="off" />
                      <Toggle checked={pushbulletEnabled} onChange={(e) => setPushbulletEnabled(e.target.checked)} label="Enable" />
                    </div>
                  </div>
                )}
                {isProviderEnabled('email') && (
                  <div>
                    <label className="conn-field-label">Email Notifications</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Toggle checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} label="Enable" />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* ── Notification Types ── */}
        <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
          <div style={sectionLabel}>Notification Types</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {NOTIF_TYPES.map(({ key, label }) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  className="themed-checkbox"
                  checked={notifTypes[key]}
                  onChange={(e) => setNotifTypes(prev => ({ ...prev, [key]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        {/* ── User Actions ── */}
        <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: '1px solid var(--border)' }}>
          <div style={sectionLabel}>Actions</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-admin btn-sm" onClick={syncWatched}>&#8639; Re-sync Watched</button>
            <button className="btn-admin btn-sm btn-danger" onClick={clearWatched}>&#10005; Clear Watched</button>
            <button className="btn-admin btn-sm btn-danger" onClick={clearDismissals}>&#10005; Clear Dismissals</button>
            <button className="btn-admin btn-sm btn-danger" onClick={clearRequests}>&#10005; Clear Requests</button>
          </div>
        </div>

        {/* ── Footer Buttons ── */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-admin" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-admin btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
