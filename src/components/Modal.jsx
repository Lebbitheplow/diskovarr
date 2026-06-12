import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

export default function Modal({ isOpen, onClose, children }) {
  const { t } = useTranslation()
  useEffect(() => {
    if (!isOpen) return
    const handleEsc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="modal-backdrop open" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label={t('Close')}>✕</button>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
