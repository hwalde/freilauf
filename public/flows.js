// cc-hub flows — designer page (vanilla JS on top of sequential-workflow-designer).
// Everything it needs comes from window.CCHUB_FLOWS: the i18n catalog (flows.*),
// the step registry (meta.steps — one source of truth with server/flows/steps.mjs),
// select lists (agents, repos, harnesses) and the flow being edited.
//
// The typed variable catalog is the SAME module the server runs
// (server/flows/varschema.mjs, served under /static/flows/): the variable
// picker, the operator list filtered by type, the value that is chosen instead
// of typed, the "no step writes that variable" notes and the placement rules
// enforced while dragging all come out of it. Nothing about variables is
// decided twice.
import {
  varsInScope, definitionWarnings, placementProblem, placementOf, activeRuleKey,
  entryFor, opsForType, valuesFor, UNARY_OPS,
} from '/static/flows/varschema.mjs'

const { i18n, meta, flow } = window.CCHUB_FLOWS
const { Designer, Uid } = window.sequentialWorkflowDesigner
const T = (key, params = {}) => String(i18n[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`)
const stepMeta = Object.fromEntries(meta.steps.map(s => [s.type, s]))
const stepLabel = (type) => T(`flows.step.${type}`)
const typeLabel = (t) => T(`flows.vartype.${t}`)
// In a picker the allowed values say more than the type name — as long as they fit.
const varLabel = (v) => {
  const values = v.enum?.length ? v.enum.join('/') : ''
  return `${v.path} · ${values && values.length <= 30 ? values : typeLabel(v.type)}${v.conditional ? ' ?' : ''}`
}
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
// Which agents this flow hangs on. NOT part of the flow row: it is stored on
// the agents (agents.flows) and edited by the agent form as well — same rows,
// so the two views cannot drift. Saved together with the flow.
let attachments = (flow.attachments ?? []).map(a => ({ agentId: a.agentId, when: a.when }))
let dirty = false
let designer = null
const status = document.getElementById('flow-status')
const setStatus = (text, cls = 'dim') => { status.textContent = text; status.className = cls }
// While dragging, the designer asks over and over whether the spot is allowed —
// the explanation is only worth printing when it changes.
let lastRefusal = ''

/** The live definition — the designer owns it once it exists. */
const definition = () => designer?.getDefinition() ?? flow.definition

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

// ---------------- placement ----------------

/**
 * The rule a step lives under with its CURRENT properties — a rule bound to one
 * field value (send_message with the target "the trigger run") must not be
 * advertised while another target is selected: those reach agents outside this
 * flow and need nothing.
 */
const placementRuleKey = (step) => activeRuleKey(step, stepMeta[step.type])

function refuse(type, code) {
  const text = T(`flows.placement.${code}.why`, { step: stepLabel(type) })
  if (text === lastRefusal) return false
  lastRefusal = text
  setStatus(text, 'err')
  return false
}

/** May a step of this shape sit at that spot? Also prints why not. */
function allowedAt(step, sequence, index) {
  const p = placementProblem(step, stepMeta, { definition: definition(), sequence, index, trigger })
  if (p?.severity !== 'error') { lastRefusal = ''; return true }
  return refuse(step.type, p.code)
}

// ---------------- validation (mirror of validateDefinition on the server) ----------------
const visible = (f, props) => !f.showIf || Object.entries(f.showIf).every(([k, v]) => props[k] === v)
function requiredFilled(step) {
  const s = stepMeta[step.type]
  if (!s) return false
  const props = step.properties ?? {}
  return s.fields.every(f => {
    if (!f.required || !visible(f, props)) return true
    const v = props[f.key]
    return !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length))
  })
}
function stepValid(step, _parentSequence, def) {
  if (!requiredFilled(step)) return false
  return placementOf(step, def ?? definition(), stepMeta, trigger)?.severity !== 'error'
}

// ---------------- variables ----------------

/** The catalog at a spot, grouped by where each variable comes from. */
function scopeAt(at) {
  return varsInScope(definition(), stepMeta, at, trigger)
}

function variablesPanel(at) {
  const scope = scopeAt(at)
  const byFrom = new Map()
  for (const v of scope) {
    if (!byFrom.has(v.from)) byFrom.set(v.from, [])
    byFrom.get(v.from).push(v)
  }
  const box = $('details', { class: 'flow-vars' }, $('summary', {}, T('flows.editor.variables')),
    $('p', { class: 'dim' }, T('flows.editor.variables_hint')))
  for (const [from, list] of byFrom) {
    box.append($('div', { class: 'var-group' },
      $('b', {}, from),
      $('div', { class: 'chips' }, list.map(v => $('code', {
        class: v.conditional ? 'cond' : '',
        title: `${typeLabel(v.type)}${v.enum?.length ? ` — ${v.enum.join(', ')}` : ''}${v.conditional ? ` · ${T('flows.editor.var_conditional')}` : ''}`,
        onclick: () => navigator.clipboard?.writeText(`{{${v.path}}}`),
      }, v.path))),
    ))
  }
  return box
}

// ---------------- {{…}} autocomplete ----------------

/**
 * Offers the catalog while typing `{{`. Deliberately anchored to the field, not
 * to the caret: a list under the input is always in the right place and never
 * lands outside the editor pane.
 */
function autocomplete(input, at) {
  let box = null, index = 0, options = []
  const close = () => { box?.remove(); box = null; options = [] }
  const fragment = () => {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length)
    const m = before.match(/\{\{\s*([A-Za-z0-9_.]*)$/)
    return m ? { text: m[1], start: before.length - m[0].length } : null
  }
  const insert = (path) => {
    const frag = fragment()
    if (!frag) return
    const caret = input.selectionStart ?? input.value.length
    input.value = input.value.slice(0, frag.start) + `{{${path}}}` + input.value.slice(caret)
    const pos = frag.start + path.length + 4
    input.setSelectionRange(pos, pos)
    close()
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const paint = () => {
    if (!box) return
    box.replaceChildren(...options.map((v, i) => $('div', {
      class: i === index ? 'ac-item sel' : 'ac-item',
      onmousedown: (ev) => { ev.preventDefault(); insert(v.path) },
    }, $('span', {}, v.path), $('span', { class: 'dim' }, typeLabel(v.type)))))
  }
  const update = () => {
    const frag = fragment()
    if (!frag) return close()
    const needle = frag.text.toLowerCase()
    options = scopeAt(at).filter(v => v.path.toLowerCase().includes(needle)).slice(0, 12)
    if (!options.length) return close()
    index = 0
    if (!box) { box = $('div', { class: 'ac-list' }); input.parentElement.append(box) }
    paint()
  }
  input.addEventListener('input', update)
  input.addEventListener('keydown', (ev) => {
    if (!box) return
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      index = (index + (ev.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
      paint()
    } else if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); insert(options[index].path) }
    else if (ev.key === 'Escape') { ev.preventDefault(); close() }
  })
  input.addEventListener('blur', () => setTimeout(close, 150))
  return input
}

/**
 * The "run finished" trigger IS the list of agents this flow hangs on — the
 * very same rows the agent form edits. A single run cannot appear here: it only
 * exists once it has been started, so it attaches its flows in its own form.
 */
function attachEditor() {
  const box = $('div', { class: 'attach' })
  const list = $('div')
  const render = () => {
    list.replaceChildren()
    if (!attachments.length) list.append($('p', { class: 'dim' }, T('flows.attach.editor_none')))
    for (const a of attachments) {
      const agent = meta.agents.find(x => x.id === a.agentId)
      const when = $('select', {}, meta.whenKinds.map(k => $('option', { value: k, selected: a.when === k }, T(`flows.when.${k}`))))
      when.addEventListener('change', () => { a.when = when.value; touch() })
      const del = $('button', { type: 'button', class: 'danger' }, '×')
      del.addEventListener('click', () => { attachments = attachments.filter(x => x !== a); render(); touch() })
      list.append($('div', { class: 'attach-row' },
        $('b', {}, agent ? agent.name : `#${a.agentId}`),
        agent ? $('span', { class: 'dim' }, ` (${agent.repo})`) : null, when, del))
    }
  }
  const add = $('select', {}, $('option', { value: '' }, T('flows.attach.add')),
    meta.agents.map(a => $('option', { value: a.id }, `${a.name} (${a.repo})`)))
  add.addEventListener('change', () => {
    const id = +add.value
    add.value = ''
    if (!id || attachments.some(x => x.agentId === id)) return
    attachments.push({ agentId: id, when: 'always' })
    render(); touch()
  })
  render()
  box.append($('p', { class: 'dim' }, T('flows.attach.editor_hint')), list, add)
  return box
}

// ---------------- root editor: name, trigger ----------------
function rootEditor() {
  const box = $('div', { class: 'flow-editor' })
  box.append($('h3', {}, T('flows.trigger')))
  const kindSel = $('select', {}, meta.triggerKinds.map(k => $('option', { value: k, selected: trigger.kind === k }, T(`flows.trigger.${k}`))))
  box.append($('label', {}, T('flows.trigger.kind'), kindSel))
  const detail = $('div')
  const renderDetail = () => {
    detail.replaceChildren()
    if (trigger.kind === 'run_finished') {
      detail.append(attachEditor())
    } else if (trigger.kind === 'cron') {
      const inp = $('input', { value: trigger.expr ?? '', placeholder: '30 6 * * 1-5' })
      inp.addEventListener('input', () => { trigger.expr = inp.value; touch() })
      // A cron flow has no trigger run — steps that need one become invalid here.
      detail.append($('label', {}, T('flows.trigger.cron_expr'), inp), $('p', { class: 'dim' }, T('flows.trigger.cron_no_run')))
    } else {
      detail.append($('p', { class: 'dim' }, T('flows.trigger.manual_hint')))
    }
  }
  kindSel.addEventListener('change', () => {
    trigger = { kind: kindSel.value, expr: '' }
    renderDetail(); touch()
    // The trigger decides which variables exist and which steps may stay where
    // they are — everything on the canvas has to be judged again.
    designer?.updateBadges()
  })
  renderDetail()
  box.append(detail, variablesPanel(null))
  return box
}

// ---------------- step editor ----------------
function optionLabel(fieldKey, value) {
  const prefix = { target: 'flows.target.', source: 'flows.source.', op: 'flows.op.', branchMode: 'flows.branch_mode.' }[fieldKey]
  return prefix ? T(prefix + value) : value
}

/**
 * The extraction fields. `light` runs on every keystroke (these names ARE the
 * variable names, so the notes update as you type); `structural` rebuilds the
 * property panel and hangs ONLY on discrete choices — a select, a row added or
 * removed. Never on typing and never on blur: a rebuild while typing throws the
 * caret out of the input, and a rebuild on blur detaches the control the user
 * just clicked, so that click is swallowed.
 */
function fieldsEditor(list, light, structural) {
  const wrap = $('div', { class: 'fields-editor' })
  const render = () => {
    wrap.replaceChildren()
    list.forEach((f, i) => {
      const name = $('input', { value: f.name ?? '', placeholder: T('flows.editor.field_name') })
      const type = $('select', {}, meta.fieldTypes.map(tp => $('option', { value: tp, selected: (f.type ?? 'string') === tp }, T(`flows.field_type.${tp}`))))
      const desc = $('input', { value: f.description ?? '', placeholder: T('flows.editor.field_desc') })
      const en = $('input', { value: f.enumValues ?? '', placeholder: T('flows.editor.field_enum') })
      name.addEventListener('input', () => { f.name = name.value; light() })
      type.addEventListener('change', () => { f.type = type.value; structural() })
      desc.addEventListener('input', () => { f.description = desc.value; light() })
      en.addEventListener('input', () => { f.enumValues = en.value; light() })
      wrap.append($('div', { class: 'field-row' }, name, type, desc, en,
        $('button', { type: 'button', class: 'danger', onclick: () => { list.splice(i, 1); render(); structural() } }, '×')))
    })
    wrap.append($('button', { type: 'button', onclick: () => { list.push({ name: '', type: 'string', description: '', enumValues: '' }); render(); structural() } }, T('flows.editor.fields_add')))
  }
  render()
  return wrap
}

const CUSTOM = '__custom__'

/** Variable picker: pick a path from the catalog, or fall back to a free template. */
function varInput(props, f, at, changed, light) {
  const scope = scopeAt(at)
  const cur = String(props[f.key] ?? '')
  const entry = entryFor(cur, scope)
  const custom = !entry && cur !== ''
  const wrap = $('div', { class: 'ac' })
  const sel = $('select', {}, $('option', { value: '', selected: cur === '' }, T('flows.editor.var_pick')))
  const byFrom = new Map()
  for (const v of scope) { if (!byFrom.has(v.from)) byFrom.set(v.from, []); byFrom.get(v.from).push(v) }
  for (const [from, list] of byFrom) {
    const g = $('optgroup', { label: from })
    for (const v of list) {
      g.append($('option', { value: `{{${v.path}}}`, selected: entry?.path === v.path }, varLabel(v)))
    }
    sel.append(g)
  }
  sel.append($('option', { value: CUSTOM, selected: custom }, T('flows.editor.var_custom')))
  wrap.append(sel)
  const free = autocomplete($('input', { value: cur, placeholder: f.placeholder ?? '' }), at)
  if (custom) wrap.append(free)
  free.addEventListener('input', () => { props[f.key] = free.value; light() })
  sel.addEventListener('change', () => {
    if (sel.value === CUSTOM) { wrap.append(free); free.focus() } else { free.remove(); props[f.key] = sel.value }
    changed()
  })
  return wrap
}

/** Operator list, narrowed to what the left side's type can answer. */
function opInput(props, f, at, changed) {
  const entry = entryFor(props[f.typeOf], scopeAt(at))
  const allowed = entry && entry.type !== 'any' ? opsForType(entry.type) : (f.options ?? meta.ops)
  const cur = props[f.key] || f.default || 'eq'
  const list = allowed.includes(cur) ? allowed : [cur, ...allowed]
  const sel = $('select', {}, list.map(o => $('option', { value: o, selected: cur === o },
    allowed.includes(o) ? T(`flows.op.${o}`) : `⚠ ${T(`flows.op.${o}`)}`)))
  sel.addEventListener('change', () => { props[f.key] = sel.value; changed() })
  return sel
}

/** Right-hand value: chosen where the type allows only certain values, typed otherwise. */
function valueInput(props, f, at, changed, light) {
  const entry = entryFor(props[f.typeOf], scopeAt(at))
  const op = props[f.opOf ?? 'op'] || 'eq'
  if (UNARY_OPS.includes(op)) return $('p', { class: 'dim' }, T('flows.editor.value_none'))
  const allowed = valuesFor(entry)
  const cur = String(props[f.key] ?? '')
  if (allowed) {
    // A yes/no or an enum can only ever match a value from this list — typing
    // anything else compares two strings that never meet.
    const known = allowed.some(v => v.toLowerCase() === cur.toLowerCase())
    const wrap = $('div', { class: 'ac' })
    const sel = $('select', {}, $('option', { value: '', selected: cur === '' }, T('flows.editor.var_pick')),
      allowed.map(v => $('option', { value: v, selected: known && v.toLowerCase() === cur.toLowerCase() }, v)),
      $('option', { value: CUSTOM, selected: cur !== '' && !known }, T('flows.editor.var_custom')))
    const free = autocomplete($('input', { value: cur, placeholder: f.placeholder ?? '' }), at)
    if (cur !== '' && !known) wrap.append(sel, free); else wrap.append(sel)
    free.addEventListener('input', () => { props[f.key] = free.value; light() })
    sel.addEventListener('change', () => {
      if (sel.value === CUSTOM) { wrap.append(free); free.focus() } else { free.remove(); props[f.key] = sel.value }
      changed()
    })
    return wrap
  }
  if (entry?.type === 'number') {
    const inp = $('input', { type: 'number', value: cur })
    inp.addEventListener('input', () => { props[f.key] = inp.value; light() })
    return inp
  }
  const wrap = $('div', { class: 'ac' })
  const inp = autocomplete($('input', { value: cur, placeholder: f.placeholder ?? '' }), at)
  inp.addEventListener('input', () => { props[f.key] = inp.value; light() })
  wrap.append(inp)
  return wrap
}

function stepEditor(step, context) {
  const s = stepMeta[step.type]
  const box = $('div', { class: 'flow-editor' })
  if (!s) { box.append($('p', { class: 'err' }, `unknown step ${step.type}`)); return box }
  box.append($('h3', {}, stepLabel(step.type)), $('p', { class: 'dim' }, T(`flows.step.${step.type}.desc`)))

  // Where this step may sit — stated up front, not only when it is broken. A
  // field-bound rule appears and disappears with the field, so this is redrawn
  // on every property change, not once when the panel opens.
  const placementBox = $('div')
  const renderPlacement = () => {
    placementBox.replaceChildren()
    const ruleKey = placementRuleKey(step)
    if (ruleKey) placementBox.append($('p', { class: 'placement' }, T(`flows.placement.${ruleKey}.rule`)))
    const placement = placementOf(step, definition(), stepMeta, trigger)
    if (placement) {
      placementBox.append($('p', { class: placement.severity === 'error' ? 'err placement-bad' : 'warn placement-bad' },
        T(`flows.placement.${placement.code}.why`, { step: stepLabel(step.type) })))
    }
  }
  box.append(placementBox)

  const name = $('input', { value: step.name })
  name.addEventListener('input', () => { step.name = name.value; context.notifyNameChanged() })
  box.append($('label', {}, T('flows.editor.step_name'), name))
  const props = step.properties
  const fieldsBox = $('div')
  const at = step.id
  // Anything typed can change what the catalog offers (an output variable being
  // renamed, an extraction field being added), so the panel is rebuilt with it.
  // Two levels on purpose. `light` is what a keystroke may do: record the value
  // and refresh what sits OUTSIDE the inputs. `changed` additionally rebuilds
  // the fields — that destroys whichever input has focus, so it hangs on
  // discrete choices only (a select, a row added or removed), never on `input`
  // and never on `blur`. A left side typed by hand instead of picked therefore
  // only re-narrows the operator list the next time the panel opens; an
  // impossible comparison still shows up in the notes either way.
  const light = () => { context.notifyPropertiesChanged(); renderPlacement(); refreshHints() }
  const changed = () => { light(); renderFields() }
  const renderFields = () => {
    fieldsBox.replaceChildren()
    for (const f of s.fields) {
      if (!visible(f, props)) continue
      const label = T(`flows.field.${f.key}`) + (f.required ? ' *' : '')
      let input
      switch (f.kind) {
        case 'textarea': {
          const wrap = $('div', { class: 'ac' })
          const ta = autocomplete($('textarea', { rows: 5, placeholder: f.placeholder ?? '' }), at)
          ta.value = props[f.key] ?? ''
          ta.addEventListener('input', () => { props[f.key] = ta.value; light() })
          wrap.append(ta); input = wrap; break
        }
        case 'number':
          input = $('input', { type: 'number', value: props[f.key] ?? '' })
          input.addEventListener('input', () => { props[f.key] = input.value; light() }); break
        case 'checkbox':
          input = $('input', { type: 'checkbox', checked: !!props[f.key] })
          input.addEventListener('change', () => { props[f.key] = input.checked; changed() })
          fieldsBox.append($('label', { class: 'chk' }, input, label)); continue
        case 'select':
          input = $('select', {}, f.options.map(o => $('option', { value: o, selected: props[f.key] === o }, optionLabel(f.key, o))))
          input.addEventListener('change', () => { props[f.key] = input.value; changed() }); break
        case 'agent':
          input = $('select', {}, $('option', { value: '' }, '–'), meta.agents.map(a => $('option', { value: a.id, selected: String(props[f.key]) === String(a.id) }, `${a.name} (${a.repo})`)))
          input.addEventListener('change', () => { props[f.key] = input.value; light() }); break
        case 'repo':
          input = $('select', {}, $('option', { value: '' }, '–'), meta.repos.map(r => $('option', { value: r.id, selected: String(props[f.key]) === String(r.id) }, r.name)))
          input.addEventListener('change', () => { props[f.key] = input.value; light() }); break
        case 'harness':
          input = $('select', {}, $('option', { value: '' }, '–'), meta.harnesses.map(h => $('option', { value: h.id, selected: props[f.key] === h.id }, h.label)))
          input.addEventListener('change', () => { props[f.key] = input.value; light() }); break
        case 'fields':
          if (!Array.isArray(props[f.key])) props[f.key] = []
          input = fieldsEditor(props[f.key], light, changed); break
        case 'var': input = varInput(props, f, at, changed, light); break
        case 'op': input = opInput(props, f, at, changed); break
        case 'value': input = valueInput(props, f, at, changed, light); break
        default: {
          const wrap = $('div', { class: 'ac' })
          const inp = autocomplete($('input', { value: props[f.key] ?? '', placeholder: f.placeholder ?? '' }), at)
          inp.addEventListener('input', () => { props[f.key] = inp.value; light() })
          wrap.append(inp); input = wrap
        }
      }
      const hintKey = `flows.field.${f.key}.hint`
      const notes = hintsFor(step.id).filter(h => h.field === f.key)
      fieldsBox.append($('label', {}, label, input,
        i18n[hintKey] ? $('span', { class: 'dim hint' }, T(hintKey)) : null,
        notes.map(h => $('span', { class: 'warn hint' }, hintText(h)))))
    }
  }
  renderFields()
  renderPlacement()
  box.append(fieldsBox, variablesPanel(at))
  return box
}

// ---------------- hints (warnings that never block saving) ----------------
let hints = []
const hintsFor = (stepId) => hints.filter(h => h.stepId === stepId)
const hintText = (h) => T(`flows.warn.${h.code}`, {
  path: h.path ?? '', type: typeLabel(h.type ?? 'any'), allowed: (h.allowed ?? []).join(', '),
})

const hintBox = $('div', { id: 'flow-hints' })
document.getElementById('flow-designer').before(hintBox)

function refreshHints() {
  const def = definition()
  hints = definitionWarnings(def, stepMeta, trigger)
  // Placement warnings are not errors, so they never reach validateDefinition —
  // they belong in the same list as everything else that is merely suspicious.
  const walk = (seq) => {
    (seq ?? []).forEach((st, i) => {
      const p = placementProblem(st, stepMeta, { definition: def, sequence: seq, index: i, trigger })
      if (p?.severity === 'warning') hints.push({ stepId: st.id, stepName: st.name || st.type, code: p.code })
      if (st.branches) for (const b of Object.values(st.branches)) walk(b)
      if (st.sequence) walk(st.sequence)
    })
  }
  walk(def.sequence)

  hintBox.replaceChildren()
  if (hints.length) {
    hintBox.append($('b', {}, T('flows.editor.hints', { n: hints.length })))
    hintBox.append($('ul', {}, hints.map(h => $('li', { onclick: () => h.stepId && designer?.selectStepById(h.stepId) },
      $('b', {}, h.stepName), ' — ', hintText(h)))))
  }
  // The canvas has no warning badge of its own (the library only knows the red
  // error one), so the step boxes get an outline instead. One frame later: the
  // designer draws its steps after this call, both on creation and on a change.
  const flagged = new Set(hints.map(h => h.stepId))
  requestAnimationFrame(() => {
    for (const el of document.querySelectorAll('#flow-designer [data-step-id]')) {
      el.classList.toggle('has-hint', flagged.has(el.getAttribute('data-step-id')))
    }
  })
}

// ---------------- designer ----------------
designer = Designer.create(document.getElementById('flow-designer'), flow.definition, {
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
    // A step whose rule the spot breaks is refused right at the drop — with the
    // reason in the status line, so "it just won't stick" never happens.
    canInsertStep: (step, targetSequence, targetIndex) => allowedAt(step, targetSequence, targetIndex),
    canMoveStep: (_source, step, targetSequence, targetIndex) =>
      allowedAt({ ...step, id: null }, targetSequence, targetIndex),
  },
  toolbox: {
    groups,
    labelProvider: (step) => stepLabel(step.type),
    // The toolbox step carries the default properties, so a rule tied to a
    // field value only shows up once that value is actually chosen.
    descriptionProvider: (step) => {
      const rule = placementRuleKey(step)
      return rule ? `${T(`flows.step.${step.type}.desc`)} ${T(`flows.placement.${rule}.rule`)}` : T(`flows.step.${step.type}.desc`)
    },
  },
  editors: { rootEditorProvider: rootEditor, stepEditorProvider: stepEditor },
  validator: { step: stepValid, root: () => true },
})
const touch = () => { dirty = true; setStatus(T('flows.editor.unsaved'), 'warn'); refreshHints() }
designer.onDefinitionChanged.subscribe(touch)
refreshHints()

// ---------------- save ----------------
async function save() {
  const name = document.getElementById('flow-name').value.trim()
  if (!name) { setStatus(T('flows.editor.name_required'), 'err'); return }
  if (!designer.isValid()) { setStatus(T('flows.editor.invalid'), 'err'); return }
  setStatus('…')
  const body = {
    id: flow.id, name, active: document.getElementById('flow-active').checked,
    trigger, attachments, definition: designer.getDefinition(),
  }
  const r = await fetch('/api/flows/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ ok: false, problems: ['network'] }))
  if (!r.ok) { setStatus((r.problems ?? [r.error]).join(' · '), 'err'); return }
  dirty = false
  setStatus(r.hints?.length ? T('flows.editor.saved_with_hints', { n: r.hints.length }) : T('flows.editor.saved'), r.hints?.length ? 'warn' : 'ok')
  if (!flow.id) location.replace(`/flows/edit?id=${r.id}`)
}
document.getElementById('flow-save').addEventListener('click', save)
document.getElementById('flow-name').addEventListener('input', touch)
document.getElementById('flow-active').addEventListener('change', touch)
window.addEventListener('beforeunload', (ev) => { if (dirty) { ev.preventDefault(); ev.returnValue = '' } })
document.getElementById('flow-run-now')?.addEventListener('submit', (ev) => { if (dirty && !confirm(T('flows.editor.run_unsaved'))) ev.preventDefault() })
void Uid
