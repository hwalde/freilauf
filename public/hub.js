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
  // Signed, like fmtRelativeTime in server/util.mjs: a started run looks back,
  // a planned one forward ("in 20 minutes"). Keep the unit ladder in sync.
  function relTimeText(ms, now) {
    var lang = document.documentElement.lang || 'en'
    var sec = Math.round((now - ms) / 1000)
    var abs = Math.abs(sec)
    var rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
    var say = function (n, unit) { return rtf.format(sec < 0 ? n : -n, unit) }
    if (abs < 60) return say(abs, 'second')
    var min = Math.floor(abs / 60)
    if (min < 60) return say(min, 'minute')
    var hr = Math.floor(min / 60)
    if (hr < 24) return say(hr, 'hour')
    var day = Math.floor(hr / 24)
    if (day < 30) return say(day, 'day')
    var month = Math.floor(day / 30)
    if (month < 12) return say(month, 'month')
    return say(Math.floor(day / 365), 'year')
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

  // ---- planned start (single-run form): show only the chosen kind's block ----
  const startSel = document.getElementById('start-mode')
  if (startSel) {
    const bloecke = Array.from(document.querySelectorAll('.st'))
    const syncStart = () => bloecke.forEach(b => { b.hidden = b.dataset.mode !== startSel.value })
    startSel.addEventListener('change', syncStart)
    syncStart()
  }

  // ---- inline renaming of a run (overview + detail page) ----
  // Renaming touches only the RUN. An agent keeps its name — that is the whole
  // point: the same agent may run twice and each run gets called what it is.
  //
  // CAPTURE phase, deliberately: in the overview the title cell stops the click
  // from bubbling (otherwise the row's onclick would navigate away while you
  // rename). A listener on document would then never see it at all.
  document.addEventListener('click', function (ev) {
    const btn = ev.target.closest('[data-title-edit]')
    if (!btn) return
    ev.preventDefault()
    ev.stopPropagation()
    const box = btn.closest('.titel-inline')
    const link = box && box.querySelector('[data-title-text]')
    if (!box || !link || box.querySelector('input')) return
    const runId = box.dataset.run
    const alt = link.textContent.trim()

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'titel-input'
    input.maxLength = 80
    input.value = alt
    input.placeholder = T('js.title_ph', 'Title of this run')
    link.hidden = true
    btn.hidden = true
    box.insertBefore(input, link)
    input.focus()
    input.select()

    let fertig = false
    let laeuft = false
    const schliessen = (text) => {
      if (fertig) return
      fertig = true
      link.textContent = text
      link.hidden = false
      btn.hidden = false
      input.remove()
    }
    const speichern = () => {
      // 'input.disabled = true' below takes the focus away and thereby fires
      // blur — which lands here again. Without this guard every rename would be
      // sent twice.
      if (fertig || laeuft) return
      const neu = input.value.trim()
      if (neu === alt) return schliessen(alt)
      laeuft = true
      input.disabled = true
      const body = new URLSearchParams()
      body.set('title', neu)
      fetch('/api/runs/' + runId + '/title', {
        method: 'POST', body, headers: { accept: 'application/json' },
      })
        .then(r => r.json())
        .then(j => {
          if (!j.ok) throw new Error(j.error || 'HTTP')
          schliessen(j.title || neu)
          // The browser tab carries the title on the detail page.
          if (location.pathname === '/runs/' + runId) document.title = 'cc-hub — ' + (j.title || neu)
        })
        .catch(err => {
          alert(T('js.rename_failed', 'Renaming failed: ') + err.message)
          schliessen(alt)
        })
    }
    input.addEventListener('keydown', (e2) => {
      if (e2.key === 'Enter') { e2.preventDefault(); speichern() }
      if (e2.key === 'Escape') { e2.preventDefault(); schliessen(alt) }
    })
    input.addEventListener('blur', speichern)
    input.addEventListener('click', (e2) => e2.stopPropagation())
  }, true)
  // ---- run/agent form: keep it while a flow is being built ----
  // The flow editor is a page of its own, and this form is plain server-rendered
  // HTML: clicking "create a flow" used to throw away everything typed and left
  // no way back to the form at all. Two halves fix that — the link carries where
  // to return to (the editor's Back button uses it), and what stands in the form
  // is parked in sessionStorage until it comes back.
  const STASH_PREFIX = 'cchub:form:'
  function ohneFlowParam() {
    const u = new URL(location.href)
    u.searchParams.delete('flow')
    return u.pathname + u.search
  }
  function stashForm(form, key) {
    if (!form) return
    try {
      const data = []
      new FormData(form).forEach(function (v, k) { if (typeof v === 'string') data.push([k, v]) })
      sessionStorage.setItem(key, JSON.stringify(data))
    } catch (err) { /* private mode / quota: the form is then simply lost, as before */ }
  }
  function restoreForm(form, key) {
    if (!form) return
    let data
    try {
      data = JSON.parse(sessionStorage.getItem(key) || 'null')
      sessionStorage.removeItem(key)
    } catch (err) { return }
    if (!Array.isArray(data)) return
    const byName = new Map()
    data.forEach(function (kv) { byName.set(kv[0], (byName.get(kv[0]) || []).concat(kv[1])) })
    form.querySelectorAll('input[name], textarea[name], select[name]').forEach(function (el) {
      const vals = byName.get(el.name)
      if (el.type === 'checkbox' || el.type === 'radio') {
        // Unchecked boxes are not in a FormData — absent means "was not ticked".
        el.checked = !!vals && vals.indexOf(el.value) >= 0
        return
      }
      if (!vals || !vals.length) return
      const v = vals.shift()
      el.value = v
      // The provider and effort <select>s are filled by fetch only afterwards;
      // 'data-gewaehlt' is what those loaders read, so the choice survives.
      if (el.dataset.gewaehlt !== undefined) el.dataset.gewaehlt = v
    })
  }

  const flowBox = document.querySelector('fieldset.flows-attach')
  if (flowBox) {
    const defForm = flowBox.closest('form')
    const stashKey = STASH_PREFIX + ohneFlowParam()
    flowBox.querySelectorAll('a[href^="/flows"]').forEach(function (a) {
      const u = new URL(a.getAttribute('href'), location.origin)
      u.searchParams.set('back', ohneFlowParam())
      a.setAttribute('href', u.pathname + u.search)
      a.addEventListener('click', function () { stashForm(defForm, stashKey) })
    })
    restoreForm(defForm, stashKey)
    // Coming back from the editor of a FRESHLY created flow: tick it right away
    // — that is why the trip was made.
    const neu = new URL(location.href).searchParams.get('flow')
    if (neu) {
      Array.from(flowBox.querySelectorAll('input[name=flows]')).forEach(function (cb) {
        if (cb.value === neu) cb.checked = true
      })
      history.replaceState(null, '', ohneFlowParam())
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

    /**
     * Switching the coding agent replaces provider, model, serving provider and
     * effort with what THAT coding agent was last run with — it does not carry
     * the previous one's setup over. Those settings are not merely unhelpful
     * across coding agents, they are incompatible: an opencode model slug is
     * nothing claude runs, cursor carries the effort level inside its model ID,
     * and a subscription harness has no provider at all. Nothing remembered for
     * it means: empty, not "whatever was standing there".
     */
    async function harnessGewechselt() {
      let c = { provider: '', model: '', or_provider: '', effort: '' }
      try {
        const j = await (await fetch('/api/run-choice?harness=' +
          encodeURIComponent(harnessSel?.value ?? ''))).json()
        if (j.ok && j.choice) c = j.choice
      } catch { /* no answer: start empty rather than keep the old coding agent's setup */ }
      provSel.dataset.gewaehlt = c.provider || ''
      provSel.value = c.provider || ''
      modelInput.value = c.model || ''
      if (effSel) { effSel.dataset.gewaehlt = c.effort || ''; effSel.value = '' }
      if (pin) pin.checked = !!c.or_provider
      if (orProv) {
        orProv.innerHTML = ''
        if (c.or_provider) {
          const opt = document.createElement('option')
          opt.value = c.or_provider
          opt.textContent = c.or_provider
          orProv.append(opt)
        }
      }
      await ladeProvider()      // fills the provider list and, through it, the models
      syncRouting()
      await ladeEffort()
      if (pin?.checked) ladeEndpunkte()
    }

    provSel.addEventListener('change', () => {
      provSel.dataset.gewaehlt = provSel.value; ladeModelle(); syncRouting(); ladeEffort()
    })
    harnessSel?.addEventListener('change', harnessGewechselt)
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
