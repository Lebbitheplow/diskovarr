import React, { useState, useCallback, useEffect } from 'react'
import GeneralSettings from '../components/admin/GeneralSettings'
import UserManagement from '../components/admin/UserManagement'
import ConnectionSettings from '../components/admin/ConnectionSettings'
import AdminNotifications from '../components/admin/notifications/AdminNotifications'
import UserSettingsModal from '../components/admin/UserSettingsModal'
import BulkSettingsModal from '../components/admin/BulkSettingsModal'
import AgentInfoModal from '../components/admin/AgentInfoModal'
import { adminStatus, adminNotifications } from '../services/adminApi'

const APP_VERSION = '1.17.12'

const LOGO_SVG = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true">
    <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.5" fill="currentColor" />
    <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="currentColor" />
    <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="currentColor" />
    <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="currentColor" />
    <circle cx="15" cy="9" r="5" stroke="currentColor" strokeWidth="2" />
    <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
)

const TABS = [
  { id: 'settings', label: 'General' },
  { id: 'users', label: 'Users' },
  { id: 'connections', label: 'Connections' },
  { id: 'notifications', label: 'Notifications' },
]

function AdminNav({ onLogout }) {
  const handleLogout = async () => {
    try {
      await fetch('/admin/logout', { method: 'POST', credentials: 'include' })
      window.location.href = '/admin/login'
    } catch {
      window.location.href = '/admin/login'
    }
  }

  return (
    <nav className="nav">
      <div className="nav-inner">
        <a href="/" className="nav-logo">
          <span className="logo-icon">{LOGO_SVG}</span>
          <span className="logo-text">Diskovarr</span>
          <span className="admin-badge">admin</span>
        </a>
        <div className="nav-user">
          <a href="/" className="nav-logout">← App</a>
          <button
            type="button"
            className="nav-logout"
            style={{ background: 'none', border: 'none', cursor: 'pointer', marginLeft: 4 }}
            onClick={onLogout}
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  )
}

function VersionStrip({ updateAvailable, latestVersion }) {
  return (
    <div className="version-strip">
      <span className="version-badge">v{APP_VERSION}</span>
      {updateAvailable && latestVersion && (
        <a
          className="version-update-badge"
          href="https://github.com/Lebbitheplow/diskovarr/releases/latest"
          target="_blank"
          rel="noopener"
        >
          ↑ v{latestVersion} available
        </a>
      )}
      {!updateAvailable && latestVersion && (
        <span className="version-uptodate">up to date</span>
      )}
      <a
        className="version-docs-link"
        href="https://diskovarr.com/#docs"
        target="_blank"
        rel="noopener"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" aria-hidden="true">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        Documentation
      </a>
    </div>
  )
}

function Toast({ message, type, visible, onClose }) {
  useEffect(() => {
    if (visible) {
      const timer = setTimeout(onClose, 4000)
      return () => clearTimeout(timer)
    }
  }, [visible, onClose])

  if (!visible || !message) return null

  return (
    <div className={`toast toast-${type}`}>
      {message}
    </div>
  )
}

export default function Admin() {
  const [activeTab, setActiveTab] = useState(() => {
    const hash = window.location.hash.replace('#', '')
    return TABS.find(t => t.id === hash)?.id || 'settings'
  })
  const [toast, setToast] = useState({ message: null, type: 'success', visible: false })
  const [connections, setConnections] = useState({
    discoverEnabled: false,
    plexUrl: '',
    plexToken: '',
    tautulliUrl: '',
    tautulliApiKey: '',
    tmdbApiKey: '',
    overseerrEnabled: false,
    overseerrUrl: '',
    overseerrApiKey: '',
    radarrEnabled: false,
    radarrUrl: '',
    radarrApiKey: '',
    radarrQualityProfileId: '',
    radarrQualityProfileName: '',
    sonarrEnabled: false,
    sonarrUrl: '',
    sonarrApiKey: '',
    sonarrQualityProfileId: '',
    sonarrQualityProfileName: '',
    rivenEnabled: false,
    defaultRequestService: 'overseerr',
    directRequestAccess: 'all',
    individualSeasonsEnabled: false,
    appPublicUrl: '',
    dumbRequestMode: 'pull',
  })
  const [userSettingsModalOpen, setUserSettingsModalOpen] = useState(false)
  const [bulkSettingsModalOpen, setBulkSettingsModalOpen] = useState(false)
  const [agentInfoModal, setAgentInfoModal] = useState(null)
  const [selectedUserId, setSelectedUserId] = useState(null)
  const [selectedUsername, setSelectedUsername] = useState('')
  const [enabledProviders, setEnabledProviders] = useState({})
  const [selectedUserIds, setSelectedUserIds] = useState([])
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [latestVersion, setLatestVersion] = useState(null)

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type, visible: true })
  }, [])

  const hideToast = useCallback(() => {
    setToast(prev => ({ ...prev, visible: false }))
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      await fetch('/admin/logout', { method: 'POST', credentials: 'include' })
      window.location.href = '/admin/login'
    } catch {
      window.location.href = '/admin/login'
    }
  }, [])

  const handleTabChange = useCallback((tabId) => {
    setActiveTab(tabId)
    window.location.hash = tabId
  }, [])

  const handleOpenUserSettings = useCallback((userId, username) => {
    setSelectedUserId(userId)
    setSelectedUsername(username)
    setUserSettingsModalOpen(true)
  }, [])

  const handleCloseUserSettings = useCallback(() => {
    setUserSettingsModalOpen(false)
    setSelectedUserId(null)
  }, [])

  const handleOpenBulkSettings = useCallback((ids = []) => {
    setSelectedUserIds(ids)
    setBulkSettingsModalOpen(true)
  }, [])

  const handleUpdateSelectedUserIds = useCallback((ids) => {
    setSelectedUserIds(ids)
  }, [])

  const handleCloseBulkSettings = useCallback(() => {
    setBulkSettingsModalOpen(false)
  }, [])

  const handleOpenAgentInfo = useCallback((agent) => {
    setAgentInfoModal(agent)
  }, [])

  const handleCloseAgentInfo = useCallback(() => {
    setAgentInfoModal(null)
  }, [])

  const handleDataLoaded = useCallback((data) => {
    if (data && data.connections) {
      setConnections(prev => ({ ...prev, ...data.connections }))
    }
  }, [])

  // Restore tab from URL hash
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '')
      if (TABS.find(t => t.id === hash)) {
        setActiveTab(hash)
      }
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  // Load provider enabled states for user modal filtering
  useEffect(() => {
    const loadProviderStates = async () => {
      try {
        const res = await adminStatus.get()
        const providers = {
          discord: !!(res.data?.discordAgent?.enabled),
          pushover: !!(res.data?.pushoverAgent?.enabled),
        }
        // Load other providers
        const [wh, sl, gf, nf, tg, pb, em, wp] = await Promise.allSettled([
          adminNotifications.getWebhook(),
          adminNotifications.getSlack(),
          adminNotifications.getGotify(),
          adminNotifications.getNtfy(),
          adminNotifications.getTelegram(),
          adminNotifications.getPushbullet(),
          adminNotifications.getEmail(),
          adminNotifications.getWebpush(),
        ])
        if (wh.status === 'fulfilled') providers.webhook = !!wh.value.data?.enabled
        if (sl.status === 'fulfilled') providers.slack = !!sl.value.data?.enabled
        if (gf.status === 'fulfilled') providers.gotify = !!gf.value.data?.enabled
        if (nf.status === 'fulfilled') providers.ntfy = !!nf.value.data?.enabled
        if (tg.status === 'fulfilled') providers.telegram = !!tg.value.data?.enabled
        if (pb.status === 'fulfilled') providers.pushbullet = !!pb.value.data?.enabled
        if (em.status === 'fulfilled') providers.email = !!em.value.data?.enabled
        if (wp.status === 'fulfilled') providers.webpush = !!wp.value.data?.enabled
        setEnabledProviders(providers)
      } catch { /* ignore */ }
    }
    loadProviderStates()
  }, [])

  // Check for updates
  useEffect(() => {
    const checkVersion = async () => {
      try {
        const res = await fetch('/admin/status', { credentials: 'include' })
        const data = await res.json()
        if (data.updateAvailable) {
          setUpdateAvailable(true)
        }
        if (data.latestVersion) {
          setLatestVersion(data.latestVersion)
        }
      } catch { /* ignore */ }
    }
    checkVersion()
  }, [])

  return (
    <>
      <AdminNav onLogout={handleLogout} />

      <main className="main-content">
        <div className="hero">
          <h1 className="hero-title">Admin Panel</h1>
          <p className="hero-sub">Connections, users, requests, and system settings</p>
        </div>

        <VersionStrip updateAvailable={updateAvailable} latestVersion={latestVersion} />

        {/* Tab navigation */}
        <div className="admin-tabs">
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={`admin-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => handleTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab panels */}
        {activeTab === 'settings' && (
          <div className="admin-tab-panel" id="panel-settings">
            <GeneralSettings onDataLoaded={handleDataLoaded} onToast={showToast} />
          </div>
        )}

        {activeTab === 'users' && (
          <div className="admin-tab-panel" id="panel-users" hidden={activeTab !== 'users'}>
            <UserManagement
              onDataLoaded={handleDataLoaded}
              onToast={showToast}
              connections={connections}
              onOpenUserSettings={handleOpenUserSettings}
              onOpenBulkSettings={handleOpenBulkSettings}
              onUpdateSelectedUserIds={handleUpdateSelectedUserIds}
            />
          </div>
        )}

        {activeTab === 'connections' && (
          <div className="admin-tab-panel" id="panel-connections" hidden={activeTab !== 'connections'}>
            <ConnectionSettings
              onDataLoaded={handleDataLoaded}
              onToast={showToast}
            />
          </div>
        )}

        {activeTab === 'notifications' && (
          <div className="admin-tab-panel" id="panel-notifications" hidden={activeTab !== 'notifications'}>
            <AdminNotifications
              onDataLoaded={handleDataLoaded}
              onToast={showToast}
              onOpenAgentInfo={handleOpenAgentInfo}
            />
          </div>
        )}
      </main>

      {/* Toast */}
      <Toast
        message={toast.message}
        type={toast.type}
        visible={toast.visible}
        onClose={hideToast}
      />

      {/* User Settings Modal */}
      {userSettingsModalOpen && (
        <UserSettingsModal
          userId={selectedUserId}
          username={selectedUsername}
          onClose={handleCloseUserSettings}
          onToast={showToast}
          enabledProviders={enabledProviders}
        />
      )}

      {/* Bulk Settings Modal */}
      {bulkSettingsModalOpen && (
        <BulkSettingsModal
          onClose={handleCloseBulkSettings}
          onToast={showToast}
          selectedUserIds={selectedUserIds}
        />
      )}

      {/* Agent Info Modals */}
      {agentInfoModal === 'discord' && (
        <AgentInfoModal
          agent="discord"
          onClose={handleCloseAgentInfo}
        />
      )}
      {agentInfoModal === 'riven-keys' && (
        <AgentInfoModal
          agent="riven-keys"
          onClose={handleCloseAgentInfo}
        />
      )}
      {agentInfoModal === 'dumb-connect' && (
        <AgentInfoModal
          agent="dumb-connect"
          onClose={handleCloseAgentInfo}
        />
      )}
      {agentInfoModal === 'pushover' && (
        <AgentInfoModal
          agent="pushover"
          onClose={handleCloseAgentInfo}
        />
      )}
      {agentInfoModal === 'webhook' && (
        <AgentInfoModal agent="webhook" onClose={handleCloseAgentInfo} />
      )}
      {agentInfoModal === 'slack' && (
        <AgentInfoModal agent="slack" onClose={handleCloseAgentInfo} />
      )}
      {agentInfoModal === 'gotify' && (
        <AgentInfoModal agent="gotify" onClose={handleCloseAgentInfo} />
      )}
      {agentInfoModal === 'ntfy' && (
        <AgentInfoModal agent="ntfy" onClose={handleCloseAgentInfo} />
      )}
      {agentInfoModal === 'telegram' && (
        <AgentInfoModal agent="telegram" onClose={handleCloseAgentInfo} />
      )}
      {agentInfoModal === 'pushbullet' && (
        <AgentInfoModal agent="pushbullet" onClose={handleCloseAgentInfo} />
      )}
      {agentInfoModal === 'email' && (
        <AgentInfoModal agent="email" onClose={handleCloseAgentInfo} />
      )}
      {agentInfoModal === 'webpush' && (
        <AgentInfoModal agent="webpush" onClose={handleCloseAgentInfo} />
      )}
    </>
  )
}
