import React, { createContext, useContext, useState, useCallback, useLayoutEffect, useRef } from 'react'

const ToastContext = createContext(null)

// Length of the exit animation (index.css .toast-leaving). A dismissed toast
// stays mounted this long, so it fades out rather than vanishing.
const EXIT_MS = 200
const REDUCED = '(prefers-reduced-motion: reduce)'
// The stack's glide when a toast arrives or goes (--ease-out)
const SHIFT_MS = 220
const SHIFT_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const stackRef = useRef(null)
  // Each toast's layout top after the last render
  const lastTops = useRef(new WeakMap())

  // The stack is anchored at the bottom, so a new toast pushes the ones above
  // it up a slot and a removed one lets them drop. A toast that moved glides
  // from where it was rather than jumping in one frame. The glide is added on
  // top of its own entrance or exit (composite: add) rather than replacing it,
  // and a second shift mid-glide stacks onto the first without a jump.
  useLayoutEffect(() => {
    const stack = stackRef.current
    if (!stack) return
    const glide = !window.matchMedia(REDUCED).matches
    const stackTop = stack.getBoundingClientRect().top
    const tops = new WeakMap()
    for (const el of stack.children) {
      const top = stackTop + el.offsetTop
      const was = lastTops.current.get(el)
      tops.set(el, top)
      if (!glide || was == null || Math.abs(was - top) < 1) continue
      el.animate(
        [{ transform: `translateY(${was - top}px)` }, { transform: 'none' }],
        { duration: SHIFT_MS, easing: SHIFT_EASE, composite: 'add' },
      )
    }
    lastTops.current = tops
  }, [toasts])

  const removeToast = useCallback((id) => {
    const drop = () => setToasts(prev => prev.filter(t => t.id !== id))
    // Nothing to play under reduced motion, so nothing to wait for
    if (window.matchMedia(REDUCED).matches) {
      drop()
      return
    }
    setToasts(prev => prev.map(t => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(drop, EXIT_MS)
  }, [])

  const addToast = useCallback((message, type = 'info', duration = 4000, action = null) => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, type, action }])
    setTimeout(() => removeToast(id), duration)
  }, [removeToast])

  const success = useCallback((msg) => addToast(msg, 'success'), [addToast])
  const error = useCallback((msg) => addToast(msg, 'error'), [addToast])
  const info = useCallback((msg) => addToast(msg, 'info'), [addToast])

  // Toast carrying a single action, used to make destructive-feeling actions
  // recoverable without a blocking confirm dialog. Held longer than a plain
  // toast because it has to be read and acted on.
  const withAction = useCallback(
    (msg, label, onAction, type = 'success') => addToast(msg, type, 9000, { label, onAction }),
    [addToast],
  )

  return (
    <ToastContext.Provider value={{ success, error, info, withAction, toasts, removeToast }}>
      {children}
      <div className="toast-container" ref={stackRef}>
        {toasts.map(t => (
          <div
            key={t.id}
            className={`toast toast-${t.type} toast-show${t.action ? ' toast-has-action' : ''}${t.leaving ? ' toast-leaving' : ''}`}
            onClick={() => removeToast(t.id)}
            style={{ cursor: 'pointer' }}
          >
            <span className="toast-message">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={(e) => {
                  // The toast body dismisses on click; don't let that swallow
                  // the action or fire it twice.
                  e.stopPropagation()
                  removeToast(t.id)
                  t.action.onAction()
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
