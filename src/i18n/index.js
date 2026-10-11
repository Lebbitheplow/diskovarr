import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Each locale is its own chunk, fetched only when that language is in use.
// Bundled eagerly, the four of them were over a third of the main bundle.
const LOCALES = {
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  pt: () => import('./locales/pt.json'),
}

// Keys are the literal English strings (gettext style): English needs no
// resource file — a missing key falls through to the key itself — and the
// locale files read as plain "English": "Translation" pairs.
export const SUPPORTED_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
]

function detectLanguage() {
  const stored = localStorage.getItem('uiLanguage')
  if (stored && SUPPORTED_LANGUAGES.some(l => l.value === stored)) return stored
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase()
  return SUPPORTED_LANGUAGES.some(l => l.value === nav) ? nav : 'en'
}

const initialLanguage = detectLanguage()

i18n.use(initReactI18next).init({
  resources: {},
  lng: initialLanguage,
  fallbackLng: 'en',
  // English strings are the keys, so '.' and ':' must not be treated as separators
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }, // React already escapes
  returnEmptyString: false,
})

async function loadLocale(lang) {
  if (!LOCALES[lang] || i18n.hasResourceBundle(lang, 'translation')) return
  const { default: strings } = await LOCALES[lang]()
  i18n.addResourceBundle(lang, 'translation', strings)
}

// Switches the live UI once the language's strings are loaded. A failed load
// still switches: missing keys fall back to English rather than nothing.
export async function changeUiLanguage(lang) {
  try { await loadLocale(lang) } catch { /* fall back to English keys */ }
  return i18n.changeLanguage(lang)
}

// main.jsx waits on this before the first render, so a non-English session
// never flashes English. Resolves at once for English.
export const i18nReady = loadLocale(initialLanguage).catch(() => {})

// Single entry point for switching language — keeps localStorage (instant on
// next boot) in sync with the live i18next instance. Server persistence is
// handled by the Settings page alongside the user's other preferences.
export function setUiLanguage(lang) {
  localStorage.setItem('uiLanguage', lang)
  return changeUiLanguage(lang)
}

export default i18n
