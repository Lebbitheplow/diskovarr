import React, { useState, useMemo, useEffect, useCallback } from 'react'
import { useToast } from '../context/ToastContext'
import { publicReviewsApi } from '../services/api'
import { buildTargets, mastodonHref } from '../utils/shareTargets'
import { useTranslation } from 'react-i18next'

// Compact brand glyphs (simple-icons paths), 24×24, drawn in white on a brand chip.
const ICONS = {
  facebook: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
  x: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z',
  threads: 'M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.781 3.631 2.695 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.475 9.16c.98-1.452 2.568-2.252 4.475-2.252h.043c3.187.02 5.087 1.969 5.275 5.366.108.046.216.094.32.144 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Z',
  reddit: 'M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z',
  bluesky: 'M5.42 3.16c2.86 2.15 5.93 6.5 7.06 8.84 1.13-2.34 4.2-6.69 7.06-8.84 2.06-1.55 5.4-2.75 5.4 1.06 0 .76-.44 6.39-.69 7.3-.88 3.17-4.11 3.98-6.99 3.49 5.03.86 6.31 3.69 3.55 6.52-5.25 5.37-7.54-1.35-8.13-3.07-.11-.31-.16-.46-.16-.33 0-.13-.05.02-.16.33-.59 1.72-2.88 8.44-8.13 3.07-2.76-2.83-1.48-5.66 3.55-6.52-2.88.49-6.11-.32-6.99-3.49-.25-.91-.69-6.54-.69-7.3 0-3.81 3.34-2.61 5.4-1.06z',
  mastodon: 'M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.005C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.308C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.066-.051 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.504 2.962 1.51l.638 1.06.638-1.06c.66-1.006 1.65-1.51 2.96-1.51 1.13 0 2.043.394 2.74 1.164.675.77 1.012 1.81 1.012 3.12z',
  linkedin: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z',
  telegram: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
  whatsapp: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413',
  discord: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z',
  email: 'M1.5 8.67v8.58a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3V8.67l-8.928 5.493a3 3 0 0 1-3.144 0L1.5 8.67Zm21-1.762V6.75a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3v.158l9.714 5.978a1.5 1.5 0 0 0 1.572 0L22.5 6.908Z',
  instagram: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z',
}

function BrandIcon({ id }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
      <path d={ICONS[id]} />
    </svg>
  )
}

function ActionTile({ icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
        padding: '12px 8px', borderRadius: '12px', border: '1px solid var(--border)',
        background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer',
        fontSize: '0.74rem', fontWeight: 500, transition: 'all 0.12s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-elevated)' }}
    >
      <span style={{ color: 'var(--accent)', display: 'flex' }}>{icon}</span>
      {label}
    </button>
  )
}

const ic = (d) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>

export default function ShareModal({ reviewId, review = {}, onClose }) {
  const { t } = useTranslation()
  const { success: toastSuccess, error: toastError } = useToast() || {}
  const [commentary, setCommentary] = useState('')
  const [working, setWorking] = useState(false)
  // Share config: canonical link base + whether social-network sharing is viable
  // (the instance must be publicly reachable for those crawlers/links to work).
  const [shareCfg, setShareCfg] = useState({ baseUrl: '', external: true, loaded: false })

  useEffect(() => {
    let active = true
    publicReviewsApi.getShareConfig()
      .then(({ data }) => { if (active) setShareCfg({ baseUrl: data.baseUrl || '', external: !!data.external, loaded: true }) })
      .catch(() => { if (active) setShareCfg({ baseUrl: '', external: false, loaded: true }) })
    return () => { active = false }
  }, [])

  const origin = shareCfg.baseUrl || window.location.origin
  const url = `${origin}/review/${reviewId}`
  const supportsNativeShare = typeof navigator !== 'undefined' && !!navigator.share

  const { targets, text, textWithUrl } = useMemo(
    () => buildTargets({ url, title: review.title, author: review.username, rating: review.rating, commentary }),
    [url, review.title, review.username, review.rating, commentary]
  )

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = useCallback(async (value, msg) => {
    try { await navigator.clipboard.writeText(value); toastSuccess?.(msg) }
    catch { toastError?.('Copy failed') }
  }, [toastSuccess, toastError])

  const fetchImageBlob = useCallback(async (square) => {
    const src = square ? `/og/review/${reviewId}/square.png` : `/og/review/${reviewId}.png`
    const res = await fetch(src)
    if (!res.ok) throw new Error('image fetch failed')
    return res.blob()
  }, [reviewId])

  const downloadImage = useCallback(async (square) => {
    setWorking(true)
    try {
      const blob = await fetchImageBlob(square)
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `diskovarr-review-${reviewId}${square ? '-square' : ''}.png`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(href)
    } catch { toastError?.('Could not download image') }
    setWorking(false)
  }, [fetchImageBlob, reviewId, toastError])

  const shareImage = useCallback(async (square) => {
    setWorking(true)
    try {
      const blob = await fetchImageBlob(square)
      const file = new File([blob], `diskovarr-review-${reviewId}.png`, { type: 'image/png' })
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text })
      } else {
        await downloadImage(square)
      }
    } catch (e) { if (e?.name !== 'AbortError') toastError?.('Could not share image') }
    setWorking(false)
  }, [fetchImageBlob, reviewId, text, downloadImage, toastError])

  const nativeShare = useCallback(async () => {
    try { await navigator.share({ title: review.title, text, url }) }
    catch (e) { if (e?.name !== 'AbortError') toastError?.('Sharing failed') }
  }, [review.title, text, url, toastError])

  const openTarget = useCallback((t) => {
    if (t.kind === 'copy') { copy(t.copyText, 'Copied — paste into Discord'); return }
    if (t.kind === 'mastodon') {
      const inst = window.prompt('Your Mastodon instance (e.g. mastodon.social)')
      const href = mastodonHref(inst, textWithUrl)
      if (href) window.open(href, '_blank', 'noopener,noreferrer')
      return
    }
    window.open(t.href, '_blank', 'noopener,noreferrer')
  }, [copy, textWithUrl])

  const sectionLabel = { fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', margin: '4px 0' }
  const tileStyle = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
    padding: '10px 4px', borderRadius: '12px', border: '1px solid var(--border)',
    background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer',
    fontSize: '0.68rem', transition: 'all 0.12s',
  }
  const chipStyle = { width: '34px', height: '34px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }

  return (
    <div className="modal-backdrop open" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={t('Share review')}
        onClick={e => e.stopPropagation()} style={{ maxWidth: '460px', padding: '24px' }}>
        <button className="modal-close" onClick={onClose} aria-label={t('Close')}>✕</button>

        <h3 style={{ margin: '0 0 4px', fontSize: '1.15rem', color: 'var(--text-primary)' }}>{t('Share review')}</h3>
        <p style={{ margin: '0 0 16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {review.title ? `${review.title}${review.username ? ` · ${review.username}` : ''}` : 'Spread the word'}
        </p>

        {/* Optional commentary — affects the outgoing share only, never the review */}
        <label style={sectionLabel}>{t('Add a comment to your share')}</label>
        <textarea
          value={commentary}
          onChange={e => setCommentary(e.target.value)}
          placeholder={t('e.g. Completely agree with this take…')}
          maxLength={280}
          rows={2}
          style={{
            width: '100%', resize: 'vertical', margin: '6px 0 18px', padding: '10px 12px',
            borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg-secondary)',
            color: 'var(--text-primary)', fontSize: '0.88rem', fontFamily: 'inherit', boxSizing: 'border-box',
          }}
        />

        {/* Primary actions */}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${supportsNativeShare ? 4 : 3}, 1fr)`, gap: '8px', marginBottom: '18px' }}>
          {supportsNativeShare && (
            <ActionTile label={t('Share')} onClick={nativeShare} icon={ic(<><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></>)} />
          )}
          <ActionTile label={t('Copy link')} onClick={() => copy(url, 'Review link copied!')} icon={ic(<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>)} />
          <ActionTile label={t('Copy text')} onClick={() => copy(review.reviewText || textWithUrl, 'Review text copied!')} icon={ic(<><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>)} />
          <ActionTile label={t('Image')} onClick={() => downloadImage(false)} icon={ic(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>)} />
        </div>

        {/* Social platforms — URL-based targets need a publicly reachable instance */}
        <label style={sectionLabel}>{t('Share to')}</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', margin: '8px 0 18px' }}>
          {shareCfg.external && targets.map(t => (
            <button key={t.id} onClick={() => openTarget(t)} title={t.label} aria-label={`Share to ${t.label}`}
              style={tileStyle}
              onMouseEnter={e => { e.currentTarget.style.borderColor = t.brand === '#000000' ? 'var(--border-hover)' : t.brand }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              <span style={{ ...chipStyle, background: t.brand }}>
                <BrandIcon id={t.id} />
              </span>
              {t.label}
            </button>
          ))}
          {/* Instagram has no web post URL — the native share sheet (with the square
              image attached) is the only path in; falls back to download where the
              file-share API is unavailable so the user can post manually. */}
          <button onClick={() => shareImage(true)} disabled={working} title={t('Instagram')} aria-label={t('Share to Instagram')}
            style={{ ...tileStyle, opacity: working ? 0.6 : 1 }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#d62976' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
          >
            <span style={{ ...chipStyle, background: 'linear-gradient(45deg, #feda75, #fa7e1e, #d62976, #962fbf, #4f5bd5)' }}>
              <BrandIcon id="instagram" />
            </span>
            {t('Instagram')}
          </button>
        </div>
        {shareCfg.loaded && !shareCfg.external && (
          <p style={{ margin: '-8px 0 16px', fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {t('Social-network sharing needs a public URL — an admin can set one in Settings. Copy Link, Copy Text, Download Image and Instagram still work.')}
          </p>
        )}
      </div>
    </div>
  )
}
