import React, { useState } from 'react'
import { adminDumbSetup } from '../../../services/adminApi'

const PROVIDERS = [
  {
    key: 'alldebrid',
    label: 'AllDebrid',
    tag: 'Recommended',
    stack: 'Decypharr + rclone',
    signup: 'https://alldebrid.com/register/',
    apikey: 'https://alldebrid.com/apikeys/',
    desc: 'Best cached-result coverage for Riven. DUMB serves it through Decypharr’s mount.',
  },
  {
    key: 'realdebrid',
    label: 'Real-Debrid',
    tag: 'Fewer results',
    stack: 'Zurg + rclone',
    signup: 'https://real-debrid.com/',
    apikey: 'https://real-debrid.com/apitoken',
    desc: 'Works, but noticeably fewer cached torrents are available, so more requests wait on a fresh download. DUMB uses Zurg instead of Decypharr.',
  },
]

// Step 2 — pick the debrid provider and validate the key against its API.
export default function StepDebrid({ form, update, onToast, onBack, onNext, t }) {
  const [busy, setBusy] = useState(false)
  const provider = PROVIDERS.find(p => p.key === form.debrid.provider) || PROVIDERS[0]

  const choose = (key) => update(prev => ({ debrid: { ...prev.debrid, provider: key, account: null } }))
  const setKey = (apiKey) => update(prev => ({ debrid: { ...prev.debrid, apiKey, account: null } }))

  const validate = async () => {
    setBusy(true)
    try {
      const r = await adminDumbSetup.validateDebrid(form.debrid.provider, form.debrid.apiKey)
      update(prev => ({ debrid: { ...prev.debrid, account: r.data } }))
      onToast?.(`${provider.label}: ${r.data.username || 'key accepted'}${r.data.premium ? ' (premium)' : ' — NOT premium'}`, r.data.premium ? 'success' : 'error')
    } catch (err) {
      update(prev => ({ debrid: { ...prev.debrid, account: null } }))
      onToast?.(err.message || 'Validation failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  const acct = form.debrid.account

  return (
    <div>
      <p className="section-desc">{t('Riven downloads through a debrid account. Pick one and paste its API key — the key is stored in DUMB, not in Diskovarr.')}</p>

      <div className="setup-grid" style={{ marginTop: 14 }}>
        {PROVIDERS.map(p => (
          <div key={p.key} className={`setup-card ${form.debrid.provider === p.key ? 'selected' : ''}`} onClick={() => choose(p.key)} role="radio" aria-checked={form.debrid.provider === p.key} tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') choose(p.key) }}>
            <div className="setup-card-title">{p.label} <span className={`setup-tag ${p.key === 'alldebrid' ? 'accent' : 'warn'}`}>{t(p.tag)}</span></div>
            <div className="setup-card-desc">{t(p.desc)}</div>
            <div className="setup-hint">{t('Stack')}: {p.stack}</div>
          </div>
        ))}
      </div>

      {provider.key === 'realdebrid' && (
        <div className="setup-callout warn">
          {t('Heads-up: Real-Debrid has fewer cached results than AllDebrid. Requests still work, they just spend more time in “downloading”.')}
        </div>
      )}

      <div className="conn-block" style={{ marginTop: 16 }}>
        <div className="conn-block-header">
          <div className="conn-block-meta">
            <span className="conn-block-name">{provider.label} {t('API key')}</span>
            <span className="conn-block-desc">
              {t('No account yet?')} <a href={provider.signup} target="_blank" rel="noreferrer">{t('Sign up for')} {provider.label}</a> · {t('Then create a key at')} <a href={provider.apikey} target="_blank" rel="noreferrer">{provider.apikey}</a>
            </span>
          </div>
        </div>
        <div className="setup-field-row">
          <div className="setup-field">
            <span className="conn-field-label">{t('API key')}</span>
            <input className="conn-input" type="password" value={form.debrid.apiKey} onChange={e => setKey(e.target.value)} autoComplete="off" />
          </div>
          <button type="button" className="btn-admin" disabled={busy || !form.debrid.apiKey} onClick={validate}>{busy ? t('Checking…') : t('Validate key')}</button>
        </div>
        {acct && (
          <div className={`setup-callout ${acct.premium ? '' : 'warn'}`}>
            {t('Account')}: <strong>{acct.username || '—'}</strong> · {acct.premium ? t('premium') : t('not premium — Riven needs a premium plan')}
            {acct.expiresAt && <> · {t('expires')} {new Date(acct.expiresAt).toLocaleDateString()}</>}
          </div>
        )}
      </div>

      <div className="setup-actions">
        <button type="button" className="btn-admin" onClick={onBack}>{t('Back')}</button>
        <div className="setup-actions-right">
          <button type="button" className="btn-admin btn-primary" disabled={!form.debrid.apiKey} onClick={onNext}>{t('Next: apps')}</button>
        </div>
      </div>
    </div>
  )
}
