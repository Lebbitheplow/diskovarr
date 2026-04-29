import React, { useState, useCallback, useEffect } from 'react'
import { userApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import UserNotifications from '../components/UserNotifications/UserNotifications'

const REGIONS = [
  { value: '', label: 'All Regions' }, { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' }, { value: 'CA', label: 'Canada' },
  { value: 'AU', label: 'Australia' }, { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' }, { value: 'ES', label: 'Spain' },
  { value: 'IT', label: 'Italy' }, { value: 'JP', label: 'Japan' },
  { value: 'KR', label: 'South Korea' }, { value: 'IN', label: 'India' },
  { value: 'BR', label: 'Brazil' }, { value: 'MX', label: 'Mexico' },
  { value: 'NL', label: 'Netherlands' }, { value: 'SE', label: 'Sweden' },
  { value: 'NO', label: 'Norway' }, { value: 'DK', label: 'Denmark' },
  { value: 'FI', label: 'Finland' }, { value: 'PL', label: 'Poland' },
  { value: 'RU', label: 'Russia' }, { value: 'CN', label: 'China' },
  { value: 'AR', label: 'Argentina' }, { value: 'CL', label: 'Chile' },
  { value: 'NZ', label: 'New Zealand' }, { value: 'ZA', label: 'South Africa' },
  { value: 'BE', label: 'Belgium' }, { value: 'CH', label: 'Switzerland' },
  { value: 'AT', label: 'Austria' }, { value: 'PT', label: 'Portugal' },
  { value: 'IE', label: 'Ireland' },
]

const LANGUAGES = [
  { value: '', label: 'All Languages' }, { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' }, { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' }, { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' }, { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' }, { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' }, { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' }, { value: 'sv', label: 'Swedish' },
  { value: 'da', label: 'Danish' }, { value: 'no', label: 'Norwegian' },
  { value: 'fi', label: 'Finnish' }, { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' }, { value: 'tr', label: 'Turkish' },
  { value: 'th', label: 'Thai' },
]

export default function Settings() {
  const { error: toastError, success: toastSuccess } = useToast()
  const [settings, setSettings] = useState(null)
  const [featureFlags, setFeatureFlags] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('content')

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

  useEffect(() => { loadSettings() }, [loadSettings])

  const handleSavePreferences = useCallback(async (e) => {
    e.preventDefault()
    setSaving(true)
    const formData = new FormData(e.target)
    const payload = {}
    formData.forEach((value, key) => { payload[key] = value || null })
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

  const handleMatureChange = useCallback(async (checked) => {
    try {
      await userApi.updateSettings({ show_mature: checked })
      localStorage.setItem('matureEnabled', checked ? 'true' : 'false')
      toastSuccess('Mature content preference updated')
    } catch (e) {
      toastError('Failed to update preference')
    }
  }, [toastSuccess, toastError])

  const handleUpdateSettings = useCallback(async (payload) => {
    try {
      await userApi.updateSettings(payload)
      // Refresh settings to stay in sync
      const { data } = await userApi.getSettings()
      setSettings(data)
      toastSuccess('Settings updated')
    } catch (e) {
      toastError(e.message || 'Save failed')
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

  return (
    <main className="main-content">
      <div className="settings-page">
        <div className="settings-hero">
          <h1>My Settings</h1>
          <p>Your personal preferences for Diskovarr.</p>
        </div>

        {/* Internal tabs */}
        <div className="settings-tabs" style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
          <button
            className={`settings-tab ${activeTab === 'content' ? 'active' : ''}`}
            style={{
              padding: '10px 22px', background: 'none', border: 'none',
              borderBottom: '2px solid transparent', color: activeTab === 'content' ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: '0.9rem', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
              marginBottom: '-1px', transition: 'color 0.15s, border-color 0.15s',
              ...(activeTab === 'content' ? { borderBottomColor: 'var(--accent)' } : {}),
            }}
            onClick={() => setActiveTab('content')}
          >
            Content Preferences
          </button>
          <button
            className={`settings-tab ${activeTab === 'notifications' ? 'active' : ''}`}
            style={{
              padding: '10px 22px', background: 'none', border: 'none',
              borderBottom: '2px solid transparent', color: activeTab === 'notifications' ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: '0.9rem', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
              marginBottom: '-1px', transition: 'color 0.15s, border-color 0.15s',
              ...(activeTab === 'notifications' ? { borderBottomColor: 'var(--accent)' } : {}),
            }}
            onClick={() => setActiveTab('notifications')}
          >
            Notifications
          </button>
        </div>

        {activeTab === 'content' && (
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
                  <input type="checkbox" checked={s.show_mature || false} onChange={(e) => handleMatureChange(e.target.checked)} />
                  <span className="slide-track" />
                </label>
                <span className="toggle-label">Show mature content (R & TV-MA)</span>
              </div>
              {ff.discoverEnabled && (
                <div className="settings-field" style={{ marginTop: '20px', padding: '0' }}>
                  <label className="settings-label">Default Landing Page</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0' }}>
                    <span className={s.landing_page !== 'explore' ? 'service-label-active' : 'service-label-inactive'}>Diskovarr</span>
                    <label className="slide-toggle slide-toggle-always-on">
                      <input type="checkbox" defaultChecked={s.landing_page === 'explore'} onChange={(e) => handleLandingPageChange(e.target.checked)} />
                      <span className="slide-track" />
                    </label>
                    <span className={s.landing_page === 'explore' ? 'service-label-active' : 'service-label-inactive'}>Diskovarr Requests</span>
                  </div>
                </div>
              )}
              <button className="btn-settings-save" type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Preferences'}</button>
            </form>
          </div>
        )}

        {activeTab === 'notifications' && (
          <UserNotifications settings={s} onToast={toastError} onUpdateSettings={handleUpdateSettings} />
        )}
      </div>
    </main>
  )
}
