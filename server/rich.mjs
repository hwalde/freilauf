// Freilauf — structured message bodies: the small markup the hub's own LLM
// texts are written in, and the three renderings a channel can pick from.
//
// Pure and import-free on purpose: the notifier plugins get these functions
// through their context (`ctx.rich`, plugins/context.mjs) and must never import
// a hub module themselves, and the tests read them without a database.
//
// The markup is deliberately tiny, because a model writes it and a channel
// renders it: blank line between paragraphs, "- " for a list line, **bold**,
// and `[[ref|words]]` for a link to something the HUB named. A ref the hub did
// not hand out becomes plain words — the model cannot invent a URL, which is
// the one property that matters here.
//
// A rich message:
//   { title?: string, blocks: Block[], buttons?: [{label, url}] }
//   Block = { type: 'paragraph', lines: Span[][] } | { type: 'list', items: Span[][] }
//   Span  = { text, bold?: true, url?: string }

const REF = /\[\[([A-Za-z0-9_-]{1,32})\|([^\]\n]{1,200})\]\]/g

/** `**bold**` and refs inside one line → spans. */
export function parseLine(line, refs = {}) {
  const spans = []
  const pushText = (text, bold = false) => {
    if (!text) return
    // **bold** runs inside a plain stretch; an unclosed ** stays literal.
    const parts = text.split(/\*\*([^*\n]+)\*\*/g)
    parts.forEach((p, i) => {
      if (!p) return
      const odd = i % 2 === 1
      spans.push(odd || bold ? { text: p, bold: true } : { text: p })
    })
  }
  let last = 0
  for (const m of String(line).matchAll(REF)) {
    pushText(line.slice(last, m.index))
    const target = refs[m[1]]
    const url = typeof target === 'string' ? target : target?.url
    const label = m[2].trim()
    spans.push(url ? { text: label, url } : { text: label })
    last = m.index + m[0].length
  }
  pushText(line.slice(last))
  return spans
}

/**
 * The markup → blocks. `refs` maps a ref (`r1`, `a3`) to its URL (or to an
 * object with `url`); anything the map does not know is rendered as its words.
 */
export function parseMarkup(text, refs = {}) {
  const blocks = []
  const paragraphs = String(text ?? '').replace(/\r/g, '').split(/\n\s*\n/)
  for (const para of paragraphs) {
    const lines = para.split('\n').map(l => l.trimEnd()).filter(l => l.trim())
    let cur = null
    for (const line of lines) {
      const item = /^\s*[-*•]\s+(.*)$/.exec(line)
      if (item) {
        if (!cur || cur.type !== 'list') { cur = { type: 'list', items: [] }; blocks.push(cur) }
        cur.items.push(parseLine(item[1], refs))
      } else {
        if (!cur || cur.type !== 'paragraph') { cur = { type: 'paragraph', lines: [] }; blocks.push(cur) }
        cur.lines.push(parseLine(line.trim(), refs))
      }
    }
  }
  return blocks
}

/** A plain text as one paragraph per line — for a message that has no markup. */
export function richFromText(text, { title = null, buttons = [] } = {}) {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  return { title, blocks: lines.length ? [{ type: 'paragraph', lines: lines.map(l => [{ text: l }]) }] : [], buttons }
}

// ------------------------------------------------------------------ renderers

function spansPlain(spans) {
  return spans.map(s => (s.url ? `${s.text} (${s.url})` : s.text)).join('')
}

/** Plain text: what every channel can show, and what `message.text` carries. */
export function toPlain(rich) {
  if (!rich) return ''
  const out = []
  if (rich.title) out.push(rich.title)
  for (const b of rich.blocks ?? []) {
    if (b.type === 'list') out.push(b.items.map(it => `• ${spansPlain(it)}`).join('\n'))
    else out.push((b.lines ?? []).map(spansPlain).join('\n'))
  }
  const text = out.join('\n\n')
  const buttons = (rich.buttons ?? []).filter(x => x?.url).map(x => `${x.label}: ${x.url}`)
  return buttons.length ? `${text}\n\n${buttons.join('\n')}` : text
}

const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;')

function spansHtml(spans) {
  return spans.map(s => {
    let h = escHtml(s.text)
    if (s.bold) h = `<b>${h}</b>`
    if (s.url) h = `<a href="${escAttr(s.url)}">${h}</a>`
    return h
  }).join('')
}

/**
 * HTML in the subset Telegram accepts (`<b>`, `<a href>`, newlines — no `<p>`,
 * no `<ul>`). Shortened BLOCK BY BLOCK when `maxLength` is given: cutting the
 * finished HTML could split a tag, and Telegram rejects the whole message for
 * that. Buttons are not part of the body; a channel renders them its own way.
 */
export function toHtml(rich, { maxLength = Infinity } = {}) {
  if (!rich) return ''
  const parts = []
  if (rich.title) parts.push(`<b>${escHtml(rich.title)}</b>`)
  for (const b of rich.blocks ?? []) {
    if (b.type === 'list') parts.push(b.items.map(it => `• ${spansHtml(it)}`).join('\n'))
    else parts.push((b.lines ?? []).map(spansHtml).join('\n'))
  }
  let out = ''
  for (const p of parts) {
    const next = out ? `${out}\n\n${p}` : p
    // Room for the "\n\n…" that says something was left out.
    if (next.length > maxLength - 3) return out ? `${out}\n\n…` : '…'
    out = next
  }
  return out
}

function spansMarkdown(spans) {
  return spans.map(s => {
    let m = String(s.text).replace(/([\\`*_[\]])/g, '\\$1')
    if (s.bold) m = `**${m}**`
    if (s.url) m = `[${m}](${s.url})`
    return m
  }).join('')
}

/** Markdown (Slack-free dialect: Discord, ntfy, Matrix, a webhook body). */
export function toMarkdown(rich) {
  if (!rich) return ''
  const parts = []
  if (rich.title) parts.push(`**${String(rich.title).replace(/([\\`*_[\]])/g, '\\$1')}**`)
  for (const b of rich.blocks ?? []) {
    if (b.type === 'list') parts.push(b.items.map(it => `- ${spansMarkdown(it)}`).join('\n'))
    else parts.push((b.lines ?? []).map(spansMarkdown).join('  \n'))
  }
  const buttons = (rich.buttons ?? []).filter(x => x?.url).map(x => `[${x.label}](${x.url})`)
  if (buttons.length) parts.push(buttons.join(' · '))
  return parts.join('\n\n')
}

/** The helpers as one object — what a plugin finds under `ctx.rich`. */
export const richHelpers = Object.freeze({ toPlain, toHtml, toMarkdown })
