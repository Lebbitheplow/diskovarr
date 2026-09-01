import React, { Suspense, lazy, useEffect, useRef } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import AppShell from './components/AppShell'
import AmbientBackground from './components/AmbientBackground'

// Lazy-loaded pages
const Home = lazy(() => import('./pages/Home'))
const Discover = lazy(() => import('./pages/Discover'))
const Explore = lazy(() => import('./pages/Explore'))
const Search = lazy(() => import('./pages/Search'))
const Queue = lazy(() => import('./pages/Queue'))
const Issues = lazy(() => import('./pages/Issues'))
const WatchHistory = lazy(() => import('./pages/WatchHistory'))
const Wrapped = lazy(() => import('./pages/Wrapped'))
const Reviews = lazy(() => import('./pages/Reviews'))
const ReviewDetail = lazy(() => import('./pages/ReviewDetail'))
const Settings = lazy(() => import('./pages/Settings'))
const UserProfile = lazy(() => import('./pages/UserProfile'))
const Login = lazy(() => import('./pages/Login'))
const Callback = lazy(() => import('./pages/Callback'))
const Admin = lazy(() => import('./pages/Admin'))
const AdminLogin = lazy(() => import('./pages/AdminLogin'))
const Privacy = lazy(() => import('./pages/Privacy'))

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="spinner" />
    </div>
  )
}

// Replays a short enter animation on every path change. The class is toggled
// rather than the subtree being keyed by pathname: keying would remount the
// page on each navigation, throwing away its state and refetching its data.
function RouteFade({ children }) {
  const { pathname } = useLocation()
  const ref = useRef(null)

  useEffect(() => {
    // Full page loads used to reset this for free; client-side navigation
    // otherwise lands the new page at the old page's scroll offset. Keyed on
    // pathname only, so query-param changes (search, filters) hold position.
    window.scrollTo(0, 0)

    const el = ref.current
    if (!el) return
    el.classList.remove('is-entering')
    void el.offsetWidth // reflow, so the animation restarts rather than continuing
    el.classList.add('is-entering')
  }, [pathname])

  return <div ref={ref} className="route-fade">{children}</div>
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
  return children
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (user) return <Navigate to="/" replace />
  return children
}

export default function App() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const isAdminRoute = location.pathname.startsWith('/admin')

  if (loading) {
    return <LoadingScreen />
  }

  // Admin has its own chrome, and signed-out screens (login/callback/shared
  // review links) render bare. Everything else gets the rail + top bar shell.
  const showChrome = user && !isAdminRoute

  const routes = (
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/login" element={
            <PublicRoute>
              <Login />
            </PublicRoute>
          } />
          <Route path="/callback" element={<Callback />} />
          <Route path="/" element={
            <ProtectedRoute>
              <Home />
            </ProtectedRoute>
          } />
          <Route path="/discover" element={
            <ProtectedRoute>
              <Discover />
            </ProtectedRoute>
          } />
          <Route path="/explore" element={
            <ProtectedRoute>
              <Explore />
            </ProtectedRoute>
          } />
          <Route path="/search" element={
            <ProtectedRoute>
              <Search />
            </ProtectedRoute>
          } />
          <Route path="/queue" element={
            <ProtectedRoute>
              <Queue />
            </ProtectedRoute>
          } />
          <Route path="/issues" element={
            <ProtectedRoute>
              <Issues />
            </ProtectedRoute>
          } />
          <Route path="/history" element={
            <ProtectedRoute>
              <WatchHistory />
            </ProtectedRoute>
          } />
          <Route path="/wrapped/:year?" element={
            <ProtectedRoute>
              <Wrapped />
            </ProtectedRoute>
          } />
          <Route path="/reviews" element={
            <ProtectedRoute>
              <Reviews />
            </ProtectedRoute>
          } />
          {/* Public so shared links work logged-out; ReviewDetail adapts to auth state */}
          <Route path="/review/:id" element={<ReviewDetail />} />
          {/* Cosmetic vanity alias — resolves by :id; username is decorative */}
          <Route path="/u/:username/review/:id" element={<ReviewDetail />} />
          <Route path="/settings" element={
            <ProtectedRoute>
              <Settings />
            </ProtectedRoute>
          } />
          <Route path="/user/:userId" element={
            <ProtectedRoute>
              <UserProfile />
            </ProtectedRoute>
          } />
          {/* Public: a privacy notice has to be readable before you sign in */}
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin/*" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
  )

  if (!showChrome) return routes

  return (
    <>
      <AmbientBackground />
      <AppShell>
        <RouteFade>{routes}</RouteFade>
      </AppShell>
    </>
  )
}
