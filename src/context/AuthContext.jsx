import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import i18n from '../i18n'
import { setUnauthorizedHandler } from '../services/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [discoverAvailable, setDiscoverAvailable] = useState(false)
  const [wrappedAvailable, setWrappedAvailable] = useState(false)
  const [activeSource, setActiveSourceState] = useState('plex')
  const [availableSources, setAvailableSources] = useState(['plex'])

  const checkAuth = useCallback(async () => {
    try {
      const res = await axios.get('/auth/check-auth', { withCredentials: true })
      if (res.data && res.data.authenticated && res.data.user) {
        setUser(res.data.user)
        setDiscoverAvailable(!!res.data.discoverAvailable)
        setWrappedAvailable(!!res.data.wrappedAvailable)
        setActiveSourceState(res.data.activeSource || 'plex')
        setAvailableSources(res.data.availableSources || ['plex'])
        // Apply the user's saved UI language (follows them across devices).
        // Fire-and-forget: localStorage already gave a fast first paint.
        axios.get('/api/user/settings', { withCredentials: true }).then(({ data }) => {
          if (data?.ui_language && data.ui_language !== i18n.language) {
            localStorage.setItem('uiLanguage', data.ui_language)
            i18n.changeLanguage(data.ui_language)
          }
        }).catch(() => { /* settings fetch is best-effort */ })
      }
    } catch (e) {
      // Not authenticated
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    ;(async () => { await checkAuth() })()
  }, [checkAuth])

  // A session that expires mid-visit used to surface only as a console warning
  // and failed requests. Dropping the user here makes ProtectedRoute redirect
  // to /login on the next render, while public routes stay readable.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null))
    return () => setUnauthorizedHandler(null)
  }, [])

  const logout = async () => {
    try {
      await axios.get('/auth/logout', { withCredentials: true })
    } catch { /* ignore */ }
    setUser(null)
    setDiscoverAvailable(false)
    setWrappedAvailable(false)
    setActiveSourceState('plex')
    setAvailableSources(['plex'])
    setLoading(false)
  }

  // Nav toggle: persists the preference server-side, then reloads data by
  // letting consumers react to the context change.
  const setActiveSource = useCallback(async (source) => {
    const prev = activeSource
    setActiveSourceState(source)
    try {
      await axios.post('/api/user/source', { source }, { withCredentials: true })
    } catch {
      setActiveSourceState(prev)
    }
  }, [activeSource])

  // Server-derived link flags (from /auth/check-auth) so gating is one line
  // everywhere: Plex-only features (cast, Wrapped playlist) key off isPlexLinked.
  const isPlexLinked = !!user?.isPlexLinked
  const hasJellyfin = !!user?.hasJellyfin
  const value = { user, loading, logout, checkAuth, discoverAvailable, wrappedAvailable, activeSource, availableSources, setActiveSource, isPlexLinked, hasJellyfin }
  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
