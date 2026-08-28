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
      // Remember the choice before navigating: pages that carry no ?repo= of
      // their own (settings, sessions, repos) keep it instead of resetting to
      // the first repo. The server re-writes the same cookie whenever a page
      // request names a repo, so both sides agree on one value.
      document.cookie = 'cchub_repo=' + encodeURIComponent(repoSwitch.value)
        + '; Path=/; Max-Age=31536000; SameSite=Lax'
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

  // ---- planned start: show only the chosen kind's block ----
  // Per fieldset, not per page: the Quick-Run dialog sits in every page's layout,
  // so the single-run form carries this block twice. Scoping to the surrounding
  // fieldset is what keeps the two from switching each other.
  document.querySelectorAll('select[data-start-switch]').forEach(function (startSel) {
    const box = startSel.closest('fieldset') || document
    const bloecke = Array.from(box.querySelectorAll('.st'))
    const syncStart = () => bloecke.forEach(b => { b.hidden = b.dataset.mode !== startSel.value })
    startSel.addEventListener('change', syncStart)
    syncStart()
  })

  // ---- branch rule: the pattern only matters when a branch is wanted at all ----
  document.querySelectorAll('select[data-branch-mode]').forEach(function (modeSel) {
    const form = modeSel.closest('form') || document
    const pattern = form.querySelector('[data-branch-pattern]')
    if (!pattern) return
    const sync = () => { pattern.hidden = modeSel.value === 'keiner' }
    modeSel.addEventListener('change', sync)
    sync()
  })

  // ---- toasts: say what happened without taking the page away ----
  // A Quick Run starts from wherever one is standing; being torn to a detail page
  // is exactly what would make it not quick. So the answer arrives here — with a
  // link for whoever does want to look.
  window.cchubToast = function (text, opts) {
    opts = opts || {}
    const box = document.getElementById('cchub-toasts')
    if (!box) return
    const el = document.createElement('div')
    el.className = 'toast ' + (opts.kind || 'ok')
    const span = document.createElement('span')
    span.textContent = text
    el.append(span)
    if (opts.href) {
      const a = document.createElement('a')
      a.href = opts.href
      a.textContent = opts.linkText || T('js.toast_open', 'open')
      el.append(a)
    }
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'mini'
    close.textContent = '✕'
    close.setAttribute('aria-label', T('js.toast_close', 'close'))
    close.addEventListener('click', function () { el.remove() })
    el.append(close)
    box.append(el)
    // An error stays until it is read; a success says its piece and goes.
    if (opts.kind !== 'err') setTimeout(function () { el.remove() }, opts.ms || 9000)
  }

  // ---- Quick Run dialog (in the layout of every page) ----
  const qrDialog = document.getElementById('qr-dialog')
  const qrOpen = document.getElementById('qr-open')
  if (qrDialog && qrOpen) {
    const qrForm = document.getElementById('qr-form')
    const favSel = document.getElementById('qr-fav')
    const favInfo = document.getElementById('qr-fav-info')
    const fehler = document.getElementById('qr-error')
    const FAV_KEY = 'cchub.quickrun.favorite'

    const zeigeFav = function () {
      if (!favSel || !favInfo) return
      const opt = favSel.selectedOptions[0]
      // The setup used to stand as a line of text under the select, where it
      // clung to the field and pushed the task box down. It is a detail one
      // looks up, not one one reads every time — so it lives on the marker.
      //
      // Built as elements rather than left to the native `title`: that one
      // waits about a second before it appears, cannot be styled, and would
      // render this as one long dot-separated line. CSS shows the bubble the
      // instant the marker is hovered or focused; this only fills it.
      const summary = opt ? (opt.dataset.summary || '') : ''
      const tip = document.getElementById('qr-fav-tip')
      favInfo.hidden = !summary
      // Guarded, not returned early: the remembered favorite is saved at the
      // end of this function, and a missing bubble must not cost that.
      if (tip) {
        tip.textContent = ''
        for (const teil of summary.split(' · ')) {
          const zeile = document.createElement('span')
          // "Extra skills: unlazy" is a pair, "opus" is a bare fact. Where
          // there is a colon the caption goes dim so the value carries the line.
          const i = teil.indexOf(': ')
          if (i > 0) {
            const k = document.createElement('i')
            k.textContent = teil.slice(0, i)
            zeile.append(k, document.createTextNode(teil.slice(i + 1)))
          } else {
            zeile.textContent = teil
          }
          tip.append(zeile)
        }
      }
      try { localStorage.setItem(FAV_KEY, favSel.value) } catch (err) { /* private mode */ }
    }
    if (favSel) {
      // The favorite one used last is almost always the one wanted again.
      try {
        const merk = localStorage.getItem(FAV_KEY)
        if (merk && Array.from(favSel.options).some(function (o) { return o.value === merk })) favSel.value = merk
      } catch (err) { /* private mode */ }
      favSel.addEventListener('change', zeigeFav)
      zeigeFav()
    }

    qrOpen.addEventListener('click', function () {
      if (fehler) { fehler.hidden = true; fehler.textContent = '' }
      qrDialog.showModal()
      const ta = qrForm && qrForm.querySelector('textarea[name=prompt]')
      if (ta) ta.focus()
    })
    qrDialog.querySelectorAll('[data-qr-close]').forEach(function (b) {
      b.addEventListener('click', function () { qrDialog.close() })
    })

    if (qrForm) qrForm.addEventListener('submit', function (ev) {
      ev.preventDefault()
      const btn = qrForm.querySelector('button[type=submit]')
      const body = new URLSearchParams()
      new FormData(qrForm).forEach(function (v, k) { if (typeof v === 'string') body.append(k, v) })
      if (fehler) { fehler.hidden = true; fehler.textContent = '' }
      if (btn) btn.disabled = true
      fetch('/api/runs/quick', { method: 'POST', body: body, headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || T('js.error_generic', 'request failed'))
          qrDialog.close()
          // Only the task is cleared: favorite, repo, branch rule and start time
          // are the setup of the next quick run just as much as of this one.
          const ta = qrForm.querySelector('textarea[name=prompt]')
          if (ta) ta.value = ''
          const name = j.title || j.favorite || ''
          const text = j.scheduled
            ? T('js.qr_scheduled', 'Run planned: {name}', { name: name })
            : j.deferred
              ? T('js.qr_deferred', 'Run deferred (quota/credit): {name}', { name: name })
              : T('js.qr_started', 'Run started: {name}', { name: name })
          window.cchubToast(text, { kind: j.deferred ? 'warn' : 'ok', href: '/runs/' + j.runId })
        })
        .catch(function (err) {
          if (fehler) { fehler.hidden = false; fehler.textContent = err.message }
          else window.cchubToast(err.message, { kind: 'err' })
        })
        .finally(function () { if (btn) btn.disabled = false })
    })
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
    const box = btn.closest('.title-inline')
    const link = box && box.querySelector('[data-title-text]')
    if (!box || !link || box.querySelector('input')) return
    const runId = box.dataset.run
    const alt = link.textContent.trim()

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'title-input'
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
          if (!j.ok) throw new Error(j.error || T('js.error_generic', 'request failed'))
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
          ladeEffort()
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
        // Effort depends on provider AND model, but at page load the provider
        // <select> is still empty until this fetch fills it — the init-time
        // ladeEffort() therefore ran with provider='' and hid the field. The
        // programmatic value assignment above fires no 'change' event, so the
        // field would stay hidden: refresh it now that the combination stands.
        ladeEffort()
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
          ? ' · ' + T('js.cursor_note', "The reasoning effort is part of the ID (…-low/-medium/-high/-xhigh/-max); IDs ending in \"-fast\" are cursor's fast mode — the default is the variant without.")
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
  // The reload STAYS, even though the live channel would update the page by
  // itself. It is not a leftover: it is what closes the terminal's WebSocket,
  // and with it the tmux client behind it. Without the reload the browser keeps
  // an attached client on a dying session — and every attached client rewraps
  // the agent's window, because tmux runs with window-size=latest. Ending a run
  // is also a deliberate act where a fresh page is the honest answer: the send
  // and kill forms have to disappear, and they sit outside the fragment.
  window.cchubKill = function (id) {
    if (!confirm(T('js.kill_confirm', 'Really end this run?'))) return false
    fetch('/api/runs/' + id + '/kill', { method: 'POST' }).then(() => location.reload())
    return false
  }

  // ---- sessions page: filter, multi-select, non-blocking ending ----
  // Nothing here reloads the page. A click marks its row as "ending …" in the
  // same tick and the request goes off in the background — so a dozen sessions
  // can be clicked away in a row without waiting for any of them. Only what the
  // server confirms is struck through; a failure hands the row back.
  const sessTable = document.querySelector('table.sessions')
  if (sessTable) {
    const showRunning = document.getElementById('sess-show-running')
    const selectAll = document.getElementById('sess-all')
    const killBtn = document.getElementById('sess-kill-selected')
    const hiddenNote = document.getElementById('sess-hidden')
    const STORE_KEY = 'cchub.sessions.showRunning'

    const rows = function () {
      return Array.from(sessTable.querySelectorAll('tbody tr[data-session]'))
    }
    // A row that is filtered away or already ended is out of reach — neither
    // "select all" nor a bulk end may touch it.
    const reachable = function (tr) { return !tr.hidden && !tr.classList.contains('gone') }
    const selected = function () {
      return rows().filter(function (tr) {
        var box = tr.querySelector('.sess-pick')
        return reachable(tr) && box && box.checked
      })
    }

    function syncSelection() {
      var n = selected().length
      killBtn.disabled = n === 0
      killBtn.textContent = T('js.sessions_end_selected', 'End selected ({n})', { n: n })
      var reachableRows = rows().filter(reachable)
      selectAll.checked = reachableRows.length > 0 && n === reachableRows.length
    }

    function syncFilter() {
      var hiddenCount = 0
      rows().forEach(function (tr) {
        var hide = tr.dataset.running === '1' && !showRunning.checked
        tr.hidden = hide
        if (hide) {
          hiddenCount++
          var box = tr.querySelector('.sess-pick')
          if (box) box.checked = false      // never end what is not on screen
        }
      })
      hiddenNote.hidden = hiddenCount === 0
      hiddenNote.textContent = T('js.sessions_hidden',
        'Sessions with a running agent, hidden: {n}', { n: hiddenCount })
      syncSelection()
    }

    function endSessions(trs) {
      trs = trs.filter(function (tr) { return tr && !tr.classList.contains('gone') })
      if (!trs.length) return
      var runningCount = trs.filter(function (tr) { return tr.dataset.running === '1' }).length
      if (runningCount && !confirm(T('js.sessions_kill_confirm',
        '{n} of these sessions still have a running agent — it is killed along with the session. Continue?',
        { n: runningCount }))) return
      trs.forEach(function (tr) {
        tr.classList.add('ending')
        var b = tr.querySelector('.sess-kill'); if (b) b.disabled = true
        var box = tr.querySelector('.sess-pick'); if (box) { box.checked = false; box.disabled = true }
        var z = tr.querySelector('.sess-state'); if (z) z.textContent = T('js.sessions_ending', 'ending …')
      })
      syncSelection()

      function finish(byName) {
        trs.forEach(function (tr) {
          var result = byName[tr.dataset.session]
          var z = tr.querySelector('.sess-state')
          tr.classList.remove('ending')
          if (result && result.ok) {
            tr.classList.add('gone')
            if (z) z.textContent = T('js.sessions_ended', 'ended')
          } else {
            tr.classList.add('failed')
            var b = tr.querySelector('.sess-kill'); if (b) b.disabled = false
            var box = tr.querySelector('.sess-pick'); if (box) box.disabled = false
            if (z) z.textContent = T('js.sessions_kill_failed', 'could not be ended')
          }
        })
        syncSelection()
      }

      var body = new URLSearchParams()
      trs.forEach(function (tr) { body.append('session', tr.dataset.session) })
      fetch('/api/sessions/kill', { method: 'POST', body: body, headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (j) {
          var byName = {}
          ;(j.results || []).forEach(function (x) { byName[x.session] = x })
          finish(byName)
        })
        .catch(function () { finish({}) })
    }

    sessTable.addEventListener('click', function (ev) {
      if (ev.target.classList.contains('sess-kill')) endSessions([ev.target.closest('tr')])
    })
    sessTable.addEventListener('change', function (ev) {
      if (ev.target.classList.contains('sess-pick')) syncSelection()
    })
    killBtn.addEventListener('click', function () { endSessions(selected()) })
    selectAll.addEventListener('change', function () {
      rows().filter(reachable).forEach(function (tr) {
        var box = tr.querySelector('.sess-pick')
        if (box && !box.disabled) box.checked = selectAll.checked
      })
      syncSelection()
    })
    showRunning.addEventListener('change', function () {
      try { localStorage.setItem(STORE_KEY, showRunning.checked ? '1' : '0') } catch (err) { /* private mode */ }
      syncFilter()
    })
    try { showRunning.checked = localStorage.getItem(STORE_KEY) === '1' } catch (err) { /* private mode */ }
    syncFilter()
  }

  // ---- status sidebar: collapsible, and the state survives the page ----
  //
  // The open/closed class sits on the SHELL, not on the sidebar: the live
  // channel replaces #status-sidebar whole, and a class on the element itself
  // would be thrown away with it on every update. sidebarSync() is therefore
  // called again after each swap — it reads the one truth (localStorage) and
  // writes it to the two places that show it, the shell and the button.
  //
  // Every localStorage access in try/catch, like cchub.sessions.showRunning:
  // in a private window the accessor itself throws, and a status panel is not
  // worth a page that stops working.
  var SIDEBAR_KEY = 'cchub.sidebar.open'
  function sidebarOpen() {
    try { return localStorage.getItem(SIDEBAR_KEY) !== '0' } catch (err) { return true }
  }
  function sidebarSync() {
    var shell = document.getElementById('shell')
    if (!shell) return
    var open = sidebarOpen()
    shell.classList.toggle('side-closed', !open)
    var btn = document.getElementById('side-toggle')
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false')
      btn.textContent = open ? '▸' : '◂'
    }
  }
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('#side-toggle')
    if (!btn) return
    try { localStorage.setItem(SIDEBAR_KEY, sidebarOpen() ? '0' : '1') } catch (err) { /* private mode */ }
    sidebarSync()
  })
  sidebarSync()

  // ---- live channel: a signal from /api/events, the HTML from the server ----
  //
  // The event carries only what changed, never markup. The page answers by
  // fetching the fragment, which the server renders through the same function
  // the full page uses — so a row has exactly one renderer, and translations,
  // traffic-light rules and conditional cells cannot drift apart from the page.
  //
  // Deliberately no framework: every swap here is a special case (an element
  // that may not exist yet, a row that must not be replaced while it is being
  // renamed, a terminal that must never be touched at all), and the inline
  // onclick attributes plus the capture-phase rename listener would have to be
  // reconciled with a library's own handlers.
  ;(function live() {
    if (typeof EventSource === 'undefined') return
    const runsBody = document.getElementById('runs-body')
    const detail = location.pathname.match(/^\/runs\/([0-9a-f-]{36})$/)
    const header = document.getElementById('header-status')
    if (!runsBody && !detail && !header) return

    // The repo comes from the BODY, not from #repo-switch: pages without a repo
    // context (sessions, repos, settings) still render that select, and it then
    // shows the first repo — filtering by it would silently drop every event.
    const repo = document.body.dataset.repo || ''

    // One trailing timer per target: a watcher pass can announce a dozen runs in
    // the same tick, and each of them would otherwise be its own request.
    const geplant = new Map()
    function bald(key, fn, ms) {
      clearTimeout(geplant.get(key))
      geplant.set(key, setTimeout(() => { geplant.delete(key); fn() }, ms || 120))
    }

    // 204 = the thing is gone (archived, ended, never existed). That is an
    // answer, not an error: the row is removed instead of left behind stale.
    async function holeFragment(pfad) {
      const res = await fetch(pfad, { headers: { accept: 'text/html' } })
      if (res.status === 204) return null
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.text()
    }
    function zuElementen(html) {
      const t = document.createElement('template')
      t.innerHTML = html.trim()
      return Array.from(t.content.children)
    }
    /** Replace every element of the fragment by its own id. Missing ids are skipped. */
    function tauscheNachId(html) {
      for (const neu of zuElementen(html)) {
        const alt = neu.id && document.getElementById(neu.id)
        if (alt) alt.replaceWith(neu)
      }
    }

    async function zeileAktualisieren(runId) {
      const zeile = document.getElementById('run-' + runId)
      if (!zeile) return
      // Never swap a row whose title is being edited — the half-typed text is
      // not in the DOM the server knows about, and replacing it throws the
      // typing away mid-word.
      if (zeile.querySelector('.title-inline input')) return
      const html = await holeFragment('/api/fragments/run-row?id=' + encodeURIComponent(runId)
        + (repo ? '&repo=' + encodeURIComponent(repo) : ''))
      if (html === null) { zeile.remove(); return }
      const neu = zuElementen(html)[0]
      if (neu) zeile.replaceWith(neu)
    }

    // A run this page does not show yet: the row cannot be created in place,
    // because the empty state and the sort order both live in the tbody. So the
    // whole body is re-rendered — the one case where a parent has to be swapped
    // (the same reason a banner that was absent cannot appear by itself).
    async function tabelleAktualisieren() {
      // Re-query: the element is replaced by every swap, so the reference
      // captured at load time is stale — and with it the status filter it
      // carries, which has to travel with the request or the filtered list
      // would silently be replaced by the unfiltered one.
      const tbody = document.getElementById('runs-body')
      if (!tbody) return
      const status = tbody.dataset.status || ''
      const html = await holeFragment('/api/fragments/runs-body' + (repo ? '?repo=' + encodeURIComponent(repo) : '?')
        + (status ? '&status=' + encodeURIComponent(status) : ''))
      if (html === null) return
      if (document.querySelector('#runs-body .title-inline input')) return
      tauscheNachId(html)
    }

    async function detailAktualisieren(runId) {
      if (!detail || detail[1] !== runId) return
      // Head, metrics and events only. The terminal is NOT part of this
      // fragment: replacing #term would tear the xterm instance off the DOM,
      // leave the WebSocket open and leak a tmux client that keeps rewrapping
      // the running agent's window.
      const html = await holeFragment('/api/fragments/run-detail?id=' + encodeURIComponent(runId))
      if (html === null) return
      if (document.querySelector('.title-inline input')) return
      tauscheNachId(html)
    }

    // The status sidebar as ONE request. Its blocks appear and disappear —
    // no open incidents means no incident block at all, no usage means no
    // usage panel — and an element that is not in the DOM cannot be swapped
    // in by its own id. So the whole aside is replaced, which also covers
    // #header-status and #usage-panel inside it; the two fragment routes for
    // those stay, they are simply not what the page asks for any more.
    async function statusAktualisieren() {
      try {
        // The sidebar's repo, not the body's: it is set on pages that have no
        // repo context too (see statusSidebar in pages.mjs).
        const sRepo = document.getElementById('status-sidebar')?.dataset.repo || repo
        const html = await holeFragment('/api/fragments/sidebar' + (sRepo ? '?repo=' + encodeURIComponent(sRepo) : ''))
        if (html !== null) { tauscheNachId(html); sidebarSync() }
      } catch (err) { /* a quiet panel beats a broken page */ }
    }

    const quelle = new EventSource('/api/events' + (repo ? '?repo=' + encodeURIComponent(repo) : ''))
    quelle.addEventListener('run', (ev) => {
      let d = {}
      try { d = JSON.parse(ev.data) } catch (err) { return }
      if (!d.runId) return
      bald('run:' + d.runId, () => {
        zeileAktualisieren(d.runId).catch(() => {})
        detailAktualisieren(d.runId).catch(() => {})
        if (runsBody && !document.getElementById('run-' + d.runId)) tabelleAktualisieren().catch(() => {})
      })
      // Quota and balances move with the work, but far more slowly — a longer
      // timer keeps a burst of run events from turning into a burst of usage
      // requests, each of which may talk to a provider API.
      bald('status', () => { statusAktualisieren().catch(() => {}) }, 2000)
    })
    // Whether the channel is actually up is a fact about the page, so the page
    // says so. It matters for real: a fresh load has no Last-Event-ID, so an
    // event fired in the gap between rendering and connecting is simply missed
    // — harmless (the page just rendered current state) but worth being able
    // to see, and the browser suite waits for it instead of racing it.
    quelle.onopen = () => { document.body.dataset.live = '1' }
    // EventSource reconnects by itself and sends Last-Event-ID, which the hub
    // answers from its ring buffer. Nothing to do here but not get in the way.
    quelle.onerror = () => { document.body.dataset.live = '0' }
  }())

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
