// cc-hub — Telegram-Sender (Planung 7.6): sendMessage mit parse_mode HTML,
// Link-Preview aus, URL-Button „Zur Detailseite", 429 → retry_after abwarten.
// Lange Inhalte (Reports) gehen zusätzlich als Datei: Telegram kappt Nachrichten
// bei 4096 Zeichen, ein Report soll aber VOLLSTÄNDIG ankommen.
import { getSetting } from './db.mjs'

const TEXT_MAX = 4096

function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

/** Öffentliche Basis-URL für Buttons: Hostname statt IP, damit der Link im Browser zum Zertifikat passt. */
export function publicBase() {
  // Ohne CCHUB_PUBLIC_URL zeigen die Buttons ins Leere — der Hinweis steht in env.example.
  return (process.env.CCHUB_PUBLIC_URL
    || `https://127.0.0.1:${process.env.CCHUB_VPN_PORT ?? 8790}`).replace(/\/+$/, '')
}
export function detailUrl(runId) {
  return runId ? `${publicBase()}/runs/${runId}` : `${publicBase()}/`
}

async function api(method, body, { timeoutMs = 15_000 } = {}) {
  const token = getSetting('telegram_token')
  if (!token) return { ok: false, grund: 'kein Token' }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const isForm = body instanceof FormData
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}))
        await new Promise(r => setTimeout(r, Math.min((j?.parameters?.retry_after ?? 3), 30) * 1000))
        continue
      }
      return { ok: res.ok, status: res.status }
    } catch (e) {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  return { ok: false, grund: 'nicht erreichbar' }
}

export async function notify(text, url = null) {
  const chat = getSetting('telegram_chat')
  if (!getSetting('telegram_token') || !chat) return false
  const body = {
    chat_id: chat,
    text: kuerzen(escapeHtml(text), TEXT_MAX),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }
  if (url) body.reply_markup = { inline_keyboard: [[{ text: 'Zur Detailseite', url }]] }
  return (await api('sendMessage', body)).ok
}

/**
 * Datei mitschicken (Report, Hilferuf-Volltext). 'caption' ≤ 1024 Zeichen laut Telegram.
 * Liefert false, wenn Token/Chat fehlen oder Telegram nicht erreichbar ist — der
 * Aufrufer hat die Kurzfassung dann schon per notify() verschickt.
 */
export async function notifyDocument(fileName, content, caption = '', url = null) {
  const chat = getSetting('telegram_chat')
  if (!getSetting('telegram_token') || !chat) return false
  const form = new FormData()
  form.set('chat_id', chat)
  if (caption) { form.set('caption', kuerzen(escapeHtml(caption), 1024)); form.set('parse_mode', 'HTML') }
  if (url) form.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: 'Zur Detailseite', url }]] }))
  form.set('document', new Blob([String(content ?? '')], { type: 'text/markdown' }), fileName)
  return (await api('sendDocument', form, { timeoutMs: 30_000 })).ok
}

/**
 * Text + ggf. Datei: passt der ganze Text in eine Nachricht, nur die Nachricht.
 * Sonst die Nachricht mit dem Anfang und dazu die vollständige Datei.
 */
export async function notifyLong(text, { fileName = 'report.md', fileContent = null, url = null } = {}) {
  const ok = await notify(text, url)
  if (!ok) return false
  const voll = fileContent ?? ''
  if (voll && (escapeHtml(text).length > TEXT_MAX || voll.length > 3000)) {
    await notifyDocument(fileName, voll, '', url)
  }
  return ok
}

function kuerzen(s, n) { return s.length > n ? s.slice(0, n - 2) + ' …' : s }

/** Testnachricht aus den Einstellungen. */
export async function sendTest() {
  return notify('cc-hub: Testnachricht. Der Kanal steht.', detailUrl(null))
}
