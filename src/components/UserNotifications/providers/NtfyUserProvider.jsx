import React, { useState } from 'react'
import { userApi } from '../../../services/api'
import { useTranslation } from 'react-i18next'

const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/

export default function NtfyUserProvider({ settings, onToast, onSave }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(!!settings?.ntfy_enabled)
  const [topic, setTopic] = useState(settings?.ntfy_topic || '')
  const [url, setUrl] = useState(settings?.ntfy_url || '')
  const [authMethod, setAuthMethod] = useState(settings?.ntfy_auth_method || 'none')
  const [token, setToken] = useState(settings?.ntfy_token || '')
  const [username, setUsername] = useState(settings?.ntfy_username || '')
  const [password, setPassword] = useState(settings?.ntfy_password || '')
  const [testing, setTesting] = useState(false)

  const adminUrl = settings?.ntfy_server_url || ''
  const usingAdminServer = !url.trim()

  const validate = () => {
    if (!TOPIC_RE.test(topic.trim())) {
      if (onToast) onToast(t('Enter a topic using only letters, numbers, - and _ (max 64)'), 'error')
      return false
    }
    if (url.trim() && !/^https?:\/\//i.test(url.trim())) {
      if (onToast) onToast(t('Server URL must start with http:// or https://'), 'error')
      return false
    }
    if (!url.trim() && !adminUrl) {
      if (onToast) onToast(t('The admin has not set a default ntfy server; enter your own server URL'), 'error')
      return false
    }
    return true
  }

  const target = () => ({
    ntfy_topic: topic.trim(),
    ntfy_url: url.trim() || null,
    ntfy_auth_method: authMethod,
    ntfy_token: authMethod === 'token' ? (token || null) : null,
    ntfy_username: authMethod === 'basic' ? (username || null) : null,
    ntfy_password: authMethod === 'basic' ? (password || null) : null,
  })

  const handleSave = async () => {
    if (enabled && !validate()) return
    try {
      await userApi.updateSettings({ ...target(), ntfy_enabled: enabled })
      if (onToast) onToast(t('ntfy settings saved'), 'success')
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.response?.data?.error || e.message || t('Save failed'), 'error')
    }
  }

  const handleTest = async () => {
    if (!validate()) return
    setTesting(true)
    try {
      const { data } = await userApi.testNtfy(target())
      if (data.ok) {
        if (onToast) onToast(t('Test message sent!'), 'success')
      } else if (onToast) onToast(data.error || t('Send failed'), 'error')
    } catch (e) {
      if (onToast) onToast(e.message || t('Send failed'), 'error')
    } finally { setTesting(false) }
  }

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">{t('ntfy')}</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>
        {t('Receive notifications on your own ntfy topic. Subscribe to the topic in the ntfy app or web UI; anyone who knows the topic name can read it, so pick something hard to guess.')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label className="conn-label">{t('Topic')}</label>
          <input type="text" className="conn-input" placeholder={t('e.g. diskovarr-alerts-8f3k2')} value={topic} onChange={(e) => setTopic(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className="conn-label">{t('Server URL')} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({t('optional')})</span></label>
          <input type="url" className="conn-input" placeholder={adminUrl || 'https://ntfy.sh'} value={url} onChange={(e) => setUrl(e.target.value)} />
          {usingAdminServer && adminUrl && (
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
              {t('Leave empty to use the server your admin configured:')} <code>{adminUrl}</code>
            </p>
          )}
        </div>
        <div>
          <label className="conn-label">{t('Authentication')} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({t('optional')})</span></label>
          <select className="conn-input" value={authMethod} onChange={(e) => setAuthMethod(e.target.value)} style={{ marginBottom: 8 }}>
            <option value="none">{usingAdminServer && adminUrl ? t("None (use the admin's credentials)") : t('None')}</option>
            <option value="token">{t('Bearer Token')}</option>
            <option value="basic">{t('Username / Password')}</option>
          </select>
          {authMethod === 'token' && <input type="password" className="conn-input" placeholder={t('Bearer token')} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}
          {authMethod === 'basic' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" className="conn-input" placeholder={t('Username')} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              <input type="password" className="conn-input" placeholder={t('Password')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </div>
          )}
        </div>
        <div className="toggle-row">
          <label className="slide-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">{t('Enable ntfy notifications')}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>{t('Save')}</button>
          <button className="btn-admin" onClick={handleTest} disabled={testing}>{testing ? t('Sending...') : t('Send Test')}</button>
        </div>
      </div>
    </section>
  )
}
