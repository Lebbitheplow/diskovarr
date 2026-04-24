import React from 'react'

export default function ToggleSwitch({
  checked, onChange, label, disabled = false, className = ''
}) {
  return (
    <label className={`toggle-label ${className}`}>
      <input
        type="checkbox"
        className="toggle-checkbox"
        checked={checked}
        onChange={(e) => onChange?.(e.target.checked)}
        disabled={disabled}
      />
      <span className="toggle-switch" />
      {label && <span className="toggle-text">{label}</span>}
    </label>
  )
}
