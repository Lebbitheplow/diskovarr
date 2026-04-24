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
    fetch('/theme.css')
      .then(r => r.text())
      .then(css => {
        const match = css.match(/--accent:\s*([^;}\s]+)/)
        const color = match ? match[1] : '#e5a00d'
        setThemeColor(color)
        applyTheme(color)
      })
      .catch(() => {
        applyTheme('#e5a00d')
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

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
