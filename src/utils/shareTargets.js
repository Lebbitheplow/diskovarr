// Pure helpers for building share text + per-platform share links.
// Used by both the ShareModal and the post-submit share flow.
//
// Commentary rules (never mutates the original review):
//  - The optional user commentary is prepended to a short review summary.
//  - Platforms with an editable text param get the full composed text.
//  - URL-only platforms (Facebook, LinkedIn) only carry the link — text can't be
//    prepopulated there, so commentary is dropped for those (documented fallback).

export function reviewSummary({ title, author, rating }) {
  const stars = rating != null ? `${rating}★ ` : ''
  return `${stars}review of ${title}${author ? ` by ${author}` : ''} on Diskovarr`
}

export function composeText({ commentary, summary }) {
  const c = (commentary || '').trim()
  return c ? `${c}\n\n${summary}` : summary
}

const enc = encodeURIComponent

/**
 * Build everything the share UI needs.
 * @param {{ url, title, author, rating, commentary }} opts
 * @returns {{ text, textWithUrl, url, summary, targets: Array }}
 */
export function buildTargets({ url, title, author, rating, commentary }) {
  const summary = reviewSummary({ title, author, rating })
  const text = composeText({ commentary, summary })
  const textWithUrl = `${text} ${url}`
  const subject = `${title} — review on Diskovarr`

  const targets = [
    { id: 'facebook', label: 'Facebook', brand: '#1877F2', kind: 'url',
      href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}&quote=${enc(text)}` },
    { id: 'x', label: 'X', brand: '#000000', kind: 'url',
      href: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}` },
    { id: 'threads', label: 'Threads', brand: '#000000', kind: 'url',
      href: `https://www.threads.net/intent/post?text=${enc(textWithUrl)}` },
    { id: 'reddit', label: 'Reddit', brand: '#FF4500', kind: 'url',
      href: `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(text)}` },
    { id: 'bluesky', label: 'Bluesky', brand: '#0285FF', kind: 'url',
      href: `https://bsky.app/intent/compose?text=${enc(textWithUrl)}` },
    { id: 'mastodon', label: 'Mastodon', brand: '#6364FF', kind: 'mastodon' },
    { id: 'linkedin', label: 'LinkedIn', brand: '#0A66C2', kind: 'url',
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}` },
    { id: 'telegram', label: 'Telegram', brand: '#229ED9', kind: 'url',
      href: `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}` },
    { id: 'whatsapp', label: 'WhatsApp', brand: '#25D366', kind: 'url',
      href: `https://wa.me/?text=${enc(textWithUrl)}` },
    { id: 'discord', label: 'Discord', brand: '#5865F2', kind: 'copy', copyText: textWithUrl },
    { id: 'email', label: 'Email', brand: '#6B7280', kind: 'url',
      href: `mailto:?subject=${enc(subject)}&body=${enc(text + '\n\n' + url)}` },
  ]

  return { text, textWithUrl, url, summary, targets }
}

// Mastodon needs the user's home instance; resolve a share URL once known.
export function mastodonHref(instance, textWithUrl) {
  const host = String(instance || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!host) return null
  return `https://${host}/share?text=${enc(textWithUrl)}`
}
