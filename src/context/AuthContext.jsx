import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [discoverAvailable, setDiscoverAvailable] = useState(false)

  const checkAuth = useCallback(async () => {
    try {
      const res = await axios.get('/auth/check-auth', { withCredentials: true })
      if (res.data && res.data.authenticated && res.data.user) {
        setUser(res.data.user)
        setDiscoverAvailable(!!res.data.discoverAvailable)
      }
    } catch (e) {
      // Not authenticated
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  const logout = async () => {
    try {
      await axios.get('/auth/logout', { withCredentials: true })
    } catch {}
    setUser(null)
    setDiscoverAvailable(false)
    setLoading(false)
  }

  const value = { user, loading, logout, checkAuth, discoverAvailable }
  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
