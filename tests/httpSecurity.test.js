import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const rateLimit = nodeRequire('../server/node_modules/express-rate-limit')
const { trustProxySetting, securityHeaders, DEFAULT_TRUST_PROXY } = nodeRequire('../server/middleware/httpSecurity.js')

afterEach(() => vi.restoreAllMocks())

function appWith(trust) {
  const app = express()
  app.set('trust proxy', trust)
  return app
}

// Spins up the app on an ephemeral loopback port for one request.
async function request(app, route, headers = {}) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers })
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

describe('trustProxySetting', () => {
  it('defaults to proxies on loopback, link-local and private networks', () => {
    expect(trustProxySetting(undefined)).toBe(DEFAULT_TRUST_PROXY)
    expect(trustProxySetting('  ')).toBe(DEFAULT_TRUST_PROXY)
    const trusts = appWith(trustProxySetting(undefined)).get('trust proxy fn')
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.18.0.2', '10.1.2.3', '192.168.1.20', 'fd00::5', '169.254.1.1']) {
      expect(trusts(addr, 0), addr).toBe(true)
    }
    // A client connecting from a public address can't vouch for X-Forwarded-*
    for (const addr of ['203.0.113.9', '8.8.8.8', '2001:db8::1', '::ffff:203.0.113.9']) {
      expect(trusts(addr, 0), addr).toBe(false)
    }
  })

  it("accepts express's trust proxy formats", () => {
    expect(trustProxySetting('1')).toBe(1)
    expect(trustProxySetting('2')).toBe(2)
    expect(trustProxySetting('true')).toBe(true)
    expect(trustProxySetting('FALSE')).toBe(false)
    expect(trustProxySetting('loopback')).toBe('loopback')
    expect(trustProxySetting('10.0.0.5, 192.168.0.0/16, 10.0.0.0/255.0.0.0')).toBe('10.0.0.5, 192.168.0.0/16, 10.0.0.0/255.0.0.0')
    expect(trustProxySetting('loopback, 100.64.0.0/10, ::ffff:10.0.0.0/104')).toBe('loopback, 100.64.0.0/10, ::ffff:10.0.0.0/104')
  })

  it('fails loudly on values express cannot compile', () => {
    expect(() => trustProxySetting('my-proxy')).toThrow(/Invalid TRUST_PROXY/)
    expect(() => trustProxySetting('10.0.0.0/40')).toThrow(/Invalid TRUST_PROXY/)
  })

  it('rejects IPv6 subnets that would trust every IPv4 client (GHSA-jqcg-44mw-7w3h)', () => {
    expect(() => trustProxySetting('::ffff:10.0.0.0/8')).toThrow(/every IPv4 address/)
    expect(() => trustProxySetting('loopback, ::/1')).toThrow(/every IPv4 address/)
  })
})

describe('behind a proxy with the default trust', () => {
  it('reads the client IP and protocol from a loopback proxy', async () => {
    const app = appWith(trustProxySetting(undefined))
    app.get('/who', (req, res) => res.json({ ip: req.ip, secure: req.secure }))
    const { body } = await request(app, '/who', { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https' })
    expect(body).toEqual({ ip: '203.0.113.9', secure: true })
  })

  it('does not trip express-rate-limit validations', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = appWith(trustProxySetting(undefined))
    app.use(rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false }))
    app.get('/limited', (req, res) => res.json({ ok: true }))
    expect((await request(app, '/limited', { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(200)
    expect((await request(app, '/limited')).status).toBe(200)
    const logged = [...errors.mock.calls, ...warns.mock.calls].flat().map(String).join('\n')
    expect(logged).not.toMatch(/ERR_ERL/)
  })
})

describe('securityHeaders', () => {
  it('sets nosniff and a referrer policy that still sends origins cross-site', async () => {
    const app = express()
    app.use(securityHeaders)
    app.get('/x', (req, res) => res.json({}))
    const { headers } = await request(app, '/x')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(headers.get('x-frame-options')).toBeNull()
    expect(headers.get('content-security-policy')).toBeNull()
  })
})
