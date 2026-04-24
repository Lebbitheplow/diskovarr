const { createProxyMiddleware } = require('http-proxy-middleware')

const backend = process.env.VITE_BACKEND_URL || 'http://localhost:3233'

module.exports = function setupProxy(app) {
  const authProxy = createProxyMiddleware({
    target: backend,
    changeOrigin: true,
    secure: false,
    onProxyRes: (proxyRes, req, res) => {
      const cookies = proxyRes.headers['set-cookie']
      if (cookies) {
        const rewritten = cookies.map(cookie =>
          cookie.replace(/; ?Secure/i, '').replace(/; ?SameSite=[^;]*/i, 'SameSite=Lax')
        )
        res.setHeader('set-cookie', rewritten)
      }
    },
  })

  const defaultProxy = createProxyMiddleware({ target: backend, changeOrigin: true, secure: false })

  app.use('/auth', authProxy)
  ;['/api', '/admin', '/theme.css', '/icons', '/manifest.json', '/discord-avatar.png'].forEach(route => {
    app.use(route, defaultProxy)
  })
}
