import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { createDialogStack } from '../src/utils/dialogStack'

// Minimal stand-in for document: one keydown listener list and a body
function fakeDoc() {
  const listeners = new Set()
  return {
    body: { focus: vi.fn() },
    addEventListener: (type, fn) => { if (type === 'keydown') listeners.add(fn) },
    removeEventListener: (type, fn) => { if (type === 'keydown') listeners.delete(fn) },
    press(key, { defaultPrevented = false } = {}) {
      const e = { key, defaultPrevented }
      listeners.forEach(fn => fn(e))
    },
    get listenerCount() { return listeners.size },
  }
}

const el = (connected = true) => ({ focus: vi.fn(), isConnected: connected })
const flush = () => new Promise(resolve => queueMicrotask(resolve))

describe('dialog stack: Escape', () => {
  it('closes only the topmost dialog, then the one beneath on the next press', () => {
    const doc = fakeDoc()
    const stack = createDialogStack(doc)
    const closeDetail = vi.fn()
    const closeMovieNight = vi.fn()
    stack.push({ onEscape: closeDetail })
    const popMovieNight = stack.push({ onEscape: closeMovieNight })

    doc.press('Escape')
    expect(closeMovieNight).toHaveBeenCalledTimes(1)
    expect(closeDetail).not.toHaveBeenCalled()

    popMovieNight()
    doc.press('Escape')
    expect(closeDetail).toHaveBeenCalledTimes(1)
    expect(closeMovieNight).toHaveBeenCalledTimes(1)
  })

  it('lets a dialog without an Escape action shield the ones beneath', () => {
    const doc = fakeDoc()
    const stack = createDialogStack(doc)
    const closeDetail = vi.fn()
    stack.push({ onEscape: closeDetail })
    stack.push({})
    doc.press('Escape')
    expect(closeDetail).not.toHaveBeenCalled()
  })

  it('ignores other keys and Escapes a widget inside the dialog already handled', () => {
    const doc = fakeDoc()
    const stack = createDialogStack(doc)
    const close = vi.fn()
    stack.push({ onEscape: close })
    doc.press('Enter')
    doc.press('Escape', { defaultPrevented: true })
    expect(close).not.toHaveBeenCalled()
  })

  it('listens only while a dialog is open', () => {
    const doc = fakeDoc()
    const stack = createDialogStack(doc)
    expect(doc.listenerCount).toBe(0)
    const popA = stack.push({})
    const popB = stack.push({})
    expect(doc.listenerCount).toBe(1)
    popA()
    popB()
    popB() // a second pop is a no-op
    expect(doc.listenerCount).toBe(0)
    expect(stack.depth).toBe(0)
  })
})

describe('dialog stack: focus', () => {
  it('returns focus to the opener when the top dialog closes', async () => {
    const stack = createDialogStack(fakeDoc())
    const opener = el()
    const pop = stack.push({ restoreFocus: opener })
    pop()
    await flush()
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('hands the outer target up when a parent dialog unmounts before its child', async () => {
    const stack = createDialogStack(fakeDoc())
    const card = el()
    const shareButton = el(false) // lived inside the detail modal, now detached
    const popDetail = stack.push({ restoreFocus: card })
    const popShare = stack.push({ restoreFocus: shareButton })
    popDetail()
    popShare()
    await flush()
    expect(card.focus).toHaveBeenCalledTimes(1)
    expect(shareButton.focus).not.toHaveBeenCalled()
  })

  it('skips targets that are gone or are the page body', async () => {
    const doc = fakeDoc()
    const stack = createDialogStack(doc)
    const detached = el(false)
    stack.push({ restoreFocus: detached })()
    stack.push({ restoreFocus: doc.body })()
    await flush()
    expect(detached.focus).not.toHaveBeenCalled()
    expect(doc.body.focus).not.toHaveBeenCalled()
  })

  it('does not pull focus out of a dialog that reopens straight away (StrictMode remount)', async () => {
    const stack = createDialogStack(fakeDoc())
    const opener = el()
    stack.push({ restoreFocus: opener })()
    stack.push({ restoreFocus: opener })
    await flush()
    expect(opener.focus).not.toHaveBeenCalled()
  })

  it('passes the closed dialog\'s target to one opened from inside it', async () => {
    // Detail modal closes as the page's request dialog opens; the Request
    // button that opened the latter went away with the detail modal
    const stack = createDialogStack(fakeDoc())
    const card = el()
    stack.push({ restoreFocus: card })()
    const popRequest = stack.push({ restoreFocus: el(false) })
    await flush()
    expect(card.focus).not.toHaveBeenCalled()
    popRequest()
    await flush()
    expect(card.focus).toHaveBeenCalledTimes(1)
  })
})

describe('dialog stack: priority', () => {
  it('keeps a higher-priority dialog on top of one opened after it', () => {
    // First-login taste quiz opens, then a deep-linked detail modal loads
    const doc = fakeDoc()
    const stack = createDialogStack(doc)
    const closeQuiz = vi.fn()
    const closeDetail = vi.fn()
    const popQuiz = stack.push({ onEscape: closeQuiz, priority: 1 })
    stack.push({ onEscape: closeDetail })

    doc.press('Escape')
    expect(closeQuiz).toHaveBeenCalledTimes(1)
    expect(closeDetail).not.toHaveBeenCalled()

    popQuiz()
    doc.press('Escape')
    expect(closeDetail).toHaveBeenCalledTimes(1)
  })

  it('does not hand a focus target to a layer that is above only by priority', async () => {
    const stack = createDialogStack(fakeDoc())
    const quizOpener = el()
    const card = el()
    const popQuiz = stack.push({ restoreFocus: quizOpener, priority: 1 })
    const popDetail = stack.push({ restoreFocus: card })
    popDetail()
    popQuiz()
    await flush()
    expect(quizOpener.focus).toHaveBeenCalledTimes(1)
    expect(card.focus).not.toHaveBeenCalled()
  })
})

describe('dialog stack: Back', () => {
  it('closes only the topmost dialog stacked over the one handling Back', () => {
    const stack = createDialogStack(fakeDoc())
    const closeDetail = vi.fn()
    const closeMovieNight = vi.fn()
    const closeRequest = vi.fn()
    const popDetail = stack.push({ onEscape: closeDetail })
    stack.push({ onEscape: closeMovieNight })
    stack.push({ onEscape: closeRequest })

    expect(stack.dismissAbove(popDetail)).toBe(true)
    expect(closeRequest).toHaveBeenCalledTimes(1)
    expect(closeMovieNight).not.toHaveBeenCalled()
    expect(closeDetail).not.toHaveBeenCalled()
  })

  it('reaches a higher-priority dialog over the detail modal (taste quiz)', () => {
    const stack = createDialogStack(fakeDoc())
    const closeQuiz = vi.fn()
    const closeDetail = vi.fn()
    stack.push({ onEscape: closeQuiz, priority: 1 })
    const popDetail = stack.push({ onEscape: closeDetail })
    expect(stack.dismissAbove(popDetail)).toBe(true)
    expect(closeQuiz).toHaveBeenCalledTimes(1)
    expect(closeDetail).not.toHaveBeenCalled()
  })

  it('lets a dialog without an Escape action absorb Back too', () => {
    const stack = createDialogStack(fakeDoc())
    const closeDetail = vi.fn()
    const popDetail = stack.push({ onEscape: closeDetail })
    stack.push({})
    expect(stack.dismissAbove(popDetail)).toBe(true)
    expect(closeDetail).not.toHaveBeenCalled()
  })

  it('reports false when the dialog is itself on top or already closed', () => {
    const stack = createDialogStack(fakeDoc())
    const popDetail = stack.push({ onEscape: vi.fn() })
    expect(stack.dismissAbove(popDetail)).toBe(false)
    popDetail()
    expect(stack.dismissAbove(popDetail)).toBe(false)
    expect(stack.dismissAbove(null)).toBe(false)
  })
})

describe('card reveal styles', () => {
  it('key the hover reveal on keyboard focus, so a card refocused after a mouse close stays collapsed', () => {
    const css = fs.readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/\.card:focus-within/)
    for (const target of ['::after', ' .card-overlay', ' .card-reasons']) {
      expect(css).toContain(`.card:is(:hover, :has(:focus-visible))${target}`)
    }
  })
})
