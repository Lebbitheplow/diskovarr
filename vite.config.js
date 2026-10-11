import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'

const brotli = promisify(zlib.brotliCompress)
const gzip = promisify(zlib.gzip)

// Writes .br and .gz next to each text asset at build time, at maximum
// compression since it only runs once. The server's builtAssets middleware
// serves them to clients that accept the encoding.
function precompress() {
  return {
    name: 'diskovarr-precompress',
    apply: 'build',
    async writeBundle(options, bundle) {
      const files = Object.keys(bundle).filter(f => f.startsWith('assets/') && /\.(js|css|svg|json)$/.test(f))
      await Promise.all(files.map(async (f) => {
        const file = path.join(options.dir, f)
        const raw = await fs.readFile(file)
        if (raw.length < 1024) return
        const [br, gz] = await Promise.all([
          brotli(raw, { params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          } }),
          gzip(raw, { level: 9 }),
        ])
        await Promise.all([fs.writeFile(file + '.br', br), fs.writeFile(file + '.gz', gz)])
      }))
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.VITE_BACKEND_URL || 'http://localhost:3233'

  const proxyRoutes = ['/auth', '/api', '/admin', '/og', '/theme.css', '/icons', '/manifest.json', '/discord-avatar.png']
  const proxy = Object.fromEntries(
    proxyRoutes.map(route => [route, { target: backend, changeOrigin: true, secure: false }])
  )

  return {
    plugins: [react(), precompress()],
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
