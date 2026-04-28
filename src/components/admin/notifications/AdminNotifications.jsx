import React, { useState, useEffect, useCallback } from 'react'
import { adminStatus, adminNotifications } from '../../../services/adminApi'
import ProviderSidebar from './ProviderSidebar'
import BroadcastMessage from './BroadcastMessage'
import DiscordProvider from './providers/DiscordProvider'
import PushoverProvider from './providers/PushoverProvider'
import WebhookProvider from './providers/WebhookProvider'
import SlackProvider from './providers/SlackProvider'
import GotifyProvider from './providers/GotifyProvider'
import NtfyProvider from './providers/NtfyProvider'
import TelegramProvider from './providers/TelegramProvider'
import PushbulletProvider from './providers/PushbulletProvider'
import EmailProvider from './providers/EmailProvider'
import WebpushProvider from './providers/WebpushProvider'
import { PROVIDERS } from './constants'

export default function AdminNotifications({ onDataLoaded, onToast, onOpenAgentInfo }) {
  const [active, setActive] = useState('broadcast')
  const [configs, setConfigs] = useState({})

  const loadAll = useCallback(async () => {
    try {
      // Load Discord + Pushover from adminStatus
      const res = await adminStatus.get()
      const discord = res.data?.discordAgent || {}
      const pushover = res.data?.pushoverAgent || {}

      // Load individual agent configs
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

      setConfigs({
        discord,
        pushover,
        webhook: wh.status === 'fulfilled' ? wh.value.data : null,
        slack: sl.status === 'fulfilled' ? sl.value.data : null,
        gotify: gf.status === 'fulfilled' ? gf.value.data : null,
        ntfy: nf.status === 'fulfilled' ? nf.value.data : null,
        telegram: tg.status === 'fulfilled' ? tg.value.data : null,
        pushbullet: pb.status === 'fulfilled' ? pb.value.data : null,
        email: em.status === 'fulfilled' ? em.value.data : null,
        webpush: wp.status === 'fulfilled' ? wp.value.data : null,
      })
      if (onDataLoaded) onDataLoaded()
    } catch {
      if (onToast) onToast('Failed to load notification settings', 'error')
    }
  }, [onDataLoaded, onToast])

  useEffect(() => { loadAll() }, [loadAll])

  // Derive enabled state map for sidebar dots
  const providerEnabled = {
    discord: !!configs.discord?.enabled,
    pushover: !!configs.pushover?.enabled,
    webhook: !!configs.webhook?.enabled,
    slack: !!configs.slack?.enabled,
    gotify: !!configs.gotify?.enabled,
    ntfy: !!configs.ntfy?.enabled,
    telegram: !!configs.telegram?.enabled,
    pushbullet: !!configs.pushbullet?.enabled,
    email: !!configs.email?.enabled,
    webpush: !!configs.webpush?.enabled,
  }

  const handleSidebarChange = useCallback((id) => {
    setActive(id)
    // Update hash for deep-linking: #/notifications/<provider>
    const hashParts = window.location.hash.split('/')
    hashParts[2] = id
    window.location.hash = hashParts.join('/')
  }, [])

  // Restore from hash on mount
  useEffect(() => {
    const handleHash = () => {
      const parts = window.location.hash.split('/')
      if (parts[1] === 'notifications' && parts[2]) {
        const p = PROVIDERS.find(pr => pr.id === parts[2])
        if (p) setActive(parts[2])
      }
    }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  const renderProvider = () => {
    switch (active) {
      case 'broadcast':
        return <BroadcastMessage onToast={onToast} />
      case 'discord':
        return <DiscordProvider initial={configs.discord} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      case 'pushover':
        return <PushoverProvider initial={configs.pushover} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      case 'webhook':
        return <WebhookProvider initial={configs.webhook} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      case 'slack':
        return <SlackProvider initial={configs.slack} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      case 'gotify':
        return <GotifyProvider initial={configs.gotify} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      case 'ntfy':
        return <NtfyProvider initial={configs.ntfy} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      case 'telegram':
        return <TelegramProvider initial={configs.telegram} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      case 'pushbullet':
        return <PushbulletProvider initial={configs.pushbullet} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      case 'email':
        return <EmailProvider initial={configs.email} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      case 'webpush':
        return <WebpushProvider initial={configs.webpush} onToast={onToast} onOpenAgentInfo={onOpenAgentInfo} />
      default:
        return <BroadcastMessage onToast={onToast} />
    }
  }

  return (
    <div className="notif-layout">
      <ProviderSidebar active={active} onChange={handleSidebarChange} providerEnabled={providerEnabled} />
      <div className="notif-content">
        {renderProvider()}
      </div>
    </div>
  )
}
