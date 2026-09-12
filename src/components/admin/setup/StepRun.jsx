import React, { useState } from 'react'
import { adminDumbSetup } from '../../../services/adminApi'

function Progress({ steps }) {
  if (!steps?.length) return null
  return (
    <ul className="setup-progress">
      {steps.map(s => (
        <li key={s.key}>
          <span className={`setup-progress-dot ${s.status}`} />
          <div>
            <div>{s.label}</div>
            {s.detail && <div className="setup-progress-detail">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ul>
  )
}

function Instructions({ plex, t }) {
  const i = plex?.instructions
  if (!i) return null
  return (
    <div className="conn-block">
      <div className="conn-block-header">
        <div className="conn-block-meta">
          <span className="conn-block-name">{t('Plex: do this by hand')}</span>
          <span className="conn-block-desc">{t('Plex → Settings → Manage → Libraries → Edit → Add folders, then Advanced for the per-library settings.')}</span>
        </div>
      </div>
      <ul className="setup-list">
        {i.folders.map(f => <li key={f.type}>{t('Add')} <code>{f.path}</code> {t('to')} {f.library}</li>)}
      </ul>
      <div className="setup-grid" style={{ marginTop: 10 }}>
        <div className="setup-card static"><div className="setup-card-title">{t('Movies library')}</div><ul className="setup-list">{i.libraryPrefs.movie.map(x => <li key={x}><code>{x}</code></li>)}</ul></div>
        <div className="setup-card static"><div className="setup-card-title">{t('TV library')}</div><ul className="setup-list">{i.libraryPrefs.show.map(x => <li key={x}><code>{x}</code></li>)}</ul></div>
        <div className="setup-card static"><div className="setup-card-title">{t('Server settings')}</div><ul className="setup-list">{i.serverPrefs.map(x => <li key={x}><code>{x}</code></li>)}</ul></div>
      </div>
      <ul className="setup-list" style={{ marginTop: 10 }}>{i.notes.map(n => <li key={n}>{n}</li>)}</ul>
    </div>
  )
}

// Step 5 — summary, run, live progress from both Diskovarr and DUMB, results.
export default function StepRun({ form, job, onBack, onStart, onReset, onToast, reload, t }) {
  const [busy, setBusy] = useState(false)
  const running = !!job?.running
  const done = job && !job.running
  const result = job?.result
  const remoteSteps = (job?.remote?.steps || []).map(s => ({ ...s, key: `remote-${s.key}`, label: `DUMB: ${s.label}` }))

  const rerunPlex = async () => {
    setBusy(true)
    try {
      await adminDumbSetup.applyPlex(form.plex)
      onToast?.('Plex step re-run')
      await reload()
    } catch (err) {
      onToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {!job && (
        <>
          <dl className="setup-summary">
            <dt>{t('Debrid')}</dt><dd>{form.debrid.provider === 'alldebrid' ? 'AllDebrid (Decypharr + rclone)' : 'Real-Debrid (Zurg + rclone)'}{form.debrid.account?.username ? ` · ${form.debrid.account.username}` : ''}</dd>
            <dt>{t('Apps')}</dt><dd>Riven{form.services.length ? `, ${form.services.join(', ')}` : ''}</dd>
            <dt>{t('Library path')}</dt><dd><code>{form.libraryPath}</code></dd>
            <dt>{t('Diskovarr URL for DUMB')}</dt><dd><code>{form.diskovarrUrl}</code></dd>
            <dt>{t('Plex')}</dt><dd>{form.plex.mode === 'auto' ? t('configure automatically') : t('instructions only')}</dd>
          </dl>
          <div className="setup-callout">
            {t('DUMB installs the selected services (first installs download binaries and can take several minutes), wires Riven to Diskovarr’s request bridge, and pushes URLs/API keys back into Connections. Diskovarr then switches the default request service to DUMB and attaches the library to Plex.')}
          </div>
        </>
      )}

      {job && (
        <>
          <div className="setup-status-row">
            <span className={`setup-pill ${running ? 'warn' : job.ok ? 'ok' : 'bad'}`}>{running ? t('Running…') : job.ok ? t('Finished') : t('Failed')}</span>
            {job.startedAt && <span className="setup-pill">{t('started')} {new Date(job.startedAt).toLocaleTimeString()}</span>}
          </div>
          <Progress steps={[...(job.steps || []), ...remoteSteps]} />
          {!!job.errors?.length && <div className="setup-callout bad">{job.errors.join(' · ')}</div>}
        </>
      )}

      {done && result && (
        <div style={{ marginTop: 16 }}>
          <div className="conn-block">
            <div className="conn-block-header">
              <div className="conn-block-meta">
                <span className="conn-block-name">{t('Result')}</span>
                <span className="conn-block-desc">{t('Riven now polls Diskovarr for approved requests; Connections shows the wired services.')}</span>
              </div>
            </div>
            <dl className="setup-summary">
              <dt>{t('Movies folder')}</dt><dd><code>{result.plex?.paths?.movies || result.paths?.movies}</code></dd>
              <dt>{t('TV folder')}</dt><dd><code>{result.plex?.paths?.shows || result.paths?.shows}</code></dd>
              {result.remote?.riven?.url && <><dt>{t('Riven')}</dt><dd><code>{result.remote.riven.url}</code>{result.remote.riven.has_api_key ? '' : ` · ${t('API key not yet written')}`}</dd></>}
              {result.remote?.services && Object.entries(result.remote.services).map(([k, v]) => (
                <React.Fragment key={k}><dt>{k}</dt><dd>{v.running ? t('running') : v.enabled ? t('enabled, not running yet') : t('not enabled')}{v.port ? ` · :${v.port}` : ''}</dd></React.Fragment>
              ))}
            </dl>
            {result.plex?.mode === 'auto' && (
              <ul className="setup-list" style={{ marginTop: 10 }}>
                {Object.entries(result.plex.libraries || {}).map(([type, r]) => (
                  <li key={type}>{type === 'movie' ? t('Movies') : t('TV')}: {r.ok ? `${t('attached to library')} ${r.sectionId}` : r.error}</li>
                ))}
                {result.plex.serverPrefs && <li>{t('Server scan settings applied')}</li>}
                {result.plex.serverPrefsError && <li>{t('Server settings')}: {result.plex.serverPrefsError}</li>}
              </ul>
            )}
          </div>
          {(result.plex?.mode === 'manual' || Object.values(result.plex?.libraries || {}).some(l => !l.ok)) && <Instructions plex={result.plex} t={t} />}
        </div>
      )}

      <div className="setup-actions">
        <button type="button" className="btn-admin" onClick={onBack} disabled={running}>{t('Back')}</button>
        <div className="setup-actions-right">
          {done && <button type="button" className="btn-admin" disabled={busy} onClick={rerunPlex}>{busy ? t('Working…') : t('Re-run Plex step')}</button>}
          {done && <button type="button" className="btn-admin" onClick={onReset}>{t('Start over')}</button>}
          {!job && <button type="button" className="btn-admin btn-primary" onClick={onStart}>{t('Run setup')}</button>}
        </div>
      </div>
    </div>
  )
}
