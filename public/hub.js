// cc-hub — small vanilla JS: repo switcher, terminal client (xterm.js), form helpers.
// UI strings come from window.CCHUB_I18N (injected by the layout); English
// fallbacks are inlined so the file also works standalone.
(function () {
  'use strict'

  var I18N = window.CCHUB_I18N || {}
  function T(key, fallback, params) {
    var raw = I18N[key] || fallback
    return String(raw).replace(/\{(\w+)\}/g, function (_, k) {
      return params && params[k] !== undefined ? String(params[k]) : '{' + k + '}'
    })
  }

  // ---- relative timestamps (overview): live "n seconds ago", exact time on hover ----
  // Unit ladder must stay in sync with fmtRelativeTime in server/util.mjs.
  function relTimeText(ms, now) {
    var lang = document.documentElement.lang || 'en'
    var sec = Math.max(0, Math.floor((now - ms) / 1000))
    var rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
    if (sec < 60) return rtf.format(-sec, 'second')
    var min = Math.floor(sec / 60)
    if (min < 60) return rtf.format(-min, 'minute')
    var hr = Math.floor(min / 60)
    if (hr < 24) return rtf.format(-hr, 'hour')
    var day = Math.floor(hr / 24)
    if (day < 30) return rtf.format(-day, 'day')
    var month = Math.floor(day / 30)
    if (month < 12) return rtf.format(-month, 'month')
    return rtf.format(-Math.floor(day / 365), 'year')
  }
  function refreshRelTimes() {
    var now = Date.now()
    var lang = document.documentElement.lang || 'en'
    document.querySelectorAll('time.reltime[datetime]').forEach(function (el) {
      var ms = Date.parse(el.getAttribute('datetime'))
      if (!Number.isFinite(ms)) return
      el.textContent = relTimeText(ms, now)
      el.title = new Date(ms).toLocaleString(lang, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      })
    })
  }
  if (document.querySelector('time.reltime')) {
    refreshRelTimes()
    setInterval(refreshRelTimes, 1000)
  }

  // ---- repo switcher in the header: append ?repo=… to the current page ----
  const repoSwitch = document.getElementById('repo-switch')
  if (repoSwitch) {
    repoSwitch.addEventListener('change', () => {
      const u = new URL(location.href)
      u.searchParams.set('repo', repoSwitch.value)
      location.href = u.pathname + u.search
    })
  }

  // ---- schedule selection: only show the block of the chosen kind ----
  const kindSel = document.getElementById('schedule-kind')
  if (kindSel) {
    const bloecke = Array.from(document.querySelectorAll('.zp'))
    const sync = () => bloecke.forEach(b => { b.hidden = b.dataset.kind !== kindSel.value })
    kindSel.addEventListener('change', sync)
    sync()
    // Only show the anchor week when the interval needs it at all.
    const takt = document.querySelector('select[name=schedule_weeks]')
    const anker = document.querySelector('input[name=schedule_anchor]')?.closest('label')
    if (takt && anker) {
      const syncAnker = () => { anker.hidden = takt.value === '1' }
      takt.addEventListener('change', syncAnker)
      syncAnker()
    }
  }

  // ---- provider and model selection ----
  // The list arrives AFTER rendering via fetch: if a provider API hangs, a
  // text field is still there immediately to type the slug into. The search is
  // <datalist>'s own substring filter while typing.
  const provSel = document.getElementById('prov')
  if (provSel) {
    const modelInput = document.getElementById('model')
    const liste = document.getElementById('modelle')
    const hinweis = document.getElementById('model-hint')
    const harnessSel = document.querySelector('select[name=harness]')
    const routing = document.getElementById('or-routing')
    const pin = document.getElementById('or-pin')
    const orProv = document.getElementById('or-prov')
    const orProvLabel = document.getElementById('or-prov-label')

    const provLabel = document.getElementById('prov-label')
    const provHint = document.getElementById('prov-hint')
    const zeitText = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

    // Every harness can use different providers — subscription-based ones none
    // at all (there is only the account). Hence the selection is re-fetched on
    // every harness change instead of offering a fixed list of which half
    // would not work.
    async function ladeProvider() {
      const harness = harnessSel?.value ?? ''
      const gewaehlt = provSel.dataset.gewaehlt || provSel.value || ''
      try {
        const j = await (await fetch('/api/providers?harness=' + encodeURIComponent(harness))).json()
        if (j.subscription) {
          // Subscription harnesses (claude, cursor): no provider, the models
          // of the account instead. For cursor the list comes from
          // 'cursor-agent models' and already carries the effort level in the
          // ID — hence the effort field stays empty and hidden there.
          provLabel.hidden = true
          provSel.value = ''
          provHint.textContent = ''
          await ladeModelle(harness)
          return
        }
        provLabel.hidden = false
        provSel.innerHTML = '<option value="">' + T('js.provider_none', '— none: type the model slug —') + '</option>' +
          j.provider.map(p => '<option value="' + p.id + '">' + p.label +
            (p.hinweis ? ' (' + p.hinweis + ')' : '') + '</option>').join('')
        if (j.provider.some(p => p.id === gewaehlt)) provSel.value = gewaehlt
        provHint.textContent = j.provider.length
          ? T('js.providers_with_creds', 'only providers with credentials, enabled for this coding agent')
          : T('js.no_creds', 'no providers available for this coding agent — type the model freely')
        await ladeModelle()
      } catch {
        provHint.textContent = T('js.provider_list_unreachable', 'provider list unreachable — type the model freely')
      }
    }

    async function ladeModelle(erzwingen) {
      const quelle = erzwingen ?? provSel.value
      liste.innerHTML = ''
      if (!quelle) { hinweis.textContent = ''; return }
      hinweis.textContent = T('js.loading_models', 'loading models …')
      try {
        const r = await fetch('/api/models?provider=' + encodeURIComponent(quelle) +
          '&harness=' + encodeURIComponent(harnessSel?.value ?? ''))
        const j = await r.json()
        if (!j.ok) { hinweis.textContent = T('js.list_unreachable', 'List unreachable ({err}) — type the model slug directly.', { err: j.error }); return }
        liste.innerHTML = j.models.map(m =>
          '<option value="' + m.id + '">' + (m.name !== m.id ? m.name : '') +
          (m.frei ? ' · ' + T('js.free', 'free') : '') + (m.ctx ? ' · ' + Math.round(m.ctx / 1000) + 'k' : '') +
          // Cursor's fast mode is more expensive and not the default — make it
          // visible instead of letting it look like an equal variant.
          (m.fast ? ' · ' + T('js.fast_tag', 'FAST (more expensive)') : '') +
          // 'auto' is the one entry that names no model: cursor routes it to its
          // own models and bills it against their pool of the included usage.
          (m.auto ? ' · ' + T('js.auto_tag', 'Auto — Cursor picks the model (draws on its own pool of the included usage)') : '') +
          (m.tools ? '' : ' · ' + T('js.no_tools', 'no tools')) + '</option>').join('')
        // 'katalog' means: the list comes from the vendor catalog instead of the
        // local opencode — it may then contain models that will not run here
        // without a key.
        const ausKatalog = j.models.some(m => m.katalog)
        // For cursor the model choice also answers the effort question — the
        // effort field therefore stays off. Without this sentence you search for it.
        const cursorNote = (harnessSel?.value === 'cursor')
          ? ' · ' + T('js.cursor_note', 'The reasoning effort is part of the ID (…-low/-medium/-high/-xhigh/-max); IDs ending in “-fast” are cursor’s fast mode — the default is the variant without.')
          : ''
        hinweis.textContent = T('js.models_count', '{n} models', { n: j.models.length }) +
          (j.stand ? ' · ' + T('js.as_of', 'as of {time}', { time: zeitText(j.stand) }) : '') +
          (j.veraltet ? ' ' + T('js.stale', '(list currently unreachable, showing the last state)') : '') +
          (ausKatalog ? ' · ' + T('js.from_catalog', 'from the vendor catalog: not everything in it is usable here without a key') : '') +
          cursorNote +
          ' · ' + T('js.type_filter', 'Typing filters; a custom slug is always allowed.')
      } catch (err) {
        hinweis.textContent = T('js.list_unreachable', 'List unreachable ({err}) — type the model slug directly.', { err: err.message })
      }
    }

    function syncRouting() {
      // The serving provider can only be passed through per run for opencode;
      // hermes only knows a global entry in ~/.hermes/config.yaml for this.
      const moeglich = harnessSel?.value === 'opencode' && provSel.value === 'openrouter'
      routing.hidden = !moeglich
      if (!moeglich && pin) pin.checked = false
      if (orProvLabel) orProvLabel.hidden = !(pin && pin.checked)
    }

    const effLabel = document.getElementById('effort-label')
    const effSel = document.getElementById('effort')
    const effHint = document.getElementById('effort-hint')

    /**
     * Effort: only show the field when this combination really knows levels.
     * Hide instead of graying out — a gray field explains nothing, and a field
     * that does nothing is worse than none: with opencode and hermes an
     * invalid level fizzles silently.
     */
    async function ladeEffort() {
      if (!effLabel) return
      const url = '/api/effort?harness=' + encodeURIComponent(harnessSel?.value ?? '') +
        '&provider=' + encodeURIComponent(provSel.value) +
        '&model=' + encodeURIComponent(modelInput.value.trim())
      try {
        const j = await (await fetch(url)).json()
        if (!j.ok || !j.stufen?.length) {
          effLabel.hidden = true
          effSel.value = ''
          return
        }
        const merken = effSel.dataset.gewaehlt || effSel.value || ''
        effLabel.hidden = false
        effSel.innerHTML = '<option value="">' + T('js.effort_default', '— default{d} —', { d: j.standard ? ' (' + j.standard + ')' : '' }) + '</option>' +
          j.stufen.map(x => '<option value="' + x + '">' + x + '</option>').join('')
        effSel.value = j.stufen.includes(merken) ? merken : ''
        effHint.textContent = j.hinweis ?? ''
      } catch {
        effLabel.hidden = true
      }
    }

    let timer
    async function ladeEndpunkte() {
      if (!pin?.checked || !modelInput.value.trim()) return
      orProv.innerHTML = '<option value="">' + T('js.loading', 'loading …') + '</option>'
      try {
        const r = await fetch('/api/or-endpoints?model=' + encodeURIComponent(modelInput.value.trim()))
        const j = await r.json()
        if (!j.ok || !j.endpoints.length) {
          orProv.innerHTML = '<option value="">' + T('js.no_endpoints', '— no data, type the slug below —') + '</option>'
          return
        }
        // The value is ALWAYS the tag: the display name is not unique (several
        // regions share a name), you would otherwise pin a different vendor
        // than intended.
        orProv.innerHTML = j.endpoints.map(ep =>
          '<option value="' + ep.tag + '">' + ep.name + ' — ' + ep.tag +
          (ep.uptime != null ? ' (' + Math.round(ep.uptime) + '% ' + T('js.uptime', 'uptime') + ')' : '') + '</option>').join('')
      } catch {
        orProv.innerHTML = '<option value="">' + T('js.not_fetchable', '— not fetchable —') + '</option>'
      }
    }

    provSel.addEventListener('change', () => {
      provSel.dataset.gewaehlt = provSel.value; ladeModelle(); syncRouting(); ladeEffort()
    })
    harnessSel?.addEventListener('change', () => { ladeProvider(); syncRouting(); ladeEffort() })
    pin?.addEventListener('change', () => { syncRouting(); ladeEndpunkte() })
    effSel?.addEventListener('change', () => { effSel.dataset.gewaehlt = effSel.value })
    modelInput.addEventListener('change', () => { ladeEndpunkte(); ladeEffort() })
    modelInput.addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(() => { ladeEndpunkte(); ladeEffort() }, 400)
    })
    syncRouting()
    ladeProvider()
    ladeEffort()
    if (pin?.checked) ladeEndpunkte()
  }

  // ---- send text into a session / end run (detail page) ----
  // NOT async: 'onsubmit="return cchubSend(...)"' would otherwise receive a
  // promise — always truthy, and the browser would also submit classically.
  window.cchubSend = function (form, url) {
    const ta = form.querySelector('textarea')
    if (!ta.value.trim()) return false
    const body = new URLSearchParams()
    body.set('text', ta.value)
    const btn = form.querySelector('button')
    if (btn) btn.disabled = true
    fetch(url, { method: 'POST', body })
      .then(r => { if (!r.ok) alert(T('js.send_failed', 'Send failed: ') + 'HTTP ' + r.status) })
      .catch(err => alert(T('js.send_failed', 'Send failed: ') + err.message))
      .finally(() => { if (btn) btn.disabled = false })
    ta.value = ''
    return false
  }
  window.cchubKill = function (id) {
    if (!confirm(T('js.kill_confirm', 'Really end this run?'))) return false
    fetch('/api/runs/' + id + '/kill', { method: 'POST' }).then(() => location.reload())
    return false
  }

  // ---- terminal: xterm.js + resize frame \0{cols},{rows} (planning 7.4) ----
  // xterm.js provides the globals 'Terminal' and 'FitAddon' — not 'Term'.
  const termBox = document.getElementById('term')
  if (!termBox || typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') return

  const runMatch = location.pathname.match(/^\/runs\/([0-9a-f-]{36})$/)
  if (!runMatch) return
  // Without a tmux session there would only be a 404 at the handshake and an empty box.
  if (termBox.dataset.session === '0') {
    termBox.textContent = T('js.no_session', 'No tmux session anymore — the history is in the log below.')
    termBox.classList.add('dim')
    return
  }
  // data-live comes from pages.mjs and means the same as there: running status
  // AND open tmux session. Earlier an innerHTML.includes('live') sat here —
  // that would have granted write access to a dead session for a run named
  // "live-…" or the word in a report. Without a session it stays view-only;
  // 'ro' must be explicitly '0', the server is fail-closed.
  const live = termBox.dataset.live === '1'
  const ro = live ? '&ro=0' : '&ro=1'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  let ws
  try { ws = new WebSocket(proto + '://' + location.host + '/term?run=' + runMatch[1] + ro) } catch { return }

  const fitAddon = new FitAddon.FitAddon()
  const term = new Terminal({ cursorBlink: true, scrollback: 5000 })
  term.loadAddon(fitAddon)
  term.open(termBox)
  fitAddon.fit()

  const sendSize = () => {
    if (ws.readyState === WebSocket.OPEN) ws.send('\0' + term.cols + ',' + term.rows)
  }

  ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : '')
  ws.onopen = sendSize
  ws.onclose = () => term.write('\r\n\x1b[90m' + T('js.conn_closed', '— connection closed —') + '\x1b[0m\r\n')
  ws.onerror = () => term.write('\r\n\x1b[90m' + T('js.term_unreachable', '— terminal unreachable (session ended?) —') + '\x1b[0m\r\n')
  term.onData(d => { if (ws.readyState === WebSocket.OPEN && live) ws.send(d) })

  new ResizeObserver(() => {
    try {
      fitAddon.fit()
      sendSize()
    } catch {}
  }).observe(termBox)
}())
