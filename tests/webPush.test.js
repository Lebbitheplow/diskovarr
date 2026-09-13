import { describe, it, expect } from 'vitest'
import { urlBase64ToUint8Array, pushUnavailableReason } from '../src/utils/webPush'
import { visibleNotifTypes, USER_FACEABLE_PROVIDERS } from '../src/components/admin/notifications/constants'

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID key, restoring padding', () => {
    // "hello" → aGVsbG8 (unpadded base64url)
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8'))).toEqual([104, 101, 108, 108, 111])
  })
  it('maps the url-safe alphabet back to standard base64', () => {
    // 0xfb 0xff → "-_8" in base64url, "+/8" in base64
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255])
  })
})

describe('pushUnavailableReason', () => {
  const ok = { isSecureContext: true, hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'default' }
  it('is null when push can be offered', () => {
    expect(pushUnavailableReason(ok)).toBeNull()
  })
  it('explains insecure contexts, missing APIs, and blocked permission', () => {
    expect(pushUnavailableReason({ ...ok, isSecureContext: false })).toMatch(/HTTPS/)
    expect(pushUnavailableReason({ ...ok, hasPushManager: false })).toMatch(/not support/)
    expect(pushUnavailableReason({ ...ok, permission: 'denied' })).toMatch(/blocked/)
  })
})

describe('user notification settings gating', () => {
  it('offers browser push alongside the other user-targetable providers, never the admin feeds', () => {
    expect(USER_FACEABLE_PROVIDERS).toEqual(['discord', 'pushover', 'telegram', 'pushbullet', 'email', 'webpush'])
    expect(USER_FACEABLE_PROVIDERS).not.toContain('ntfy')
  })
  it('shows admin-facing event toggles to every privileged user and to nobody else', () => {
    const keys = (o) => visibleNotifTypes(o).map(t => t.key)
    const plain = keys({})
    expect(plain).not.toContain('notify_pending')
    expect(plain).not.toContain('notify_issue_new')
    expect(plain).toContain('notify_approved')
    expect(keys({ isElevated: true })).toEqual(keys({ isAdmin: true }))
    expect(keys({ isAdmin: true })).toEqual(expect.arrayContaining(['notify_pending', 'notify_auto_approved', 'notify_process_failed', 'notify_issue_new']))
  })
})
