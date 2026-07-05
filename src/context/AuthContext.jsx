import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import i18n from '../i18n'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [discoverAvailable, setDiscoverAvailable] = useState(false)
  const [wrappedAvailable, setWrappedAvailable] = useState(false)

  const checkAuth = useCallback(async () => {
    try {
      const res = await axios.get('/auth/check-auth', { withCredentials: true })
      if (res.data && res.data.authenticated && res.data.user) {
        setUser(res.data.user)
        setDiscoverAvailable(!!res.data.discoverAvailable)
        setWrappedAvailable(!!res.data.wrappedAvailable)
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

  const logout = async () => {
    try {
      await axios.get('/auth/logout', { withCredentials: true })
    } catch { /* ignore */ }
    setUser(null)
    setDiscoverAvailable(false)
    setWrappedAvailable(false)
    setLoading(false)
  }

  const value = { user, loading, logout, checkAuth, discoverAvailable, wrappedAvailable }
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
