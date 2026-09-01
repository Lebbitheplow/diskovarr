import React, { createContext, useContext, useState, useCallback } from 'react'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const addToast = useCallback((message, type = 'info', duration = 4000, action = null) => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, type, action }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, duration)
  }, [])

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

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ success, error, info, withAction, toasts, removeToast }}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`toast toast-${t.type} toast-show${t.action ? ' toast-has-action' : ''}`}
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
