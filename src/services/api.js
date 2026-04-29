import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

const authApiInstance = axios.create({
  baseURL: '/auth',
  withCredentials: true,
  timeout: 15000,
})

const adminApiInstance = axios.create({
  baseURL: '/admin',
  withCredentials: true,
  timeout: 15000,
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

api.interceptors.request.use((config) => config, (error) => Promise.reject(normalizeError(error)))
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const normalized = normalizeError(error)
    if (normalized.status === 401) console.warn('[401] Session may have expired')
    else if (normalized.status === 403) console.warn('[403] Insufficient permissions')
    else if (normalized.status === 500) console.error('[500] Server error')
    return Promise.reject(normalized)
  },
)

/** Authentication API */
export const authApi = {
  checkAuth: () => authApiInstance.get('/check-auth'),
  logout: () => authApiInstance.get('/logout'),
  callback: (data) => authApiInstance.post('/callback', data),
  checkPin: () => authApiInstance.get('/check-pin'),
}

/** Recommendations */
export const recommendationsApi = {
  getRecommendations: () => api.get('/recommendations'),
}

/** Discover / Library Browse */
export const discoverApi = {
  getDiscover: (params) => api.get('/discover', { params }),
  getGenres: () => api.get('/discover/genres'),
}

/** Search */
export const searchApi = {
  search: (query, page = 1, genre, type) => api.get('/search', { params: { q: query, page, genre, type } }),
  getSuggestions: (query) => api.get('/search/suggest', { params: { q: query } }),
  getDetails: (tmdbId, type) => api.get('/search/details', { params: { tmdbId, type } }),
  getSeasons: (tmdbId) => api.get('/search/seasons', { params: { tmdbId } }),
  getSimilar: (tmdbId, type, hideLibrary) => api.get('/search/similar', { params: { tmdbId, type, hideLibrary } }),
}

/** Watchlist */
export const watchlistApi = {
  getWatchlist: () => api.get('/watchlist'),
  addToWatchlist: (ratingKey) => api.post('/watchlist/add', { ratingKey }),
  removeFromWatchlist: (ratingKey) => api.post('/watchlist/remove', { ratingKey }),
}

/** Queue / Requests */
export const queueApi = {
  getQueue: (params = {}) => api.get('/queue', { params }),
  getRequest: (id) => api.get(`/queue/${id}`),
  createRequest: (data) => api.post('/request', data),
  approveRequest: (id) => api.post(`/queue/${id}/approve`),
  denyRequest: (id) => api.post(`/queue/${id}/deny`),
  denyRequestWithNote: (id, data) => api.post(`/queue/${id}/deny`, data),
  deleteRequest: (id) => api.delete(`/queue/${id}`),
  updateRequest: (id, data) => api.put(`/queue/${id}`, data),
}

/** Issues */
export const issuesApi = {
  getIssues: (params = {}) => api.get('/issues', { params }),
  getIssue: (id) => api.get(`/issues/${id}`),
  createIssue: (data) => api.post('/issues', data),
  getIssueComments: (id) => api.get(`/issues/${id}/comments`),
  addComment: (id, content) => api.post(`/issues/${id}/comments`, { content }),
  resolveIssue: (id) => api.post(`/issues/${id}/resolve`),
  resolveIssueWithNote: (id, data) => api.post(`/issues/${id}/resolve`, data),
  closeIssue: (id) => api.post(`/issues/${id}/close`),
  closeIssueWithNote: (id, data) => api.post(`/issues/${id}/close`, data),
  deleteIssue: (id) => api.delete(`/issues/${id}`),
  deleteComment: (id, commentId) => api.delete(`/issues/${id}/comments/${commentId}`),
}

/** Notifications */
export const notificationsApi = {
  getNotifications: (params = {}) => api.get('/notifications', { params }),
  markAsRead: (data) => api.post('/notifications/read', data),
  markAllAsRead: () => api.post('/notifications/read-all'),
}

/** Plex (clients, cast, dismiss, trailer) */
export const plexApi = {
  getClients: () => api.get('/clients'),
  castMedia: (data) => api.post('/cast', data),
  getTrailer: (tmdbId, mediaType) => api.get('/trailer', { params: { tmdbId, mediaType } }),
  dismissItem: (ratingKey) => api.post('/dismiss', { ratingKey }),
  restoreItem: (ratingKey) => api.delete('/dismiss', { data: { ratingKey } }),
}

/** Explore (external recommendations) */
export const exploreApi = {
  getServices: () => api.get('/explore/services'),
  getRecommendations: (params) => api.get('/explore/recommendations', { params }),
  dismissRecommendation: (tmdbId, mediaType) => api.post('/explore/dismiss', { tmdbId, mediaType }),
  followRecommendation: (tmdbId, mediaType) => api.post('/explore/follow', { tmdbId, mediaType }),
}

/** User Settings */
export const userApi = {
  updateSettings: (data) => api.post('/user/settings', data),
  getSettings: () => api.get('/user/settings'),
  testPushover: (userKey) => api.post('/user/pushover/test', { userKey }),
  testDiscord: (discordUserId) => api.post('/user/discord/test', { discordUserId }),
}

/** Poster proxy */
export const posterApi = {
  getPoster: (path) => api.get('/poster', { params: { path } }),
}

/** Admin */
export const adminApi = {
  getAdminStats: () => adminApiInstance.get('/stats'),
  syncLibrary: () => adminApiInstance.post('/sync'),
  getAdminUsers: () => adminApiInstance.get('/users'),
  promoteUser: (userId) => adminApiInstance.post(`/users/${userId}/promote`),
  demoteUser: (userId) => adminApiInstance.post(`/users/${userId}/demote`),
  updateAdminSettings: (data) => adminApiInstance.post('/settings', data),
  testConnection: (serviceName, data) => adminApiInstance.post('/test-connection', { service: serviceName, ...data }),
  getBroadcast: () => adminApiInstance.get('/broadcast'),
  setBroadcast: (message) => adminApiInstance.post('/broadcast', { message }),
  deleteBroadcast: () => adminApiInstance.delete('/broadcast'),
  rebuildPool: () => apiInstance.post('/admin/rebuild-pool'),
}

/** Error helpers */
export function isNotFoundError(e) { return e?.status === 404 }
export function isUnauthorizedError(e) { return e?.status === 401 }
export function isForbiddenError(e) { return e?.status === 403 }
export function isRateLimitError(e) { return e?.status === 429 }
export function isServerError(e) { return e?.status === 500 }

export default api
