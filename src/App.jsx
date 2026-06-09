import React, { Suspense, lazy } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import NavigationBar from './components/NavigationBar'
import Footer from './components/Footer'

// Lazy-loaded pages
const Home = lazy(() => import('./pages/Home'))
const Discover = lazy(() => import('./pages/Discover'))
const Explore = lazy(() => import('./pages/Explore'))
const Search = lazy(() => import('./pages/Search'))
const Queue = lazy(() => import('./pages/Queue'))
const Issues = lazy(() => import('./pages/Issues'))
const WatchHistory = lazy(() => import('./pages/WatchHistory'))
const Reviews = lazy(() => import('./pages/Reviews'))
const ReviewDetail = lazy(() => import('./pages/ReviewDetail'))
const Settings = lazy(() => import('./pages/Settings'))
const UserProfile = lazy(() => import('./pages/UserProfile'))
const Login = lazy(() => import('./pages/Login'))
const Callback = lazy(() => import('./pages/Callback'))
const Admin = lazy(() => import('./pages/Admin'))
const AdminLogin = lazy(() => import('./pages/AdminLogin'))

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="spinner" />
    </div>
  )
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

  return (
    <>
      {user && !isAdminRoute && <NavigationBar />}
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
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin/*" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {user && !isAdminRoute && <Footer />}
    </>
  )
}
