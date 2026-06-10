import React from 'react'

const REPO_URL = 'https://github.com/Lebbitheplow/diskovarr'
const SITE_URL = 'https://diskovarr.com'
const VERSION = import.meta.env.VITE_APP_VERSION || '2.2.1'
const YEAR = new Date().getFullYear()

// Diskovarr brand mark — mirrors the logo used in the navigation bar.
function DiskovarrLogo() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.5" fill="currentColor" />
      <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="currentColor" />
      <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="currentColor" />
      <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="currentColor" />
      <circle cx="15" cy="9" r="5" stroke="currentColor" strokeWidth="2" />
      <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

export default function Footer() {
  return (
    <footer className="app-footer">
      <div className="app-footer-inner">
        <a
          className="app-footer-brand"
          href={SITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Diskovarr"
        >
          <DiskovarrLogo />
          <span>Diskovarr</span>
        </a>
        <span className="app-footer-sep" aria-hidden="true">·</span>
        <a
          className="app-footer-gh"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Diskovarr on GitHub"
        >
          <GitHubIcon />
          <span>GitHub</span>
        </a>
        <span className="app-footer-sep" aria-hidden="true">·</span>
        <a href={`${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer">v{VERSION}</a>
        <span className="app-footer-sep" aria-hidden="true">·</span>
        <span>Made with <span className="app-footer-heart">♥</span> for Plex</span>
        <p className="app-footer-fineprint">
          © {YEAR} Diskovarr · This product uses the TMDB API but is not endorsed or certified by{' '}
          <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">TMDB</a>.
          {' '}Not affiliated with Plex, Inc.
        </p>
      </div>
    </footer>
  )
}
