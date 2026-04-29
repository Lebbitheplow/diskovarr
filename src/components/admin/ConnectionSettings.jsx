import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  adminConnections,
  adminPlex,
  adminRiven,
  adminCompat,
} from '../../services/adminApi'

const MASKED = String.fromCharCode(8226).repeat(8)

function maskKey(key) {
  if (!key || key.length < 8) return MASKED
  return key.slice(0, 6) + MASKED + key.slice(-4)
}

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
  const [host, setHost] = useState(parseHost(plexUrl))
  const [port, setPort] = useState(parsePort(plexUrl))
  const [token, setToken] = useState(plexToken ? MASKED : '')
  const [tokenVisible, setTokenVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const pollRef = useRef(null)
  const realToken = token === MASKED ? '' : token

  useEffect(() => { setHost(parseHost(plexUrl)); setPort(parsePort(plexUrl)) }, [plexUrl])
  useEffect(() => { setToken(plexToken ? MASKED : '') }, [plexToken])
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
        } catch {}
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
            <span className="conn-block-name">Plex</span>
            <span className="conn-block-desc">Your Plex Media Server — required for library sync and authentication</span>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-host">
            <span className="conn-field-label">Address</span>
            <input type="text" className="conn-input" placeholder="http://localhost"
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">Port <span className="conn-field-optional">optional</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="32400" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">Token</span>
            <div className="conn-input-wrap">
              <input type={tokenVisible ? 'text' : 'password'} className="conn-input" placeholder="Plex Token"
                value={tokenVisible && token === MASKED ? plexToken : token} onChange={handleTokenInput} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setTokenVisible(!tokenVisible)} title="Show / hide" />
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
  const [host, setHost] = useState(parseHost(tautulliUrl))
  const [port, setPort] = useState(parsePort(tautulliUrl))
  const [apiKey, setApiKey] = useState(tautulliApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const realKey = apiKey === MASKED ? '' : apiKey

  useEffect(() => { setHost(parseHost(tautulliUrl)); setPort(parsePort(tautulliUrl)) }, [tautulliUrl])
  useEffect(() => { setApiKey(tautulliApiKey ? MASKED : '') }, [tautulliApiKey])

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
            <span className="conn-block-name">Tautulli</span>
            <span className="conn-block-desc">Watch history source — required for personalized recommendations</span>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-host">
            <span className="conn-field-label">Address</span>
            <input type="text" className="conn-input" placeholder="http://localhost"
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">Port <span className="conn-field-optional">optional</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="8181" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">API Key</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder="API Key"
                value={apiKeyVisible && apiKey === MASKED ? tautulliApiKey : apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title="Show / hide" />
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
  const [apiKey, setApiKey] = useState(tmdbApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [discover, setDiscover] = useState(!!discoverEnabled)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const realKey = apiKey === MASKED ? '' : apiKey
  const hasKey = apiKey === MASKED || !!apiKey

  useEffect(() => { setApiKey(tmdbApiKey ? MASKED : '') }, [tmdbApiKey])
  useEffect(() => { setDiscover(!!discoverEnabled) }, [discoverEnabled])

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
            <span className="conn-block-name">TMDB</span>
            <span className="conn-block-desc">The Movie Database — metadata source for Diskovarr Requests</span>
          </div>
          <div className="conn-toggle-wrap">
            <div className="conn-toggle-stack">
              <span className="conn-toggle-sublabel" style={{ color: '#fff' }}>Diskovarr Requests Tab</span>
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
            <span className="conn-field-label">API Key</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder="API Key (v3 auth)"
                value={apiKeyVisible && apiKey === MASKED ? tmdbApiKey : apiKey} onChange={(e) => { setApiKey(e.target.value); onUpdate({ tmdb_api_key: e.target.value }) }}
                onBlur={() => { adminConnections.save({ tmdb_api_key: realKey }).catch(() => {}) }}
                autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title="Show / hide" />
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
  const [service, setService] = useState(defaultService)
  const [adminOnly, setAdminOnly] = useState(directRequestAccess === '1')

  useEffect(() => { setService(defaultService) }, [defaultService])
  useEffect(() => { setAdminOnly(directRequestAccess === '1') }, [directRequestAccess])

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
          <span className="conn-block-name">Default app for requests</span>
          <span className="conn-block-desc">
            {service === 'direct' ? 'Sonarr/Radarr is the default' : service === 'riven' ? 'DUMB is the default' : 'Overseerr is the default'}
          </span>
        </div>
        <div className="conn-toggle-wrap" style={{ gap: 6, alignItems: 'center' }}>
          {hasOverseerrSide && (
            <button type="button"
              className={`service-opt-btn ${service !== 'direct' && service !== 'riven' ? 'service-opt-active' : 'service-opt-inactive'}`}
              onClick={() => handleService('overseerr')}>Overseerr</button>
          )}
          {hasRivenSide && (
            <button type="button"
              className={`service-opt-btn ${service === 'riven' ? 'service-opt-active' : 'service-opt-inactive'}`}
              onClick={() => handleService('riven')}>DUMB</button>
          )}
          {hasDirectSide && (
            <button type="button"
              className={`service-opt-btn ${service === 'direct' ? 'service-opt-active' : 'service-opt-inactive'}`}
              onClick={() => handleService('direct')}>Sonarr/Radarr</button>
          )}
        </div>
      </div>
      <div className="conn-block-header" style={{ borderBottom: 'none', paddingTop: 10, marginTop: 10, borderTop: '1px solid var(--border)' }}>
        <div className="conn-block-meta">
          <span className="conn-block-name" style={{ fontSize: '0.88rem' }}>Alternate Request App Access</span>
          <span className="conn-block-desc">Controls who can see the secondary request service (Advanced button). "Admin" hides it from regular users.</span>
        </div>
        <div className="conn-toggle-wrap" style={{ gap: 10, alignItems: 'center' }}>
          <span className={adminOnly ? 'service-label-inactive' : 'service-label-active'}>All Users</span>
          <label className="slide-toggle slide-toggle-choice">
            <input type="checkbox" checked={adminOnly} onChange={(e) => handleAccessChange(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className={adminOnly ? 'service-label-active' : 'service-label-inactive'}>Admin</span>
        </div>
      </div>
    </div>
  )
}

function OverseerrSection({ overseerrUrl, overseerrApiKey, overseerrEnabled, onUpdate, onSave, onToast }) {
  const [host, setHost] = useState(parseHost(overseerrUrl))
  const [port, setPort] = useState(parsePort(overseerrUrl))
  const [apiKey, setApiKey] = useState(overseerrApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const [enabled, setEnabled] = useState(overseerrEnabled)
  const realKey = apiKey === MASKED ? '' : apiKey

  useEffect(() => {
    setHost(parseHost(overseerrUrl))
    setPort(parsePort(overseerrUrl))
  }, [overseerrUrl])
  useEffect(() => { setApiKey(overseerrApiKey ? MASKED : '') }, [overseerrApiKey])
  useEffect(() => { setEnabled(overseerrEnabled) }, [overseerrEnabled])

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

  const handleSave = async () => {
    setSaveLoading(true)
    try {
      await adminConnections.save({ overseerr_url: buildUrl(host, port), overseerr_api_key: realKey })
      onSave?.()
      onToast?.('Overseerr settings saved')
    } catch (err) {
      onToast?.(err.message || 'Failed to save Overseerr settings', 'error')
    } finally { setSaveLoading(false) }
  }

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">Overseerr</span>
            <span className="conn-block-desc">Media request management</span>
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
            <span className="conn-field-label">Address</span>
            <input type="text" className="conn-input" placeholder="http://localhost"
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">Port <span className="conn-field-optional">optional</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="5055" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">API Key</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder="API Key"
                value={apiKeyVisible && apiKey === MASKED ? overseerrApiKey : apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title="Show / hide" />
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
  profiles, onUpdate, onSave, onToast }) {
  const [host, setHost] = useState(parseHost(radarrUrl))
  const [port, setPort] = useState(parsePort(radarrUrl))
  const [apiKey, setApiKey] = useState(radarrApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const [enabled, setEnabled] = useState(radarrEnabled)
  const [profileId, setProfileId] = useState(radarrQualityProfileId || '')
  const [profilesList, setProfilesList] = useState(profiles || [])
  const realKey = apiKey === MASKED ? '' : apiKey

  useEffect(() => {
    setHost(parseHost(radarrUrl))
    setPort(parsePort(radarrUrl))
    setApiKey(radarrApiKey ? MASKED : '')
  }, [radarrUrl, radarrApiKey])
  useEffect(() => { setEnabled(radarrEnabled) }, [radarrEnabled])
  useEffect(() => { setProfileId(radarrQualityProfileId || '') }, [radarrQualityProfileId])
  useEffect(() => { setProfilesList(profiles || []) }, [profiles])

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

  const handleSave = async () => {
    setSaveLoading(true)
    try {
      const sel = profilesList.find(p => p.id === profileId)
      await adminConnections.save({
        radarr_url: buildUrl(host, port),
        radarr_api_key: realKey,
        ...(profileId ? { radarr_quality_profile_id: profileId, radarr_quality_profile_name: sel?.name || radarrQualityProfileName } : {}),
      })
      onSave?.()
      onToast?.('Radarr settings saved')
    } catch (err) {
      onToast?.(err.message || 'Failed to save Radarr settings', 'error')
    } finally { setSaveLoading(false) }
  }

  const qualityRowStyle = hasBothFields ? { display: 'block' } : { display: 'none' }

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">Radarr</span>
            <span className="conn-block-desc">Movies — direct fallback if Overseerr is not used</span>
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
            <span className="conn-field-label">Address</span>
            <input type="text" className="conn-input" placeholder="http://localhost"
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">Port <span className="conn-field-optional">optional</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="7878" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">API Key</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder="API Key"
                value={apiKeyVisible && apiKey === MASKED ? radarrApiKey : apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title="Show / hide" />
              </div>
            </div>
          </div>
          <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading || !hasBothFields}>
            {testLoading ? 'Testing...' : 'Test'}
          </button>
        </div>
        <div className="conn-quality-row" style={qualityRowStyle}>
          <div className="conn-quality-header">
            <span className="conn-quality-label">Quality Profile</span>
            <span className="conn-quality-required">required to enable</span>
          </div>
          <div className="conn-quality-field">
            <select className="conn-select" value={profileId} onChange={(e) => handleProfileChange(e.target.value)}>
              <option value="">— select a profile —</option>
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
  profiles, onUpdate, onSave, onToast }) {
  const [host, setHost] = useState(parseHost(sonarrUrl))
  const [port, setPort] = useState(parsePort(sonarrUrl))
  const [apiKey, setApiKey] = useState(sonarrApiKey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const [enabled, setEnabled] = useState(sonarrEnabled)
  const [profileId, setProfileId] = useState(sonarrQualityProfileId || '')
  const [profilesList, setProfilesList] = useState(profiles || [])
  const realKey = apiKey === MASKED ? '' : apiKey

  useEffect(() => {
    setHost(parseHost(sonarrUrl))
    setPort(parsePort(sonarrUrl))
    setApiKey(sonarrApiKey ? MASKED : '')
  }, [sonarrUrl, sonarrApiKey])
  useEffect(() => { setEnabled(sonarrEnabled) }, [sonarrEnabled])
  useEffect(() => { setProfileId(sonarrQualityProfileId || '') }, [sonarrQualityProfileId])
  useEffect(() => { setProfilesList(profiles || []) }, [profiles])

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

  const handleSave = async () => {
    setSaveLoading(true)
    try {
      const sel = profilesList.find(p => p.id === profileId)
      await adminConnections.save({
        sonarr_url: buildUrl(host, port),
        sonarr_api_key: realKey,
        ...(profileId ? { sonarr_quality_profile_id: profileId, sonarr_quality_profile_name: sel?.name || sonarrQualityProfileName } : {}),
      })
      onSave?.()
      onToast?.('Sonarr settings saved')
    } catch (err) {
      onToast?.(err.message || 'Failed to save Sonarr settings', 'error')
    } finally { setSaveLoading(false) }
  }

  const qualityRowStyle = hasBothFields ? { display: 'block' } : { display: 'none' }

  return (
    <>
      {toast && <div className={`toast toast-${toast.isError ? 'error' : 'success'}`}>{toast.msg}</div>}
      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">Sonarr</span>
            <span className="conn-block-desc">TV Shows — direct fallback if Overseerr is not used</span>
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
            <span className="conn-field-label">Address</span>
            <input type="text" className="conn-input" placeholder="http://localhost"
              value={host} onChange={(e) => setHost(e.target.value)} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-port">
            <span className="conn-field-label">Port <span className="conn-field-optional">optional</span></span>
            <input type="number" className="conn-input conn-input-port" placeholder="8989" min="1" max="65535"
              value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} onBlur={handleBlur} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">API Key</span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input" placeholder="API Key"
                value={apiKeyVisible && apiKey === MASKED ? sonarrApiKey : apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={handleBlur} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title="Show / hide" />
              </div>
            </div>
          </div>
          <button className="btn-admin conn-action-btn" onClick={handleTest} disabled={testLoading || !hasBothFields}>
            {testLoading ? 'Testing...' : 'Test'}
          </button>
        </div>
        <div className="conn-quality-row" style={qualityRowStyle}>
          <div className="conn-quality-header">
            <span className="conn-quality-label">Quality Profile</span>
            <span className="conn-quality-required">required to enable</span>
          </div>
          <div className="conn-quality-field">
            <select className="conn-select" value={profileId} onChange={(e) => handleProfileChange(e.target.value)}>
              <option value="">— select a profile —</option>
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

function RivenSection({ rivenEnabled, rivenUrl, rivenApiKey, rivenRdkey, dumbRequestMode, compatKey,
  onUpdate, onSave, onToast }) {
  const [url, setUrl] = useState(parseHost(rivenUrl))
  const [apiKey, setApiKey] = useState(rivenApiKey ? MASKED : '')
  const [rdkey, setRdkey] = useState(rivenRdkey ? MASKED : '')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [rdkeyVisible, setRdkeyVisible] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const [enabled, setEnabled] = useState(!!rivenEnabled)
  const [mode, setMode] = useState(dumbRequestMode || 'pull')
  const realKey = apiKey === MASKED ? '' : apiKey
  const realRdkey = rdkey === MASKED ? '' : rdkey

  useEffect(() => { setUrl(parseHost(rivenUrl)) }, [rivenUrl])
  useEffect(() => { setApiKey(rivenApiKey ? MASKED : '') }, [rivenApiKey])
  useEffect(() => { setRdkey(rivenRdkey ? MASKED : '') }, [rivenRdkey])
  useEffect(() => { setEnabled(!!rivenEnabled) }, [rivenEnabled])
  useEffect(() => { setMode(dumbRequestMode || 'pull') }, [dumbRequestMode])

  const handleToggle = async (checked) => {
    setEnabled(checked)
    onUpdate?.({ riven_enabled: checked })
    try { await adminRiven.save({ riven_enabled: checked }) } catch { /* ignore */ }
  }

  const handleTest = async () => {
    setTestLoading(true)
    try {
      await adminRiven.test({ url: url || rivenUrl, apiKey: realKey, riven_rdkey: realRdkey })
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
        ...(realRdkey ? { riven_rdkey: realRdkey } : {}),
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
              DUMB / Riven
              <button type="button" className="agent-info-btn" title="API key info">&#9432;</button>
            </span>
            <span className="conn-block-desc">All-in-one debrid media stack — routes approved requests through DUMB&apos;s Riven component</span>
          </div>
          <div className="conn-toggle-wrap">
            <span className="conn-toggle-label">{enabled ? 'Enabled' : 'Disabled'}</span>
            <label className="slide-toggle" title="Enable DUMB / Riven features">
              <input type="checkbox" checked={enabled} onChange={(e) => handleToggle(e.target.checked)} />
              <span className="slide-track" />
            </label>
          </div>
        </div>
        <div className="conn-block-fields">
          <div className="conn-field-group conn-field-host">
            <span className="conn-field-label">Riven URL <span className="conn-field-optional">DUMB component</span></span>
            <input type="text" className="conn-input" placeholder="http://127.0.0.1:8082"
              value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">API Key <span className="conn-field-optional">auto-read from DUMB</span></span>
            <div className="conn-input-wrap">
              <input type={apiKeyVisible ? 'text' : 'password'} className="conn-input"
                placeholder="Auto-detected from /docker/DUMB/data/riven/settings.json"
                value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setApiKeyVisible(!apiKeyVisible)} title="Show / hide" />
              </div>
            </div>
          </div>
          <div className="conn-field-group conn-field-key">
            <span className="conn-field-label">Real-Debrid Key <span className="conn-field-optional">auto-read from DUMB</span></span>
            <div className="conn-input-wrap">
              <input type={rdkeyVisible ? 'text' : 'password'} className="conn-input"
                placeholder="Auto-detected from RIVEN_DOWNLOADERS_REAL_DEBRID_API_KEY"
                value={rdkey} onChange={(e) => setRdkey(e.target.value)} autoComplete="new-password" />
              <div className="conn-input-btns">
                <button type="button" className="conn-input-icon-btn"
                  onClick={() => setRdkeyVisible(!rdkeyVisible)} title="Show / hide" />
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
              DUMB Integration <button type="button" className="agent-info-btn" title="How to connect DUMB">&#9432;</button>
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: 8 }}>
              Let DUMB poll Diskovarr for approved requests
            </span>
          </div>
          <div className="conn-block-fields">
            <div className="conn-field-group">
              <span className="conn-field-label">Overseerr Compat Key</span>
              <button className="btn-admin btn-primary" onClick={handleCopyCompatKey} style={{ marginTop: 6 }}>
                Copy Key
              </button>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                Manage this key in General Settings.
              </p>
            </div>
            <div className="conn-field-group" style={{ marginLeft: 'auto' }}>
              <span className="conn-field-label">Request Mode</span>
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
  const [fields, setFields] = useState({})
  const [loading, setLoading] = useState(true)
  const [radarrProfiles, setRadarrProfiles] = useState([])
  const [sonarrProfiles, setSonarrProfiles] = useState([])
  const [compatKey, setCompatKey] = useState('')
  const [radarrSaving, setRadarrSaving] = useState(false)
  const [sonarrSaving, setSonarrSaving] = useState(false)

  // Derived visibility flags for Default Service section
  const hasOverseerrSide = fields.overseerr_enabled && !!fields.overseerr_url
  const hasRivenSide = !!fields.riven_enabled
  const hasDirectSide =
    (fields.radarr_enabled && !!fields.radarr_url) ||
    (fields.sonarr_enabled && !!fields.sonarr_url)

  // Build full URLs for parsing
  const plexUrl = fields.plex_url || ''
  const plexHost = parseHost(plexUrl)
  const plexPort = parsePort(plexUrl)

  const tautulliUrl = fields.tautulli_url || ''
  const tautulliHost = parseHost(tautulliUrl)
  const tautulliPort = parsePort(tautulliUrl)

  const overseerrUrl = fields.overseerr_url || ''
  const overseerrHost = parseHost(overseerrUrl)
  const overseerrPort = parsePort(overseerrUrl)

  const radarrUrl = fields.radarr_url || ''
  const radarrHost = parseHost(radarrUrl)
  const radarrPort = parsePort(radarrUrl)

  const sonarrUrl = fields.sonarr_url || ''
  const sonarrHost = parseHost(sonarrUrl)
  const sonarrPort = parsePort(sonarrUrl)

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
        diskovarr_api_key: r.diskovarrApiKey,
        agregarr_api_key:  r.agregarrApiKey,
        dumb_api_key:      r.dumbApiKey,
        compat_api_key:    r.compatApiKey,
        riven_api_key:     rv?.hasApiKey ? MASKED : '',
        riven_rdkey:       rv?.hasRdKey  ? MASKED : '',
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

  useEffect(() => { loadInitialData() }, [loadInitialData])

  const handleFieldUpdate = useCallback((patch) => {
    setFields((prev) => ({ ...prev, ...patch }))
  }, [])

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
    return <div className="admin-section"><p style={{ color: 'var(--text-muted)' }}>Loading connection settings...</p></div>
  }

  const plexHostVal = parseHost(fields.plex_url || '')
  const plexPortVal = parsePort(fields.plex_url || '')

  return (
    <>
      {/* ───────── Core Services ───────── */}
      <section className="admin-section">
        <p className="section-desc" style={{ marginBottom: 24 }}>
          Configure external metadata sources and request services. Fill in the URL and API key for a service, then flip its toggle to enable it. Settings are saved automatically when the toggle changes.
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
          onSave={() => setRadarrSaving(false)}
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
          onSave={() => setSonarrSaving(false)}
          onToast={onToast}
        />
      </section>

      {/* ───────── DUMB / Riven ───────── */}
      <section className="admin-section">
        <RivenSection
          rivenEnabled={fields.riven_enabled}
          rivenUrl={fields.riven_url}
          rivenApiKey={fields.riven_api_key}
          rivenRdkey={fields.riven_rdkey}
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
