import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { versionApi } from '../services/api'
import { renderInlineMarkdown } from '../utils/renderRichText'

const RELEASES_URL = 'https://github.com/Lebbitheplow/diskovarr/releases'

const SECTION_LABEL_STYLE = {
  margin: '4px 0 2px',
  fontSize: '0.78rem',
  fontWeight: '600',
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const LIST_STYLE = { margin: '0 0 8px', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }
const ITEM_STYLE = { fontSize: '0.84rem' }
const PARA_STYLE = { fontSize: '0.84rem', margin: '0 0 8px' }
const DATE_STYLE = { fontWeight: '400', color: 'var(--text-secondary)', fontSize: '0.78rem' }
const LINK_STYLE = { color: 'var(--accent)', textDecoration: 'underline' }

const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

// Inline markdown plus [text](https://…) links. React elements only — no HTML.
function renderInline(text, key) {
  const out = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index > last) out.push(...renderInlineMarkdown(text.slice(last, m.index), `${key}-${i}`))
    out.push(<a key={`${key}-a${i}`} href={m[2]} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>{m[1]}</a>)
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) out.push(...renderInlineMarkdown(text.slice(last), `${key}-${i}`))
  return out
}

// The subset of GitHub markdown release notes use: headings, bullet lists
// (with wrapped continuation lines) and paragraphs.
function parseNotes(body) {
  const blocks = []
  let list = null
  let para = null
  for (const raw of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) { list = null; para = null; continue }
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    const bullet = line.match(/^[-*+]\s+(.*)$/)
    if (heading) {
      blocks.push({ type: 'heading', text: heading[1] })
      list = null; para = null
    } else if (bullet) {
      if (!list) { list = { type: 'list', items: [] }; blocks.push(list) }
      list.items.push(bullet[1])
      para = null
    } else if (list && /^\s/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line}`
    } else if (para) {
      para.text += ` ${line}`
    } else {
      para = { type: 'para', text: line }
      blocks.push(para)
      list = null
    }
  }
  return blocks
}

function ReleaseNotes({ body, id }) {
  return parseNotes(body).map((b, i) => {
    const key = `${id}-${i}`
    if (b.type === 'heading') return <p key={key} style={SECTION_LABEL_STYLE}>{b.text}</p>
    if (b.type === 'list') {
      return (
        <ul key={key} style={LIST_STYLE}>
          {b.items.map((item, j) => <li key={j} style={ITEM_STYLE}>{renderInline(item, `${key}-${j}`)}</li>)}
        </ul>
      )
    }
    return <p key={key} style={PARA_STYLE}>{renderInline(b.text, key)}</p>
  })
}

// The installed release plus the two before it, straight from GitHub releases
// (fetched and cached by the server).
export default function ChangelogModal({ open, onClose }) {
  const { t } = useTranslation()
  const [state, setState] = useState({ loading: true, releases: [] })

  useEffect(() => {
    if (!open) return
    let cancelled = false
    versionApi.getChangelog()
      .then(({ data }) => { if (!cancelled) setState({ loading: false, releases: data?.releases || [] }) })
      .catch(() => { if (!cancelled) setState({ loading: false, releases: [] }) })
    return () => { cancelled = true }
  }, [open])

  if (!open) return null
  const { loading, releases } = state

  return (
    <div className="info-modal-backdrop open" onClick={onClose}>
      <div className="info-modal-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
        <button className="info-modal-close" onClick={onClose} aria-label={t('Close')}>✕</button>
        <div className="info-modal-logo">
          <span className="logo-text">{t('Changelog')}</span>
        </div>
        <div className="info-modal-sections" id="changelog-entries">
          {loading && releases.length === 0 && (
            <p style={PARA_STYLE}>{t('Loading release notes…')}</p>
          )}
          {!loading && releases.length === 0 && (
            <p style={PARA_STYLE}>{t("Release notes couldn't be loaded from GitHub.")}</p>
          )}
          {releases.map(r => (
            <div className="info-modal-section" key={r.version}>
              <div className="info-modal-section-title">
                <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>v{r.version}</a>{' '}
                <span style={DATE_STYLE}>{r.date}</span>
              </div>
              <ReleaseNotes body={r.body} id={r.version} />
            </div>
          ))}
          <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" style={{ ...LINK_STYLE, fontSize: '0.84rem' }}>
            {t('All releases on GitHub')}
          </a>
        </div>
      </div>
    </div>
  )
}
