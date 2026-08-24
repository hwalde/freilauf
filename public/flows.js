// cc-hub flows — designer page (vanilla JS on top of sequential-workflow-designer).
// Everything it needs comes from window.CCHUB_FLOWS: the i18n catalog (flows.*),
// the step registry (meta.steps — one source of truth with server/flows/steps.mjs),
// select lists (agents, repos, harnesses) and the flow being edited.
(function () {
  const { i18n, meta, flow } = window.CCHUB_FLOWS
  const { Designer, Uid } = window.sequentialWorkflowDesigner
  const T = (key, params = {}) => String(i18n[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`)
  const stepMeta = Object.fromEntries(meta.steps.map(s => [s.type, s]))
  const stepLabel = (type) => T(`flows.step.${type}`)
  const $ = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else if (k === 'html') el.innerHTML = v
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v)
    }
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)))
    return el
  }

  let trigger = flow.trigger
  let dirty = false
  const status = document.getElementById('flow-status')
  const setStatus = (text, cls = 'dim') => { status.textContent = text; status.className = cls }

  // ---------------- toolbox ----------------
  function toolboxStep(type) {
    const s = stepMeta[type]
    const props = {}
    for (const f of s.fields) props[f.key] = f.default ?? (f.kind === 'checkbox' ? false : f.kind === 'fields' ? [] : '')
    const step = { componentType: s.component, type, name: stepLabel(type), properties: props }
    if (s.component === 'switch') step.branches = Object.fromEntries(s.branches.map(b => [b, []]))
    if (s.component === 'container') step.sequence = []
    return step
  }
  const groups = meta.groups.map(g => ({
    name: T(`flows.group.${g}`),
    steps: meta.steps.filter(s => s.group === g).map(s => toolboxStep(s.type)),
  }))

  // ---------------- validation (mirror of validateDefinition on the server) ----------------
  const visible = (f, props) => !f.showIf || Object.entries(f.showIf).every(([k, v]) => props[k] === v)
  function stepValid(step) {
    const s = stepMeta[step.type]
    if (!s) return false
    const props = step.properties ?? {}
    return s.fields.every(f => {
      if (!f.required || !visible(f, props)) return true
      const v = props[f.key]
      return !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length))
    })
  }

  // ---------------- variables hint ----------------
  const RUN_FIELDS = ['id', 'short_id', 'status', 'outcome', 'ended_normally', 'agent_name', 'repo_name', 'harness', 'model', 'branch', 'pr_url', 'report', 'duration_min', 'help_text', 'url']
  function collectOutputVars(def) {
    const out = []
    const walk = (seq) => {
      for (const st of seq ?? []) {
        const s = stepMeta[st.type]
        if (s?.output) out.push(String(st.properties?.outputVar || st.type))
        // "for each" publishes its current element (and its 1-based position).
        if (st.type === 'for_each') {
          const v = String(st.properties?.itemVar || 'item')
          out.push(v, `${v}_index`)
        }
        if (st.branches) for (const b of Object.values(st.branches)) walk(b)
        if (st.sequence) walk(st.sequence)
      }
    }
    walk(def.sequence)
    return [...new Set(out)]
  }
  function variablesHint(def) {
    const items = [
      ...RUN_FIELDS.map(f => `{{trigger.run.${f}}}`),
      ...collectOutputVars(def).map(v => `{{vars.${v}}}`),
    ]
    return $('details', { class: 'flow-vars' }, $('summary', {}, T('flows.editor.variables')),
      $('p', { class: 'dim' }, T('flows.editor.variables_hint')),
      $('div', { class: 'chips' }, items.map(v => $('code', { onclick: () => navigator.clipboard?.writeText(v) }, v))))
  }

  // ---------------- root editor: name, trigger ----------------
  function rootEditor(definition) {
    const box = $('div', { class: 'flow-editor' })
    box.append($('h3', {}, T('flows.trigger')))
    const kindSel = $('select', {}, meta.triggerKinds.map(k => $('option', { value: k, selected: trigger.kind === k }, T(`flows.trigger.${k}`))))
    box.append($('label', {}, T('flows.trigger.kind'), kindSel))
    const detail = $('div')
    const renderDetail = () => {
      detail.replaceChildren()
      if (trigger.kind === 'run_finished') {
        const agents = $('select', { multiple: true, size: Math.min(8, Math.max(3, meta.agents.length)) },
          meta.agents.map(a => $('option', { value: a.id, selected: (trigger.agentIds ?? []).includes(a.id) }, `${a.name} (${a.repo})`)))
        agents.addEventListener('change', () => { trigger.agentIds = [...agents.selectedOptions].map(o => +o.value); touch() })
        detail.append($('label', {}, T('flows.trigger.agents'), agents, $('span', { class: 'dim' }, ' ' + T('flows.trigger.agents_hint'))))
        const repo = $('select', {}, $('option', { value: '' }, T('flows.trigger.any_repo')),
          meta.repos.map(r => $('option', { value: r.id, selected: trigger.repoId === r.id }, r.name)))
        repo.addEventListener('change', () => { trigger.repoId = +repo.value || null; touch() })
        detail.append($('label', {}, T('flows.trigger.repo'), repo))
        const oc = $('div', { class: 'tage' }, meta.outcomes.map(o => {
          const cb = $('input', { type: 'checkbox', checked: (trigger.outcomes ?? meta.outcomes).includes(o) })
          cb.addEventListener('change', () => {
            const set = new Set(trigger.outcomes ?? meta.outcomes); cb.checked ? set.add(o) : set.delete(o)
            trigger.outcomes = meta.outcomes.filter(x => set.has(x)); touch()
          })
          return $('label', { class: 'tag' }, cb, T(`flows.outcome.${o}`))
        }))
        detail.append($('div', {}, T('flows.trigger.outcomes'), oc))
        const single = $('input', { type: 'checkbox', checked: trigger.singleRuns !== false })
        single.addEventListener('change', () => { trigger.singleRuns = single.checked; touch() })
        detail.append($('label', { class: 'chk' }, single, T('flows.trigger.single_runs')))
        const fs = $('input', { type: 'checkbox', checked: trigger.flowStarted === true })
        fs.addEventListener('change', () => { trigger.flowStarted = fs.checked; touch() })
        detail.append($('label', { class: 'chk' }, fs, T('flows.trigger.flow_started')), $('p', { class: 'dim' }, T('flows.trigger.flow_started_hint')))
      } else if (trigger.kind === 'cron') {
        const inp = $('input', { value: trigger.expr ?? '', placeholder: '30 6 * * 1-5' })
        inp.addEventListener('input', () => { trigger.expr = inp.value; touch() })
        detail.append($('label', {}, T('flows.trigger.cron_expr'), inp))
      } else {
        detail.append($('p', { class: 'dim' }, T('flows.trigger.manual_hint')))
      }
    }
    kindSel.addEventListener('change', () => { trigger = { kind: kindSel.value, agentIds: [], outcomes: [...meta.outcomes], singleRuns: true, flowStarted: false, expr: '' }; renderDetail(); touch() })
    renderDetail()
    box.append(detail, variablesHint(definition))
    return box
  }

  // ---------------- step editor ----------------
  function optionLabel(fieldKey, value) {
    const prefix = { target: 'flows.target.', source: 'flows.source.', op: 'flows.op.', branchMode: 'flows.branch_mode.' }[fieldKey]
    return prefix ? T(prefix + value) : value
  }
  function fieldsEditor(list, onChange) {
    const wrap = $('div', { class: 'fields-editor' })
    const render = () => {
      wrap.replaceChildren()
      list.forEach((f, i) => {
        const name = $('input', { value: f.name ?? '', placeholder: T('flows.editor.field_name') })
        const type = $('select', {}, meta.fieldTypes.map(tp => $('option', { value: tp, selected: (f.type ?? 'string') === tp }, T(`flows.field_type.${tp}`))))
        const desc = $('input', { value: f.description ?? '', placeholder: T('flows.editor.field_desc') })
        const en = $('input', { value: f.enumValues ?? '', placeholder: T('flows.editor.field_enum') })
        name.addEventListener('input', () => { f.name = name.value; onChange() })
        type.addEventListener('change', () => { f.type = type.value; onChange() })
        desc.addEventListener('input', () => { f.description = desc.value; onChange() })
        en.addEventListener('input', () => { f.enumValues = en.value; onChange() })
        wrap.append($('div', { class: 'field-row' }, name, type, desc, en,
          $('button', { type: 'button', class: 'danger', onclick: () => { list.splice(i, 1); render(); onChange() } }, '×')))
      })
      wrap.append($('button', { type: 'button', onclick: () => { list.push({ name: '', type: 'string', description: '', enumValues: '' }); render(); onChange() } }, T('flows.editor.fields_add')))
    }
    render()
    return wrap
  }

  function stepEditor(step, context, definition) {
    const s = stepMeta[step.type]
    const box = $('div', { class: 'flow-editor' })
    if (!s) { box.append($('p', { class: 'err' }, `unknown step ${step.type}`)); return box }
    box.append($('h3', {}, stepLabel(step.type)), $('p', { class: 'dim' }, T(`flows.step.${step.type}.desc`)))
    const name = $('input', { value: step.name })
    name.addEventListener('input', () => { step.name = name.value; context.notifyNameChanged() })
    box.append($('label', {}, T('flows.editor.step_name'), name))
    const props = step.properties
    const fieldsBox = $('div')
    const changed = () => { context.notifyPropertiesChanged() }
    const renderFields = () => {
      fieldsBox.replaceChildren()
      for (const f of s.fields) {
        if (!visible(f, props)) continue
        const label = T(`flows.field.${f.key}`) + (f.required ? ' *' : '')
        let input
        switch (f.kind) {
          case 'textarea':
            input = $('textarea', { rows: 5, placeholder: f.placeholder ?? '' }); input.value = props[f.key] ?? ''
            input.addEventListener('input', () => { props[f.key] = input.value; changed() }); break
          case 'number':
            input = $('input', { type: 'number', value: props[f.key] ?? '' })
            input.addEventListener('input', () => { props[f.key] = input.value; changed() }); break
          case 'checkbox':
            input = $('input', { type: 'checkbox', checked: !!props[f.key] })
            input.addEventListener('change', () => { props[f.key] = input.checked; changed() })
            fieldsBox.append($('label', { class: 'chk' }, input, label)); continue
          case 'select':
            input = $('select', {}, f.options.map(o => $('option', { value: o, selected: props[f.key] === o }, optionLabel(f.key, o))))
            input.addEventListener('change', () => { props[f.key] = input.value; changed(); renderFields() }); break
          case 'agent':
            input = $('select', {}, $('option', { value: '' }, '–'), meta.agents.map(a => $('option', { value: a.id, selected: String(props[f.key]) === String(a.id) }, `${a.name} (${a.repo})`)))
            input.addEventListener('change', () => { props[f.key] = input.value; changed() }); break
          case 'repo':
            input = $('select', {}, $('option', { value: '' }, '–'), meta.repos.map(r => $('option', { value: r.id, selected: String(props[f.key]) === String(r.id) }, r.name)))
            input.addEventListener('change', () => { props[f.key] = input.value; changed() }); break
          case 'harness':
            input = $('select', {}, $('option', { value: '' }, '–'), meta.harnesses.map(h => $('option', { value: h.id, selected: props[f.key] === h.id }, h.label)))
            input.addEventListener('change', () => { props[f.key] = input.value; changed() }); break
          case 'fields':
            if (!Array.isArray(props[f.key])) props[f.key] = []
            input = fieldsEditor(props[f.key], changed); break
          default:
            input = $('input', { value: props[f.key] ?? '', placeholder: f.placeholder ?? '' })
            input.addEventListener('input', () => { props[f.key] = input.value; changed() })
        }
        const hintKey = `flows.field.${f.key}.hint`
        fieldsBox.append($('label', {}, label, input, i18n[hintKey] ? $('span', { class: 'dim hint' }, T(hintKey)) : null))
      }
    }
    renderFields()
    box.append(fieldsBox, variablesHint(definition))
    return box
  }

  // ---------------- designer ----------------
  const designer = Designer.create(document.getElementById('flow-designer'), flow.definition, {
    theme: 'light',
    undoStackSize: 20,
    controlBar: true,
    steps: {
      // One line drawing per group as an inline SVG — no image files, no external
      // hosts, and no dependency on the platform's emoji font.
      iconUrlProvider: (_componentType, type) => {
        const d = {
          agents: '<rect x="4" y="7.5" width="16" height="11.5" rx="3"/><path d="M12 3.5v4"/><path d="M9.5 12.5v1.5M14.5 12.5v1.5"/>',
          data: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/><path d="M9 12.5h6M9 16h6"/>',
          control: '<path d="M5 4.5v7a3 3 0 0 0 3 3h11"/><path d="M15.5 11l3.5 3.5-3.5 3.5"/>',
          notify: '<path d="M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
        }[stepMeta[type]?.group] ?? '<circle cx="12" cy="12" r="6.5"/>'
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#334155" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
      },
    },
    toolbox: { groups, labelProvider: (step) => stepLabel(step.type) },
    editors: { rootEditorProvider: rootEditor, stepEditorProvider: stepEditor },
    validator: { step: stepValid, root: () => true },
  })
  const touch = () => { dirty = true; setStatus(T('flows.editor.unsaved'), 'warn') }
  designer.onDefinitionChanged.subscribe(touch)

  // ---------------- save ----------------
  async function save() {
    const name = document.getElementById('flow-name').value.trim()
    if (!name) { setStatus(T('flows.editor.name_required'), 'err'); return }
    if (!designer.isValid()) { setStatus(T('flows.editor.invalid'), 'err'); return }
    setStatus('…')
    const body = { id: flow.id, name, active: document.getElementById('flow-active').checked, trigger, definition: designer.getDefinition() }
    const r = await fetch('/api/flows/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ ok: false, problems: ['network'] }))
    if (!r.ok) { setStatus((r.problems ?? [r.error]).join(' · '), 'err'); return }
    dirty = false
    setStatus(T('flows.editor.saved'), 'ok')
    if (!flow.id) location.replace(`/flows/edit?id=${r.id}`)
  }
  document.getElementById('flow-save').addEventListener('click', save)
  document.getElementById('flow-name').addEventListener('input', touch)
  document.getElementById('flow-active').addEventListener('change', touch)
  window.addEventListener('beforeunload', (ev) => { if (dirty) { ev.preventDefault(); ev.returnValue = '' } })
  document.getElementById('flow-run-now')?.addEventListener('submit', (ev) => { if (dirty && !confirm(T('flows.editor.run_unsaved'))) ev.preventDefault() })
  void Uid
})()
