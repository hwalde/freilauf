// cc-hub — Telegram sender (planning 7.6): sendMessage with parse_mode HTML,
// link preview off, URL button "Open detail page", 429 → wait out retry_after.
// Long content (reports) is additionally sent as a file: Telegram truncates messages
// at 4096 characters, but a report must arrive COMPLETE.
import { getSetting } from './db.mjs'

const TEXT_MAX = 4096

function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

/** Public base URL for buttons: hostname instead of IP, so the link matches the certificate in the browser. */
export function publicBase() {
  // Without CCHUB_PUBLIC_URL the buttons point nowhere — the note is in env.example.
  return (process.env.CCHUB_PUBLIC_URL
    || `https://127.0.0.1:${process.env.CCHUB_VPN_PORT ?? 8790}`).replace(/\/+$/, '')
}
export function detailUrl(runId) {
  return runId ? `${publicBase()}/runs/${runId}` : `${publicBase()}/`
}

async function api(method, body, { timeoutMs = 15_000 } = {}) {
  const token = getSetting('telegram_token')
  if (!token) return { ok: false, grund: 'no token' }
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
  return { ok: false, grund: 'unreachable' }
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
  if (url) body.reply_markup = { inline_keyboard: [[{ text: 'Open detail page', url }]] }
  return (await api('sendMessage', body)).ok
}

/**
 * Send a file along (report, help-request full text). 'caption' ≤ 1024 characters per Telegram.
 * Returns false when token/chat are missing or Telegram is unreachable — the
 * caller has already sent the short version via notify() in that case.
 */
export async function notifyDocument(fileName, content, caption = '', url = null) {
  const chat = getSetting('telegram_chat')
  if (!getSetting('telegram_token') || !chat) return false
  const form = new FormData()
  form.set('chat_id', chat)
  if (caption) { form.set('caption', kuerzen(escapeHtml(caption), 1024)); form.set('parse_mode', 'HTML') }
  if (url) form.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: 'Open detail page', url }]] }))
  form.set('document', new Blob([String(content ?? '')], { type: 'text/markdown' }), fileName)
  return (await api('sendDocument', form, { timeoutMs: 30_000 })).ok
}

/**
 * Text + file if needed: if the whole text fits into one message, just the message.
 * Otherwise the message with the beginning plus the complete file.
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

/** Test message from the settings page. */
export async function sendTest() {
  return notify('cc-hub: test message. The channel works.', detailUrl(null))
}
