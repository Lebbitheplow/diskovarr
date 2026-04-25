import { useState, useCallback } from 'react'
import { adminUserSettings } from '../../services/adminApi'

const defaultState = {
  overrideGlobal: 'nochange',
  movieUnlimited: false,
  movieCount: 5,
  movieDays: 7,
  seasonUnlimited: false,
  seasonCount: 5,
  seasonDays: 7,
  autoApproveMovies: 'nochange',
  autoApproveTv: 'nochange',
  isAdmin: 'nochange',
}

function BulkSettingsModal({ onClose, onToast, selectedUserIds = [] }) {
  const [state, setState] = useState(defaultState)

  const handleOverlayClick = useCallback((e) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  const setField = useCallback((field) => (value) => {
    setState((prev) => ({ ...prev, [field]: value }))
  }, [])

  const buildPayload = useCallback(() => {
    const payload = { userIds: selectedUserIds }

    if (state.overrideGlobal !== 'nochange') {
      payload.overrideGlobal = state.overrideGlobal === 'enable' ? 'enable' : 'disable'
    }

    if (state.overrideGlobal === 'enable') {
      payload.movieLimit = state.movieUnlimited ? undefined : state.movieCount
      payload.movieWindowDays = state.movieDays
      payload.seasonLimit = state.seasonUnlimited ? undefined : state.seasonCount
      payload.tvWindowDays = state.seasonDays
    }

    if (state.autoApproveMovies !== 'nochange') {
      payload.auto_approve_movies = state.autoApproveMovies === 'enable' ? 'enable' : 'disable'
    }

    if (state.autoApproveTv !== 'nochange') {
      payload.auto_approve_tv = state.autoApproveTv === 'enable' ? 'enable' : 'disable'
    }

    if (state.isAdmin !== 'nochange') {
      payload.is_admin = state.isAdmin === 'grant' ? 'grant' : 'revoke'
    }

    return payload
  }, [state, selectedUserIds])

  const handleApply = useCallback(async () => {
    if (selectedUserIds.length === 0) {
      onClose()
      return
    }

    const payload = buildPayload()

    try {
      await adminUserSettings.bulkSet(payload)
      onToast(`Updated ${selectedUserIds.length} users`)
      onClose()
    } catch (err) {
      const message = err?.message || err?.response?.data?.error || 'Unknown error'
      onToast(`Save failed: ${message}`)
    }
  }, [selectedUserIds, buildPayload, onClose, onToast])

  const canApply = selectedUserIds.length > 0

  return (
    <div
      className="conn-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.75)',
        alignItems: 'center',
        justifyContent: 'center',
        display: 'flex',
      }}
      onClick={handleOverlayClick}
    >
      <div
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: '14px',
          padding: '28px',
          width: 'min(520px,92vw)',
          border: '1px solid var(--border)',
          position: 'relative',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '14px',
            right: '16px',
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            fontSize: '1.3rem',
            cursor: 'pointer',
          }}
        >
          &#215;
        </button>

        <h3 style={{ margin: '0 0 4px', fontSize: '1.05rem' }}>Bulk Edit Settings</h3>
        <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
          {selectedUserIds.length} user{selectedUserIds.length !== 1 ? 's' : ''} selected
        </p>

        {/* Override global limits */}
        <div style={{ marginBottom: '16px', paddingBottom: '16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Request Limit Override
          </div>

          <select
            className="btn-admin"
            style={{ width: '100%', marginBottom: '12px' }}
            value={state.overrideGlobal}
            onChange={(e) => {
              setField('overrideGlobal')(e.target.value)
            }}
          >
            <option value="nochange">No change</option>
            <option value="enable">Enable override</option>
            <option value="disable">Disable override</option>
          </select>

          {state.overrideGlobal === 'enable' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {/* Movies */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                <span style={{ minWidth: '84px', fontSize: '0.9rem', color: '#fff', fontWeight: '500' }}>Movies</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    className="themed-checkbox"
                    checked={state.movieUnlimited}
                    onChange={(e) => setField('movieUnlimited')(e.target.checked)}
                  />
                  Unlimited
                </label>
                {!state.movieUnlimited && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      className="btn-admin limit-num"
                      min="1"
                      max="9999"
                      value={state.movieCount}
                      onChange={(e) => setField('movieCount')(Math.min(9999, Math.max(1, Number(e.target.value) || 0)))}
                    />
                    <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>movies per</span>
                    <input
                      type="number"
                      className="btn-admin limit-num"
                      min="1"
                      max="365"
                      value={state.movieDays}
                      onChange={(e) => setField('movieDays')(Math.min(365, Math.max(1, Number(e.target.value) || 0)))}
                    />
                    <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>days</span>
                  </div>
                )}
              </div>

              {/* TV Seasons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                <span style={{ minWidth: '84px', fontSize: '0.9rem', color: '#fff', fontWeight: '500' }}>TV Seasons</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    className="themed-checkbox"
                    checked={state.seasonUnlimited}
                    onChange={(e) => setField('seasonUnlimited')(e.target.checked)}
                  />
                  Unlimited
                </label>
                {!state.seasonUnlimited && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      className="btn-admin limit-num"
                      min="1"
                      max="9999"
                      value={state.seasonCount}
                      onChange={(e) => setField('seasonCount')(Math.min(9999, Math.max(1, Number(e.target.value) || 0)))}
                    />
                    <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>seasons per</span>
                    <input
                      type="number"
                      className="btn-admin limit-num"
                      min="1"
                      max="365"
                      value={state.seasonDays}
                      onChange={(e) => setField('seasonDays')(Math.min(365, Math.max(1, Number(e.target.value) || 0)))}
                    />
                    <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>days</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Auto-approve override */}
        <div style={{ marginBottom: '16px', paddingBottom: '16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Auto-Approve Override
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ minWidth: '130px', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>Movies override</span>
              <select
                className="btn-admin"
                style={{ flex: 1 }}
                value={state.autoApproveMovies}
                onChange={(e) => setField('autoApproveMovies')(e.target.value)}
              >
                <option value="nochange">No change</option>
                <option value="enable">Auto-approve</option>
                <option value="disable">Require approval</option>
                <option value="clear">Clear (use global)</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ minWidth: '130px', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>TV override</span>
              <select
                className="btn-admin"
                style={{ flex: 1 }}
                value={state.autoApproveTv}
                onChange={(e) => setField('autoApproveTv')(e.target.value)}
              >
                <option value="nochange">No change</option>
                <option value="enable">Auto-approve</option>
                <option value="disable">Require approval</option>
                <option value="clear">Clear (use global)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Admin privileges */}
        <div style={{ marginBottom: '24px' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Admin Privileges
          </div>
          <select
            className="btn-admin"
            style={{ width: '100%' }}
            value={state.isAdmin}
            onChange={(e) => setField('isAdmin')(e.target.value)}
          >
            <option value="nochange">No change</option>
            <option value="grant">Grant admin</option>
            <option value="revoke">Revoke admin</option>
          </select>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button className="btn-admin" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-admin btn-primary"
            onClick={handleApply}
            disabled={!canApply}
          >
            Apply to Selected
          </button>
        </div>
      </div>
    </div>
  )
}

export default BulkSettingsModal
