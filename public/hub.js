// cc-hub — kleines Vanilla-JS: Repo-Umschalter, Terminal-Client (xterm.js), Formular-Helfer.
(function () {
  'use strict'

  // ---- Repo-Umschalter im Seitenkopf: ?repo=… an die aktuelle Seite hängen ----
  const repoSwitch = document.getElementById('repo-switch')
  if (repoSwitch) {
    repoSwitch.addEventListener('change', () => {
      const u = new URL(location.href)
      u.searchParams.set('repo', repoSwitch.value)
      // Bei festen Pfaden (/agents/edit?id=…) repo einfach ergänzen.
      location.href = u.pathname + u.search
    })
  }

  // ---- Zeitplan-Auswahl: immer nur den Block der gewählten Art zeigen ----
  const kindSel = document.getElementById('schedule-kind')
  if (kindSel) {
    const bloecke = Array.from(document.querySelectorAll('.zp'))
    const sync = () => bloecke.forEach(b => { b.hidden = b.dataset.kind !== kindSel.value })
    kindSel.addEventListener('change', sync)
    sync()
    // Startwoche nur zeigen, wenn der Takt sie überhaupt braucht.
    const takt = document.querySelector('select[name=schedule_weeks]')
    const anker = document.querySelector('input[name=schedule_anchor]')?.closest('label')
    if (takt && anker) {
      const syncAnker = () => { anker.hidden = takt.value === '1' }
      takt.addEventListener('change', syncAnker)
      syncAnker()
    }
  }

  // ---- Provider- und Modellauswahl ----
  // Die Liste kommt NACH dem Rendern per fetch: hängt eine Provider-API, steht trotzdem
  // sofort ein Textfeld da, in das man den Slug direkt tippen kann. Die Suchfunktion
  // erledigt <datalist> von sich aus (Substring-Filter beim Tippen).
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
    const zeitText = (iso) => { try { return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

    // Jede Harness kann andere Provider — claude gar keinen (dort gibt es nur das Abo).
    // Deshalb wird die Auswahl bei jedem Harness-Wechsel neu geholt, statt eine feste
    // Liste anzubieten, in der die Hälfte nicht funktioniert.
    async function ladeProvider() {
      const harness = harnessSel?.value ?? 'claude'
      const gewaehlt = provSel.dataset.gewaehlt || provSel.value || ''
      try {
        const j = await (await fetch('/api/providers?harness=' + encodeURIComponent(harness))).json()
        if (harness === 'claude' || harness === 'cursor') {
          // claude und cursor laufen über ihr Abo: kein Provider, dafür direkt die
          // Modelle des Kontos. Bei cursor kommt die Liste aus 'cursor-agent models'
          // und trägt den Denk-Aufwand schon in der ID — deshalb bleibt das
          // Effort-Feld dort leer und ausgeblendet.
          provLabel.hidden = true
          provSel.value = ''
          provHint.textContent = ''
          await ladeModelle(harness)
          return
        }
        provLabel.hidden = false
        provSel.innerHTML = '<option value="">— keiner: Modell frei eintippen —</option>' +
          j.provider.map(p => '<option value="' + p.id + '">' + p.label +
            (p.hinweis ? ' (' + p.hinweis + ')' : '') + '</option>').join('')
        if (j.provider.some(p => p.id === gewaehlt)) provSel.value = gewaehlt
        provHint.textContent = j.provider.length
          ? 'nur Provider, für die hier auch Zugangsdaten vorliegen'
          : 'für diese Harness sind keine Zugangsdaten hinterlegt — Modell frei eintippen'
        await ladeModelle()
      } catch {
        provHint.textContent = 'Providerliste nicht abrufbar — Modell frei eintippen'
      }
    }

    async function ladeModelle(erzwingen) {
      const quelle = erzwingen ?? provSel.value
      liste.innerHTML = ''
      if (!quelle) { hinweis.textContent = ''; return }
      hinweis.textContent = 'lade Modelle …'
      try {
        const r = await fetch('/api/models?provider=' + encodeURIComponent(quelle) +
          '&harness=' + encodeURIComponent(harnessSel?.value ?? ''))
        const j = await r.json()
        if (!j.ok) { hinweis.textContent = 'Liste nicht erreichbar (' + j.error + ') — Modell-Slug bitte direkt eintippen.'; return }
        liste.innerHTML = j.models.map(m =>
          '<option value="' + m.id + '">' + (m.name !== m.id ? m.name : '') +
          (m.frei ? ' · frei' : '') + (m.ctx ? ' · ' + Math.round(m.ctx / 1000) + 'k' : '') +
          // Cursors Fast-Modus ist teurer und nicht der Regelfall — sichtbar machen,
          // statt ihn wie eine gleichwertige Variante aussehen zu lassen.
          (m.fast ? ' · FAST (teurer)' : '') +
          (m.tools ? '' : ' · ohne Tools') + '</option>').join('')
        // 'katalog' heißt: die Liste kommt aus dem Anbieter-Katalog statt aus dem lokalen
        // opencode — dann kann darin stehen, was hier mangels Schlüssel gar nicht läuft.
        const ausKatalog = j.models.some(m => m.katalog)
        // Bei cursor beantwortet die Modellwahl zugleich die Effort-Frage — das
        // Denk-Aufwand-Feld bleibt deshalb aus. Ohne diesen Satz sucht man es.
        const cursorNote = (harnessSel?.value === 'cursor')
          ? ' · Der Denk-Aufwand steckt in der ID (…-low/-medium/-high/-xhigh/-max);'
            + ' IDs mit „-fast“ sind Cursors Schnellmodus — im Regelfall die Variante ohne.'
          : ''
        hinweis.textContent = j.models.length + ' Modelle' +
          (j.stand ? ' · Stand ' + zeitText(j.stand) : '') +
          (j.veraltet ? ' (Liste gerade nicht erreichbar, zeige den letzten Stand)' : '') +
          (ausKatalog ? ' · aus dem Anbieter-Katalog: nicht alles davon ist hier ohne Schlüssel nutzbar' : '') +
          cursorNote +
          ' · Tippen filtert, eigener Slug ist jederzeit erlaubt.'
      } catch (err) {
        hinweis.textContent = 'Liste nicht erreichbar (' + err.message + ') — Modell-Slug bitte direkt eintippen.'
      }
    }

    function syncRouting() {
      // Serving-Provider lässt sich nur bei opencode pro Lauf durchreichen; hermes
      // kennt dafür ausschließlich einen globalen Eintrag in ~/.hermes/config.yaml.
      const moeglich = harnessSel?.value === 'opencode' && provSel.value === 'openrouter'
      routing.hidden = !moeglich
      if (!moeglich && pin) pin.checked = false
      if (orProvLabel) orProvLabel.hidden = !(pin && pin.checked)
    }

    const effLabel = document.getElementById('effort-label')
    const effSel = document.getElementById('effort')
    const effHint = document.getElementById('effort-hint')

    /**
     * Denk-Aufwand: Feld nur zeigen, wenn diese Kombination wirklich Stufen kennt.
     * Ausblenden statt ausgrauen — ein graues Feld erklärt nichts, und ein Feld, das
     * nichts bewirkt, ist schlimmer als keines: bei opencode und hermes verpufft eine
     * ungültige Stufe lautlos.
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
        effSel.innerHTML = '<option value="">— Standard' + (j.standard ? ' (' + j.standard + ')' : '') + ' —</option>' +
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
      orProv.innerHTML = '<option value="">lade …</option>'
      try {
        const r = await fetch('/api/or-endpoints?model=' + encodeURIComponent(modelInput.value.trim()))
        const j = await r.json()
        if (!j.ok || !j.endpoints.length) {
          orProv.innerHTML = '<option value="">— keine Angaben, Slug unten eintippen —</option>'
          return
        }
        // Wert ist IMMER der tag: der Anzeigename ist nicht eindeutig (mehrere Regionen
        // heißen gleich), man würde sonst einen anderen Anbieter festnageln als gedacht.
        orProv.innerHTML = j.endpoints.map(ep =>
          '<option value="' + ep.tag + '">' + ep.name + ' — ' + ep.tag +
          (ep.uptime != null ? ' (' + Math.round(ep.uptime) + '% Uptime)' : '') + '</option>').join('')
      } catch {
        orProv.innerHTML = '<option value="">— nicht abrufbar —</option>'
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

  // ---- Text in Session senden / Lauf beenden (Detailseite) ----
  // NICHT async: 'onsubmit="return cchubSend(...)"' bekäme sonst ein Promise zurück —
  // immer truthy, und der Browser würde das Formular zusätzlich klassisch abschicken.
  window.cchubSend = function (form, url) {
    const ta = form.querySelector('textarea')
    if (!ta.value.trim()) return false
    const body = new URLSearchParams()
    body.set('text', ta.value)
    const btn = form.querySelector('button')
    if (btn) btn.disabled = true
    fetch(url, { method: 'POST', body })
      .then(r => { if (!r.ok) alert('Senden fehlgeschlagen: HTTP ' + r.status) })
      .catch(err => alert('Senden fehlgeschlagen: ' + err.message))
      .finally(() => { if (btn) btn.disabled = false })
    ta.value = ''
    return false
  }
  window.cchubKill = function (id) {
    if (!confirm('Diesen Lauf wirklich beenden?')) return false
    fetch(`/api/runs/${id}/kill`, { method: 'POST' }).then(() => location.reload())
    return false
  }

  // ---- Terminal: xterm.js + Resize-Frame \0{cols},{rows} (Planung 7.4) ----
  // xterm.js stellt die Globals 'Terminal' und 'FitAddon' bereit — nicht 'Term'.
  const termBox = document.getElementById('term')
  if (!termBox || typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') return

  const runMatch = location.pathname.match(/^\/runs\/([0-9a-f-]{36})$/)
  if (!runMatch) return
  // Ohne tmux-Session gäbe es nur einen 404 beim Handshake und einen leeren Kasten.
  if (termBox.dataset.session === '0') {
    termBox.textContent = 'Keine tmux-Session mehr — der Verlauf steht unten im Log.'
    termBox.classList.add('dim')
    return
  }
  // data-live kommt aus pages.mjs und meint dasselbe wie dort: laufender Status UND
  // offene tmux-Session. Früher stand hier ein innerHTML.includes('live') — das hätte
  // bei einem Lauf namens „live-…" oder dem Wort im Report Schreibrechte auf eine tote
  // Session gegeben. Ohne Session bleibt es beim Zusehen; 'ro' muss explizit '0' sein,
  // der Server ist fail-closed.
  const live = termBox.dataset.live === '1'
  const ro = live ? '&ro=0' : '&ro=1'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  let ws
  try { ws = new WebSocket(`${proto}://${location.host}/term?run=${runMatch[1]}${ro}`) } catch { return }

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
  ws.onclose = () => term.write('\r\n\x1b[90m— Verbindung geschlossen —\x1b[0m\r\n')
  ws.onerror = () => term.write('\r\n\x1b[90m— Terminal nicht erreichbar (Session beendet?) —\x1b[0m\r\n')
  term.onData(d => { if (ws.readyState === WebSocket.OPEN && live) ws.send(d) })

  new ResizeObserver(() => {
    try {
      fitAddon.fit()
      sendSize()
    } catch {}
  }).observe(termBox)
}())
