import axios from 'axios'

const adminApi = axios.create({
  baseURL: '/admin',
  withCredentials: true,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

export function normalizeError(error) {
  if (error.response) {
    const { status } = error.response
    const data = error.response.data
    return { status, message: data?.error || data?.message || error.message || 'An error occurred', details: data, isNetworkError: false }
  } else if (error.request) {
    return { status: null, message: 'Network error', details: {}, isNetworkError: true }
  }
  return { status: null, message: error.message || 'Unknown error', details: {}, isNetworkError: false }
}

adminApi.interceptors.request.use((config) => config, (error) => Promise.reject(normalizeError(error)))
adminApi.interceptors.response.use(
  (response) => response,
  (error) => {
    const normalized = normalizeError(error)
    if (normalized.status === 401) console.warn('[401] Admin session expired')
    else if (normalized.status === 403) console.warn('[403] Insufficient permissions')
    else if (normalized.status === 500) console.error('[500] Server error')
    return Promise.reject(normalized)
  },
)

/** Admin Status (polled for updates) */
export const adminStatus = {
  get: () => adminApi.get('/status'),
}

/** Library Sync */
export const adminSync = {
  start: () => adminApi.post('/sync/library'),
  autoEnable: () => adminApi.post('/sync/auto/enable'),
  autoDisable: () => adminApi.post('/sync/auto/disable'),
  watchedSync: (userId) => adminApi.post(`/sync/watched/${userId}`),
}

/** Theme Color */
export const adminTheme = {
  getColor: () => adminApi.get('/theme/color'),
  setColor: (color) => adminApi.post('/theme/color', { color }),
}

/** Settings */
export const adminSettings = {
  getWatchlistMode: () => adminApi.get('/settings/watchlist-mode'),
  setWatchlistMode: (mode) => adminApi.post('/settings/watchlist-mode', { mode }),
  setLogging: (enabled) => adminApi.post('/settings/logging', { enabled }),
  setOwnerUser: (userId) => adminApi.post('/settings/owner-user', { userId }),
  setAutoApprove: (movies, tv) => adminApi.post('/settings/auto-approve', { movies, tv }),
  getAutoApprove: () => adminApi.get('/settings/auto-approve'),
  setAutoRequest: (type, enabled) => adminApi.post('/settings/auto-request', { type, enabled }),
  setDiscordAvatar: (imageDataUri, clear) => adminApi.post('/settings/discord-avatar', { imageDataUri, clear }),
  generateApiKey: () => adminApi.post('/settings/generate-api-key'),
}

/** Request Limits */
export const adminRequestLimits = {
  getGlobal: () => adminApi.get('/request-limits/global'),
  setGlobal: (data) => adminApi.post('/request-limits/global', data),
  setUser: (data) => adminApi.post('/request-limits/user', data),
}

/** Users */
export const adminUsers = {
  getList: (page = 1, perPage = 10) => adminApi.get('/users', { params: { page, perPage } }),
  clearAllWatched: () => adminApi.post('/cache/clear/watched'),
  clearAllDismissals: () => adminApi.post('/cache/clear/dismissals'),
  clearRecCache: () => adminApi.post('/cache/clear/recommendations'),
  clearUserWatched: (userId) => adminApi.post(`/cache/clear/watched/${userId}`),
  clearUserDismissals: (userId) => adminApi.post(`/cache/clear/dismissals/${userId}`),
  clearUserRequests: (userId) => adminApi.delete(`/users/${userId}/requests`),
}

/** User Settings */
export const adminUserSettings = {
  get: (userId) => adminApi.get(`/users/${userId}/settings`),
  set: (userId, data) => adminApi.post(`/users/${userId}/settings`, data),
  bulkSet: (data) => adminApi.post('/users/bulk-settings', data),
}

/** Connections */
export const adminConnections = {
  save: (data) => adminApi.post('/connections/save', data),
  reveal: () => adminApi.get('/connections/reveal'),
  test: (serviceName, data) => adminApi.post(`/connections/test/${serviceName}`, data),
  getQualityProfiles: (service) => adminApi.get(`/connections/quality-profiles/${service}`),
  setDefaultService: (service) => adminApi.post('/connections/save', { default_request_service: service }),
  setDirectRequestAccess: (adminOnly) => adminApi.post('/connections/save', { direct_request_access: adminOnly ? '1' : '0' }),
}

/** Plex OAuth */
export const adminPlex = {
  getAuthUrl: () => adminApi.get('/plex/auth-url'),
  checkPin: (pinId) => adminApi.get(`/plex/check-pin/${pinId}`),
}

/** Notification Agents */
export const adminNotifications = {
  broadcast: (message) => adminApi.post('/notifications/broadcast', { message }),
  setDiscord: (data) => adminApi.post('/settings/discord', data),
  testDiscord: (data) => adminApi.post('/settings/discord/test', data),
  setPushover: (data) => adminApi.post('/settings/pushover', data),
  testPushover: (data) => adminApi.post('/settings/pushover/test', data),
}

/** Agregarr / API Apps */
export const adminAgregarr = {
  getConfig: () => adminApi.get('/agregarr/config'),
  enable: (enabled) => adminApi.post('/agregarr/enable', { enabled }),
  regenerateKey: () => adminApi.post('/agregarr/regenerate-key'),
  deleteServiceUser: (id) => adminApi.delete(`/agregarr/service-users/${id}`),
}

/** Compat */
export const adminCompat = {
  getConfig: () => adminApi.get('/compat/config'),
  enable: (enabled) => adminApi.post('/compat/enable', { enabled }),
  regenerateKey: () => adminApi.post('/compat/regenerate-key'),
}

/** DUMB/Riven */
export const adminRiven = {
  save: (data) => adminApi.post('/connections/save', data),
  test: (data) => adminApi.post('/riven/config/test', data),
  setMode: (mode) => adminApi.post('/connections/save', { dumb_request_mode: mode }),
}

export default adminApi
