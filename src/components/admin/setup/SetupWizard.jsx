import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { adminDumbSetup } from '../../../services/adminApi'
import StepDumb from './StepDumb'
import StepDebrid from './StepDebrid'
import StepServices from './StepServices'
import StepPlex from './StepPlex'
import StepRun from './StepRun'
import './setup.css'

const STEPS = [
  { id: 'dumb', label: 'DUMB' },
  { id: 'debrid', label: 'Debrid account' },
  { id: 'services', label: 'Apps' },
  { id: 'plex', label: 'Plex' },
  { id: 'run', label: 'Review & run' },
]

const DEFAULT_FORM = {
  debrid: { provider: 'alldebrid', apiKey: '', account: null },
  services: ['zilean'],
  libraryPath: '/mnt/debrid/library',
  diskovarrUrl: '',
  plex: { mode: 'auto', hostPathPrefix: '', movieSectionId: '', showSectionId: '' },
}

// Admin → Setup. Walks an admin from "no DUMB yet" to a wired Riven stack:
// detect/install DUMB → debrid key → optional apps → Plex libraries → run.
export default function SetupWizard({ onToast }) {
  const { t } = useTranslation()
  const [state, setState] = useState(null)
  const [caps, setCaps] = useState(null)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [stepIndex, setStepIndex] = useState(0)
  const [job, setJob] = useState(null)
  const [loading, setLoading] = useState(true)
  const pollRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const res = await adminDumbSetup.state()
      const s = res.data
      setState(s)
      setJob(s.job || null)
      setForm(prev => ({
        ...prev,
        services: s.diskovarr?.tautulliRequired && !prev.services.includes('tautulli') ? [...prev.services, 'tautulli'] : prev.services,
        diskovarrUrl: prev.diskovarrUrl || s.diskovarr?.url || '',
        plex: {
          ...prev.plex,
          hostPathPrefix: prev.plex.hostPathPrefix || s.docker?.container?.debridHostPath || (s.docker?.installDir ? `${s.docker.installDir}/mnt/debrid` : ''),
          movieSectionId: prev.plex.movieSectionId || (s.plex?.libraries || []).find(l => l.type === 'movie')?.id || '',
          showSectionId: prev.plex.showSectionId || (s.plex?.libraries || []).find(l => l.type === 'show')?.id || '',
        },
      }))
      if (s.dumb?.provision) {
        setCaps(s.dumb.capabilities || null)
        if (!s.dumb.capabilities) adminDumbSetup.capabilities().then(r => setCaps(r.data)).catch(() => {})
      }
      if (s.job?.running) setStepIndex(STEPS.length - 1)
    } catch (err) {
      onToast?.(err.message || 'Failed to load setup state', 'error')
    } finally {
      setLoading(false)
    }
  }, [onToast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load()
  }, [load])

  // Poll the job while it runs.
  useEffect(() => {
    if (!job?.running) { clearInterval(pollRef.current); return undefined }
    pollRef.current = setInterval(async () => {
      try {
        const r = await adminDumbSetup.job()
        setJob(r.data)
        if (r.data && !r.data.running) {
          clearInterval(pollRef.current)
          onToast?.(r.data.ok ? 'DUMB setup finished' : 'DUMB setup failed — see the steps below', r.data.ok ? 'success' : 'error')
        }
      } catch { /* keep polling */ }
    }, 4000)
    return () => clearInterval(pollRef.current)
  }, [job?.running, onToast])

  const update = useCallback((patch) => setForm(prev => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) })), [])

  const dumbReady = !!state?.dumb?.provision
  const debridReady = !!form.debrid.apiKey
  const canGo = (i) => i === 0 || (i === 1 && dumbReady) || (i >= 2 && dumbReady && debridReady)

  const start = async () => {
    try {
      const r = await adminDumbSetup.apply({
        debrid: { provider: form.debrid.provider, apiKey: form.debrid.apiKey },
        services: form.services,
        libraryPath: form.libraryPath,
        diskovarrUrl: form.diskovarrUrl,
        plex: form.plex,
      })
      setJob(r.data)
    } catch (err) {
      onToast?.(err.message || 'Could not start setup', 'error')
    }
  }

  if (loading) return <div className="admin-section"><p className="section-desc">{t('Checking for DUMB…')}</p></div>

  const stepProps = { state, caps, form, update, onToast, reload: load, t }
  const current = STEPS[stepIndex].id

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 style={{ margin: 0 }}>{t('Request apps setup')}</h2>
          <p className="section-desc setup-intro" style={{ margin: '6px 0 0' }}>
            {t('Install DUMB Traktless and connect Riven, your debrid account and any extra apps to Diskovarr in a few guided steps.')}
          </p>
        </div>
      </div>

      <div className="setup-stepper" role="tablist">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            className={`setup-step-btn ${i === stepIndex ? 'active' : ''} ${i < stepIndex ? 'done' : ''}`}
            disabled={!canGo(i)}
            onClick={() => setStepIndex(i)}
          >
            <span className="setup-step-num">{i + 1}</span>{t(s.label)}
          </button>
        ))}
      </div>

      {current === 'dumb' && <StepDumb {...stepProps} onNext={() => setStepIndex(1)} />}
      {current === 'debrid' && <StepDebrid {...stepProps} onBack={() => setStepIndex(0)} onNext={() => setStepIndex(2)} />}
      {current === 'services' && <StepServices {...stepProps} onBack={() => setStepIndex(1)} onNext={() => setStepIndex(3)} />}
      {current === 'plex' && <StepPlex {...stepProps} onBack={() => setStepIndex(2)} onNext={() => setStepIndex(4)} />}
      {current === 'run' && <StepRun {...stepProps} job={job} onBack={() => setStepIndex(3)} onStart={start} onReset={async () => { await adminDumbSetup.reset(); setJob(null) }} />}
    </div>
  )
}
