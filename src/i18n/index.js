import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import es from './locales/es.json'
import fr from './locales/fr.json'
import de from './locales/de.json'
import pt from './locales/pt.json'

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

i18n.use(initReactI18next).init({
  resources: {
    es: { translation: es },
    fr: { translation: fr },
    de: { translation: de },
    pt: { translation: pt },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  // English strings are the keys, so '.' and ':' must not be treated as separators
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }, // React already escapes
  returnEmptyString: false,
})

// Single entry point for switching language — keeps localStorage (instant on
// next boot) in sync with the live i18next instance. Server persistence is
// handled by the Settings page alongside the user's other preferences.
export function setUiLanguage(lang) {
  localStorage.setItem('uiLanguage', lang)
  i18n.changeLanguage(lang)
}

export default i18n
