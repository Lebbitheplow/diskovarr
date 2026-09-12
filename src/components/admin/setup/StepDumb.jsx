import React, { useState } from 'react'
import { adminDumbSetup } from '../../../services/adminApi'

function Pill({ ok, warn, children }) {
  return <span className={`setup-pill ${ok ? 'ok' : warn ? 'warn' : 'bad'}`}>{children}</span>
}

// Step 1 — find DUMB (or install it) and prove Diskovarr can drive its API.
export default function StepDumb({ state, onToast, reload, onNext, t }) {
  const d = state?.dumb || {}
  const docker = state?.docker || {}
  const [url, setUrl] = useState(d.configuredUrl || d.url || d.defaultUrl || '')
  const [username, setUsername] = useState(d.username || '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [installDir, setInstallDir] = useState(docker.installDir || '')
  const [image, setImage] = useState(docker.image || '')
  const [compose, setCompose] = useState('')
  const [installOut, setInstallOut] = useState(null)

  const connect = async () => {
    setBusy(true)
    try {
      const r = await adminDumbSetup.saveConnection({ url, username, password })
      const p = r.data.probe
      if (!p.reachable) onToast?.(p.error || 'DUMB is not reachable at that URL', 'error')
      else if (!p.loggedIn) onToast?.(p.authError ? 'DUMB rejected the username/password' : (p.error || 'Could not log in to DUMB'), 'error')
      else if (!p.provision) onToast?.('Connected, but this DUMB is not the Traktless fork (no guided setup API)', 'error')
      else onToast?.('Connected to DUMB Traktless')
      await reload()
    } catch (err) {
      onToast?.(err.message || 'Connection failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  const showCompose = async () => {
    try { const r = await adminDumbSetup.compose(image); setCompose(r.data) } catch (err) { onToast?.(err.message, 'error') }
  }

  const install = async () => {
    setBusy(true)
    setInstallOut(null)
    try {
      const r = await adminDumbSetup.install({ dir: installDir, image })
      setInstallOut(r.data)
      if (r.data.ok) { onToast?.('DUMB container started'); setTimeout(reload, 15000) }
      else if (r.data.manual) { setCompose(r.data.compose); onToast?.(r.data.reason || 'Docker is not available here — use the compose file below', 'error') }
      else onToast?.('docker compose failed — see output', 'error')
    } catch (err) {
      onToast?.(err.message || 'Install failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  const ready = !!d.provision

  return (
    <div>
      <div className="setup-status-row">
        <Pill ok={d.reachable}>{d.reachable ? t('DUMB reachable') : t('DUMB not found')}</Pill>
        {d.reachable && <Pill ok={d.loggedIn} warn={d.authEnabled === false}>{d.loggedIn ? t('API access OK') : t('Login needed')}</Pill>}
        {d.loggedIn && <Pill ok={d.traktless}>{d.traktless ? t('Traktless fork') : t('Stock DUMB')}</Pill>}
        {d.loggedIn && <Pill ok={d.provision}>{d.provision ? t('Guided setup supported') : t('No guided setup API')}</Pill>}
        <Pill ok={docker.available && docker.compose} warn={docker.available && !docker.compose}>
          {docker.available ? t('Docker available') : t('Docker not available from Diskovarr')}
        </Pill>
        {docker.container?.exists && <Pill ok={docker.container.state === 'running'}>{t('Container')} “DUMB”: {docker.container.state}</Pill>}
      </div>

      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('Connect to DUMB')}</span>
            <span className="conn-block-desc">{t('DUMB’s API listens on port 8000 inside its container; with host networking that is http://127.0.0.1:8000 on this machine.')}</span>
          </div>
        </div>
        <div className="setup-field-row">
          <div className="setup-field">
            <span className="conn-field-label">{t('DUMB API URL')}</span>
            <input className="conn-input" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:8000" />
          </div>
          <div className="setup-field">
            <span className="conn-field-label">{t('DUMB username')} <span className="conn-field-optional">{t('if DUMB login is enabled')}</span></span>
            <input className="conn-input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" />
          </div>
          <div className="setup-field">
            <span className="conn-field-label">{t('DUMB password')} {d.hasPassword && <span className="conn-field-optional">{t('saved')}</span>}</span>
            <input className="conn-input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" placeholder={d.hasPassword ? '••••••••' : ''} />
          </div>
          <button type="button" className="btn-admin btn-primary" disabled={busy || !url} onClick={connect}>{busy ? t('Testing…') : t('Test & save')}</button>
        </div>
        {d.reachable && d.loggedIn && !d.traktless && (
          <div className="setup-callout warn">
            {t('This is stock DUMB. The guided setup needs the DUMB Traktless fork, which adds the /diskovarr provisioning API and the TMDB/TVDB-based Riven indexer. Switch the container image to the fork and come back.')}
          </div>
        )}
      </div>

      {!ready && (
        <div className="conn-block">
          <div className="conn-block-header">
            <div className="conn-block-meta">
              <span className="conn-block-name">{t('Install DUMB Traktless')}</span>
              <span className="conn-block-desc">
                {docker.available && docker.compose
                  ? t('Diskovarr can write the compose file and start the container for you.')
                  : t('Docker is not reachable from Diskovarr, so copy the compose file below and run “docker compose up -d” on the host.')}
              </span>
            </div>
          </div>
          <div className="setup-field-row">
            <div className="setup-field">
              <span className="conn-field-label">{t('Install directory (host)')}</span>
              <input className="conn-input" value={installDir} onChange={e => setInstallDir(e.target.value)} />
            </div>
            <div className="setup-field">
              <span className="conn-field-label">{t('Image')}</span>
              <input className="conn-input" value={image} onChange={e => setImage(e.target.value)} />
            </div>
            {docker.available && docker.compose && (
              <button type="button" className="btn-admin btn-primary" disabled={busy} onClick={install}>{busy ? t('Installing…') : t('Install now')}</button>
            )}
            <button type="button" className="btn-admin" onClick={showCompose}>{t('Show compose file')}</button>
          </div>
          <div className="setup-hint">
            {t('Needs /dev/fuse and SYS_ADMIN for the rclone mount. The container keeps everything under the install directory: config/, data/, log/ and mnt/debrid (the debrid mount + symlink library).')}
          </div>
          {installOut && (
            <div className={`setup-callout ${installOut.ok ? '' : 'bad'}`}>
              <div>{installOut.hint || installOut.reason}</div>
              {installOut.output && <pre className="setup-pre" style={{ marginTop: 8 }}>{installOut.output}</pre>}
            </div>
          )}
          {compose && <pre className="setup-pre" style={{ marginTop: 12 }}>{compose}</pre>}
        </div>
      )}

      {ready && state?.dumb?.capabilities?.current?.provider && (
        <div className="setup-callout">
          {t('DUMB already runs a')} <strong>{state.dumb.capabilities.current.provider === 'alldebrid' ? 'AllDebrid' : 'Real-Debrid'}</strong> {t('stack. Running the wizard again will re-apply the plan on top of it (same provider keeps existing mounts; a different provider adds a new stack).')}
        </div>
      )}

      <div className="setup-actions">
        <span />
        <div className="setup-actions-right">
          <button type="button" className="btn-admin btn-primary" disabled={!ready} onClick={onNext}>{t('Next: debrid account')}</button>
        </div>
      </div>
    </div>
  )
}
