import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  adminConnections,
  adminPlex,
  adminRiven,
  adminCompat,
} from '../../services/adminApi'
import YoutubeMappingsModal from './YoutubeMappings'

const MASKED = String.fromCharCode(8226).repeat(8)

function buildUrl(host, port) {
  if (!host) return ''
  if (port && port !== '0') return host.replace(/\/$/, '') + ':' + port
  return host
}

function parseHost(url) {
  if (!url) return ''
  try { const u = new URL(url); return u.protocol + '//' + u.hostname } catch { return url }
}

function parsePort(url) {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.port) return u.port
    // Handle legacy /port path format stored by old buildUrl bug (e.g., http://host/7878)
    const m = u.pathname.match(/^\/(\d+)\/?$/)
    return m ? m[1] : ''
  } catch { return '' }
}



function PlexSection({ plexUrl, plexToken, onUpdate, onSave, onToast }) {
  const { t } = useTranslation()
  const [host, setHost] = useState(parseHost(plexUrl))
  const [port, setPort] = useState(parsePort(plexUrl))
  const [token, setToken] = useState(plexToken ? MASKED : '')
  const [tokenVisible, setTokenVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [toast] = useState(null)
  const pollRef = useRef(null)
  const realToken = token === MASKED ? '' : token

  // Sync local fields from props (render-phase adjustment, React's recommended
  // alternative to state-syncing effects).
  const [prevPlexUrl, setPrevPlexUrl] = useState(plexUrl)
  if (plexUrl !== prevPlexUrl) {
    setPrevPlexUrl(plexUrl)
    setHost(parseHost(plexUrl))
    setPort(parsePort(plexUrl))
  }
  const [prevPlexToken, setPrevPlexToken] = useState(plexToken)
  if (plexToken !== prevPlexToken) {
    setPrevPlexToken(plexToken)
    setToken(plexToken ? MASKED : '')
  }
  useEffect(() => () => { clearTimeout(pollRef.current) }, [])

  const handleTokenInput = (e) => {
    const v = e.target.value
    setToken(v)
    onUpdate({ plex_token: v === MASKED ? '' : v })
  }

  const handleBlur = useCallback(() => {
    const url = buildUrl(host, port)
    onUpdate({ plex_url: url })
    adminConnections.save({ plex_url: url, plex_token: realToken }).catch(() => {})
  }, [host, port, realToken, onUpdate])

  const handleTest = async () => {
    setTestLoading(true)
    try {
      await adminConnections.test('plex', { url: buildUrl(host, port), token: realToken })
      onToast?.('Plex connection successful')
    } catch (err) {
      onToast?.(err.message || 'Plex test failed', 'error')
    } finally { setTestLoading(false) }
  }

  const handleSave = async () => {
    setSaveLoading(true)
    try {
      await adminConnections.save({ plex_url: buildUrl(host, port), plex_token: realToken })
      onSave?.({ plex_url: buildUrl(host, port), plex_token: realToken })
      onToast?.('Plex settings saved')
    } catch (err) {
      onToast?.(err.message || 'Failed to save Plex settings', 'error')
    } finally { setSaveLoading(false) }
  }

  const handleOAuth = async () => {
    setOauthLoading(true)
    try {
      const res = await adminPlex.getAuthUrl()
      window.open(res.data.authUrl, '_blank')
      const pinId = res.data.pinId
      let attempts = 0
      const poll = async () => {
        attempts++
        try {
          const pinRes = await adminPlex.checkPin(pinId)
          if (pinRes.data.authorized) {
            clearTimeout(pollRef.current)
            const t = pinRes.data.token
            setToken(MASKED)
            onUpdate({ plex_token: t })
            adminConnections.save({ plex_url: buildUrl(host, port), plex_token: t }).catch(() => {})
            onToast?.('Signed in to Plex successfully')
            return
          }
        } catch { /* keep polling */ }
        if (attempts < 60) pollRef.current = setTimeout(poll, 5000)
        else onToast?.('Plex sign-in timed out', 'error')
      }
      pollRef.current = setTimeout(poll, 5000)
    } catch (err) {
      onToast?.(err.message || 'Failed to start Plex sign-in', 'error')
    } finally { setOauthLoading(false) }
  }

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('Plex')}</span>
            <span className="conn-block-desc">{t('Your Plex Media Server — required for library sync and authentication')}</span>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-host">
            <span className="conn-field-label">{t('Address')}</span>
            <input type="text" className="conn-input" placeholder={t('http://localhost')}
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">{t('Port')} <span className="conn-field-optional">{t('optional')}</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="32400" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">{t('Token')}</span>
            <div className="conn-input-wrap">
              <input type={tokenVisible ? 'text' : 'password'} className="conn-input" placeholder={t('Plex Token')}
                value={tokenVisible && token === MASKED ? plexToken : token} onChange={handleTokenInput} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setTokenVisible(!tokenVisible)} title={t('Show / hide')} />
              </div>
            </div>
          </div>
          <button className="btn-admin conn-action-btn" onClick={handleOAuth} disabled={oauthLoading}>
            {oauthLoading ? 'Signing in...' : 'Sign in with Plex'}
          </button>
          <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading}>
            {testLoading ? 'Testing...' : 'Test'}
          </button>
          <button className="btn-admin btn-primary conn-action-btn" onClick={handleSave} disabled={saveLoading}>
            {saveLoading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </>
  )
}

function TautulliSection({ tautulliUrl, tautulliApiKey, onUpdate, onSave, onToast }) {
  const { t } = useTranslation()
  const [host, setHost] = useState(parseHost(tautulliUrl))
  const [port, setPort] = useState(parsePort(tautulliUrl))
  const [apiKey, setApiKey] = useState(tautulliApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toast] = useState(null)
  const realKey = apiKey === MASKED ? '' : apiKey

  // Sync local fields from props (render-phase adjustment).
  const [prevTautulliUrl, setPrevTautulliUrl] = useState(tautulliUrl)
  if (tautulliUrl !== prevTautulliUrl) {
    setPrevTautulliUrl(tautulliUrl)
    setHost(parseHost(tautulliUrl))
    setPort(parsePort(tautulliUrl))
  }
  const [prevTautulliApiKey, setPrevTautulliApiKey] = useState(tautulliApiKey)
  if (tautulliApiKey !== prevTautulliApiKey) {
    setPrevTautulliApiKey(tautulliApiKey)
    setApiKey(tautulliApiKey ? MASKED : '')
  }

  const handleBlur = () => {
    const url = buildUrl(host, port)
    onUpdate({ tautulli_url: url })
    adminConnections.save({ tautulli_url: url, tautulli_api_key: realKey }).catch(() => {})
  }

  const handleTest = async () => {
    setTestLoading(true)
    try {
      await adminConnections.test('tautulli', { url: buildUrl(host, port), apiKey: realKey })
      onToast?.('Tautulli connection successful')
    } catch (err) {
      onToast?.(err.message || 'Tautulli test failed', 'error')
    } finally { setTestLoading(false) }
  }

  const handleSave = async () => {
    setSaveLoading(true)
    try {
      await adminConnections.save({ tautulli_url: buildUrl(host, port), tautulli_api_key: realKey })
      onSave?.({ tautulli_url: buildUrl(host, port), tautulli_api_key: realKey })
      onToast?.('Tautulli settings saved')
    } catch (err) {
      onToast?.(err.message || 'Failed to save Tautulli settings', 'error')
    } finally { setSaveLoading(false) }
  }

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('Tautulli')}</span>
            <span className="conn-block-desc">{t('Watch history source — required for personalized recommendations')}</span>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-host">
            <span className="conn-field-label">{t('Address')}</span>
            <input type="text" className="conn-input" placeholder={t('http://localhost')}
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">{t('Port')} <span className="conn-field-optional">{t('optional')}</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="8181" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">{t('API Key')}</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder={t('API Key')}
                value={apiKeyVisible && apiKey === MASKED ? tautulliApiKey : apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title={t('Show / hide')} />
              </div>
            </div>
          </div>
          <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading}>
            {testLoading ? 'Testing...' : 'Test'}
          </button>
          <button className="btn-admin btn-primary conn-action-btn" onClick={handleSave} disabled={saveLoading}>
            {saveLoading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </>
  )
}

function TmdbSection({ tmdbApiKey, discoverEnabled, onUpdate, onSave, onToast }) {
  const { t } = useTranslation()
  const [apiKey, setApiKey] = useState(tmdbApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [discover, setDiscover] = useState(!!discoverEnabled)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toast] = useState(null)
  const realKey = apiKey === MASKED ? '' : apiKey
  const hasKey = apiKey === MASKED || !!apiKey

  // Sync local fields from props (render-phase adjustment).
  const [prevTmdbApiKey, setPrevTmdbApiKey] = useState(tmdbApiKey)
  if (tmdbApiKey !== prevTmdbApiKey) {
    setPrevTmdbApiKey(tmdbApiKey)
    setApiKey(tmdbApiKey ? MASKED : '')
  }
  const [prevDiscoverEnabled, setPrevDiscoverEnabled] = useState(discoverEnabled)
  if (discoverEnabled !== prevDiscoverEnabled) {
    setPrevDiscoverEnabled(discoverEnabled)
    setDiscover(!!discoverEnabled)
  }

  const handleToggle = async (checked) => {
    setDiscover(checked)
    onUpdate({ discover_enabled: checked })
    try { await adminConnections.save({ discover_enabled: checked }) } catch { /* ignore */ }
  }

  const handleTest = async () => {
    setTestLoading(true)
    try {
      await adminConnections.test('tmdb', { apiKey: realKey })
      onToast?.('TMDB connection successful')
    } catch (err) {
      onToast?.(err.message || 'TMDB test failed', 'error')
    } finally { setTestLoading(false) }
  }

  const handleSave = async () => {
    setSaveLoading(true)
    try {
      await adminConnections.save({ tmdb_api_key: realKey })
      onSave?.({ tmdb_api_key: realKey })
      onToast?.('TMDB key saved')
    } catch (err) {
      onToast?.(err.message || 'Failed to save TMDB key', 'error')
    } finally { setSaveLoading(false) }
  }

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('TMDB')}</span>
            <span className="conn-block-desc">{t('The Movie Database — metadata source for Diskovarr Requests')}</span>
          </div>
          <div className="conn-toggle-wrap">
            <div className="conn-toggle-stack">
              <span className="conn-toggle-sublabel" style={{ color: '#fff' }}>{t('Diskovarr Requests Tab')}</span>
              <div className="conn-toggle-row">
                <span className="conn-toggle-label">{discover ? 'Enabled' : 'Disabled'}</span>
                <label className="slide-toggle" title={!hasKey ? 'Save a TMDB API key first' : ''}>
                  <input type="checkbox" checked={discover} disabled={!hasKey}
                    onChange={(e) => handleToggle(e.target.checked)} />
                  <span className="slide-track" />
                </label>
              </div>
            </div>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">{t('API Key')}</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder={t('API Key (v3 auth)')}
                value={apiKeyVisible && apiKey === MASKED ? tmdbApiKey : apiKey} onChange={(e) => { setApiKey(e.target.value); onUpdate({ tmdb_api_key: e.target.value }) }}
                onBlur={() => { adminConnections.save({ tmdb_api_key: realKey }).catch(() => {}) }}
                autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title={t('Show / hide')} />
              </div>
            </div>
          </div>
          <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading}>
            {testLoading ? 'Testing...' : 'Test'}
          </button>
          <button className="btn-admin btn-primary conn-action-btn" onClick={handleSave} disabled={saveLoading}>
            {saveLoading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </>
  )
}

function DefaultServiceSection({
  defaultService, directRequestAccess,
  hasOverseerrSide, hasRivenSide, hasDirectSide,
  onSave, onToast,
}) {
  const { t } = useTranslation()
  const [service, setService] = useState(defaultService)
  const [adminOnly, setAdminOnly] = useState(directRequestAccess === '1')

  // Sync local fields from props (render-phase adjustment).
  const [prevDefaultService, setPrevDefaultService] = useState(defaultService)
  if (defaultService !== prevDefaultService) {
    setPrevDefaultService(defaultService)
    setService(defaultService)
  }
  const [prevDirectRequestAccess, setPrevDirectRequestAccess] = useState(directRequestAccess)
  if (directRequestAccess !== prevDirectRequestAccess) {
    setPrevDirectRequestAccess(directRequestAccess)
    setAdminOnly(directRequestAccess === '1')
  }

  const activeCount = [hasOverseerrSide, hasRivenSide, hasDirectSide].filter(Boolean).length

  const handleService = async (svc) => {
    setService(svc)
    try {
      await adminConnections.save({ default_request_service: svc })
      onSave?.({ default_request_service: svc })
    } catch { /* ignore */ }
  }

  const handleAccessChange = async (checked) => {
    setAdminOnly(checked)
    try {
      await adminConnections.save({ direct_request_access: checked ? '1' : '0' })
      onSave?.({ direct_request_access: checked ? '1' : '0' })
    } catch (err) {
      onToast?.(err.message || 'Failed to save access setting', 'error')
    }
  }

  if (activeCount < 2) return null

  return (
    <div className="conn-block" id="default-service-block">
      <div className="conn-block-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <div className="conn-block-meta">
          <span className="conn-block-name">{t('Default app for requests')}</span>
          <span className="conn-block-desc">
            {service === 'direct' ? 'Sonarr/Radarr is the default' : service === 'riven' ? 'DUMB is the default' : 'Overseerr is the default'}
          </span>
        </div>
        <div className="conn-toggle-wrap" style={{ gap: 6, alignItems: 'center' }}>
          {hasOverseerrSide && (
            <button type="button"
              className={`service-opt-btn ${service !== 'direct' && service !== 'riven' ? 'service-opt-active' : 'service-opt-inactive'}`}
              onClick={() => handleService('overseerr')}>{t('Overseerr')}</button>
          )}
          {hasRivenSide && (
            <button type="button"
              className={`service-opt-btn ${service === 'riven' ? 'service-opt-active' : 'service-opt-inactive'}`}
              onClick={() => handleService('riven')}>{t('DUMB')}</button>
          )}
          {hasDirectSide && (
            <button type="button"
              className={`service-opt-btn ${service === 'direct' ? 'service-opt-active' : 'service-opt-inactive'}`}
              onClick={() => handleService('direct')}>{t('Sonarr/Radarr')}</button>
          )}
        </div>
      </div>
      <div className="conn-block-header" style={{ borderBottom: 'none', paddingTop: 10, marginTop: 10, borderTop: '1px solid var(--border)' }}>
        <div className="conn-block-meta">
          <span className="conn-block-name" style={{ fontSize: '0.88rem' }}>{t('Alternate Request App Access')}</span>
          <span className="conn-block-desc">Controls who can see the secondary request service (Advanced button). "Admin" hides it from regular users.</span>
        </div>
        <div className="conn-toggle-wrap" style={{ gap: 10, alignItems: 'center' }}>
          <span className={adminOnly ? 'service-label-inactive' : 'service-label-active'}>{t('All Users')}</span>
          <label className="slide-toggle slide-toggle-choice">
            <input type="checkbox" checked={adminOnly} onChange={(e) => handleAccessChange(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className={adminOnly ? 'service-label-active' : 'service-label-inactive'}>{t('Admin')}</span>
        </div>
      </div>
    </div>
  )
}

function OverseerrSection({ overseerrUrl, overseerrApiKey, overseerrEnabled, onUpdate, onToast }) {
  const { t } = useTranslation()
  const [host, setHost] = useState(parseHost(overseerrUrl))
  const [port, setPort] = useState(parsePort(overseerrUrl))
  const [apiKey, setApiKey] = useState(overseerrApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [toast] = useState(null)
  const [enabled, setEnabled] = useState(overseerrEnabled)
  const realKey = apiKey === MASKED ? '' : apiKey

  // Sync local fields from props (render-phase adjustment).
  const [prevOverseerrUrl, setPrevOverseerrUrl] = useState(overseerrUrl)
  if (overseerrUrl !== prevOverseerrUrl) {
    setPrevOverseerrUrl(overseerrUrl)
    setHost(parseHost(overseerrUrl))
    setPort(parsePort(overseerrUrl))
  }
  const [prevOverseerrApiKey, setPrevOverseerrApiKey] = useState(overseerrApiKey)
  if (overseerrApiKey !== prevOverseerrApiKey) {
    setPrevOverseerrApiKey(overseerrApiKey)
    setApiKey(overseerrApiKey ? MASKED : '')
  }
  const [prevOverseerrEnabled, setPrevOverseerrEnabled] = useState(overseerrEnabled)
  if (overseerrEnabled !== prevOverseerrEnabled) {
    setPrevOverseerrEnabled(overseerrEnabled)
    setEnabled(overseerrEnabled)
  }

  const hasBothFields = !!host && (apiKey === MASKED || !!apiKey)

  const handleBlur = useCallback(() => {
    const url = buildUrl(host, port)
    if (apiKey === MASKED) {
      onUpdate?.({ overseerr_url: url })
    } else {
      onUpdate?.({ overseerr_url: url, overseerr_api_key: apiKey })
    }
  }, [host, port, apiKey, onUpdate])

  const handleEnabledToggle = async (checked) => {
    setEnabled(checked)
    onUpdate?.({ overseerr_enabled: checked })
    try { await adminConnections.save({ overseerr_enabled: checked }) } catch { /* ignore */ }
  }

  const handleTest = async () => {
    if (!hasBothFields) return
    setTestLoading(true)
    try {
      await adminConnections.test('overseerr', { url: buildUrl(host, port), apiKey: realKey })
      onToast?.('Overseerr connection successful')
    } catch (err) {
      onToast?.(err.message || 'Overseerr test failed', 'error')
    } finally { setTestLoading(false) }
  }

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('Overseerr')}</span>
            <span className="conn-block-desc">{t('Media request management')}</span>
          </div>
          <div className="conn-toggle-wrap">
            <span className="conn-toggle-label">{enabled ? 'Enabled' : 'Disabled'}</span>
            <label className="slide-toggle" title={!hasBothFields ? 'Enter URL and API key first' : ''}>
              <input type="checkbox" checked={enabled} disabled={!enabled && !hasBothFields}
                onChange={(e) => handleEnabledToggle(e.target.checked)} />
              <span className="slide-track" />
            </label>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-host">
            <span className="conn-field-label">{t('Address')}</span>
            <input type="text" className="conn-input" placeholder={t('http://localhost')}
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">{t('Port')} <span className="conn-field-optional">{t('optional')}</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="5055" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">{t('API Key')}</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder={t('API Key')}
                value={apiKeyVisible && apiKey === MASKED ? overseerrApiKey : apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title={t('Show / hide')} />
              </div>
            </div>
          </div>
          <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading || !hasBothFields}>
            {testLoading ? 'Testing...' : 'Test'}
          </button>
        </div>
      </div>
    </>
  )
}

function RadarrSection({ radarrUrl, radarrApiKey, radarrEnabled, radarrQualityProfileId, radarrQualityProfileName,
  profiles, onUpdate, onToast }) {
  const { t } = useTranslation()
  const [host, setHost] = useState(parseHost(radarrUrl))
  const [port, setPort] = useState(parsePort(radarrUrl))
  const [apiKey, setApiKey] = useState(radarrApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [toast] = useState(null)
  const [enabled, setEnabled] = useState(radarrEnabled)
  const [profileId, setProfileId] = useState(radarrQualityProfileId || '')
  const [profilesList, setProfilesList] = useState(profiles || [])
  const realKey = apiKey === MASKED ? '' : apiKey

  // Sync local fields from props (render-phase adjustment).
  const [prevRadarrConn, setPrevRadarrConn] = useState(`${radarrUrl} ${radarrApiKey}`)
  if (`${radarrUrl} ${radarrApiKey}` !== prevRadarrConn) {
    setPrevRadarrConn(`${radarrUrl} ${radarrApiKey}`)
    setHost(parseHost(radarrUrl))
    setPort(parsePort(radarrUrl))
    setApiKey(radarrApiKey ? MASKED : '')
  }
  const [prevRadarrEnabled, setPrevRadarrEnabled] = useState(radarrEnabled)
  if (radarrEnabled !== prevRadarrEnabled) {
    setPrevRadarrEnabled(radarrEnabled)
    setEnabled(radarrEnabled)
  }
  const [prevRadarrProfileId, setPrevRadarrProfileId] = useState(radarrQualityProfileId)
  if (radarrQualityProfileId !== prevRadarrProfileId) {
    setPrevRadarrProfileId(radarrQualityProfileId)
    setProfileId(radarrQualityProfileId || '')
  }
  const [prevRadarrProfiles, setPrevRadarrProfiles] = useState(profiles)
  if (profiles !== prevRadarrProfiles) {
    setPrevRadarrProfiles(profiles)
    setProfilesList(profiles || [])
  }

  const hasBothFields = !!host && (apiKey === MASKED || !!apiKey)
  const canEnable = hasBothFields && !!profileId

  const handleBlur = useCallback(() => {
    const url = buildUrl(host, port)
    if (apiKey === MASKED) {
      onUpdate?.({ radarr_url: url })
    } else {
      onUpdate?.({ radarr_url: url, radarr_api_key: apiKey })
    }
  }, [host, port, apiKey, onUpdate])

  const handleEnabledToggle = async (checked) => {
    setEnabled(checked)
    onUpdate?.({ radarr_enabled: checked })
    try {
      const sel = profilesList.find(p => p.id === profileId)
      await adminConnections.save({
        radarr_enabled: checked,
        ...(profileId ? { radarr_quality_profile_id: profileId, radarr_quality_profile_name: sel?.name || radarrQualityProfileName } : {}),
      })
    } catch { /* ignore */ }
  }

  const handleProfileChange = async (id) => {
    setProfileId(id)
    const sel = profilesList.find(p => p.id === id)
    onUpdate?.({ radarr_quality_profile_id: id, radarr_quality_profile_name: sel?.name || '' })
    if (enabled && id) {
      try { await adminConnections.save({ radarr_quality_profile_id: id, radarr_quality_profile_name: sel?.name || '' }) } catch { /* ignore */ }
    }
  }

  const handleTest = async () => {
    if (!hasBothFields) return
    setTestLoading(true)
    try {
      const testUrl = buildUrl(host, port)
      await adminConnections.test('radarr', { url: testUrl, apiKey: realKey })
      onToast?.('Radarr connection successful')
      const profileParams = { url: testUrl, ...(realKey ? { apiKey: realKey } : {}) }
      const res = await adminConnections.getQualityProfiles('radarr', profileParams)
      const list = (res.data?.profiles || []).map(p => ({ id: p.id.toString(), name: p.name }))
      setProfilesList(list)
      if (radarrQualityProfileId && !list.find(p => p.id === radarrQualityProfileId)) {
        setProfileId(radarrQualityProfileId)
        onUpdate?.({ radarr_quality_profile_id: radarrQualityProfileId, radarr_quality_profile_name: radarrQualityProfileName })
      }
    } catch (err) {
      onToast?.(err.message || 'Radarr test failed', 'error')
    } finally { setTestLoading(false) }
  }

  const qualityRowStyle = hasBothFields ? { display: 'block' } : { display: 'none' }

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('Radarr')}</span>
            <span className="conn-block-desc">{t('Movies — direct fallback if Overseerr is not used')}</span>
          </div>
          <div className="conn-toggle-wrap">
            <span className="conn-toggle-label">{enabled ? 'Enabled' : 'Disabled'}</span>
            <label className="slide-toggle" title={!canEnable ? 'Test connection and select a quality profile first' : ''}>
              <input type="checkbox" checked={enabled} disabled={!enabled && !canEnable}
                onChange={(e) => handleEnabledToggle(e.target.checked)} />
              <span className="slide-track" />
            </label>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-host">
            <span className="conn-field-label">{t('Address')}</span>
            <input type="text" className="conn-input" placeholder={t('http://localhost')}
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">{t('Port')} <span className="conn-field-optional">{t('optional')}</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="7878" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">{t('API Key')}</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder={t('API Key')}
                value={apiKeyVisible && apiKey === MASKED ? radarrApiKey : apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title={t('Show / hide')} />
              </div>
            </div>
          </div>
          <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading || !hasBothFields}>
            {testLoading ? 'Testing...' : 'Test'}
          </button>
        </div>
        <div className="conn-quality-row" style={qualityRowStyle}>
          <div className="conn-quality-header">
            <span className="conn-quality-label">{t('Quality Profile')}</span>
            <span className="conn-quality-required">{t('required to enable')}</span>
          </div>
          <div className="conn-quality-field">
            <select className="conn-select" value={profileId} onChange={(e) => handleProfileChange(e.target.value)}>
              <option value="">{t('— select a profile —')}</option>
              {profilesList.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              {radarrQualityProfileName && !profilesList.some(p => p.id === profileId) && (
                <option value={profileId} selected>{radarrQualityProfileName}</option>
              )}
            </select>
          </div>
        </div>
      </div>
    </>
  )
}

function SonarrSection({ sonarrUrl, sonarrApiKey, sonarrEnabled, sonarrQualityProfileId, sonarrQualityProfileName,
  profiles, onUpdate, onToast }) {
  const { t } = useTranslation()
  const [host, setHost] = useState(parseHost(sonarrUrl))
  const [port, setPort] = useState(parsePort(sonarrUrl))
  const [apiKey, setApiKey] = useState(sonarrApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [toast] = useState(null)
  const [enabled, setEnabled] = useState(sonarrEnabled)
  const [profileId, setProfileId] = useState(sonarrQualityProfileId || '')
  const [profilesList, setProfilesList] = useState(profiles || [])
  const realKey = apiKey === MASKED ? '' : apiKey

  // Sync local fields from props (render-phase adjustment).
  const [prevSonarrConn, setPrevSonarrConn] = useState(`${sonarrUrl} ${sonarrApiKey}`)
  if (`${sonarrUrl} ${sonarrApiKey}` !== prevSonarrConn) {
    setPrevSonarrConn(`${sonarrUrl} ${sonarrApiKey}`)
    setHost(parseHost(sonarrUrl))
    setPort(parsePort(sonarrUrl))
    setApiKey(sonarrApiKey ? MASKED : '')
  }
  const [prevSonarrEnabled, setPrevSonarrEnabled] = useState(sonarrEnabled)
  if (sonarrEnabled !== prevSonarrEnabled) {
    setPrevSonarrEnabled(sonarrEnabled)
    setEnabled(sonarrEnabled)
  }
  const [prevSonarrProfileId, setPrevSonarrProfileId] = useState(sonarrQualityProfileId)
  if (sonarrQualityProfileId !== prevSonarrProfileId) {
    setPrevSonarrProfileId(sonarrQualityProfileId)
    setProfileId(sonarrQualityProfileId || '')
  }
  const [prevSonarrProfiles, setPrevSonarrProfiles] = useState(profiles)
  if (profiles !== prevSonarrProfiles) {
    setPrevSonarrProfiles(profiles)
    setProfilesList(profiles || [])
  }

  const hasBothFields = !!host && (apiKey === MASKED || !!apiKey)
  const canEnable = hasBothFields && !!profileId

  const handleBlur = useCallback(() => {
    const url = buildUrl(host, port)
    if (apiKey === MASKED) {
      onUpdate?.({ sonarr_url: url })
    } else {
      onUpdate?.({ sonarr_url: url, sonarr_api_key: apiKey })
    }
  }, [host, port, apiKey, onUpdate])

  const handleEnabledToggle = async (checked) => {
    setEnabled(checked)
    onUpdate?.({ sonarr_enabled: checked })
    try {
      const sel = profilesList.find(p => p.id === profileId)
      await adminConnections.save({
        sonarr_enabled: checked,
        ...(profileId ? { sonarr_quality_profile_id: profileId, sonarr_quality_profile_name: sel?.name || sonarrQualityProfileName } : {}),
      })
    } catch { /* ignore */ }
  }

  const handleProfileChange = async (id) => {
    setProfileId(id)
    const sel = profilesList.find(p => p.id === id)
    onUpdate?.({ sonarr_quality_profile_id: id, sonarr_quality_profile_name: sel?.name || '' })
    if (enabled && id) {
      try { await adminConnections.save({ sonarr_quality_profile_id: id, sonarr_quality_profile_name: sel?.name || '' }) } catch { /* ignore */ }
    }
  }

  const handleTest = async () => {
    if (!hasBothFields) return
    setTestLoading(true)
    try {
      const testUrl = buildUrl(host, port)
      await adminConnections.test('sonarr', { url: testUrl, apiKey: realKey })
      onToast?.('Sonarr connection successful')
      const profileParams = { url: testUrl, ...(realKey ? { apiKey: realKey } : {}) }
      const res = await adminConnections.getQualityProfiles('sonarr', profileParams)
      const list = (res.data?.profiles || []).map(p => ({ id: p.id.toString(), name: p.name }))
      setProfilesList(list)
      if (sonarrQualityProfileId && !list.find(p => p.id === sonarrQualityProfileId)) {
        setProfileId(sonarrQualityProfileId)
        onUpdate?.({ sonarr_quality_profile_id: sonarrQualityProfileId, sonarr_quality_profile_name: sonarrQualityProfileName })
      }
    } catch (err) {
      onToast?.(err.message || 'Sonarr test failed', 'error')
    } finally { setTestLoading(false) }
  }

  const qualityRowStyle = hasBothFields ? { display: 'block' } : { display: 'none' }

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('Sonarr')}</span>
            <span className="conn-block-desc">{t('TV Shows — direct fallback if Overseerr is not used')}</span>
          </div>
          <div className="conn-toggle-wrap">
            <span className="conn-toggle-label">{enabled ? 'Enabled' : 'Disabled'}</span>
            <label className="slide-toggle" title={!canEnable ? 'Test connection and select a quality profile first' : ''}>
              <input type="checkbox" checked={enabled} disabled={!enabled && !canEnable}
                onChange={(e) => handleEnabledToggle(e.target.checked)} />
              <span className="slide-track" />
            </label>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-host">
            <span className="conn-field-label">{t('Address')}</span>
            <input type="text" className="conn-input" placeholder={t('http://localhost')}
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">{t('Port')} <span className="conn-field-optional">{t('optional')}</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="8989" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">{t('API Key')}</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder={t('API Key')}
                value={apiKeyVisible && apiKey === MASKED ? sonarrApiKey : apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title={t('Show / hide')} />
              </div>
            </div>
          </div>
          <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading || !hasBothFields}>
            {testLoading ? 'Testing...' : 'Test'}
          </button>
        </div>
        <div className="conn-quality-row" style={qualityRowStyle}>
          <div className="conn-quality-header">
            <span className="conn-quality-label">{t('Quality Profile')}</span>
            <span className="conn-quality-required">{t('required to enable')}</span>
          </div>
          <div className="conn-quality-field">
            <select className="conn-select" value={profileId} onChange={(e) => handleProfileChange(e.target.value)}>
              <option value="">{t('— select a profile —')}</option>
              {profilesList.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              {sonarrQualityProfileName && !profilesList.some(p => p.id === profileId) && (
                <option value={profileId} selected>{sonarrQualityProfileName}</option>
              )}
            </select>
          </div>
        </div>
      </div>
    </>
  )
}

function YoutubeSection({ youtubeEnabled, youtubeApiKey, youtubeRootFolder, tuberrUrl, tuberrApiKey, sonarrEnabled, onUpdate, onToast }) {
  const { t } = useTranslation()
  const [host, setHost] = useState(parseHost(tuberrUrl))
  const [port, setPort] = useState(parsePort(tuberrUrl))
  const [serviceKey, setServiceKey] = useState(tuberrApiKey ? MASKED : '')
  const [serviceKeyVisible, setServiceKeyVisible] = useState(false)
  const [ytKey, setYtKey] = useState(youtubeApiKey ? MASKED : '')
  const [ytKeyVisible, setYtKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [enabled, setEnabled] = useState(!!youtubeEnabled)
  const [infoOpen, setInfoOpen] = useState(false)
  const [seriesOpen, setSeriesOpen] = useState(false)
  const [rootFolder, setRootFolder] = useState(youtubeRootFolder || '')
  const [rootFolders, setRootFolders] = useState([])
  const realServiceKey = serviceKey === MASKED ? '' : serviceKey

  // Optional per-admin routing: only offered when Sonarr is reachable; unset
  // means YouTube series share the default root folder like any other show.
  useEffect(() => {
    if (!sonarrEnabled) return
    let cancelled = false
    adminConnections.getSonarrRootFolders()
      .then(({ data }) => { if (!cancelled && data?.ok) setRootFolders(data.folders || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [sonarrEnabled])

  const [prevRootFolder, setPrevRootFolder] = useState(youtubeRootFolder)
  if (youtubeRootFolder !== prevRootFolder) {
    setPrevRootFolder(youtubeRootFolder)
    setRootFolder(youtubeRootFolder || '')
  }

  const handleRootFolderChange = async (path) => {
    setRootFolder(path)
    onUpdate?.({ youtube_root_folder: path })
    try { await adminConnections.save({ youtube_root_folder: path }) } catch { /* ignore */ }
  }

  // Sync local fields from props (render-phase adjustment).
  const [prevConn, setPrevConn] = useState(`${tuberrUrl} ${tuberrApiKey} ${youtubeApiKey}`)
  if (`${tuberrUrl} ${tuberrApiKey} ${youtubeApiKey}` !== prevConn) {
    setPrevConn(`${tuberrUrl} ${tuberrApiKey} ${youtubeApiKey}`)
    setHost(parseHost(tuberrUrl))
    setPort(parsePort(tuberrUrl))
    setServiceKey(tuberrApiKey ? MASKED : '')
    setYtKey(youtubeApiKey ? MASKED : '')
  }
  const [prevEnabled, setPrevEnabled] = useState(youtubeEnabled)
  if (youtubeEnabled !== prevEnabled) {
    setPrevEnabled(youtubeEnabled)
    setEnabled(!!youtubeEnabled)
  }

  const hasFields = !!host && (serviceKey === MASKED || !!serviceKey)
  const canEnable = hasFields && (ytKey === MASKED || !!ytKey) && sonarrEnabled

  const handleBlur = useCallback(() => {
    const patch = { tuberr_url: buildUrl(host, port) }
    if (serviceKey !== MASKED) patch.tuberr_api_key = serviceKey
    if (ytKey !== MASKED) patch.youtube_api_key = ytKey
    onUpdate?.(patch)
  }, [host, port, serviceKey, ytKey, onUpdate])

  const handleEnabledToggle = async (checked) => {
    setEnabled(checked)
    onUpdate?.({ youtube_enabled: checked })
    try { await adminConnections.save({ youtube_enabled: checked }) } catch { /* ignore */ }
  }

  const handleTest = async () => {
    if (!hasFields) return
    setTestLoading(true)
    try {
      const res = await adminConnections.test('tuberr', { url: buildUrl(host, port), apiKey: realServiceKey })
      if (res.data?.ok) onToast?.(res.data.message || 'Tuberr connection successful')
      else onToast?.(res.data?.message || 'Tuberr test failed', 'error')
    } catch (err) {
      onToast?.(err.message || 'Tuberr test failed', 'error')
    } finally { setTestLoading(false) }
  }

  const [setupLoading, setSetupLoading] = useState(false)
  const handleSetupSonarr = async () => {
    setSetupLoading(true)
    try {
      const res = await adminConnections.setupTuberrSonarr()
      if (res.data?.ok) onToast?.(res.data.message)
      else onToast?.(res.data?.message || 'Sonarr setup failed', 'error')
    } catch (err) {
      onToast?.(err.message || 'Sonarr setup failed', 'error')
    } finally { setSetupLoading(false) }
  }

  // The same Tuberr key authenticates Sonarr's Torznab indexer — offer it for
  // copy so admins never have to dig it out of Tuberr's log or data dir.
  const copyableKey = realServiceKey || tuberrApiKey || ''
  const handleCopyKey = async () => {
    if (!copyableKey) return
    try {
      await navigator.clipboard.writeText(copyableKey)
      onToast?.(t('Tuberr API key copied — paste it into Sonarr’s Torznab indexer'))
    } catch {
      onToast?.(t('Copy failed — reveal the key field and copy it manually'), 'error')
    }
  }

  const torznabUrl = (buildUrl(host, port) || 'http://<tuberr-host>:9832') + '/torznab'
  const stepStyle = { margin: '0 0 8px', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5 }
  const codeStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontSize: '0.78rem', fontFamily: 'monospace' }

  return (
    <div className="conn-block">
      <div className="conn-block-header">
        <div className="conn-block-meta">
          <span className="conn-block-name">
            {t('YouTube (Tuberr)')}
            <button type="button" className="agent-info-btn" title={t('Setup instructions')}
              onClick={() => setInfoOpen(o => !o)} style={{ marginLeft: 6 }}>&#9432;</button>
          </span>
          <span className="conn-block-desc">{t('Search and request YouTube series through Sonarr — requires the Tuberr companion service')}</span>
        </div>
        <div className="conn-toggle-wrap">
          <span className="conn-toggle-label">{enabled ? 'Enabled' : 'Disabled'}</span>
          <label className="slide-toggle" title={!canEnable && !enabled ? 'Configure Tuberr, a YouTube API key, and enable Sonarr first' : ''}>
            <input type="checkbox" checked={enabled} disabled={!enabled && !canEnable}
              onChange={(e) => handleEnabledToggle(e.target.checked)} />
            <span className="slide-track" />
          </label>
        </div>
      </div>
      {infoOpen && (
        <div style={{ margin: '12px 0', padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
          <p style={{ ...stepStyle, fontWeight: 600, color: 'var(--text)' }}>{t('Setup — one time, in this order')}</p>
          <p style={stepStyle}>
            <strong>1. Start Tuberr.</strong> {t('Docker installs already run it — the bundled Tuberr starts with the container and pairs itself here automatically (address + API key fill in on their own), so skip to step 2. Bare-metal installs run it from the repo under')} <code style={codeStyle}>tuberr/</code> ({t('with')} <code style={codeStyle}>node server.js</code> {t('or the included systemd unit) and copy the API key from')} <code style={codeStyle}>tuberr/data/api_key.txt</code> {t('into the field below.')}
          </p>
          <p style={stepStyle}>
            <strong>2. {t('Add a YouTube API key')}.</strong> {t('Free from Google Cloud Console (YouTube Data API v3) — used for channel search and episode matching. Hit Test to confirm everything is reachable.')}
          </p>
          <p style={stepStyle}>
            <strong>3. {t('Wire up Sonarr')}.</strong> {t('Click Set up Sonarr above — it creates the Tuberr indexer and download client in Sonarr automatically (both tagged')} <code style={codeStyle}>yt</code>{t(', category')} <code style={codeStyle}>tv-youtube</code>{t(') so only YouTube series use them. Note: if Sonarr runs on a different machine or in Docker, the Tuberr address above must be one Sonarr can reach (LAN IP, not localhost). Prefer manual setup? Add a qBittorrent download client (host/port of Tuberr, any credentials) and a Torznab indexer:')} <code style={codeStyle}>{torznabUrl}</code> {t('with the Tuberr API key.')}
          </p>
          <p style={stepStyle}>
            <strong>4. {t('Flip the toggle above.')}</strong> {t('TV requests gain a “Download via YouTube” option, TVDB-only shows appear in search, and episode matches are reviewed via the Manage Series button in this section.')}
          </p>
          <button type="button" className="btn-admin" onClick={handleCopyKey} disabled={!copyableKey}
            title={!copyableKey ? t('Enter or save the Tuberr API key first') : ''}>
            {t('Copy Tuberr API key for Sonarr')}
          </button>
        </div>
      )}
      <div className="conn-block-fields">
        <div className="conn-field-group conn-field-host">
          <span className="conn-field-label">{t('Tuberr Address')}</span>
          <input type="text" className="conn-input" placeholder={t('http://localhost')}
            value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
        </div>
        <div className="conn-field-group conn-field-port">
          <span className="conn-field-label">{t('Port')} <span className="conn-field-optional">{t('optional')}</span></span>
          <input type="number" className="conn-input conn-input-port" placeholder="9832" min="1" max="65535"
            value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
        </div>
        <div className="conn-field-group conn-field-key">
          <span className="conn-field-label">{t('Tuberr API Key')}</span>
          <div className="conn-input-wrap">
            <input type={serviceKeyVisible ? 'text' : 'password'} className="conn-input" placeholder={t('API Key')}
              value={serviceKeyVisible && serviceKey === MASKED ? tuberrApiKey : serviceKey}
              onChange={(e) => setServiceKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
            <div className="conn-input-btns">
              <button type="button" className="conn-input-icon-btn"
                onClick={() => setServiceKeyVisible(!serviceKeyVisible)} title={t('Show / hide')} />
            </div>
          </div>
        </div>
        <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading || !hasFields}>
          {testLoading ? 'Testing...' : 'Test'}
        </button>
        <button className="btn-admin conn-action-btn" onClick={() => setSeriesOpen(true)} disabled={!hasFields}
          title={!hasFields ? t('Configure Tuberr first') : t('Review series↔channel mappings and episode matches')}>
          {t('Manage Series')}
        </button>
        <button className="btn-admin conn-action-btn" onClick={handleSetupSonarr} disabled={setupLoading || !hasFields || !sonarrEnabled}
          title={t('Create the Tuberr indexer + download client in Sonarr automatically (tag yt, category tv-youtube)')}>
          {setupLoading ? t('Setting up…') : t('Set up Sonarr')}
        </button>
      </div>
      {seriesOpen && <YoutubeMappingsModal onClose={() => setSeriesOpen(false)} onToast={onToast} />}
      <div className="conn-block-fields" style={{ marginTop: 10 }}>
        <div className="conn-field-group conn-field-key">
          <span className="conn-field-label">{t('YouTube Data API Key')}</span>
          <div className="conn-input-wrap">
            <input type={ytKeyVisible ? 'text' : 'password'} className="conn-input" placeholder={t('AIza…')}
              value={ytKeyVisible && ytKey === MASKED ? youtubeApiKey : ytKey}
              onChange={(e) => setYtKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
            <div className="conn-input-btns">
              <button type="button" className="conn-input-icon-btn"
                onClick={() => setYtKeyVisible(!ytKeyVisible)} title={t('Show / hide')} />
            </div>
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            {t('Used for channel search and episode matching. Free key from Google Cloud Console (YouTube Data API v3).')}
          </p>
        </div>
        {rootFolders.length > 0 && (
          <div className="conn-field-group">
            <span className="conn-field-label">{t('YouTube Root Folder')} <span className="conn-field-optional">{t('optional')}</span></span>
            <select className="conn-select" value={rootFolder} onChange={(e) => handleRootFolderChange(e.target.value)}>
              <option value="">{t('Same as other shows (Sonarr default)')}</option>
              {rootFolders.map((f) => (
                <option key={f.path} value={f.path}>{f.path}</option>
              ))}
              {rootFolder && !rootFolders.some(f => f.path === rootFolder) && (
                <option value={rootFolder}>{rootFolder}</option>
              )}
            </select>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
              {t('New YouTube series are added to Sonarr under this folder, keeping them apart from regular shows.')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function RivenSection({ rivenEnabled, rivenUrl, rivenApiKey, dumbRequestMode, compatKey,
  onUpdate, onSave, onToast }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState(parseHost(rivenUrl))
  const [apiKey, setApiKey] = useState(rivenApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toast] = useState(null)
  const [enabled, setEnabled] = useState(!!rivenEnabled)
  const [mode, setMode] = useState(dumbRequestMode || 'pull')
  const realKey = apiKey === MASKED ? '' : apiKey

  // Sync local fields from props (render-phase adjustment).
  const [prevRivenUrl, setPrevRivenUrl] = useState(rivenUrl)
  if (rivenUrl !== prevRivenUrl) {
    setPrevRivenUrl(rivenUrl)
    setUrl(parseHost(rivenUrl))
  }
  const [prevRivenApiKey, setPrevRivenApiKey] = useState(rivenApiKey)
  if (rivenApiKey !== prevRivenApiKey) {
    setPrevRivenApiKey(rivenApiKey)
    setApiKey(rivenApiKey ? MASKED : '')
  }
  const [prevRivenEnabled, setPrevRivenEnabled] = useState(rivenEnabled)
  if (rivenEnabled !== prevRivenEnabled) {
    setPrevRivenEnabled(rivenEnabled)
    setEnabled(!!rivenEnabled)
  }
  const [prevDumbRequestMode, setPrevDumbRequestMode] = useState(dumbRequestMode)
  if (dumbRequestMode !== prevDumbRequestMode) {
    setPrevDumbRequestMode(dumbRequestMode)
    setMode(dumbRequestMode || 'pull')
  }

  const handleToggle = async (checked) => {
    setEnabled(checked)
    onUpdate?.({ riven_enabled: checked })
    try { await adminRiven.save({ riven_enabled: checked }) } catch { /* ignore */ }
  }

  const handleTest = async () => {
    setTestLoading(true)
    try {
      await adminRiven.test({ url: url || rivenUrl, apiKey: realKey })
      onToast?.('Riven connection successful')
    } catch (err) {
      onToast?.(err.message || 'Riven test failed', 'error')
    } finally { setTestLoading(false) }
  }

  const handleSave = async () => {
    setSaveLoading(true)
    try {
      const fullUrl = url && url !== 'http://' ? url : ''
      const savePayload = {
        riven_enabled: enabled,
        riven_url: fullUrl,
        ...(realKey ? { riven_api_key: realKey } : {}),
      }
      await adminRiven.save(savePayload)
      onSave?.({ riven_url: fullUrl })
      onToast?.('DUMB / Riven settings saved')
    } catch (err) {
      onToast?.(err.message || 'Failed to save DUMB / Riven settings', 'error')
    } finally { setSaveLoading(false) }
  }

  const handleMode = async (newMode) => {
    setMode(newMode)
    try {
      await adminRiven.setMode(newMode)
      onUpdate?.({ dumb_request_mode: newMode })
    } catch (err) {
      onToast?.(err.message || 'Failed to set mode', 'error')
    }
  }

  const handleCopyCompatKey = async () => {
    try {
      await navigator.clipboard.writeText(compatKey)
      onToast?.('Compat key copied')
    } catch { onToast?.('Failed to copy', 'error') }
  }

  const modeDesc = mode === 'push'
    ? 'Diskovarr pushes to Riven on approval (lower latency, requires Riven reachable)'
    : 'DUMB polls /api/v1/request?filter=approved on a schedule — no push from Diskovarr'

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">
              {t('DUMB / Riven')}
              <button type="button" className="agent-info-btn" title={t('API key info')}>&#9432;</button>
            </span>
            <span className="conn-block-desc">All-in-one debrid media stack — routes approved requests through DUMB&apos;s Riven component</span>
          </div>
          <div className="conn-toggle-wrap">
            <span className="conn-toggle-label">{enabled ? 'Enabled' : 'Disabled'}</span>
            <label className="slide-toggle" title={t('Enable DUMB / Riven features')}>
              <input type="checkbox" checked={enabled} onChange={(e) => handleToggle(e.target.checked)} />
              <span className="slide-track" />
            </label>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-host">
            <span className="conn-field-label">{t('Riven URL')} <span className="conn-field-optional">{t('DUMB component')}</span></span>
            <input type="text" className="conn-input" placeholder={t('http://127.0.0.1:8082')}
              value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">{t('API Key')} <span className="conn-field-optional">{t('auto-read from DUMB')}</span></span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input"
                placeholder={t('Auto-detected from /docker/DUMB/data/riven/settings.json')}
                value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title={t('Show / hide')} />
              </div>
            </div>
          </div>
          <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading}>
            {testLoading ? 'Testing...' : 'Test'}
          </button>
          <button className="btn-admin btn-primary conn-action-btn" onClick={handleSave} disabled={saveLoading}>
            {saveLoading ? 'Saving...' : 'Save'}
          </button>
        </div>

        {/* DUMB Integration subsection */}
        <div style={{ margin: '20px 0 0', padding: '16px', borderTop: '1px solid var(--border)' }}>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text)' }}>
              {t('DUMB Integration')} <button type="button" className="agent-info-btn" title={t('How to connect DUMB')}>&#9432;</button>
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: 8 }}>
              {t('Let DUMB poll Diskovarr for approved requests')}
            </span>
          </div>
          <div className="conn-block-fields">
            <div className="conn-field-group">
              <span className="conn-field-label">{t('Overseerr Compat Key')}</span>
              <button className="btn-admin btn-primary" onClick={handleCopyCompatKey} style={{ marginTop: 6 }}>
                {t('Copy Key')}
              </button>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                {t('Manage this key in General Settings.')}
              </p>
            </div>
            <div className="conn-field-group" style={{ marginLeft: 'auto' }}>
              <span className="conn-field-label">{t('Request Mode')}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                <button type="button"
                  className={`service-opt-btn ${mode !== 'push' ? 'service-opt-active' : 'service-opt-inactive'}`}
                  onClick={() => handleMode('pull')}>Pull (DUMB polls)</button>
                <button type="button"
                  className={`service-opt-btn ${mode === 'push' ? 'service-opt-active' : 'service-opt-inactive'}`}
                  onClick={() => handleMode('push')}>Push (instant)</button>
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                {modeDesc}
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/* ───────── Main Component ───────── */
export default function ConnectionSettings({ onDataLoaded, onToast }) {
  const { t } = useTranslation()
  const [fields, setFields] = useState({})
  const [loading, setLoading] = useState(true)
  const [radarrProfiles, setRadarrProfiles] = useState([])
  const [sonarrProfiles, setSonarrProfiles] = useState([])
  const [compatKey, setCompatKey] = useState('')
  // Derived visibility flags for Default Service section
  const hasOverseerrSide = fields.overseerr_enabled && !!fields.overseerr_url
  const hasRivenSide = !!fields.riven_enabled
  const hasDirectSide =
    (fields.radarr_enabled && !!fields.radarr_url) ||
    (fields.sonarr_enabled && !!fields.sonarr_url)

  const loadInitialData = useCallback(async () => {
    try {
      const [connRes, settingsRes, compatRes, rivenRes] = await Promise.all([
        adminConnections.reveal(),
        adminConnections.settings(),
        adminCompat.getConfig(),
        adminRiven.getConfig().catch(() => null),
      ])
      const r = connRes.data
      const rv = rivenRes?.data
      const revealSnake = {
        plex_token:        r.plexToken,
        tautulli_api_key:  r.tautulliApiKey,
        tmdb_api_key:      r.tmdbApiKey,
        overseerr_api_key: r.overseerrApiKey,
        radarr_api_key:    r.radarrApiKey,
        sonarr_api_key:    r.sonarrApiKey,
        youtube_api_key:   r.youtubeApiKey,
        tuberr_api_key:    r.tuberrApiKey,
        diskovarr_api_key: r.diskovarrApiKey,
        agregarr_api_key:  r.agregarrApiKey,
        dumb_api_key:      r.dumbApiKey,
        compat_api_key:    r.compatApiKey,
        riven_api_key:     rv?.hasApiKey ? MASKED : '',
      }
      const rivenSettings = rv ? {
        riven_url:         rv.url || settingsRes.data.riven_url || '',
        riven_enabled:     rv.enabled ?? settingsRes.data.riven_enabled,
        dumb_request_mode: rv.dumbRequestMode || settingsRes.data.dumb_request_mode || 'pull',
      } : {}
      const data = { ...settingsRes.data, ...rivenSettings, ...revealSnake }
      setFields(data)

      // Pre-load quality profiles for already-configured services
      const s = settingsRes.data
      const [radarrProfileRes, sonarrProfileRes] = await Promise.all([
        s.radarr_url && r.radarrApiKey ? adminConnections.getQualityProfiles('radarr').catch(() => null) : null,
        s.sonarr_url && r.sonarrApiKey ? adminConnections.getQualityProfiles('sonarr').catch(() => null) : null,
      ])
      if (radarrProfileRes?.data?.profiles) setRadarrProfiles(radarrProfileRes.data.profiles.map(p => ({ id: p.id.toString(), name: p.name })))
      if (sonarrProfileRes?.data?.profiles) setSonarrProfiles(sonarrProfileRes.data.profiles.map(p => ({ id: p.id.toString(), name: p.name })))
      setCompatKey(compatRes.data?.app?.api_key || compatRes.data?.app?.apiKey || '')
      onDataLoaded?.(data)
    } catch (err) {
      onToast?.(err.message || 'Failed to load connection settings', 'error')
    } finally {
      setLoading(false)
    }
  }, [onDataLoaded, onToast])

  useEffect(() => {
    ;(async () => { await loadInitialData() })()
  }, [loadInitialData])

  // ── Auto-save handler for field changes ──
  const debouncedSaveRef = useRef(null)
  const handleFieldSave = useCallback(async (patch) => {
    clearTimeout(debouncedSaveRef.current)
    debouncedSaveRef.current = setTimeout(async () => {
      try { await adminConnections.save(patch) } catch { /* ignore */ }
    }, 500)
  }, [])

  // ── Plex field updates ──
  const handlePlexUpdate = useCallback((patch) => {
    setFields((prev) => ({ ...prev, ...patch }))
    handleFieldSave(patch)
  }, [handleFieldSave])

  // ── Tautulli field updates ──
  const handleTautulliUpdate = useCallback((patch) => {
    setFields((prev) => ({ ...prev, ...patch }))
    handleFieldSave(patch)
  }, [handleFieldSave])

  // ── TMDB field updates ──
  const handleTmdbUpdate = useCallback((patch) => {
    setFields((prev) => ({ ...prev, ...patch }))
    handleFieldSave(patch)
  }, [handleFieldSave])

  // ── Overseerr field updates ──
  const handleOverseerrUpdate = useCallback((patch) => {
    setFields((prev) => ({ ...prev, ...patch }))
    handleFieldSave(patch)
  }, [handleFieldSave])

  // ── Radarr field updates ──
  const handleRadarrUpdate = useCallback((patch) => {
    setFields((prev) => ({ ...prev, ...patch }))
    handleFieldSave(patch)
  }, [handleFieldSave])

  // ── Sonarr field updates ──
  const handleSonarrUpdate = useCallback((patch) => {
    setFields((prev) => ({ ...prev, ...patch }))
    handleFieldSave(patch)
  }, [handleFieldSave])

  // ── Riven field updates ──
  const handleRivenUpdate = useCallback((patch) => {
    setFields((prev) => ({ ...prev, ...patch }))
    handleFieldSave(patch)
  }, [handleFieldSave])

  // ── Default Service save ──
  const handleDefaultServiceSave = useCallback(async (patch) => {
    setFields((prev) => ({ ...prev, ...patch }))
    try { await adminConnections.save(patch) } catch { /* ignore */ }
  }, [])

  if (loading) {
    return <div className="admin-section"><p style={{ color: 'var(--text-muted)' }}>{t('Loading connection settings...')}</p></div>
  }

  return (
    <>
      {/* ───────── Core Services ───────── */}
      <section className="admin-section">
        <p className="section-desc" style={{ marginBottom: 24 }}>
          {t('Configure external metadata sources and request services. Fill in the URL and API key for a service, then flip its toggle to enable it. Settings are saved automatically when the toggle changes.')}
        </p>

        <PlexSection
          plexUrl={fields.plex_url}
          plexToken={fields.plex_token}
          onUpdate={handlePlexUpdate}
          onSave={handlePlexUpdate}
          onToast={onToast}
        />

        <TautulliSection
          tautulliUrl={fields.tautulli_url}
          tautulliApiKey={fields.tautulli_api_key}
          onUpdate={handleTautulliUpdate}
          onSave={handleTautulliUpdate}
          onToast={onToast}
        />

        <TmdbSection
          tmdbApiKey={fields.tmdb_api_key}
          discoverEnabled={fields.discover_enabled}
          onUpdate={handleTmdbUpdate}
          onSave={handleTmdbUpdate}
          onToast={onToast}
        />
      </section>

      {/* ───────── Default Request Service ───────── */}
      <section className="admin-section">
        <DefaultServiceSection
          defaultService={fields.default_request_service || 'overseerr'}
          directRequestAccess={fields.direct_request_access || '0'}
          hasOverseerrSide={hasOverseerrSide}
          hasRivenSide={hasRivenSide}
          hasDirectSide={hasDirectSide}
          onSave={handleDefaultServiceSave}
          onToast={onToast}
        />
      </section>

      {/* ───────── Request Services ───────── */}
      <section className="admin-section">
        <OverseerrSection
          overseerrUrl={fields.overseerr_url}
          overseerrApiKey={fields.overseerr_api_key}
          overseerrEnabled={fields.overseerr_enabled}
          onUpdate={handleOverseerrUpdate}
          onSave={() => {}}
          onToast={onToast}
        />

        <RadarrSection
          radarrUrl={fields.radarr_url}
          radarrApiKey={fields.radarr_api_key}
          radarrEnabled={fields.radarr_enabled}
          radarrQualityProfileId={fields.radarr_quality_profile_id}
          radarrQualityProfileName={fields.radarr_quality_profile_name}
          profiles={radarrProfiles}
          onUpdate={handleRadarrUpdate}
          onToast={onToast}
        />

        <SonarrSection
          sonarrUrl={fields.sonarr_url}
          sonarrApiKey={fields.sonarr_api_key}
          sonarrEnabled={fields.sonarr_enabled}
          sonarrQualityProfileId={fields.sonarr_quality_profile_id}
          sonarrQualityProfileName={fields.sonarr_quality_profile_name}
          profiles={sonarrProfiles}
          onUpdate={handleSonarrUpdate}
          onToast={onToast}
        />

        <YoutubeSection
          youtubeEnabled={fields.youtube_enabled}
          youtubeApiKey={fields.youtube_api_key}
          youtubeRootFolder={fields.youtube_root_folder}
          tuberrUrl={fields.tuberr_url}
          tuberrApiKey={fields.tuberr_api_key}
          sonarrEnabled={fields.sonarr_enabled}
          onUpdate={handleSonarrUpdate}
          onToast={onToast}
        />
      </section>

      {/* ───────── DUMB / Riven ───────── */}
      <section className="admin-section">
        <RivenSection
          rivenEnabled={fields.riven_enabled}
          rivenUrl={fields.riven_url}
          rivenApiKey={fields.riven_api_key}
          dumbRequestMode={fields.dumb_request_mode || 'pull'}
          compatKey={compatKey}
          onUpdate={handleRivenUpdate}
          onSave={handleRivenUpdate}
          onToast={onToast}
        />
      </section>
    </>
  )
}
