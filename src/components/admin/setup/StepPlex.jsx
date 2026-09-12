import React, { useState } from 'react'
import { adminDumbSetup } from '../../../services/adminApi'

const RECOMMENDED = {
  movie: ['Video preview thumbnails: off', 'Credits detection: on', 'Voice activity detection: on', 'Ad detection: on'],
  show: ['Video preview thumbnails: off', 'Intro detection: off', 'Credits detection: off', 'Voice activity detection: off', 'Use local assets: off', 'Episode ordering: aired'],
  server: ['Scan my library automatically: on', 'Run a partial scan when changes are detected: on', 'Scan my library periodically: every 30 minutes', 'Empty trash automatically after every scan: OFF'],
}

function mapPath(prefix, p) {
  const pre = String(prefix || '').replace(/\/$/, '')
  return pre ? p.replace(/^\/mnt\/debrid/, pre) : p
}

// Step 4 — how the symlink library reaches Plex: automatic attachment with
// the recommended debrid-friendly settings, or written instructions.
export default function StepPlex({ state, form, update, onToast, onBack, onNext, t }) {
  const libs = state?.plex?.libraries || []
  const plex = form.plex
  const [verify, setVerify] = useState(null)
  const [busy, setBusy] = useState(false)
  const moviesPath = mapPath(plex.hostPathPrefix, `${form.libraryPath.replace(/\/$/, '')}/movies`)
  const showsPath = mapPath(plex.hostPathPrefix, `${form.libraryPath.replace(/\/$/, '')}/shows`)
  const setPlex = (patch) => update(prev => ({ plex: { ...prev.plex, ...patch } }))

  const check = async () => {
    setBusy(true)
    try {
      const r = await adminDumbSetup.verifyPlexPath(mapPath(plex.hostPathPrefix, '/mnt/debrid'))
      setVerify(r.data.visible)
      onToast?.(r.data.visible ? 'Plex can see the DUMB mount' : 'Plex cannot see that path yet (the folder may not exist until DUMB has started)', r.data.visible ? 'success' : 'error')
    } catch (err) {
      onToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="section-desc">
        {t('Riven builds a clean, Plex-friendly symlink library. Diskovarr can add its two folders to your Plex libraries and apply the scan settings that behave best on a debrid mount, or just tell you what to set.')}
      </p>

      <div className="setup-grid" style={{ marginTop: 14 }}>
        <div className={`setup-card ${plex.mode === 'auto' ? 'selected' : ''}`} onClick={() => setPlex({ mode: 'auto' })} role="radio" aria-checked={plex.mode === 'auto'} tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setPlex({ mode: 'auto' }) }}>
          <div className="setup-card-title">{t('Configure Plex for me')} <span className="setup-tag accent">{t('Recommended')}</span></div>
          <div className="setup-card-desc">{t('Adds the folders to the libraries you pick (or creates them), applies the recommended per-library and server settings, and starts a scan.')}</div>
        </div>
        <div className={`setup-card ${plex.mode === 'manual' ? 'selected' : ''}`} onClick={() => setPlex({ mode: 'manual' })} role="radio" aria-checked={plex.mode === 'manual'} tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setPlex({ mode: 'manual' }) }}>
          <div className="setup-card-title">{t('Show me instructions')}</div>
          <div className="setup-card-desc">{t('Diskovarr changes nothing in Plex. You get the folder paths and settings list to apply by hand.')}</div>
        </div>
      </div>

      <div className="conn-block" style={{ marginTop: 16 }}>
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('Where Plex sees the DUMB mount')}</span>
            <span className="conn-block-desc">{t('DUMB keeps the mount at /mnt/debrid inside its container. Enter the same folder as Plex sees it: the host path for a native Plex, or the path you mounted it at inside the Plex container.')}</span>
          </div>
        </div>
        <div className="setup-field-row">
          <div className="setup-field">
            <span className="conn-field-label">{t('Plex-side path for /mnt/debrid')}</span>
            <input className="conn-input" value={plex.hostPathPrefix} onChange={e => { setPlex({ hostPathPrefix: e.target.value }); setVerify(null) }} placeholder="/home/you/docker/DUMB/mnt/debrid" />
          </div>
          <button type="button" className="btn-admin" disabled={busy || !state?.plex?.configured} onClick={check}>{busy ? t('Checking…') : t('Check with Plex')}</button>
        </div>
        {verify != null && <div className={`setup-callout ${verify ? '' : 'warn'}`}>{verify ? t('Plex can browse that folder.') : t('Plex cannot browse that folder. If DUMB is not running yet the folder appears once it starts; the Plex step can be re-run afterwards.')}</div>}
        <dl className="setup-summary" style={{ marginTop: 10 }}>
          <dt>{t('Movies folder')}</dt><dd><code>{moviesPath}</code></dd>
          <dt>{t('TV folder')}</dt><dd><code>{showsPath}</code></dd>
        </dl>
        {plex.mode === 'auto' && (
          <div className="setup-field-row" style={{ marginTop: 14 }}>
            <div className="setup-field">
              <span className="conn-field-label">{t('Add movies folder to')}</span>
              <select className="conn-input conn-select" value={plex.movieSectionId} onChange={e => setPlex({ movieSectionId: e.target.value })}>
                <option value="">{t('Create a new “Movies” library')}</option>
                {libs.filter(l => l.type === 'movie').map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
              </select>
            </div>
            <div className="setup-field">
              <span className="conn-field-label">{t('Add TV folder to')}</span>
              <select className="conn-input conn-select" value={plex.showSectionId} onChange={e => setPlex({ showSectionId: e.target.value })}>
                <option value="">{t('Create a new “TV Shows” library')}</option>
                {libs.filter(l => l.type === 'show').map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
              </select>
            </div>
          </div>
        )}
        {!state?.plex?.configured && <div className="setup-callout warn">{t('Plex is not configured in Admin → Connections, so only the instructions mode is possible.')}</div>}
      </div>

      <div className="conn-block">
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('Recommended Plex settings')}</span>
            <span className="conn-block-desc">{t('Background analysis hammers a debrid mount, and auto-emptied trash can wipe the library after a mount hiccup.')}</span>
          </div>
        </div>
        <div className="setup-grid">
          <div className="setup-card static"><div className="setup-card-title">{t('Movies library')}</div><ul className="setup-list">{RECOMMENDED.movie.map(x => <li key={x}>{t(x)}</li>)}</ul></div>
          <div className="setup-card static"><div className="setup-card-title">{t('TV library')}</div><ul className="setup-list">{RECOMMENDED.show.map(x => <li key={x}>{t(x)}</li>)}</ul></div>
          <div className="setup-card static"><div className="setup-card-title">{t('Server (Settings → Library)')}</div><ul className="setup-list">{RECOMMENDED.server.map(x => <li key={x}>{t(x)}</li>)}</ul></div>
        </div>
      </div>

      <div className="setup-actions">
        <button type="button" className="btn-admin" onClick={onBack}>{t('Back')}</button>
        <div className="setup-actions-right">
          <button type="button" className="btn-admin btn-primary" onClick={onNext}>{t('Next: review')}</button>
        </div>
      </div>
    </div>
  )
}
