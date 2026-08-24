// cc-hub — UI internationalization.
//
// The web UI is multilingual: English is the default, German and Chinese are
// selectable in the settings. All UI strings live in lang/<code>.json (flat
// key → string maps); this module loads them once and resolves keys with
// {placeholder} interpolation. A missing key falls back to English, and an
// unknown key returns the key itself — a page must never crash over a string.
//
// The language files are part of the project and MUST be maintained together:
// every key added to lang/en.json needs a translation in lang/de.json and
// lang/zh.json (a unit test enforces identical key sets).
//
// This module deliberately does not import db.mjs: the active language is
// injected from outside (hub.mjs at startup, settings save at runtime), which
// keeps i18n trivially unit-testable.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LANG_DIR = process.env.CCHUB_LANG_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'lang')

export const LANGUAGES = { en: 'English', de: 'Deutsch', zh: '中文' }
export const DEFAULT_LANGUAGE = 'en'

const catalogs = {}
for (const code of Object.keys(LANGUAGES)) {
  try {
    catalogs[code] = JSON.parse(readFileSync(join(LANG_DIR, `${code}.json`), 'utf8'))
  } catch {
    catalogs[code] = {}   // a broken/missing catalog falls back to English
  }
}

let current = DEFAULT_LANGUAGE

export function setLanguage(code) {
  current = LANGUAGES[code] ? code : DEFAULT_LANGUAGE
}
export function currentLanguage() { return current }

/** Translate a key with {name} interpolation; falls back en → key. */
export function t(key, params = {}) {
  const raw = catalogs[current]?.[key] ?? catalogs[DEFAULT_LANGUAGE]?.[key] ?? key
  return String(raw).replace(/\{(\w+)\}/g, (_, k) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`)
}

/** Full catalog of the active language (with English fallback merged in) — for client-side JS. */
export function clientCatalog(prefix = 'js.') {
  const merged = { ...catalogs[DEFAULT_LANGUAGE], ...catalogs[current] }
  const out = {}
  for (const [k, v] of Object.entries(merged)) if (k.startsWith(prefix)) out[k] = v
  return out
}

/** Test hook: raw catalogs, e.g. to compare key sets across languages. */
export function _catalogs() { return catalogs }
