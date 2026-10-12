import React from 'react'
import { useTranslation } from 'react-i18next'
import useModalOpen from '../hooks/useModalOpen'
import useDialogLayer from '../hooks/useDialogLayer'

export default function Modal({ isOpen, onClose, children }) {
  useModalOpen(isOpen)
  // Escape closes only the topmost dialog, so one opened from the detail
  // modal (request, movie night, watch together) doesn't take it down too.
  useDialogLayer(isOpen, onClose)
  const { t } = useTranslation()

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
