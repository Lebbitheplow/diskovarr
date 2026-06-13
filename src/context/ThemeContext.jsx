import React, { createContext, useContext, useEffect, useState } from 'react'

const ThemeContext = createContext(null)

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

function applyTheme(color) {
  document.documentElement.style.setProperty('--accent', color)
  const { r, g, b } = hexToRgb(color)
  document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`)
  document.documentElement.style.setProperty('--accent-dim', `rgba(${r}, ${g}, ${b}, 0.15)`)
  document.documentElement.style.setProperty('--accent-dim2', `rgba(${r}, ${g}, ${b}, 0.20)`)
  document.documentElement.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.08)`)
  document.documentElement.style.setProperty('--accent-border', `rgba(${r}, ${g}, ${b}, 0.4)`)
  document.documentElement.style.setProperty('--accent-shadow', `rgba(${r}, ${g}, ${b}, 0.4)`)
  // Lighten by 15% for the hover shade — must match the server's /theme.css,
  // otherwise hover states keep the stale default accent.
  const hex2 = (n) => Math.min(255, Math.round(n + (255 - n) * 0.15)).toString(16).padStart(2, '0')
  document.documentElement.style.setProperty('--accent-hover', `#${hex2(r)}${hex2(g)}${hex2(b)}`)

  // Cache for the pre-paint inline-style script in index.html, so a full page
  // load (e.g. returning from /admin) shows the saved accent with no flash.
  try { localStorage.setItem('dk-accent', color) } catch { /* ignore */ }

  let styleEl = document.getElementById('diskovarr-bg-gradient')
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'diskovarr-bg-gradient'
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = `body{background-image:radial-gradient(ellipse 50% 50% at 50% 0%,rgba(${r},${g},${b},0.28) 0%,transparent 100%),radial-gradient(ellipse 60% 40% at 50% 100%,rgba(${r},${g},${b},0.12) 0%,transparent 100%);background-attachment:fixed;}`
}

export function ThemeProvider({ children }) {
  const [themeColor, setThemeColor] = useState('#e5a00d')

  useEffect(() => {
    // Cache-bust + no-store: a proxy or browser cache must not serve a stale
    // accent right after it's changed in admin (e.g. still green after pink).
    fetch(`/theme.css?ts=${Date.now()}`, { cache: 'no-store' })
      .then(r => r.text())
      .then(css => {
        const match = css.match(/--accent:\s*([^;}\s]+)/)
        if (!match) return // leave the color the inline pre-paint script applied
        setThemeColor(match[1])
        applyTheme(match[1])
      })
      .catch(() => {
        // Network error — keep whatever the inline script already applied
        // rather than clobbering it back to the default accent.
      })
  }, [])

  const updateTheme = (color) => {
    setThemeColor(color)
    applyTheme(color)
  }

  return (
    <ThemeContext.Provider value={{ themeColor, setThemeColor: updateTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
