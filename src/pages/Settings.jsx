import React, { useState, useCallback, useEffect } from 'react'
import {
  userApi,
} from '../services/api'
import { useToast } from '../context/ToastContext'


const REGIONS = [
  { value: '', label: 'All Regions' },
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
  { value: 'IN', label: 'India' },
  { value: 'BR', label: 'Brazil' },
  { value: 'MX', label: 'Mexico' },
  { value: 'NL', label: 'Netherlands' },
  { value: 'SE', label: 'Sweden' },
  { value: 'NO', label: 'Norway' },
  { value: 'DK', label: 'Denmark' },
  { value: 'FI', label: 'Finland' },
  { value: 'PL', label: 'Poland' },
  { value: 'RU', label: 'Russia' },
  { value: 'CN', label: 'China' },
  { value: 'AR', label: 'Argentina' },
  { value: 'CL', label: 'Chile' },
  { value: 'NZ', label: 'New Zealand' },
  { value: 'ZA', label: 'South Africa' },
  { value: 'BE', label: 'Belgium' },
  { value: 'CH', label: 'Switzerland' },
  { value: 'AT', label: 'Austria' },
  { value: 'PT', label: 'Portugal' },
  { value: 'IE', label: 'Ireland' },
]

const LANGUAGES = [
  { value: '', label: 'All Languages' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'sv', label: 'Swedish' },
  { value: 'da', label: 'Danish' },
  { value: 'no', label: 'Norwegian' },
  { value: 'fi', label: 'Finnish' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'tr', label: 'Turkish' },
  { value: 'th', label: 'Thai' },
]


export default function Settings() {
  const { error: toastError, success: toastSuccess } = useToast()

  const [settings, setSettings] = useState(null)
  const [featureFlags, setFeatureFlags] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const loadSettings = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await userApi.getSettings()
      setSettings(data)
      if (data.discover_enabled !== undefined) {
        setFeatureFlags({ discoverEnabled: data.discover_enabled })
      }
    } catch (e) {
      toastError('Failed to load settings')
    } finally {
      setLoading(false)
    }
  }, [toastError])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const handleSavePreferences = useCallback(async (e) => {
    e.preventDefault()
    setSaving(true)
    const formData = new FormData(e.target)
    const payload = {}
    formData.forEach((value, key) => {
      payload[key] = value || null
    })
    // Unchecked checkboxes are omitted from FormData; explicitly set each to true/false
    Array.from(e.target.querySelectorAll('input[type="checkbox"][name]')).forEach(cb => {
      if (cb.name.startsWith('notify_') || cb.name === 'pushover_enabled' || cb.name === 'discord_enabled') {
        payload[cb.name] = cb.checked
      }
    })
    try {
      await userApi.updateSettings(payload)
      toastSuccess('Settings saved')
    } catch (e) {
      toastError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [toastSuccess, toastError])

  const handleLandingPageChange = useCallback(async (checked) => {
    try {
      await userApi.updateSettings({ landing_page: checked ? 'explore' : 'home' })
      localStorage.setItem('landing_page', checked ? 'explore' : 'home')
      toastSuccess('Landing page preference updated')
    } catch (e) {
      toastError('Failed to update preference')
    }
  }, [toastSuccess, toastError])

  const handleTestPushover = useCallback(async () => {
    const key = document.getElementById('notif-pushover-key')?.value
    if (!key?.trim()) {
      toastError('Enter your Pushover user key first')
      return
    }
    try {
      const { data } = await userApi.testPushover(key.trim())
      if (data.ok) toastSuccess('Test message sent!')
      else toastError(data.error || 'Send failed')
    } catch (e) {
      toastError('Send failed')
    }
  }, [toastSuccess, toastError])

  const handleTestDiscord = useCallback(async () => {
    const userId = document.getElementById('notif-discord-userid')?.value
    if (!userId?.trim()) {
      toastError('Enter your Discord User ID first')
      return
    }
    try {
      const { data } = await userApi.testDiscord(userId.trim())
      if (data.ok) toastSuccess('Test message sent!')
      else toastError(data.error || 'Send failed')
    } catch (e) {
      toastError('Send failed')
    }
  }, [toastSuccess, toastError])

  const handleMatureChange = useCallback(async (checked) => {
    try {
      await userApi.updateSettings({ show_mature: checked })
      localStorage.setItem('matureEnabled', checked ? 'true' : 'false')
      toastSuccess('Mature content preference updated')
    } catch (e) {
      toastError('Failed to update preference')
    }
  }, [toastSuccess, toastError])

  if (loading) {
    return (
      <main className="main-content">
        <div className="queue-loading">Loading settings...</div>
      </main>
    )
  }

  const s = settings || {}
  const ff = featureFlags || {}

  const showElevatedNotifications = s.is_admin || s.is_elevated
  const showAdminOnlyNotifications = s.is_admin

  return (
    <main className="main-content">
      <div className="settings-page">
        <div className="settings-hero">
          <h1>My Settings</h1>
          <p>Your personal preferences for Diskovarr.</p>
        </div>

        <div className="settings-section">
          <p className="settings-section-title">Content Preferences</p>
          <p className="settings-desc" style={{ marginBottom: '20px' }}>These preferences will be used to filter content recommendations.</p>

          <form onSubmit={handleSavePreferences}>
            <div className="settings-field">
              <label className="settings-label" htmlFor="pref-region">Region</label>
              <select id="pref-region" name="region" className="settings-select" defaultValue={s.region || ''}>
                {REGIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>

            <div className="settings-field">
              <label className="settings-label" htmlFor="pref-language">Language</label>
              <select id="pref-language" name="language" className="settings-select" defaultValue={s.language || ''}>
                {LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>

            <div className="settings-field" style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <label className="slide-toggle">
                <input
                  type="checkbox"
                  checked={s.show_mature || false}
                  onChange={(e) => handleMatureChange(e.target.checked)}
                />
                <span className="slide-track" />
              </label>
              <span className="toggle-label">Show mature content (R & TV-MA)</span>
            </div>

            {ff.discoverEnabled && (
              <div className="settings-field" style={{ marginTop: '20px', padding: '0' }}>
                <label className="settings-label">Default Landing Page</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0' }}>
                  <span className="landing-label" style={{ fontWeight: s.landing_page !== 'explore' ? '600' : '400', opacity: s.landing_page !== 'explore' ? '1' : '0.6' }}>Diskovarr</span>
                  <label className="slide-toggle slide-toggle-always-on">
                    <input type="checkbox" defaultChecked={s.landing_page === 'explore'} onChange={(e) => handleLandingPageChange(e.target.checked)} />
                    <span className="slide-track" />
                  </label>
                  <span className="landing-label" style={{ fontWeight: s.landing_page === 'explore' ? '600' : '400', opacity: s.landing_page === 'explore' ? '1' : '0.6' }}>Diskovarr Requests</span>
                </div>
              </div>
            )}

            <button className="btn-settings-save" type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Preferences'}</button>
          </form>
        </div>

        <div className="settings-section">
          <p className="settings-section-title">Notification Settings</p>

          <form onSubmit={handleSavePreferences}>
            <div className="settings-field">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                  <input type="checkbox" name="notify_approved" defaultChecked={s.notify_approved !== false} />
                  <span style={{ fontSize: '0.88rem' }}>
                    <strong style={{ color: '#fff' }}>Request Approved</strong>
                    <span style={{ color: 'var(--text-secondary)' }}> — Get notified when your media requests are approved</span>
                  </span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                  <input type="checkbox" name="notify_denied" defaultChecked={s.notify_denied !== false} />
                  <span style={{ fontSize: '0.88rem' }}>
                    <strong style={{ color: '#fff' }}>Request Declined</strong>
                    <span style={{ color: 'var(--text-secondary)' }}> — Get notified when your media requests are declined</span>
                  </span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                  <input type="checkbox" name="notify_available" defaultChecked={s.notify_available !== false} />
                  <span style={{ fontSize: '0.88rem' }}>
                    <strong style={{ color: '#fff' }}>Request Available</strong>
                    <span style={{ color: 'var(--text-secondary)' }}> — Get notified when your requested media is available in the library</span>
                  </span>
                </label>
                 <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                   <input type="checkbox" name="notify_issue_update" defaultChecked={s.notify_issue_update !== false} />
                   <span style={{ fontSize: '0.88rem' }}>
                     <strong style={{ color: '#fff' }}>Issue Status Updated</strong>
                     <span style={{ color: 'var(--text-secondary)' }}> — Get notified when an issue you reported changes status</span>
                   </span>
                 </label>
                 {showElevatedNotifications && (
                   <>
                     <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                       <input type="checkbox" name="notify_pending" defaultChecked={s.notify_pending !== false} />
                       <span style={{ fontSize: '0.88rem' }}>
                         <strong style={{ color: '#fff' }}>New Request Pending</strong>
                         <span style={{ color: 'var(--text-secondary)' }}> — Get notified when a user submits a request awaiting approval</span>
                       </span>
                     </label>
                     <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                       <input type="checkbox" name="notify_auto_approved" defaultChecked={s.notify_auto_approved !== false} />
                       <span style={{ fontSize: '0.88rem' }}>
                         <strong style={{ color: '#fff' }}>Request Auto-Approved</strong>
                         <span style={{ color: 'var(--text-secondary)' }}> — Get notified when a request is automatically submitted</span>
                       </span>
                     </label>
                   </>
                 )}
                 {showAdminOnlyNotifications && (
                   <>
                     <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                       <input type="checkbox" name="notify_process_failed" defaultChecked={s.notify_process_failed !== false} />
                       <span style={{ fontSize: '0.88rem' }}>
                         <strong style={{ color: '#fff' }}>Processing Failed</strong>
                         <span style={{ color: 'var(--text-secondary)' }}> — Get notified when a request fails to submit to Radarr/Sonarr/Overseerr</span>
                       </span>
                     </label>
                     <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                       <input type="checkbox" name="notify_issue_new" defaultChecked={s.notify_issue_new !== false} />
                       <span style={{ fontSize: '0.88rem' }}>
                         <strong style={{ color: '#fff' }}>New Issue Reported</strong>
                         <span style={{ color: 'var(--text-secondary)' }}> — Get notified when a user reports a new issue</span>
                       </span>
                     </label>
                   </>
                 )}
                 <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                   <input type="checkbox" name="notify_issue_comment" defaultChecked={s.notify_issue_comment !== false} />
                   <span style={{ fontSize: '0.88rem' }}>
                     <strong style={{ color: '#fff' }}>Issue Comment</strong>
                     <span style={{ color: 'var(--text-secondary)' }}> — Get notified when a comment is added to an issue</span>
                   </span>
                 </label>
              </div>
            </div>

            <div className="settings-field" style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
              <label className="settings-label">Pushover</label>
              <p className="settings-desc">Receive personal push notifications via Pushover.</p>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
                <input type="text" id="notif-pushover-key" name="pushover_user_key" className="settings-select" style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.82rem' }} placeholder="User key..." defaultValue={s.pushover_user_key || ''} />
                <button type="button" className="btn-settings-save" style={{ whiteSpace: 'nowrap', padding: '8px 14px', fontSize: '0.82rem' }} onClick={handleTestPushover}>Send Test</button>
              </div>
              <div className="toggle-row" style={{ marginTop: '10px' }}>
                <label className="slide-toggle">
                  <input type="checkbox" name="pushover_enabled" defaultChecked={s.pushover_enabled || false} />
                  <span className="slide-track" />
                </label>
                <span className="toggle-label">Enable Pushover notifications</span>
              </div>
            </div>

            <div className="settings-field" style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
              <label className="settings-label">Discord (Bot DMs)</label>
              <p className="settings-desc">Enter your Discord User ID to receive direct message notifications from the Diskovarr bot.</p>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '0 0 4px' }}>
                <strong style={{ color: 'var(--text-primary)' }}>Desktop:</strong> A 17-19 digit number — not your username. Enable Developer Mode (Settings → Advanced), then right-click your avatar on any message you've sent → Copy User ID.
              </p>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '0 0 6px' }}>
                <strong style={{ color: 'var(--text-primary)' }}>Mobile:</strong> Tap on your profile in a message, then tap the ⋯ in the top-right corner → Copy User ID.
              </p>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
                <input type="text" id="notif-discord-userid" name="discord_user_id" className="settings-select" style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.82rem' }} placeholder="e.g. 185234567891234560" defaultValue={s.discord_user_id || ''} />
                <button type="button" className="btn-settings-save" style={{ whiteSpace: 'nowrap', padding: '8px 14px', fontSize: '0.82rem' }} onClick={handleTestDiscord}>Send Test</button>
              </div>
              {s.discord_invite_link && (
                <div style={{ background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.25)', borderRadius: '8px', padding: '10px 14px', marginTop: '10px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                  ⚠️ You must be a member of the admin's Discord server for the bot to send you DMs.
                  <a href={s.discord_invite_link} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: '8px', padding: '6px 14px', background: 'var(--accent)', color: '#000', borderRadius: '6px', fontWeight: '600', textDecoration: 'none', fontSize: '0.82rem' }}>Join Server</a>
                </div>
              )}
              <div className="toggle-row" style={{ marginTop: '10px' }}>
                <label className="slide-toggle">
                  <input type="checkbox" name="discord_enabled" defaultChecked={s.discord_enabled || false} />
                  <span className="slide-track" />
                </label>
                <span className="toggle-label">Enable Discord notifications</span>
              </div>
            </div>

            <button className="btn-settings-save" type="submit" style={{ marginTop: '16px' }} disabled={saving}>
              {saving ? 'Saving...' : 'Save Notification Settings'}
            </button>
          </form>
        </div>


      </div>
    </main>
  )
}
