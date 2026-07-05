import React from 'react'
import { posterSrc } from './format'

// Tiny building blocks shared by the Wrapped slides (components only here;
// formatting helpers live in format.js).

export function Avatar({ thumb, name, size = 36 }) {
  const src = posterSrc(thumb)
  return src ? (
    <img src={src} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }} />
  ) : (
    <span className="wrapped-avatar-initial" style={{ width: size, height: size, fontSize: size * 0.44 }}>
      {(name || '?')[0].toUpperCase()}
    </span>
  )
}
