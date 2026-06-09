import api from './api';

export const monitorsApi = {
  getMonitors: () => api.get('/monitors'),
  getMonitor: (id) => api.get(`/monitors/${id}`),
  createMonitor: (data) => api.post('/monitors', data),
  updateMonitor: (id, data) => api.put(`/monitors/${id}`, data),
  deleteMonitor: (id) => api.delete(`/monitors/${id}`),
  toggleMonitor: (id, enabled) => api.post(`/monitors/${id}/toggle`, { enabled }),
  addCriteria: (monitorId, criteria) => api.post(`/monitors/${monitorId}/criteria`, criteria),
  deleteCriteria: (monitorId, criteriaId) => api.delete(`/monitors/${monitorId}/criteria/${criteriaId}`),
  quickCreate: (data) => api.post('/monitors/quick', data),
  suggestCriteria: (params) => api.get('/monitors/criteria/suggest', { params }),
};
