import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { notificationsApi } from '../services/api'
import { notificationDestination } from '../utils/notificationRoutes'

// Notification-bell state for the app shell: unread-count polling, the
// lazily-loaded list, read-state mutations, and the per-type navigation.
//
// The badge always shows the server's unreadCount — the list is capped at 20
// unread rows, so its length is not the count. Destinations per event type
// live in src/utils/notificationRoutes.js (request_available → /queue is a
// deliberate product decision documented there).
export default function useNotifications() {
  const navigate = useNavigate()
  const [bellCount, setBellCount] = useState(0)
  const [notifications, setNotifications] = useState([])
  const [selectedBroadcast, setSelectedBroadcast] = useState(null)

  const refreshCount = useCallback(async () => {
    try {
      const { data } = await notificationsApi.getNotifications({ countOnly: 1 })
      setBellCount(data?.unreadCount || 0)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    const fetchCount = async () => {
      try {
        const { data } = await notificationsApi.getNotifications({ countOnly: 1 })
        setBellCount(data?.unreadCount || 0)
      } catch { /* ignore */ }
    }
    fetchCount()
    const interval = setInterval(fetchCount, 60000)
    return () => clearInterval(interval)
  }, [])

  const loadNotifications = useCallback(async () => {
    try {
      const { data } = await notificationsApi.getNotifications()
      const unread = data?.notifications || []
      const read = data?.recentRead || []
      setNotifications([...unread, ...read])
      if (typeof data?.unreadCount === 'number') setBellCount(data.unreadCount)
    } catch { /* ignore */ }
  }, [])

  // Only an unread row changes anything; the server's count after the
  // mutation is authoritative (a failed call re-reads it and restores the row).
  const markRead = useCallback(async (notification) => {
    if (!notification || notification.read) return
    const { id } = notification
    setBellCount((c) => Math.max(0, c - 1))
    setNotifications((ns) => ns.map((n) => n.id === id ? { ...n, read: true } : n))
    try {
      const { data } = await notificationsApi.markAsRead({ ids: [id] })
      if (typeof data?.unreadCount === 'number') setBellCount(data.unreadCount)
    } catch {
      setNotifications((ns) => ns.map((n) => n.id === id ? { ...n, read: false } : n))
      refreshCount()
    }
  }, [refreshCount])

  const markAllRead = useCallback(async () => {
    try {
      const { data } = await notificationsApi.markAllAsRead()
      setBellCount(typeof data?.unreadCount === 'number' ? data.unreadCount : 0)
      setNotifications((ns) => ns.map((n) => ({ ...n, read: true })))
    } catch { /* ignore */ }
  }, [])

  // `onBroadcast` lets the shell close its dropdown before the modal opens.
  const handleItemClick = useCallback(async (notification, onBroadcast) => {
    const destination = notificationDestination(notification)
    await markRead(notification)

    if (destination?.kind === 'broadcast') {
      if (onBroadcast) onBroadcast()
      setSelectedBroadcast(notification)
    } else if (destination?.kind === 'navigate') {
      navigate(destination.path)
    }
  }, [markRead, navigate])

  return {
    bellCount,
    notifications,
    selectedBroadcast,
    setSelectedBroadcast,
    loadNotifications,
    markAllRead,
    handleItemClick,
  }
}
