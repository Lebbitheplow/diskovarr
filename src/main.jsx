import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { ToastProvider } from './context/ToastContext'
import App from './App'
import { i18nReady } from './i18n'
// Registers the beforeinstallprompt listener before React mounts (see utils/pwaInstall)
import './utils/pwaInstall'
import './index.css'

const root = ReactDOM.createRoot(document.getElementById('root'))

i18nReady.then(() => root.render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
))
