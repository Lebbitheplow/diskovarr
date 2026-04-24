import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.VITE_BACKEND_URL || 'http://localhost:3233'

  const proxyRoutes = ['/auth', '/api', '/admin', '/theme.css', '/icons', '/manifest.json', '/discord-avatar.png']
  const proxy = Object.fromEntries(
    proxyRoutes.map(route => [route, { target: backend, changeOrigin: true, secure: false }])
  )

  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: '0.0.0.0',
      proxy,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  }
})
