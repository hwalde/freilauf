// Freilauf — small vanilla JS: repo switcher, terminal client (xterm.js), form helpers.
// UI strings come from window.FREILAUF_I18N (injected by the layout); English
// fallbacks are inlined so the file also works standalone.
(function () {
  'use strict'

  var I18N = window.FREILAUF_I18N || {}
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
        timeZone: window.FREILAUF_TZ || undefined,
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
      document.cookie = 'freilauf_repo=' + encodeURIComponent(repoSwitch.value)
        + '; Path=/; Max-Age=31536000; SameSite=Lax'
      location.href = u.pathname + u.search
    })
  }

  // ---- Quick Run → full run form: what was typed survives the handoff ----
  // The Quick-Run dialog's "more settings" opens /runs/new in a NEW window and
  // parks its fields under this key first (a window opened by the opener
  // inherits a copy of its sessionStorage). This block restores them onto the
  // MAIN form — never onto the Quick-Run dialog that sits on this page too —
  // and runs BEFORE the start-time and branch syncs below, so those re-evaluate
  // against the restored values. What the dialog does not ask for (coding
  // agent, provider, model, effort, skills, flows) is not parked and stays as
  // the server rendered it — the favorite that travels in the URL.
  const QRFULL_KEY = 'freilauf:qrfull'
  if (location.pathname === '/runs/new') {
    const laufForm = document.querySelector('form.settings')
    if (laufForm) {
      let geparkt = null
      try { geparkt = JSON.parse(sessionStorage.getItem(QRFULL_KEY) || 'null') } catch (err) { geparkt = null }
      if (Array.isArray(geparkt)) {
        const byName = new Map()
        geparkt.forEach(function (kv) { byName.set(kv[0], (byName.get(kv[0]) || []).concat(kv[1])) })
        laufForm.querySelectorAll('input[name], textarea[name], select[name]').forEach(function (el) {
          const vals = byName.get(el.name)
          if (el.type === 'checkbox' || el.type === 'radio') {
            el.checked = !!vals && vals.indexOf(el.value) >= 0
            return
          }
          if (!vals || !vals.length) return
          const v = vals.shift()
          el.value = v
          // The provider/effort <select>s are filled by fetch only afterwards;
          // 'data-gewaehlt' is what those loaders read, so the choice survives.
          if (el.dataset.gewaehlt !== undefined) el.dataset.gewaehlt = v
        })
        try { sessionStorage.removeItem(QRFULL_KEY) } catch (err) { /* private mode */ }
      }
    }
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
  // fieldset is what keeps the two from switching each other. Delegated instead
  // of bound directly because the block also lives inside the swap-in-able
  // "Edit this run" card — a direct listener dies when the fragment replaces
  // #run-edit, and a silently dead start-time switch would be a card that does
  // nothing.
  document.addEventListener('change', function (e) {
    const startSel = e.target && e.target.closest && e.target.closest('select[data-start-switch]')
    if (!startSel) return
    const box = startSel.closest('fieldset') || document
    const bloecke = Array.from(box.querySelectorAll('.st'))
    bloecke.forEach(b => { b.hidden = b.dataset.mode !== startSel.value })
  })
  document.querySelectorAll('select[data-start-switch]').forEach(function (startSel) {
    const box = startSel.closest('fieldset') || document
    const bloecke = Array.from(box.querySelectorAll('.st'))
    bloecke.forEach(b => { b.hidden = b.dataset.mode !== startSel.value })
  })

  // ---- the branch rule: a choice that explains itself ----
  //
  // The pattern field only matters when a branch is wanted at all, and the
  // explanation under each option depends on whether THIS repo is one the hub
  // integrates for. Which explanation is visible is CSS's job (both are in the
  // markup, `data-merge-mode` on the fieldset decides) — so the static case
  // needs nothing from here.
  //
  // What does need JS is a form that can change repo without rebuilding the
  // page: the Quick-Run dialog has a repo <select>, and picking another repo
  // there can turn a run that gets merged into one that does not. The header's
  // repo switcher reloads, so it is none of this code's business. The "Edit
  // this run" card carries the same block AND is part of the run-detail
  // fragment — so everything here is delegated, or a swapped-in card would
  // silently stop reacting (same reason as the start-time switch above).
  function syncBranchBox(box, repoSel) {
    const pattern = box.querySelector('[data-branch-pattern]')
    const radios = Array.from(box.querySelectorAll('input[name=branch_mode]'))
    const gewaehlt = () => (radios.find(r => r.checked) || {}).value || 'keiner'
    if (pattern) pattern.hidden = gewaehlt() === 'keiner'
    if (!repoSel) return
    let modes = {}, bases = {}
    try { modes = JSON.parse(box.dataset.mergeModes || '{}') } catch (e) { modes = {} }
    try { bases = JSON.parse(box.dataset.mergeBases || '{}') } catch (e) { bases = {} }
    const modus = modes[repoSel.value] === 'hub' ? 'hub' : 'off'
    box.dataset.mergeMode = modus
    // A base branch is part of the sentence, and it belongs to the repo — so
    // the explanations say the name of the branch one actually picked.
    const base = bases[repoSel.value]
    if (base) box.querySelectorAll('[data-base]').forEach(el => { el.textContent = base })
    const keep = box.querySelector('[data-hub-only]')
    if (!keep) return
    keep.hidden = modus !== 'hub'
    // Hidden AND unticked: a box one cannot see must not still submit, and
    // "keep the work here" means nothing in a repo the hub does not integrate.
    if (keep.hidden) keep.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = false })
  }
  document.querySelectorAll('[data-branch-choice]').forEach(function (box) {
    const form = box.closest('form') || document
    syncBranchBox(box, form.querySelector && form.querySelector('select[name=repo_id]'))
  })
  document.addEventListener('change', function (e) {
    const t = e.target
    if (!t || !t.closest) return
    if (t.closest('input[name=branch_mode]')) {
      const box = t.closest('[data-branch-choice]')
      if (box) syncBranchBox(box, null)
      return
    }
    if (t.matches && t.matches('select[name=repo_id]')) {
      const form = t.form || t.closest('form')
      if (!form) return
      form.querySelectorAll('[data-branch-choice]').forEach(function (box) { syncBranchBox(box, t) })
    }
  })

  // ---- the hub's own questions: which model source answers them ----
  //
  // Three fieldsets ask the same thing in a row (incident check, run title,
  // worktree extras), and the welcome wizard asks it again. So nothing here
  // knows an id: everything is scoped to the fieldset the <select> sits in, and
  // the listener is DELEGATED — a wizard step or a fragment may replace the
  // block, and a direct listener would die with it while the picker still
  // looked alive.
  const llmMru = new WeakMap()   // <datalist> -> what the server rendered into it

  function llmBox(sel) { return sel.closest('fieldset') || sel.closest('form') || document }

  function llmSyncSource(sel) {
    const box = llmBox(sel)
    const opt = sel.selectedOptions[0]
    // A coding agent starts a whole session for one question — slower and more
    // expensive than a model provider. The plugin says so (`llm.overhead`), the
    // option carries it, and the warning follows the choice.
    const warn = box.querySelector('[data-llm-overhead]')
    if (warn) warn.hidden = !(opt && opt.dataset.overhead === '1')
    // Pinning a serving provider is an OpenRouter thing and means nothing
    // anywhere else. Hidden AND disabled: a field one cannot see must not still
    // submit — it would send an OpenRouter endpoint tag with somebody else's
    // answer.
    const pin = box.querySelector('[data-llm-pin]')
    if (pin) {
      const passt = sel.value === 'provider:openrouter'
      pin.hidden = !passt
      pin.querySelectorAll('input').forEach(function (i) { i.disabled = !passt })
    }
  }

  async function llmLoadModels(sel) {
    const box = llmBox(sel)
    const input = box.querySelector('input[list]')
    const liste = input && document.getElementById(input.getAttribute('list'))
    if (!liste) return
    // The server-rendered suggestions are the recently used models — they stay,
    // whatever the source answers, and they are what the list falls back to
    // when it answers nothing at all.
    if (!llmMru.has(liste)) {
      llmMru.set(liste, {
        html: liste.innerHTML,
        ids: Array.prototype.map.call(liste.querySelectorAll('option'), function (o) { return o.value }),
      })
    }
    const snap = llmMru.get(liste)
    liste.innerHTML = snap.html
    try {
      const j = await (await fetch('/api/llm-models?source=' + encodeURIComponent(sel.value))).json()
      if (!j.ok || !j.models || !j.models.length) return
      j.models.forEach(function (m) {
        if (snap.ids.indexOf(m.id) >= 0) return
        const o = document.createElement('option')
        o.value = m.id
        if (m.name && m.name !== m.id) o.textContent = m.name
        liste.append(o)
      })
    } catch {
      /* no list: the model field is free text and always works */
    }
  }

  document.querySelectorAll('select[data-llm-source]').forEach(function (sel) {
    llmSyncSource(sel)
    llmLoadModels(sel)
  })
  document.addEventListener('change', function (ev) {
    const sel = ev.target && ev.target.closest && ev.target.closest('select[data-llm-source]')
    if (!sel) return
    llmSyncSource(sel)
    llmLoadModels(sel)
  })

  // ---- the fallback picker of an LLM job ----
  //
  // Its own container (`[data-llm-fb]`) and its own select attribute, NOT the
  // primary's: the primary wiring above scopes itself to the fieldset, and a
  // second `select[data-llm-source]` in the same fieldset would fight it over
  // one warning. The model datalist is filled on CHANGE only — the page load
  // stays at one request per job, and the field is free text anyway.
  function llmSyncFallback(sel) {
    const box = sel.closest('[data-llm-fb-block]')
    if (!box) return
    const opt = sel.selectedOptions[0]
    const warn = box.querySelector('[data-llm-fb-overhead]')
    if (warn) warn.hidden = !(opt && opt.dataset.overhead === '1')
    const model = box.querySelector('[data-llm-fb-model]')
    if (model) model.hidden = !sel.value
  }

  async function llmLoadFallbackModels(sel) {
    if (!sel.value) return
    const box = sel.closest('[data-llm-fb-block]')
    const input = box && box.querySelector('input[list]')
    const liste = input && document.getElementById(input.getAttribute('list'))
    if (!liste || liste.options.length) return
    try {
      const j = await (await fetch('/api/llm-models?source=' + encodeURIComponent(sel.value))).json()
      if (!j.ok || !j.models || !j.models.length) return
      j.models.forEach(function (m) {
        const o = document.createElement('option')
        o.value = m.id
        if (m.name && m.name !== m.id) o.textContent = m.name
        liste.append(o)
      })
    } catch {
      /* no list: the model field is free text and always works */
    }
  }

  document.querySelectorAll('select[data-llm-fb]').forEach(llmSyncFallback)
  document.addEventListener('change', function (ev) {
    const sel = ev.target && ev.target.closest && ev.target.closest('select[data-llm-fb]')
    if (!sel) return
    llmSyncFallback(sel)
    llmLoadFallbackModels(sel)
  })

  // ---- the LLM jobs' serving-provider routing: mode decides the fields ----
  // Same three modes as the run forms (open / auto / pin); the settings page
  // renders one block per LLM job, so this is DELEGATED and namespaced by the
  // field names rather than by ids.
  document.addEventListener('change', function (ev) {
    const box = ev.target && ev.target.closest && ev.target.closest('[data-llm-pin]')
    if (!box || ev.target.name?.indexOf('_or_mode') < 0) return
    const mode = (box.querySelector('input[name$=_or_mode]:checked') || {}).value || 'offen'
    const pinField = box.querySelector('[data-or-pin-field]')
    const autoDetails = box.querySelector('[data-or-auto-details]')
    if (pinField) pinField.hidden = mode !== 'pin'
    if (autoDetails) {
      autoDetails.hidden = mode !== 'auto'
      autoDetails.open = mode === 'auto'
    }
  })

  // ---- a credential: show only the field the chosen mode needs ----
  //
  // "Where the key comes from" is a dropdown with two answers, and the block
  // used to show BOTH fields under it whatever one picked — so half of it was
  // always asking for something that would be ignored, and picking "stored in
  // Freilauf" left a box labelled "Name of the environment variable" underneath.
  //
  // Hidden AND disabled, the same pair as the OpenRouter pin above: a field one
  // cannot see must not still submit. The server renders the correct state
  // already (server/plugins/web.mjs) — this only keeps it in step while the
  // dropdown is used.
  //
  // Selected by FIELD NAME rather than by a data attribute, because the same
  // block is rendered by two modules: the Plugins page and the Welcome wizard,
  // which share the names `cred_<key>_mode|_env|_value` and nothing else. And
  // delegated, because a wizard step is a fresh page and a plugin card can be
  // re-rendered under it.
  function credSync(sel) {
    const prefix = sel.name.slice(0, -('_mode'.length))
    const box = sel.closest('.cred') || sel.form || document
    ;[['_env', 'env'], ['_value', 'value']].forEach(function (paar) {
      const field = box.querySelector('[name="' + prefix + paar[0] + '"]')
      if (!field) return
      const passt = sel.value === paar[1]
      const label = field.closest('label') || field
      label.hidden = !passt
      field.disabled = !passt
    })
  }
  const CRED_MODE = 'select[name^="cred_"][name$="_mode"]'
  document.querySelectorAll(CRED_MODE).forEach(credSync)
  document.addEventListener('change', function (ev) {
    const sel = ev.target && ev.target.closest && ev.target.closest(CRED_MODE)
    if (sel) credSync(sel)
  })

  // ---- toasts: say what happened without taking the page away ----
  // A Quick Run starts from wherever one is standing; being torn to a detail page
  // is exactly what would make it not quick. So the answer arrives here — with a
  // link for whoever does want to look.
  window.freilaufToast = function (text, opts) {
    opts = opts || {}
    const box = document.getElementById('freilauf-toasts')
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
    const FAV_KEY = 'freilauf.quickrun.favorite'

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
          window.freilaufToast(text, { kind: j.deferred ? 'warn' : 'ok', href: '/runs/' + j.runId })
        })
        .catch(function (err) {
          if (fehler) { fehler.hidden = false; fehler.textContent = err.message }
          else window.freilaufToast(err.message, { kind: 'err' })
        })
        .finally(function () { if (btn) btn.disabled = false })
    })

    // "More settings": the moment one wants more than the dialog asks, the run
    // stops being quick — open the FULL single-run form in a new window with
    // what is already here. The favorite travels in the URL (it IS the form's
    // template, resolved server-side), everything the dialog itself holds is
    // parked in sessionStorage first — a window this opener opens inherits a
    // copy of it, and the form page restores the fields at load.
    const qrFull = qrForm && qrForm.querySelector('[data-qr-full]')
    if (qrFull) {
      qrFull.addEventListener('click', function () {
        const repo = qrForm.querySelector('select[name=repo_id]').value
        const fav = qrForm.querySelector('select[name=favorite_id]').value
        if (!repo || !fav) return
        try {
          const data = []
          new FormData(qrForm).forEach(function (v, k) { if (typeof v === 'string') data.push([k, v]) })
          sessionStorage.setItem(QRFULL_KEY, JSON.stringify(data))
        } catch (err) { /* private mode: the form then opens with the favorite alone */ }
        window.open('/runs/new?repo=' + encodeURIComponent(repo) +
          '&favorite=' + encodeURIComponent(fav), '_blank')
        // The new window got its own copy at open time; the opener does not need
        // the blob any more, and a stale one would come back on the next click.
        try { sessionStorage.removeItem(QRFULL_KEY) } catch (err) { /* private mode */ }
        qrDialog.close()
      })
    }
  }

  // ---- "Find worktree extras" dialog (repo create/edit form) ----
  // The button sits next to the worktree-extras textarea; the dialog shows the
  // path from the form's path field and, once started, asks the hub — which
  // checks existence and "is a git project" algorithmically first and only then
  // calls the model. The answer REPLACES the textarea completely, which the
  // dialog warns about before the start button becomes useful.
  const extrasBtn = document.getElementById('extras-find')
  const extrasDialog = document.getElementById('extras-dialog')
  if (extrasBtn && extrasDialog) {
    const form = extrasBtn.closest('form')
    const pathIn = form && form.querySelector('input[name=path]')
    const extrasTa = form && form.querySelector('textarea[name=worktree_extras]')
    const pathOut = document.getElementById('extras-path')
    const errorOut = document.getElementById('extras-error')
    const workingOut = document.getElementById('extras-working')
    const startBtn = document.getElementById('extras-start')

    extrasBtn.addEventListener('click', function () {
      errorOut.hidden = true
      workingOut.hidden = true
      pathOut.textContent = pathIn && pathIn.value.trim() ? pathIn.value.trim() : '—'
      extrasDialog.showModal()
    })
    extrasDialog.querySelectorAll('[data-extras-close]').forEach(function (b) {
      b.addEventListener('click', function () { extrasDialog.close() })
    })

    startBtn.addEventListener('click', function () {
      const p = pathIn ? pathIn.value.trim() : ''
      if (!p) {
        errorOut.textContent = T('js.extras_no_path', 'Enter the path first.')
        errorOut.hidden = false
        return
      }
      startBtn.disabled = true
      errorOut.hidden = true
      workingOut.hidden = false
      const body = new URLSearchParams()
      body.append('path', p)
      fetch('/api/repos/extras-suggest', { method: 'POST', body: body, headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || T('js.error_generic', 'request failed'))
          if (extrasTa) extrasTa.value = JSON.stringify(j.extras, null, 2)
          extrasDialog.close()
          window.freilaufToast(T('js.extras_done', 'Worktree extras: {n}', { n: j.extras.length }), { kind: 'ok' })
        })
        .catch(function (err) {
          errorOut.textContent = err.message
          errorOut.hidden = false
        })
        .finally(function () {
          startBtn.disabled = false
          workingOut.hidden = true
        })
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
          if (location.pathname === '/runs/' + runId) document.title = 'Freilauf — ' + (j.title || neu)
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
  const STASH_PREFIX = 'freilauf:form:'
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
    // Setting .checked in code fires no event, so whoever listens for one has
    // not heard. The branch rule is the case that shows: without this the
    // pattern field stays hidden next to a restored "new branch".
    form.querySelectorAll('input[name=branch_mode]:checked')
      .forEach(function (r) { r.dispatchEvent(new Event('change', { bubbles: true })) })
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

  // ---- goal: the second prompt, and only where there is one ----
  // Which coding agents know a goal is the plugins' answer, not this file's:
  // the server writes it into `data-goal-harnesses`. Hidden means DISABLED too —
  // a field one cannot see must not be submitted either, otherwise switching the
  // coding agent would send along a condition the operator can no longer read.
  // The text itself stays put, so switching back and forth does not cost it.
  const goalBlock = document.getElementById('goal-block')
  if (goalBlock) {
    const harnessSel = document.querySelector('select[name=harness]')
    const koennen = (goalBlock.dataset.goalHarnesses || '').split(/\s+/).filter(Boolean)
    const goalFeld = goalBlock.querySelector('textarea')
    const goalSync = () => {
      const on = koennen.includes(harnessSel?.value ?? '')
      goalBlock.hidden = !on
      if (goalFeld) goalFeld.disabled = !on
    }
    harnessSel?.addEventListener('change', goalSync)
    goalSync()
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
    const orModeRadios = routing ? Array.from(routing.querySelectorAll('input[name=or_mode]')) : []
    const orProv = document.getElementById('or-prov')
    const orProvLabel = document.getElementById('or-prov-label')
    const orAutoDetails = document.getElementById('or-auto-details')
    const orAutoHint = document.getElementById('or-auto-hint')
    const orUnsupported = document.getElementById('or-unsupported')
    const orQuant = document.getElementById('or-quant')

    const orMode = () => orModeRadios.find(r => r.checked)?.value || 'offen'

    const provLabel = document.getElementById('prov-label')
    const provHint = document.getElementById('prov-hint')
    const zeitText = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: window.FREILAUF_TZ || undefined }) } catch { return '' } }

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
      // The block shows whenever OpenRouter is the provider — on EVERY harness.
      // Whether it can take effect is another question (opencode carries the
      // provider block in OPENCODE_CONFIG_CONTENT; hermes only knows a global
      // entry in ~/.hermes/config.yaml), and the note says so instead of
      // hiding the choice: the visible silence beats a field that pretends.
      const offen = provSel.value === 'openrouter'
      if (routing) routing.hidden = !offen
      if (orUnsupported) orUnsupported.hidden = !(offen && harnessSel?.value !== 'opencode')
      const mode = orMode()
      if (orProvLabel) orProvLabel.hidden = mode !== 'pin'
      if (orAutoDetails) {
        orAutoDetails.hidden = mode !== 'auto'
        orAutoDetails.open = mode === 'auto'
      }
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
      if (!modelInput.value.trim()) return
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
     * Auto mode's live preview: what the selection WOULD pin for this model
     * under the current requirements. Asks the same endpoint the start path
     * resolves through — same cache, so the preview cannot promise something
     * the start would not deliver. A failure shows its reason instead of a
     * checkbox that pretends nothing is happening.
     */
    async function ladeAutoVorschau() {
      if (!orAutoHint) return
      const model = modelInput.value.trim()
      if (!model || !routing || routing.hidden || orMode() !== 'auto') { orAutoHint.hidden = true; return }
      const params = new URLSearchParams({
        model,
        quant: orQuant?.value ?? '',
        region: routing.querySelector('select[name=or_region]')?.value ?? 'all',
        max_in: routing.querySelector('input[name=or_max_in]')?.value ?? '',
        max_out: routing.querySelector('input[name=or_max_out]')?.value ?? '',
      })
      try {
        const j = await (await fetch('/api/or-routing?' + params)).json()
        if (!j.ok) {
          orAutoHint.textContent = T('js.or_auto_fail', 'auto: no qualifying provider ({err})', { err: j.error || '?' })
          orAutoHint.hidden = false
          return
        }
        const preis = (j.prices || []).find(p => p.tag === j.best)
        orAutoHint.textContent = T('js.or_auto_ok', 'auto → {best} ({quant}){cache}', {
          best: j.best,
          quant: j.quant || '?',
          cache: j.cached ? ' · ' + T('js.or_cached', 'cached') : '',
        }) + (preis && preis.in_usd_mio != null
          ? ' · $' + preis.in_usd_mio + '/' + preis.out_usd_mio + ' /Mio' : '')
        orAutoHint.hidden = false
      } catch {
        orAutoHint.hidden = true
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
      let c = { provider: '', model: '', or_provider: '', or_routing: '', effort: '' }
      try {
        const j = await (await fetch('/api/run-choice?harness=' +
          encodeURIComponent(harnessSel?.value ?? ''))).json()
        if (j.ok && j.choice) c = j.choice
      } catch { /* no answer: start empty rather than keep the old coding agent's setup */ }
      provSel.dataset.gewaehlt = c.provider || ''
      provSel.value = c.provider || ''
      modelInput.value = c.model || ''
      if (effSel) { effSel.dataset.gewaehlt = c.effort || ''; effSel.value = '' }
      let cfg = {}
      try { cfg = JSON.parse(c.or_routing || '') ?? {} } catch { /* old choice: no routing stored */ }
      const mode = c.or_provider ? 'pin' : (cfg.mode === 'auto' ? 'auto' : 'offen')
      orModeRadios.forEach(r => { r.checked = r.value === mode })
      if (orQuant) orQuant.value = cfg.quant_min || ''
      const setField = (name, v) => {
        const el = routing?.querySelector(`[name=${name}]`)
        if (el && v != null) el.value = v
      }
      setField('or_region', cfg.location)
      setField('or_max_in', cfg.max_in)
      setField('or_max_out', cfg.max_out)
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
      if (provSel.value === 'openrouter' && orMode() === 'pin') ladeEndpunkte()
    }

    provSel.addEventListener('change', () => {
      provSel.dataset.gewaehlt = provSel.value; ladeModelle(); syncRouting(); ladeEffort()
    })
    harnessSel?.addEventListener('change', harnessGewechselt)
    orModeRadios.forEach(r => r.addEventListener('change', () => {
      syncRouting()
      if (orMode() === 'pin') ladeEndpunkte()
      if (orMode() === 'auto') ladeAutoVorschau()
    }))
    orQuant?.addEventListener('change', ladeAutoVorschau)
    routing?.querySelector('select[name=or_region]')?.addEventListener('change', ladeAutoVorschau)
    routing?.querySelector('input[name=or_max_in]')?.addEventListener('change', ladeAutoVorschau)
    routing?.querySelector('input[name=or_max_out]')?.addEventListener('change', ladeAutoVorschau)
    effSel?.addEventListener('change', () => { effSel.dataset.gewaehlt = effSel.value })
    modelInput.addEventListener('change', () => { ladeEndpunkte(); ladeAutoVorschau(); ladeEffort() })
    modelInput.addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(() => { ladeEndpunkte(); ladeAutoVorschau(); ladeEffort() }, 400)
    })
    syncRouting()
    ladeProvider()
    ladeEffort()
    if (provSel.value === 'openrouter' && orMode() === 'pin') ladeEndpunkte()
    if (provSel.value === 'openrouter' && orMode() === 'auto') ladeAutoVorschau()
  }

  // ---- send text into a session / end run (detail page) ----
  // NOT async: 'onsubmit="return freilaufSend(...)"' would otherwise receive a
  // promise — always truthy, and the browser would also submit classically.
  window.freilaufSend = function (form, url) {
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
  window.freilaufKill = function (id) {
    if (!confirm(T('js.kill_confirm', 'Really end this run?'))) return false
    fetch('/api/runs/' + id + '/kill', { method: 'POST' }).then(() => location.reload())
    return false
  }
  // The notification checkbox under the terminal: one request per click, nothing
  // reloads. The box is optimistic — it shows the click at once — and is put
  // back only when the server refuses, so a flaky request never leaves the page
  // claiming a silence the hub does not keep.
  const notifyBox = document.getElementById('notify-on')
  if (notifyBox) {
    notifyBox.addEventListener('change', () => {
      const wanted = notifyBox.checked
      const body = new URLSearchParams()
      body.set('on', wanted ? '1' : '0')
      fetch('/api/runs/' + notifyBox.dataset.run + '/notify', { method: 'POST', body })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
        .then(j => { notifyBox.checked = j.notify_on === 1 })
        // Its own string: what failed here is SAVING a checkbox, not sending a
        // message, and 'Send failed' would say the opposite of what happened.
        .catch(err => { notifyBox.checked = !wanted; alert(T('js.notify_toggle_failed', 'Could not change the notification setting: ') + err.message) })
    })
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
    const STORE_KEY = 'freilauf.sessions.showRunning'

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

  // ---- tmux memory cleanup: sidebar button + Sessions page box ----
  // Both triggers (the small button in the sidebar's tmux block and the button
  // on the Sessions page) open the SAME modal and ask the same question — free
  // the machine's tmux memory down to which GB. The modal is rendered by the
  // server (layout), so the triggers only open it; the dialog's submit starts
  // the configured agent. The sidebar is replaced whole every 30 s, so the
  // triggers listen on document — delegation survives the swap, and the one
  // modal is stable on the page, never inside a replaced block.
  function startCleanup(body, done) {
    fetch('/api/cleanup/start', { method: 'POST', body: body, headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.json().then(function (j) { return { status: r.status, j: j } })
      })
      .then(function (x) {
        var j = x.j
        if (x.status !== 200 || !j.ok) {
          if (done) done({ ok: false, error: j.error || T('js.cleanup_failed', 'Could not start the cleanup agent.') })
          return
        }
        window.freilaufToast(T('js.cleanup_started', 'Memory cleanup started — target {target} GB', { target: j.targetGb }), {
          href: '/runs/' + j.runId, linkText: T('js.toast_open', 'open'),
        })
        if (done) done({ ok: true })
      })
      .catch(function () {
        if (done) done({ ok: false, error: T('js.cleanup_failed', 'Could not start the cleanup agent.') })
      })
  }

  function cleanupDialog() { return document.getElementById('cleanup-dialog') }
  function openCleanupDialog(source) {
    var d = cleanupDialog()
    if (!d) return
    d.dataset.source = source || 'manual'
    if (!d.open) d.showModal()
  }
  function closeCleanupDialog() {
    var d = cleanupDialog()
    if (d && d.open) d.close()
  }

  document.addEventListener('click', function (ev) {
    if (ev.target.closest && ev.target.closest('.mem-free-open')) { openCleanupDialog('sidebar'); return }
    if (ev.target.closest && ev.target.closest('.cleanup-free-open')) { openCleanupDialog('sessions'); return }
    if (ev.target.closest && ev.target.closest('[data-cleanup-close]')) { closeCleanupDialog(); return }
    // A click on the backdrop closes the modal, like any plain dialog — but not
    // one that lands inside it, which would close it the moment it is clicked.
    var d = cleanupDialog()
    if (d && d.open && ev.target === d) closeCleanupDialog()
  })

  document.addEventListener('submit', function (ev) {
    var form = ev.target
    if (!form || form.id !== 'cleanup-dialog-form') return
    ev.preventDefault()
    var t = form.querySelector('input[name="target"]')
    var keep = form.querySelector('input[name="keep"]')
    var body = new URLSearchParams()
    body.set('target_gb', (t && t.value) || '')
    body.set('source', (cleanupDialog() && cleanupDialog().dataset.source) || 'manual')
    if (keep) body.set('keep', (keep && keep.value) || '')
    var err = document.getElementById('cleanup-dialog-error')
    if (err) err.hidden = true
    var btn = form.querySelector('button[type="submit"]')
    if (btn) btn.disabled = true
    startCleanup(body, function (res) {
      if (btn) btn.disabled = false
      if (!res || res.ok) { closeCleanupDialog() }
      else if (err) { err.textContent = res.error; err.hidden = false }
    })
  })

  // ---- Repos: confirm before a repository goes ----
  //
  // One dialog per row, rendered by the server with the real counts and the
  // real paths in it. This code does exactly two things: open and close it, and
  // keep the delete button disabled until the typed name matches the repo's.
  // The server checks the name again — the hub has no authentication, and a
  // fence that only exists in the browser is not a fence.
  //
  // Delegation on `document`, not a listener per row: the Repos page is
  // re-rendered whole on every navigation, and a direct listener would be gone.
  function repoDelDialog(id) { return document.getElementById('repo-del-' + id) }
  function closeRepoDel() {
    var open = document.querySelector('dialog.repo-del[open]')
    if (open) open.close()
  }

  document.addEventListener('click', function (ev) {
    if (!ev.target.closest) return
    var opener = ev.target.closest('.repo-delete-open')
    if (opener) {
      var d = repoDelDialog(opener.dataset.repo)
      if (d && !d.open) {
        // Always reopened empty: a name left in the field from a previous look
        // would arm the button before anybody typed anything.
        var field = d.querySelector('.repo-del-name')
        if (field) field.value = ''
        var go = d.querySelector('.repo-del-go')
        if (go) go.disabled = true
        var hidden = d.querySelector('.repo-del-confirm')
        if (hidden) hidden.value = ''
        d.showModal()
      }
      return
    }
    if (ev.target.closest('[data-repo-del-close]')) { closeRepoDel(); return }
    var open = document.querySelector('dialog.repo-del[open]')
    if (open && ev.target === open) closeRepoDel()
  })

  document.addEventListener('input', function (ev) {
    var field = ev.target
    if (!field.classList || !field.classList.contains('repo-del-name')) return
    var d = field.closest('dialog.repo-del')
    if (!d) return
    var matches = field.value === d.dataset.name
    var go = d.querySelector('.repo-del-go')
    var hidden = d.querySelector('.repo-del-confirm')
    // The hidden field is what actually travels; the visible one is the gesture.
    if (hidden) hidden.value = matches ? field.value : ''
    if (go) go.disabled = !matches
  })

  // ---- Settings -> Freilauf skills: confirm before the files go ----
  //
  // Unticking "install the skills" is the one settings change on this hub that
  // DELETES something from directories that belong to other programs, so it
  // does not happen on a stray click. The dialog is rendered by the server on
  // that page and already lists the exact directories — nothing here composes a
  // sentence, which is also why none of this needs a `js.*` translation.
  //
  // The form's own `data-was-on` is what makes the question askable at all: it
  // records the state the page was RENDERED with, so unticking a box that was
  // already off is not a removal and asks nothing.
  function skillsDialog() { return document.getElementById('skills-remove-dialog') }
  function closeSkillsDialog() {
    var d = skillsDialog()
    if (d && d.open) d.close()
  }

  document.addEventListener('click', function (ev) {
    if (!ev.target.closest) return
    if (ev.target.closest('[data-skills-close]')) { closeSkillsDialog(); return }
    if (ev.target.closest('#skills-remove-confirm')) {
      var form = document.getElementById('skills-form')
      closeSkillsDialog()
      // `dataset.confirmed` is the one-shot pass: the submit handler below lets
      // it through and clears it again, so a second edit asks again.
      if (form) { form.dataset.confirmed = '1'; form.submit() }
      return
    }
    var d = skillsDialog()
    if (d && d.open && ev.target === d) closeSkillsDialog()
  })

  // "Keep them up to date" is a switch about nothing while the installation is
  // off, so it is not on the page at all then. Hiding it is not enough: its
  // hidden `0` companion would keep posting, and a save with the installation
  // off would quietly overwrite a preference the operator had left on. So both
  // inputs are disabled along with it — the same rule the goal field follows.
  document.addEventListener('change', function (ev) {
    var box = ev.target
    if (!box.name || box.name !== 'skills_install' || box.type !== 'checkbox') return
    // The update switch and the per-skill picker are both switches about nothing
    // while the installation is off, and both must be DISABLED and not merely
    // hidden: a hidden checkbox that still submits would rewrite a selection
    // nobody could see.
    var rows = [document.getElementById('skills-auto'), document.getElementById('skills-pick')]
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r]
      if (!row) continue
      row.hidden = !box.checked
      var felder = row.querySelectorAll('input')
      for (var i = 0; i < felder.length; i++) felder[i].disabled = !box.checked
    }
  })

  document.addEventListener('submit', function (ev) {
    var form = ev.target
    if (!form || form.id !== 'skills-form') return
    if (form.dataset.confirmed === '1') { delete form.dataset.confirmed; return }
    var box = form.querySelector('input[type="checkbox"][name="skills_install"]')
    var d = skillsDialog()
    // Only the transition on -> off asks. Everything else saves straight away.
    if (!box || box.checked || form.dataset.wasOn !== '1' || !d) return
    ev.preventDefault()
    if (!d.open) d.showModal()
  })

  // ---- status sidebar: collapsible, and the state survives the page ----
  //
  // The open/closed class sits on the SHELL, not on the sidebar: the live
  // channel replaces #status-sidebar whole, and a class on the element itself
  // would be thrown away with it on every update. sidebarSync() is therefore
  // called again after each swap — it reads the one truth (localStorage) and
  // writes it to the two places that show it, the shell and the button.
  //
  // Every localStorage access in try/catch, like freilauf.sessions.showRunning:
  // in a private window the accessor itself throws, and a status panel is not
  // worth a page that stops working.
  var SIDEBAR_KEY = 'freilauf.sidebar.open'
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
      const incidents = tbody.dataset.incidents || ''
      const html = await holeFragment('/api/fragments/runs-body' + (repo ? '?repo=' + encodeURIComponent(repo) : '?')
        + (status ? '&status=' + encodeURIComponent(status) : '')
        + (incidents ? '&incidents=' + encodeURIComponent(incidents) : ''))
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
      // The "Edit this run" card is part of the fragment, and an edit in
      // progress is typing that lives only in the DOM — swapping it would throw
      // the half-written prompt away. Wait for the next event instead.
      if (document.querySelector('#run-edit :focus')) return
      tauscheNachId(html)
      // Unlike the other blocks the card is CONDITIONAL: a finished run is not
      // editable, and tauscheNachId only replaces by id — an element absent
      // from the new fragment would otherwise linger as a stale form that the
      // server would refuse. Remove it when the fragment no longer has one.
      if (!/id="run-edit"/.test(html)) {
        const alte = document.getElementById('run-edit')
        if (alte) alte.remove()
      }
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

    // The panel's statistics (subscription usage, provider balances) move on
    // their OWN clock, not with run events: a long-running agent burns quota
    // without a single event, and without a timer the sidebar sat frozen at
    // page-load values until the next run event or reload. A periodic re-fetch
    // closes that. It goes through the SAME fragment the run events use, so the
    // server's panel cache (usage.mjs) decides how often the vendors are really
    // asked — this timer only makes sure something asks, and the
    // stale-while-revalidate refresh lands on the next tick. Skipped while the
    // tab is hidden; browsers throttle timers there anyway.
    // Overridable for the browser suite, which must not wait thirty seconds.
    const POLL_MS = Math.max(1000, Number(window.FREILAUF_SIDEBAR_POLL_MS) || 30_000)
    setInterval(() => {
      if (document.hidden) return
      statusAktualisieren().catch(() => {})
    }, POLL_MS)

    // While the header stands on ANOTHER repo than the page — a run detail
    // after the switcher was used, which the page says out loud — one filter
    // cannot serve both: the detail wants its own run's repo, the sidebar counts
    // the chosen one. So the stream is left unfiltered for that stretch. Nothing
    // misfires on the extra events: every handler is keyed on a run id, and the
    // one that is not (the tbody) only exists on pages that follow the switcher,
    // where the two repos are the same value by construction.
    const sidebarRepo = document.getElementById('status-sidebar')?.dataset.repo || ''
    const filter = sidebarRepo && repo && sidebarRepo !== repo ? '' : repo
    const quelle = new EventSource('/api/events' + (filter ? '?repo=' + encodeURIComponent(filter) : ''))
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
  // data-live comes from pages.mjs and means the same as there: a standing tmux
  // session with a live process in it — NOT "the run is still going". A claude,
  // opencode or cursor that has reported 'done' is still sitting in its TUI,
  // and typing a follow-up into it is the whole point of keeping the session.
  // Earlier an innerHTML.includes('live') sat here — that would have granted
  // write access to a dead session for a run named "live-…" or the word in a
  // report. Without a session it stays view-only; 'ro' must be explicitly '0',
  // the server is fail-closed.
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
