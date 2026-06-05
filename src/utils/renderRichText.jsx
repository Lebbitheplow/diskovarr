import React from 'react'

// Canonical in-app renderer for Discord-flavored markdown produced by the broadcast editor
// (BroadcastMessage.jsx). Shared by every notification view (bell dropdown, detail modal) so
// formatting renders identically everywhere. Output is React elements — text becomes element
// children and is auto-escaped, so there is no HTML injection / XSS surface (no
// dangerouslySetInnerHTML).

const URL_RE = /(https?:\/\/[^\s<]+)/g
const URL_TEST = /^https?:\/\/[^\s<]+$/

// Matches **bold**, __underline__, ~~strike~~, ==highlight==, `code`, *italic* (non-greedy, single-line).
// Order matters: double-marker variants must be tried before single-asterisk italic.
const MD_RE = /(\*\*([^*\n]+?)\*\*)|(__([^_\n]+?)__)|(~~([^~\n]+?)~~)|(==([^=\n]+?)==)|(`([^`\n]+?)`)|(\*([^*\n]+?)\*)/g
const HIGHLIGHT_STYLE = { background: 'var(--accent-dim2)', color: 'var(--accent)', padding: '0 4px', borderRadius: '3px' }
const CODE_STYLE = { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: '0.9em', background: 'var(--bg-elevated)', border: '1px solid var(--border)', padding: '0 4px', borderRadius: '3px' }

export function renderInlineMarkdown(text, keyPrefix) {
  // Returns an array of React nodes with all six inline formats applied. No URL handling here.
  // Recurses into matched content so nested formats render correctly, e.g. **__bold underline__**
  // or **==bold highlight==** — otherwise the inner markers would show as literal text. `code` is
  // intentionally not recursed (its content is rendered verbatim). A fresh RegExp per call keeps
  // `lastIndex` isolated across the recursion (the shared MD_RE is only used as a source template).
  const re = new RegExp(MD_RE.source, 'g')
  const out = []
  let lastIndex = 0
  let m
  let idx = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) out.push(text.slice(lastIndex, m.index))
    const key = `${keyPrefix}-md-${idx++}`
    if (m[1])      out.push(React.createElement('strong', { key }, ...renderInlineMarkdown(m[2], key)))
    else if (m[3]) out.push(React.createElement('u', { key }, ...renderInlineMarkdown(m[4], key)))
    else if (m[5]) out.push(React.createElement('s', { key }, ...renderInlineMarkdown(m[6], key)))
    else if (m[7]) out.push(React.createElement('mark', { key, style: HIGHLIGHT_STYLE }, ...renderInlineMarkdown(m[8], key)))
    else if (m[9]) out.push(React.createElement('code', { key, style: CODE_STYLE }, m[10]))
    else if (m[11]) out.push(React.createElement('em', { key }, ...renderInlineMarkdown(m[12], key)))
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex))
  return out
}

export function renderTextWithLinks(text) {
  if (!text) return null
  const parts = text.split(URL_RE)
  const elements = []
  parts.forEach((part, i) => {
    if (URL_TEST.test(part)) {
      elements.push(
        React.createElement('a', {
          key: i,
          href: part,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: { color: 'var(--accent)', textDecoration: 'underline' },
        }, part)
      )
    } else if (part) {
      part.split('\n').forEach((line, j) => {
        if (j > 0) elements.push(React.createElement('br', { key: `${i}-${j}-br` }))
        if (!line) { elements.push('\u00A0'); return }
        const rendered = renderInlineMarkdown(line, `${i}-${j}`)
        rendered.forEach((node) => elements.push(node))
      })
    }
  })
  return elements
}
