import React, { useState, useCallback } from 'react'
import UserProviderSidebar from './UserProviderSidebar'
import NotificationTypesPanel from './NotificationTypesPanel'
import DiscordUserProvider from './providers/DiscordUserProvider'
import PushoverUserProvider from './providers/PushoverUserProvider'
import TelegramUserProvider from './providers/TelegramUserProvider'
import PushbulletUserProvider from './providers/PushbulletUserProvider'
import EmailUserProvider from './providers/EmailUserProvider'
import { USER_FACEABLE_PROVIDERS } from '../../components/admin/notifications/constants'

const USER_PROVIDER_MAP = {
  discord: { Component: DiscordUserProvider, label: 'Discord' },
  pushover: { Component: PushoverUserProvider, label: 'Pushover' },
  telegram: { Component: TelegramUserProvider, label: 'Telegram' },
  pushbullet: { Component: PushbulletUserProvider, label: 'Pushbullet' },
  email: { Component: EmailUserProvider, label: 'Email' },
}

const USER_ENABLED_FIELD = {
  discord: 'discord_enabled',
  pushover: 'pushover_enabled',
  telegram: 'telegram_enabled',
  pushbullet: 'pushbullet_enabled',
  email: 'email_enabled',
}

function buildEnabledMap(s) {
  return Object.fromEntries(
    Object.entries(USER_ENABLED_FIELD).map(([id, key]) => [id, !!s?.[key]])
  )
}

export default function UserNotifications({ settings, onToast, onUpdateSettings }) {
  const [active, setActive] = useState('types')
  const [notifTypes, setNotifTypes] = useState({
    notify_approved: settings?.notify_approved !== false,
    notify_denied: settings?.notify_denied !== false,
    notify_available: settings?.notify_available !== false,
    notify_issue_update: settings?.notify_issue_update !== false,
    notify_issue_comment: settings?.notify_issue_comment !== false,
    notify_pending: settings?.notify_pending !== false,
    notify_auto_approved: settings?.notify_auto_approved !== false,
    notify_process_failed: settings?.notify_process_failed !== false,
    notify_issue_new: settings?.notify_issue_new !== false,
  })
  const [userProviderEnabled, setUserProviderEnabled] = useState(() => buildEnabledMap(settings))

  // Build list of enabled providers from settings (only admin-enabled ones appear)
  const enabledProviderKeys = settings?.enabled_providers || USER_FACEABLE_PROVIDERS
  const providers = enabledProviderKeys
    .filter(k => USER_PROVIDER_MAP[k])
    .map(k => ({ id: k, label: USER_PROVIDER_MAP[k].label }))

  const isElevated = settings?.is_elevated || settings?.is_admin || false
  const isAdmin = !!settings?.is_admin

  const handleTypeChange = useCallback(async (key, checked) => {
    setNotifTypes(prev => ({ ...prev, [key]: checked }))
    try {
      if (onUpdateSettings) {
        onUpdateSettings({ [key]: checked })
      } else {
        const { userApi } = await import('../../services/api')
        await userApi.updateSettings({ [key]: checked })
      }
    } catch (e) {
      if (onToast) onToast(e.message || 'Save failed', 'error')
    }
  }, [onUpdateSettings, onToast])

  const handleProviderChange = useCallback((id) => {
    setActive(id)
  }, [])

  const handleProviderSave = useCallback(async () => {
    try {
      const { userApi } = await import('../../services/api')
      const { data } = await userApi.getSettings()
      setUserProviderEnabled(buildEnabledMap(data))
    } catch {}
  }, [])

  const renderContent = () => {
    if (active === 'types') {
      return (
        <NotificationTypesPanel
          types={notifTypes}
          onChange={handleTypeChange}
          isElevated={isElevated}
          isAdmin={isAdmin}
        />
      )
    }

    const provider = USER_PROVIDER_MAP[active]
    if (!provider) return null

    const { Component } = provider
    return <Component settings={settings} onToast={onToast} onSave={handleProviderSave} />
  }

  return (
    <div className="notif-layout">
      <UserProviderSidebar providers={providers} active={active} onChange={handleProviderChange} providerEnabled={userProviderEnabled} />
      <div className="notif-content">
        {renderContent()}
      </div>
    </div>
  )
}
