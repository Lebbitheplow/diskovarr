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

/** Popular content (Tautulli home stats) */
export const popularApi = {
  getPopular: () => api.get('/popular'),
}

/** Discover / Library Browse */
export const discoverApi = {
  getDiscover: (params) => api.get('/discover', { params }),
  getGenres: () => api.get('/discover/genres'),
  getFacets: (field, q = '', limit) => api.get('/discover/facets', { params: { field, q, limit } }),
}

/** Search */
export const searchApi = {
  search: (query, page = 1, genre, type, filters = {}) => api.get('/search', {
    params: {
      q: query,
      page,
      genre,
      type,
      filterGenres: filters.filterGenres?.length ? filters.filterGenres.join(',') : undefined,
      contentRatings: filters.contentRatings?.length ? filters.contentRatings.join(',') : undefined,
      yearFrom: filters.yearFrom || undefined,
      yearTo: filters.yearTo || undefined,
      minScore: filters.minScore || undefined,
    },
  }),
  getSuggestions: (query) => api.get('/search/suggest', { params: { q: query } }),
  getDetails: (tmdbId, type) => api.get('/search/details', { params: { tmdbId, type } }),
  getSeasons: (tmdbId) => api.get('/search/seasons', { params: { tmdbId } }),
  getSimilar: (tmdbId, type, hideLibrary) => api.get('/search/similar', { params: { tmdbId, type, hideLibrary } }),
  getPersonCredits: (personId, hideLibrary) => api.get('/search/person', { params: { personId, hideLibrary } }),
}

/** Watchlist */
export const watchlistApi = {
  getWatchlist: () => api.get('/watchlist'),
  addToWatchlist: (ratingKey) => api.post('/watchlist/add', { ratingKey }),
  removeFromWatchlist: (ratingKey) => api.post('/watchlist/remove', { ratingKey }),
}

/** Blacklist (dismissed / not-interested items) */
export const blacklistApi = {
  getBlacklist: () => api.get('/blacklist'),
  removeFromBlacklist: (ratingKey) => api.delete(`/blacklist/library/${ratingKey}`),
  removeExploreFromBlacklist: (tmdbId, mediaType) => api.delete(`/blacklist/explore/${tmdbId}/${mediaType}`),
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
  getUsers: () => api.get('/queue/users'),
  bulkDelete: (ids) => api.post('/queue/bulk-delete', { ids }),
}

/** Issues */
export const issuesApi = {
  getIssues: (params = {}) => api.get('/issues', { params }),
  getIssue: (id) => api.get(`/issues/${id}`),
  createIssue: (data) => api.post('/issues', data),
  getIssueComments: (id) => api.get(`/issues/${id}/comments`),
  addComment: (id, comment) => api.post(`/issues/${id}/comments`, { comment }),
  getUsers: () => api.get('/issues/users'),
  resolveIssue: (id) => api.post(`/issues/${id}/resolve`),
  resolveIssueWithNote: (id, data) => api.post(`/issues/${id}/resolve`, data),
  closeIssue: (id) => api.post(`/issues/${id}/close`),
  closeIssueWithNote: (id, data) => api.post(`/issues/${id}/close`, data),
  deleteIssue: (id) => api.delete(`/issues/${id}`),
  bulkDelete: (ids) => api.post('/issues/bulk-delete', { ids }),
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
  rebuildPool: () => adminApiInstance.post('/admin/rebuild-pool'),
}

/** Watch History */
export const historyApi = {
  getHistory: (params) => api.get('/history', { params }),
  getUsers: () => api.get('/history/users'),
}

/** Reviews */
export const reviewsApi = {
  getReviews: (params) => api.get('/reviews', { params }),
  getReview: (mediaType, tmdbId) => api.get(`/reviews/${mediaType}/${tmdbId}`),
  createReview: (data) => api.post('/reviews', data),
  updateReview: (id, data) => api.put(`/reviews/${id}`, data),
  deleteReview: (id) => api.delete(`/reviews/${id}`),
}

/** Social Reviews Feed */
export const socialReviewsApi = {
  getFeed: (params) => api.get('/reviews/feed', { params }),
  getReview: (id) => api.get(`/reviews/${id}`),
  toggleReaction: (id) => api.post(`/reviews/${id}/react`),
  getComments: (id) => api.get(`/reviews/${id}/comments`),
  createComment: (id, data) => api.post(`/reviews/${id}/comments`, data),
  updateComment: (commentId, data) => api.put(`/reviews/comments/${commentId}`, data),
  deleteComment: (commentId) => api.delete(`/reviews/comments/${commentId}`),
}

/** Public (unauthenticated) review read — for shared links opened logged-out */
export const publicReviewsApi = {
  getReview: (id) => api.get(`/public/review/${id}`),
  getShareConfig: () => api.get('/public/share-config'),
}

/** Follow System */
export const followApi = {
  initFollows: () => api.post('/users/init-follows'),
  follow: (userId) => api.post(`/users/${userId}/follow`),
  unfollow: (userId) => api.delete(`/users/${userId}/follow`),
  isFollowing: (userId) => api.get(`/users/${userId}/following`),
  getFollowers: (userId, params) => api.get(`/users/${userId}/followers`, { params }),
  getFollowing: (userId, params) => api.get(`/users/${userId}/following-list`, { params }),
}

/** User Profile */
export const profileApi = {
  getProfile: (userId) => api.get(`/users/${userId}/profile`),
  updateProfile: (data) => api.put('/users/profile', data),
  getUserReviews: (userId, params) => api.get(`/users/${userId}/reviews`, { params }),
}

/** TMDB Per-User Integration */
export const tmdbApi = {
  getConnection: () => api.get('/tmdb/connection'),
  initiateConnect: () => api.post('/tmdb/connect/initiate'),
  disconnect: () => api.post('/tmdb/disconnect'),
  verifySession: () => api.post('/tmdb/verify'),
  syncRating: (reviewId) => api.post('/tmdb/sync-rating', { reviewId }),
  removeRating: (reviewId) => api.delete('/tmdb/sync-rating', { data: { reviewId } }),
}

/** Error helpers */
export function isNotFoundError(e) { return e?.status === 404 }
export function isUnauthorizedError(e) { return e?.status === 401 }
export function isForbiddenError(e) { return e?.status === 403 }
export function isRateLimitError(e) { return e?.status === 429 }
export function isServerError(e) { return e?.status === 500 }

export default api
