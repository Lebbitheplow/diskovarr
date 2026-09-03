import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { notificationsApi } from '../services/api'

// Notification-bell state for the app shell: unread-count polling, the
// lazily-loaded list, read-state mutations, and the per-type navigation.
//
// Lifted out of NavigationBar during the rail refresh. The behaviour here is
// deliberately unchanged from what shipped in 2.6.0 — including the branch
// ordering in handleItemClick, where `request_available` is matched by the
// earlier `request_` prefix test and so routes to /queue. Changing that is a
// product decision, not a side effect of moving the nav.
export default function useNotifications() {
  const navigate = useNavigate()
  const [bellCount, setBellCount] = useState(0)
  const [notifications, setNotifications] = useState([])
  const [selectedBroadcast, setSelectedBroadcast] = useState(null)

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
      if (unread.length > 0) setBellCount(unread.length)
    } catch { /* ignore */ }
  }, [])

  const markRead = useCallback(async (id) => {
    try {
      await notificationsApi.markAsRead({ ids: [id] })
      setBellCount((c) => Math.max(0, c - 1))
      setNotifications((ns) => ns.map((n) => n.id === id ? { ...n, read: true } : n))
    } catch { /* ignore */ }
  }, [])

  const markAllRead = useCallback(async () => {
    try {
      await notificationsApi.markAllAsRead()
      setBellCount(0)
      setNotifications((ns) => ns.map((n) => ({ ...n, read: true })))
    } catch { /* ignore */ }
  }, [])

  // `onBroadcast` lets the shell close its dropdown before the modal opens.
  const handleItemClick = useCallback(async (notification, onBroadcast) => {
    await markRead(notification.id)

    if (notification.type === 'broadcast') {
      if (onBroadcast) onBroadcast()
      setSelectedBroadcast(notification)
    } else if (notification.type.startsWith('request_')) {
      navigate('/queue')
    } else if (notification.type === 'request_available') {
      const data = typeof notification.data === 'string' ? JSON.parse(notification.data) : notification.data
      if (data?.tmdbId && data?.mediaType) {
        navigate(`/?openModal=${encodeURIComponent(data.tmdbId)}&mediaType=${encodeURIComponent(data.mediaType)}`)
      } else {
        navigate('/queue?filter=available')
      }
    } else if (notification.type.startsWith('issue_')) {
      navigate('/issues')
    } else if (notification.type === 'tuberr_alert') {
      // Admin tabs are hash-addressed (src/pages/Admin.jsx reads location.hash)
      navigate('/admin#youtube')
    } else if (notification.type === 'monitor_match') {
      const data = typeof notification.data === 'string' ? JSON.parse(notification.data) : notification.data
      if (data?.tmdbId && data?.mediaType) {
        navigate(`/search?q=${encodeURIComponent(data.title || '')}&selectedTmdbId=${encodeURIComponent(data.tmdbId)}&selectedType=${encodeURIComponent(data.mediaType)}`)
      } else {
        navigate('/search')
      }
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
