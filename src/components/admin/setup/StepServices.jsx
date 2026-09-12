import React from 'react'

const CONNECTION_HINT = {
  sonarr: 'sonarr',
  radarr: 'radarr',
  tautulli: 'tautulli',
  seerr: 'overseerr',
}

// Step 3 — choose which apps DUMB should install alongside Riven.
export default function StepServices({ state, caps, form, update, onBack, onNext, t }) {
  const services = caps?.services || []
  const connections = state?.diskovarr?.connections || {}
  const tautulliRequired = !!state?.diskovarr?.tautulliRequired

  const toggle = (key) => update(prev => ({
    services: prev.services.includes(key) ? prev.services.filter(s => s !== key) : [...prev.services, key],
  }))

  return (
    <div>
      <p className="section-desc">
        {t('Riven is always installed. Tick anything else you want DUMB to run — it wires Prowlarr, Zilean and the download client into Sonarr/Radarr for you, and pushes their URLs and API keys into Diskovarr’s Connections page.')}
      </p>

      <div className="setup-grid" style={{ marginTop: 14 }}>
        {services.map(s => {
          const required = s.role === 'riven' || (s.key === 'tautulli' && tautulliRequired)
          const selected = required || form.services.includes(s.key)
          const already = CONNECTION_HINT[s.key] && connections[CONNECTION_HINT[s.key]]
          const requiredLabel = s.key === 'tautulli' ? t('Required for Plex') : t('Required')
          return (
            <div
              key={s.key}
              className={`setup-card ${selected ? 'selected' : ''} ${required ? 'static' : ''}`}
              onClick={() => !required && toggle(s.key)}
              role="checkbox"
              aria-checked={selected}
              tabIndex={required ? -1 : 0}
              onKeyDown={e => { if (!required && (e.key === 'Enter' || e.key === ' ')) toggle(s.key) }}
            >
              <div className="setup-card-title">
                {s.label}
                {required && <span className="setup-tag accent">{requiredLabel}</span>}
                {s.recommended && !required && <span className="setup-tag accent">{t('Recommended')}</span>}
                {s.running ? <span className="setup-tag ok">{t('running')}</span> : s.enabled ? <span className="setup-tag warn">{t('enabled, stopped')}</span> : null}
                {already && <span className="setup-tag">{t('already connected')}</span>}
              </div>
              <div className="setup-card-desc">
                {s.key === 'tautulli' && tautulliRequired
                  ? t('Plex is connected but Tautulli is not. Diskovarr needs Tautulli for Plex watch history (recommendations, Wrapped, deletion rules), so it is installed with the stack and connected for you.')
                  : s.description}
              </div>
              {s.port && <div className="setup-hint">{t('Port')} {s.port}</div>}
            </div>
          )
        })}
        {!services.length && <div className="setup-callout warn">{t('DUMB did not report its service catalogue — reconnect on step 1.')}</div>}
      </div>

      <div className="conn-block" style={{ marginTop: 18 }}>
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{t('Paths & URLs')}</span>
            <span className="conn-block-desc">{t('Defaults are fine for a standard DUMB install.')}</span>
          </div>
        </div>
        <div className="setup-field-row">
          <div className="setup-field">
            <span className="conn-field-label">{t('Symlink library path (inside DUMB)')}</span>
            <input className="conn-input" value={form.libraryPath} onChange={e => update({ libraryPath: e.target.value })} placeholder="/mnt/debrid/library" />
            <div className="setup-hint">{t('Riven writes movies/ and shows/ here. Plex gets pointed at those two folders on the next step.')}</div>
          </div>
          <div className="setup-field">
            <span className="conn-field-label">{t('Diskovarr URL as DUMB reaches it')}</span>
            <input className="conn-input" value={form.diskovarrUrl} onChange={e => update({ diskovarrUrl: e.target.value })} placeholder={state?.diskovarr?.urlGuess} />
            <div className="setup-hint">{t('Riven polls this address for approved requests. Loopback works when Diskovarr runs on the same host as DUMB.')}</div>
          </div>
        </div>
        <div className="setup-hint" style={{ marginTop: 10 }}>
          {t('TMDB key')}: {state?.diskovarr?.hasTmdbKey ? t('taken from Admin → Connections and handed to Riven’s indexer') : t('not set — Riven will fall back to its bundled TMDB token (set one in Connections for your own quota)')} · {t('TVDB key')}: {t('Riven’s bundled key')}
        </div>
      </div>

      <div className="setup-actions">
        <button type="button" className="btn-admin" onClick={onBack}>{t('Back')}</button>
        <div className="setup-actions-right">
          <button type="button" className="btn-admin btn-primary" onClick={onNext}>{t('Next: Plex')}</button>
        </div>
      </div>
    </div>
  )
}
