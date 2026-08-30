// cc-hub — notifier plugin: Telegram.
//
// Everything this file holds used to be `server/telegram.mjs`, imported
// directly by ten modules: sendMessage with parse_mode HTML, link preview off,
// a URL button "Open detail page", 429 → wait out `retry_after`, and the file
// upload that exists because Telegram truncates a message at 4096 characters
// while a report has to arrive COMPLETE.
//
// None of that is the hub's business any more. The hub composes one normalized
// message and hands it to `server/notify.mjs`; how a channel renders it — HTML
// here, a JSON body somewhere else — belongs to the channel.
//
// Import discipline (see docs/plugins.md): a built-in plugin file imports
// nothing of the hub's. The token and the chat arrive through `ctx.setting()`,
// the UI strings of the setup wizard through the `page` helper the hub hands
// `setup.render()`, and the settings keys are the historic ones — `settingKey`
// is what lets `telegram_token` and `telegram_chat` stay exactly where they
// have always been, so no installation has anything to migrate.

const TEXT_MAX = 4096
const CAPTION_MAX = 1024

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shorten(s, n) { return s.length > n ? s.slice(0, n - 2) + ' …' : s }

const token = (ctx) => String(ctx?.setting?.('token') ?? '').trim()
const chatId = (ctx) => String(ctx?.setting?.('chat') ?? '').trim()

/**
 * One Bot API call. Returns `{ ok, status?, reason? }` and never throws — the
 * facade above turns a falsy `ok` into one logged line, and a channel having a
 * bad day must not become the caller's problem.
 *
 * A 429 is waited out up to three times: Telegram says how long in
 * `parameters.retry_after`, and honouring it is the difference between a
 * delayed message and a dropped one.
 */
async function api(ctx, method, body, { timeoutMs = 15_000 } = {}) {
  const tok = token(ctx)
  if (!tok) return { ok: false, reason: 'no token', errorKey: 'tg.err_no_token' }
  const base = ctx?.env?.CCHUB_TELEGRAM_BASE ?? 'https://api.telegram.org'
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const isForm = body instanceof FormData
      const res = await fetch(`${base}/bot${tok}/${method}`, {
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
      return { ok: res.ok, status: res.status, reason: res.ok ? null : `HTTP ${res.status}`, errorKey: null }
    } catch {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  return { ok: false, reason: 'unreachable', errorKey: 'tg.err_unreachable' }
}

/** The message itself. `url` becomes the inline "Open detail page" button. */
async function sendText(ctx, text, url, buttonLabel) {
  const chat = chatId(ctx)
  if (!chat) return { ok: false, reason: 'no chat', errorKey: 'tg.err_no_chat' }
  const body = {
    chat_id: chat,
    text: shorten(escapeHtml(text), TEXT_MAX),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }
  if (url) body.reply_markup = { inline_keyboard: [[{ text: buttonLabel, url }]] }
  return api(ctx, 'sendMessage', body)
}

/**
 * The attachment. A report longer than one message is the whole reason this
 * exists: the short version arrives as text, the complete one as a file.
 */
async function sendDocument(ctx, fileName, content, url, buttonLabel) {
  const chat = chatId(ctx)
  if (!chat) return { ok: false, reason: 'no chat', errorKey: 'tg.err_no_chat' }
  const form = new FormData()
  form.set('chat_id', chat)
  if (url) form.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: buttonLabel, url }]] }))
  form.set('document', new Blob([String(content ?? '')], { type: 'text/markdown' }), fileName)
  return api(ctx, 'sendDocument', form, { timeoutMs: 30_000 })
}

/**
 * The setup wizard, unchanged in what it walks the operator through: the
 * BotFather token, the chat id out of `getUpdates`, a test message. It lives
 * here rather than in `pages.mjs` because it is knowledge about Telegram and
 * about nothing else — `page.t` and `page.e` are what keep it translated and
 * escaped without this file importing `i18n.mjs`.
 */
const setup = {
  labelKey: 'notify.setup_open',

  async render(ctx, page) {
    const { t, e, base } = page
    const tokenSet = !!token(ctx)
    const chat = chatId(ctx)

    const step1 = `
  <div class="card ${tokenSet ? 'ok' : ''}">
    <h3>${e(t('tg.step1'))}</h3>
    <p class="dim">${e(t('tg.step1_hint'))}</p>
    <form method="post" action="${e(base)}/token" class="inline">
      <input name="telegram_token" type="password" placeholder="${e(t('tg.token_ph'))}" size="50" required>
      <button>${e(t('tg.token_save'))}</button>
    </form>
    ${tokenSet ? `<p class="ok">✓ ${e(t('tg.token_saved'))}</p>` : ''}
  </div>`

    const step2 = `
  <div class="card ${chat ? 'ok' : ''}">
    <h3>${e(t('tg.step2'))}</h3>
    <p class="dim">${e(t('tg.step2_hint'))}</p>
    <button id="tg-fetch">${e(t('tg.fetch'))}</button>
    <div id="tg-chats"></div>
    ${chat ? `<p class="ok">✓ ${e(t('tg.chat_saved'))}: <code>${e(chat)}</code></p>` : ''}
  </div>`

    const step3 = `
  <div class="card">
    <h3>${e(t('tg.step3'))}</h3>
    <form method="post" action="${e(base)}/test"><button>${e(t('tg.send_test'))}</button></form>
    <p class="dim">${e(t('tg.step3_hint'))}</p>
  </div>`

    return `${step1}${step2}${step3}
  <script>
  document.getElementById('tg-fetch')?.addEventListener('click', async () => {
    const box = document.getElementById('tg-chats')
    box.textContent = '…'
    try {
      const r = await fetch('${e(base)}/json/chats')
      const j = await r.json()
      if (!j.ok) { box.innerHTML = '<p class="err">' + j.error + '</p>'; return }
      if (!j.chats.length) { box.innerHTML = '<p class="warn">${e(t('tg.no_chats'))}</p>'; return }
      box.innerHTML = j.chats.map(c =>
        '<form method="post" action="${e(base)}/chat"><input type="hidden" name="chat_id" value="' + c.id + '">' +
        '<button>${e(t('tg.use'))}: ' + c.label + ' (ID ' + c.id + ')</button></form>').join('')
    } catch (e2) { box.textContent = String(e2) }
  })
  </script>`
  },

  // POST <base>/<name>. `{ error }` is a translated sentence the hub renders as
  // a problem page; anything else redirects back to the wizard.
  actions: {
    async token(ctx, page, body) {
      const value = String(body?.telegram_token ?? '').trim()
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(value)) return { error: page.t('tg.token_invalid') }
      ctx.setSetting('token', value)
      return { ok: true }
    },
    async chat(ctx, page, body) {
      const value = String(body?.chat_id ?? '').trim()
      if (!/^-?\d+$/.test(value)) return { error: page.t('tg.chat_invalid') }
      ctx.setSetting('chat', value)
      return { ok: true }
    },
  },

  // GET <base>/json/<name>. Read `getUpdates` and name the chats the bot has
  // heard from, deduplicated — the operator picks one instead of hunting for a
  // number.
  json: {
    async chats(ctx, page) {
      const tok = token(ctx)
      if (!tok) return { status: 400, body: { ok: false, error: page.t('tg.no_token') } }
      const bs = ctx?.env?.CCHUB_TELEGRAM_BASE ?? 'https://api.telegram.org'
      try {
        const res = await fetch(`${bs}/bot${tok}/getUpdates?limit=100`, { signal: AbortSignal.timeout(15_000) })
        const j = await res.json()
        if (!j.ok) {
          return { body: { ok: false, error: page.t('tg.api_error', { msg: j.description ?? page.t('tg.unknown_error') }) } }
        }
        const byId = new Map()
        for (const u of j.result ?? []) {
          for (const key of ['message', 'edited_message', 'channel_post', 'my_chat_member']) {
            const c = u[key]?.chat
            if (!c) continue
            const text = u[key]?.text || u[key]?.caption || ''
            const label = [c.first_name, c.last_name, c.title, c.username && '@' + c.username].filter(Boolean).join(' ')
            const prev = byId.get(c.id)
            if (!prev) byId.set(c.id, { id: c.id, label: label || page.t('tg.chat_fallback', { id: c.id }), last_text: text })
            else if (text) prev.last_text = text
          }
        }
        return { body: { ok: true, chats: [...byId.values()] } }
      } catch (err) {
        return { body: { ok: false, error: page.t('tg.unreachable', { err: err.message }) } }
      }
    },
  },
}

const plugin = {
  id: 'telegram',
  kind: 'notifier',
  label: 'Telegram',
  descriptionKey: 'notify.telegram_description',

  /**
   * Both fields keep the settings keys they have always had. That is the whole
   * point of `settingKey`, and it is why this rebuild needed no settings
   * migration: an installation that upgrades finds its token exactly where it
   * left it, and `bin/cc-notify` reads the same row.
   *
   * `required: true` is what `notifierConfigured()` reads — a Telegram without
   * a token or without a chat is not a channel, it is a blank form, and the
   * hub has to be able to tell the two apart to stay silent.
   */
  settings: [
    { key: 'token', settingKey: 'telegram_token', type: 'password', required: true, labelKey: 'settings.telegram_token' },
    { key: 'chat', settingKey: 'telegram_chat', type: 'text', required: true, labelKey: 'settings.telegram_chat' },
  ],

  setup,

  /**
   * Send one normalized message (see docs/plugins.md, "Notifier plugin
   * contract"). Returns `{ ok, error? }` and never throws.
   *
   * The attachment goes out as a SECOND call and only when the text really
   * does not fit or the file is substantial — the old `notifyLong()` rule,
   * unchanged: a truncated report is not a report, and a file for three lines
   * is noise.
   */
  async send(message, ctx) {
    const text = String(message?.text ?? '')
    // The button needs BOTH a link and a caption — Telegram rejects an empty
    // one. The caption is the facade's translated `linkLabel`; there is
    // deliberately no English literal here to fall back on, because a UI string
    // in a plugin file is a UI string nobody can translate.
    const url = message?.linkLabel ? (message?.url ?? null) : null
    const first = await sendText(ctx, text, url, message?.linkLabel)
    if (!first.ok) {
      return { ok: false, error: first.reason ?? 'send failed', errorKey: first.errorKey ?? 'tg.err_send_failed' }
    }

    const file = message?.attachment
    const content = String(file?.content ?? '')
    if (content && (escapeHtml(text).length > TEXT_MAX || content.length > 3000)) {
      // Best effort: the short version has arrived, and failing the whole
      // message over the appendix would lose the part that did get through.
      await sendDocument(ctx, file.fileName || 'report.md', content, url, message?.linkLabel)
    }
    return { ok: true }
  },

  /**
   * "Send test message" on the Notifications page. Same signature as `send` —
   * `(message, ctx)` — because the facade calls whichever of the two exists
   * with the same two arguments, and a declaration that reversed them would
   * hand the message to the context parameter without anything noticing.
   */
  async test(message, ctx) {
    return plugin.send(message, ctx)
  },
}

// Telegram's caption limit is documented here rather than in a comment nobody
// finds: a caption is not used at all today (the file travels with the text
// message that precedes it), and the constant states the ceiling in case it is.
export const TELEGRAM_LIMITS = { TEXT_MAX, CAPTION_MAX }

export default plugin
