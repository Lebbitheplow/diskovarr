import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.VITE_BACKEND_URL || 'http://localhost:3233'
  // Single source of truth for the displayed version: package.json (an explicit
  // VITE_APP_VERSION env still wins). Keeps the footer/admin/changelog in sync
  // with each release instead of relying on the hardcoded fallback.
  const appVersion = env.VITE_APP_VERSION || pkg.version

  const proxyRoutes = ['/auth', '/api', '/admin', '/og', '/theme.css', '/icons', '/manifest.json', '/discord-avatar.png']
  const proxy = Object.fromEntries(
    proxyRoutes.map(route => [route, { target: backend, changeOrigin: true, secure: false }])
  )

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    },
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
