import React, { useState, useEffect, useCallback } from 'react'
import { userApi } from '../../../services/api'
import { useTranslation } from 'react-i18next'
import {
  currentPushEnv, pushUnavailableReason, getExistingSubscription,
  subscribeBrowser, unsubscribeBrowser,
} from '../../../utils/webPush'

export default function WebpushUserProvider({ settings, onToast, onSave }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(!!settings?.webpush_enabled)
  const [thisDevice, setThisDevice] = useState(false)   // this browser is subscribed
  const [deviceCount, setDeviceCount] = useState(null)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const unavailable = pushUnavailableReason(currentPushEnv())

  const refresh = useCallback(async () => {
    try {
      const sub = unavailable ? null : await getExistingSubscription()
      setThisDevice(!!sub)
      const { data } = await userApi.getWebpushSubscriptions()
      setDeviceCount(data.count ?? 0)
    } catch { /* ignore */ }
  }, [unavailable])

  useEffect(() => {
    ;(async () => { await refresh() })()
  }, [refresh])

  const handleSubscribe = async () => {
    setBusy(true)
    try {
      const { data } = await userApi.getWebpushVapidKey()
      const sub = await subscribeBrowser(data.publicKey)
      await userApi.subscribeWebpush(sub.toJSON())
      setEnabled(true)
      if (onToast) onToast(t('This device will now receive browser notifications'), 'success')
      await refresh()
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.response?.data?.error || e.message || t('Could not enable notifications'), 'error')
    } finally { setBusy(false) }
  }

  const handleUnsubscribe = async () => {
    setBusy(true)
    try {
      const endpoint = await unsubscribeBrowser()
      if (endpoint) await userApi.unsubscribeWebpush(endpoint)
      if (onToast) onToast(t('This device was removed'), 'success')
      await refresh()
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.message || t('Could not remove this device'), 'error')
    } finally { setBusy(false) }
  }

  const handleSave = async () => {
    try {
      await userApi.updateSettings({ webpush_enabled: enabled })
      if (onToast) onToast(t('Browser notification settings saved'), 'success')
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.message || t('Save failed'), 'error')
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const { data } = await userApi.testWebpush()
      if (data.ok) {
        if (onToast) onToast(t('Test notification sent!'), 'success')
      } else if (onToast) onToast(data.error || t('Send failed'), 'error')
    } catch (e) {
      if (onToast) onToast(e.message || t('Send failed'), 'error')
    } finally { setTesting(false) }
  }

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">{t('Browser push')}</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>
        {t('Get native notifications from this browser, even when Diskovarr is closed. Each device you want alerts on has to be enabled from that device.')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {unavailable ? (
          <div style={{ background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.25)', borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
            {t(unavailable)}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {thisDevice ? (
              <>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{t('This device is enabled.')}</span>
                <button className="btn-admin" onClick={handleUnsubscribe} disabled={busy}>{t('Remove this device')}</button>
              </>
            ) : (
              <button className="btn-admin btn-primary" onClick={handleSubscribe} disabled={busy}>
                {busy ? t('Enabling...') : t('Enable on this device')}
              </button>
            )}
          </div>
        )}
        {deviceCount !== null && (
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
            {deviceCount === 1 ? t('1 device registered') : t('{{count}} devices registered', { count: deviceCount })}
          </p>
        )}
        <div className="toggle-row">
          <label className="slide-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">{t('Enable browser notifications')}</span>
        </div>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
          {t('Turning this off pauses pushes to all your devices without removing them.')}
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>{t('Save')}</button>
          <button className="btn-admin" onClick={handleTest} disabled={testing || !deviceCount}>{testing ? t('Sending...') : t('Send Test')}</button>
        </div>
      </div>
    </section>
  )
}
