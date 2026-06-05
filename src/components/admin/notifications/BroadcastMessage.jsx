import React, { useState, useRef } from 'react'
import { adminNotifications } from '../../../services/adminApi'

// Discord-flavored markdown markers — bold/italic/underline render natively in Discord webhooks/DMs.
// Highlight (==) is a non-standard marker rendered with the app accent in the in-app modal; in channels
// that don't recognize it (Pushover, etc.) it shows as raw text — acceptable degradation.
const FORMATS = [
  { key: 'bold',      label: 'B',   title: 'Bold (Ctrl+B)',                style: { fontWeight: 700 } },
  { key: 'italic',    label: 'I',   title: 'Italic (Ctrl+I)',              style: { fontStyle: 'italic' } },
  { key: 'underline', label: 'U',   title: 'Underline (Ctrl+U)',           style: { textDecoration: 'underline' } },
  { key: 'strike',    label: 'S',   title: 'Strikethrough (Ctrl+Shift+S)', style: { textDecoration: 'line-through' } },
  { key: 'code',      label: '<>',  title: 'Code (Ctrl+E)',                style: { fontFamily: 'var(--font-mono, monospace)', fontSize: '0.85rem', letterSpacing: '-1px' } },
  { key: 'highlight',               title: 'Highlight (Ctrl+Shift+H)',     swatch: true },
]

// Walk a DOM node and emit the equivalent markdown text. Used at submit time to convert the rich
// contenteditable HTML back into the marker format the notification agents understand.
function nodeToMarkdown(node) {
  let out = ''
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { out += child.textContent; continue }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const tag = child.tagName.toLowerCase()
    const inner = () => nodeToMarkdown(child)
    if (tag === 'br') out += '\n'
    else if (tag === 'div' || tag === 'p') {
      if (out && !out.endsWith('\n')) out += '\n'
      out += inner()
    }
    else if (tag === 'b' || tag === 'strong')         out += `**${inner()}**`
    else if (tag === 'i' || tag === 'em')             out += `*${inner()}*`
    else if (tag === 'u')                             out += `__${inner()}__`
    else if (tag === 's' || tag === 'strike' || tag === 'del') out += `~~${inner()}~~`
    else if (tag === 'code')                          out += `\`${inner()}\``
    else if (tag === 'mark' || child.dataset?.mark)   out += `==${inner()}==`
    else out += inner()
  }
  return out
}

function wrapSelectionInTag(tagName, datasetKey) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
  const range = sel.getRangeAt(0)
  const el = document.createElement(tagName)
  if (datasetKey) el.dataset[datasetKey] = '1'
  try {
    range.surroundContents(el)
  } catch {
    // surroundContents fails on selections that cross element boundaries; fall back to extract+insert
    const frag = range.extractContents()
    el.appendChild(frag)
    range.insertNode(el)
  }
  sel.removeAllRanges()
  const r = document.createRange()
  r.selectNodeContents(el)
  sel.addRange(r)
}

// Check whether the current selection is fully inside an element of the given tag name.
function selectionInsideTag(tagName) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  const node = range.collapsed ? range.startContainer : range.commonAncestorContainer
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  return el ? el.closest(tagName) !== null : false
}

// Remove a <mark> wrapper from the current selection or cursor position.
function removeHighlight() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)

  if (range.collapsed) {
    // Cursor is inside a <mark> — unwrap it
    const node = range.startContainer
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    const mark = el ? el.closest('mark') : null
    if (!mark) return
    unwrapElement(mark)
  } else {
    // Selection spans some content — find and unwrap any <mark> ancestors
    const ancestor = range.commonAncestorContainer
    const el = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement
    const mark = el ? el.closest('mark') : null
    if (!mark) return
    unwrapElement(mark)
  }
}

function unwrapElement(el) {
  const frag = document.createDocumentFragment()
  while (el.firstChild) frag.appendChild(el.firstChild)
  el.parentNode.replaceChild(frag, el)
}

function getFormatState() {
  const state = {}
  try {
    state.bold = document.queryCommandState('bold')
    state.italic = document.queryCommandState('italic')
    state.underline = document.queryCommandState('underline')
    state.strike = document.queryCommandState('strikeThrough')
  } catch {
    // queryCommandState may throw in some contexts
    state.bold = false
    state.italic = false
    state.underline = false
    state.strike = false
  }
  // queryCommandState doesn't work for custom-wrapped tags; use DOM traversal
  state.code = selectionInsideTag('code')
  state.highlight = selectionInsideTag('mark')
  return state
}

export default function BroadcastMessage({ onToast }) {
  const [result, setResult] = useState('')
  const [sending, setSending] = useState(false)
  const [empty, setEmpty] = useState(true)
  const [formatState, setFormatState] = useState(getFormatState)
  const editorRef = useRef(null)

  const checkEmpty = () => {
    const el = editorRef.current
    if (!el) return true
    // A "blank" contenteditable often still contains a <br> placeholder; check rendered text.
    return el.innerText.replace(/\u200B/g, '').trim() === ''
  }

  const updateState = () => setFormatState(getFormatState())

  const applyFormat = (key) => {
    const el = editorRef.current
    if (!el) return
    el.focus()
    if (key === 'highlight') {
      if (selectionInsideTag('mark')) {
        removeHighlight()
      } else {
        wrapSelectionInTag('mark', 'mark')
      }
    } else if (key === 'code') {
      if (selectionInsideTag('code')) {
        // Toggle off: unwrap the <code> element
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0)
          const node = range.collapsed ? range.startContainer : range.commonAncestorContainer
          const el2 = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
          const code = el2 ? el2.closest('code') : null
          if (code) unwrapElement(code)
        }
      } else {
        wrapSelectionInTag('code')
      }
    } else if (key === 'strike') {
      document.execCommand('strikeThrough', false)
    } else {
      document.execCommand(key, false)
    }
    setEmpty(checkEmpty())
    updateState()
  }

  const handleKeyDown = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (e.shiftKey && k === 'h') { e.preventDefault(); applyFormat('highlight'); return }
    if (e.shiftKey && k === 's') { e.preventDefault(); applyFormat('strike');    return }
    if (e.shiftKey) return
    if (k === 'e') { e.preventDefault(); applyFormat('code'); return }
    const map = { b: 'bold', i: 'italic', u: 'underline' }
    if (map[k]) { e.preventDefault(); applyFormat(map[k]) }
  }

  const handlePaste = (e) => {
    // Force plain-text paste so we don't inherit fonts/colors/structure from the clipboard source.
    e.preventDefault()
    const text = (e.clipboardData || window.clipboardData).getData('text/plain')
    document.execCommand('insertText', false, text)
  }

  const handleInput = () => {
    setEmpty(checkEmpty())
    updateState()
  }

  const handleBroadcast = async () => {
    const md = nodeToMarkdown(editorRef.current || document.createElement('div')).trim()
    if (!md) {
      if (onToast) onToast('Please enter a message', 'error')
      return
    }
    setSending(true)
    setResult('')
    try {
      const res = await adminNotifications.broadcast(md)
      setResult(res.data?.message || 'Notification sent')
      if (onToast) onToast('Broadcast sent', 'success')
      if (editorRef.current) editorRef.current.innerHTML = ''
      setEmpty(true)
      updateState()
    } catch (err) {
      setResult(err.message || 'Failed to send broadcast')
      if (onToast) onToast(err.message || 'Failed to send broadcast', 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="admin-section notif-broadcast">
      <div className="admin-section-header">
        <h2 className="section-title">Broadcast Message</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>
        Send a custom message to all users via all configured notification channels (in-app bell, Discord, etc).
      </p>
      <div className="broadcast-toolbar" role="toolbar" aria-label="Text formatting">
        {FORMATS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`broadcast-fmt-btn${formatState[f.key] ? ' active' : ''}`}
            title={f.title}
            onMouseDown={(e) => e.preventDefault() /* keep editor selection */}
            onClick={() => applyFormat(f.key)}
            style={f.swatch ? undefined : f.style}
          >
            {f.swatch ? <span className="broadcast-fmt-swatch" aria-hidden="true" /> : f.label}
          </button>
        ))}
      </div>
      <div
        ref={editorRef}
        className="conn-input broadcast-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder="Type a message to send to all users..."
        data-empty={empty ? '1' : undefined}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onPaste={handlePaste}
        onSelect={updateState}
        onMouseUp={updateState}
        onKeyUp={updateState}
        spellCheck
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
        <button className="btn-admin btn-primary" onClick={handleBroadcast} disabled={sending}>
          {sending ? 'Sending...' : 'Notify All Users'}
        </button>
        <span style={{ fontSize: '0.82rem' }}>{result}</span>
      </div>
    </section>
  )
}
