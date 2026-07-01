import { applyTemplate } from './template.js'
import { OverlayScrollbars } from '../../node_modules/overlayscrollbars/overlayscrollbars.mjs'

// Minimal, dependency-free YAML highlighter for the docker stack preview (we don't pull in a
// highlight library for one read-only panel). Tokenises each line left-to-right — never regex over
// already-inserted HTML — so quotes inside the markup can't break it. Emits <span class="tok-*">.
const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const tok = (cls, text) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`

function highlightYamlLine(line) {
  let html = ''
  let rest = line
  // Leading "key:" (optionally after a list dash), highlighted as a key.
  const key = rest.match(/^(\s*(?:-\s+)?)([A-Za-z0-9_.\-/]+)(:)(?=\s|$)/)
  if (key) { html += escapeHtml(key[1]) + tok('key', key[2]) + escapeHtml(key[3]); rest = rest.slice(key[0].length) }
  let i = 0
  while (i < rest.length) {
    const s = rest.slice(i)
    let m
    if (s[0] === '#')                                   { html += tok('comment', s); break }
    if ((m = s.match(/^"(?:[^"\\]|\\.)*"/)) || (m = s.match(/^'[^']*'/))) { html += tok('str', m[0]); i += m[0].length; continue }
    if ((m = s.match(/^\$\{[^}]*\}/)))                  { html += tok('var', m[0]); i += m[0].length; continue }
    if ((m = s.match(/^\d+(?:\.\d+)?/)))                { html += tok('num', m[0]); i += m[0].length; continue }
    m = s.match(/^[^#"'$\d]+/)                           // plain run up to the next interesting char
    const chunk = m ? m[0] : s[0]
    html += escapeHtml(chunk)
    i += chunk.length
  }
  return html
}
const highlightYaml = src => String(src).split('\n').map(highlightYamlLine).join('\n')

// Hosts the config dialog that a configurable plugin ships as its own config.html (surfaced as
// entry.configHtml by the manager:plugins discovery — see ipc/handlers/plugins.js). The dialog's
// markup belongs to the plugin; this host only renders it into the manager DOM, binds its
// controls to the per-app config, and owns the generic open/close behaviour. One overlay per
// plugin, built lazily and reused; controls are (re-)bound on every open to the current app.
//
// Controls bind declaratively so the host stays plugin-agnostic and no plugin JS runs in the
// renderer (which has no file access):
//   input[data-config-key]                — an input whose value is config[key]
//   textarea[data-config-key]             — a multi-line free-text field whose value is config[key]
//   select[data-config-key]               — a dropdown whose selected value is config[key]
//   .dialog-field-toggle[data-config-key] — a toggle button whose .active state is config[key]
//   data-config-default                   — seeds the control when unset ("true" = toggle on)
//   [data-config-value]                   — a live mirror of a key's value, suffixed by data-unit
//   [data-config-swatch]                   — a colour-preview element; gets the value as the CSS
//                                            var --swatch-color (style the element to use it)
//   [data-config-enabled-by="<toggleKey>"] — dimmed + disabled while that toggle is off
//   [data-config-stacks="<key>"]           — a clickable icon+label chooser whose selection is
//                                            config[key], filled from the plugin's discovered stacks
//                                            ({ id, label, icon, content }); native <select> can't
//                                            show icons. Pair with:
//   [data-config-stack-preview]            —   a read-only field showing the chosen stack's content
//
// Repeatable rows — for a config value that is an array of small objects (e.g. css-inject's list
// of variable→colour overrides):
//   [data-config-list="<key>"]             — container; config[key] is an array of row objects
//     [data-config-rows]                   —   where row instances are appended
//     <template data-config-row>           —   the markup of one row, cloned per entry
//       [data-config-field="<name>"]       —     an input inside a row; its value is entry[name]
//       [data-config-field-default]        —     seeds that field when the entry has no value
//       [data-config-field-swatch="<name>"]—     per-row colour preview (via --swatch-color)
//       [data-config-remove]               —     button that drops its row
//     [data-config-add]                    —   button that appends a fresh blank row
export function initPluginConfig({ i18n, icons, plugins }) {
  const catalog  = plugins || []
  const overlays = new Map()  // plugin file path -> overlay element

  // Fill any <select data-config-options="<key>"> from the catalog entry's matching array (e.g. the
  // docker plugin's discovered `stacks`: [{ id, label }]). Options are static per plugin, so this
  // runs once at build time; bindControls later sets the selected value from the app's config. Any
  // static <option> already in the markup (e.g. a "none" placeholder) is kept; the rest are appended.
  function fillOptionLists(overlay, entry) {
    for (const sel of overlay.querySelectorAll('select[data-config-options]')) {
      const items = entry[sel.dataset.configOptions]
      if (!Array.isArray(items)) continue
      for (const it of items) {
        const opt = document.createElement('option')
        opt.value = it.id ?? it.value ?? it
        opt.textContent = it.label ?? it.id ?? it
        sel.appendChild(opt)
      }
    }
  }

  function buildOverlay(entry) {
    // pluginIcon is the plugin's own icon (data URL from the catalog), shown in the dialog header.
    const overlay = applyTemplate(entry.configHtml, { i18n, icons, vars: { pluginIcon: entry.icon || '' } })
    document.body.appendChild(overlay)
    fillOptionLists(overlay, entry)
    // Stash the plugin's discovered stacks ({ id, label, icon, content }) for the stack chooser
    // (bindStackLists) — bound per open, like the option lists above.
    overlay._stacks = Array.isArray(entry.stacks) ? entry.stacks : []
    const close = () => overlay.classList.add('hidden')
    // ✕ and Cancel discard: they close without running the commit. The working copy lives only
    // until close; the next open re-seeds the controls from the stored config. A backdrop click is
    // deliberately not a dismiss — it closes dialogs too easily by accident, especially on trackpads.
    overlay.querySelector('.dialog-close')?.addEventListener('click', close)
    overlay.querySelector('.plugin-config-cancel')?.addEventListener('click', close)
    // Apply commits the working copy (set by the latest bindControls) to the app's config.
    overlay.querySelector('.plugin-config-apply')?.addEventListener('click', () => {
      overlay._commit?.()
      close()
    })
    return overlay
  }

  // Mirror a key's current value into its live displays: a [data-config-value] text output (with
  // optional unit) and/or a [data-config-swatch] colour preview (via the --swatch-color CSS var).
  function reflectValue(overlay, key, raw) {
    const out = overlay.querySelector(`[data-config-value="${key}"]`)
    if (out) out.textContent = `${raw}${out.dataset.unit || ''}`
    const swatch = overlay.querySelector(`[data-config-swatch="${key}"]`)
    if (swatch) swatch.style.setProperty('--swatch-color', raw)
  }

  // Mirror a row field's value into its per-row colour preview, scoped to that row (rows share
  // field names, so the lookup must stay inside the row rather than the whole overlay).
  function reflectFieldSwatch(row, field, raw) {
    const swatch = row.querySelector(`[data-config-field-swatch="${field}"]`)
    if (swatch) swatch.style.setProperty('--swatch-color', raw)
  }

  // (Re)bind every [data-config-list] repeatable group to the working copy. Each list mirrors
  // config[key] as an array of row objects: stored entries seed one row each, plus a trailing
  // blank row so there is always somewhere to type. cfg[key] is recomputed from the DOM on every
  // edit (add/remove/input), dropping rows whose fields are all blank — so an untouched trailing
  // row never persists. Listeners that live on reused elements (the add button) use the onX
  // property to avoid stacking across opens; per-row listeners die with their (recreated) rows.
  function bindLists(overlay, cfg) {
    for (const listEl of overlay.querySelectorAll('[data-config-list]')) {
      const key      = listEl.dataset.configList
      const template = listEl.querySelector('template[data-config-row]')
      const rowsBox  = listEl.querySelector('[data-config-rows]')
      if (!template || !rowsBox) continue

      // Collect the current rows as [{ field: value }, …], skipping untouched rows. A row counts as
      // untouched when every field is blank or still holds its seeded default — otherwise the
      // trailing blank row would persist (its colour field carries a non-empty default), so an
      // unfilled row could never be dropped.
      const readRows = () => {
        const out = []
        for (const row of rowsBox.querySelectorAll('[data-config-row-instance]')) {
          const entry = {}
          let touched = false
          for (const field of row.querySelectorAll('[data-config-field]')) {
            const value = field.value.trim()
            entry[field.dataset.configField] = value
            if (value && value !== (field.dataset.configFieldDefault ?? '')) touched = true
          }
          if (touched) out.push(entry)
        }
        return out
      }
      const sync = () => { cfg[key] = readRows() }

      // Clone one row from the template, seed its fields from `entry`, and wire its live updates.
      const addRow = (entry = {}) => {
        const row = template.content.firstElementChild.cloneNode(true)
        row.setAttribute('data-config-row-instance', '')
        for (const field of row.querySelectorAll('[data-config-field]')) {
          const name = field.dataset.configField
          field.value = entry[name] ?? (field.dataset.configFieldDefault ?? '')
          reflectFieldSwatch(row, name, field.value)
          field.oninput = field.onchange = () => { reflectFieldSwatch(row, name, field.value); sync() }
        }
        row.querySelector('[data-config-remove]')?.addEventListener('click', () => { row.remove(); sync() })
        rowsBox.appendChild(row)
      }

      rowsBox.replaceChildren()  // drop any rows from a previous open before reseeding
      const entries = Array.isArray(cfg[key]) ? cfg[key] : []
      for (const entry of entries) addRow(entry)
      addRow()  // trailing blank row (dropped on read if left untouched)
      sync()

      const addBtn = listEl.querySelector('[data-config-add]')
      if (addBtn) addBtn.onclick = () => { addRow(); sync() }
    }
  }

  // Custom stack chooser: clickable icon+label rows bound to config[key], plus a read-only preview of
  // the chosen stack's compose content. Native <select> can't show per-entry icons, so the docker
  // plugin uses this instead. Reads the stacks (with icon + content) the discovery put on _stacks.
  function bindStackLists(overlay, cfg) {
    const stacks = overlay._stacks || []
    for (const listEl of overlay.querySelectorAll('[data-config-stacks]')) {
      const key     = listEl.dataset.configStacks
      const preview = overlay.querySelector('[data-config-stack-preview]')
      const codeEl  = preview?.querySelector('code')
      // Attach OverlayScrollbars once (matches the rest of the UI); the highlighted <code> scrolls inside.
      if (preview && !preview._osInited) {
        OverlayScrollbars(preview, { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
        preview._osInited = true
      }
      listEl.replaceChildren()  // drop rows from a previous open before reseeding
      const apply = (id) => {
        cfg[key] = id || ''
        for (const row of listEl.children) row.classList.toggle('active', row.dataset.id === id)
        if (codeEl) codeEl.innerHTML = highlightYaml((stacks.find(s => s.id === id) || {}).content || '')
      }
      for (const s of stacks) {
        const row = document.createElement('div')
        row.className = 'docker-stack-row'
        row.dataset.id = s.id
        const img = document.createElement('img')
        img.src = s.icon || ''; img.width = 20; img.height = 20; img.alt = ''
        const span = document.createElement('span')
        span.textContent = s.label
        row.append(img, span)
        row.addEventListener('click', () => apply(s.id))
        listEl.appendChild(row)
      }
      apply(cfg[key] || '')  // reflect the stored selection + its preview on open
    }
  }

  // (Re)bind every control to `access` for the app being edited. cfg is a working copy that edits
  // accumulate into; nothing is written back until Apply runs overlay._commit (so Cancel discards
  // by simply closing). oninput (property, not addEventListener) is reassigned per open, so
  // re-opening the same overlay for another app never stacks stale listeners.
  function bindControls(overlay, access) {
    const cfg = { ...access.get() }

    // Value controls (input range/number/text/color, a textarea free-text block, or a select
    // dropdown): config[key] <-> value. A <select>/<textarea> is treated like a text input (string
    // value); only range/number coerce to Number. Both oninput and onchange are bound so selects
    // (which fire change) round-trip like inputs.
    for (const el of overlay.querySelectorAll('input[data-config-key], select[data-config-key], textarea[data-config-key]')) {
      const key       = el.dataset.configKey
      const hasNumber = el.type === 'range' || el.type === 'number'
      const fallback  = 'configDefault' in el.dataset
        ? (hasNumber ? Number(el.dataset.configDefault) : el.dataset.configDefault)
        : ''
      el.value = cfg[key] ?? fallback
      reflectValue(overlay, key, el.value)
      el.oninput = el.onchange = () => {
        cfg[key] = hasNumber ? Number(el.value) : el.value
        reflectValue(overlay, key, el.value)
      }
    }

    // Toggle buttons (the edit dialog's .dialog-field-toggle style): config[key] <-> .active as a
    // boolean. data-config-default="true" makes the toggle default-on when the app has no value.
    for (const toggle of overlay.querySelectorAll('.dialog-field-toggle[data-config-key]')) {
      const key = toggle.dataset.configKey
      const on  = cfg[key] ?? (toggle.dataset.configDefault === 'true')
      toggle.classList.toggle('active', on)
      toggle.onclick = () => {
        toggle.classList.toggle('active')
        cfg[key] = toggle.classList.contains('active')
        applyGating(overlay)
      }
    }

    bindLists(overlay, cfg)
    bindStackLists(overlay, cfg)
    applyGating(overlay)
    overlay._commit = () => access.set({ ...cfg })
  }

  // Greys out and disables controls gated by a toggle: an element with
  // [data-config-enabled-by="<toggleKey>"] is dimmed (and its inputs disabled) while that toggle
  // is off. Reads the toggle's live .active state so it works on open and on every toggle change.
  function applyGating(overlay) {
    for (const el of overlay.querySelectorAll('[data-config-enabled-by]')) {
      const gate = overlay.querySelector(`.dialog-field-toggle[data-config-key="${el.dataset.configEnabledBy}"]`)
      const enabled = gate ? gate.classList.contains('active') : true
      el.classList.toggle('config-disabled', !enabled)
      el.querySelectorAll('input, button, select').forEach(c => { c.disabled = !enabled })
    }
  }

  // Opens the plugin's config dialog. `access` reads/writes this plugin's per-app config object
  // ({ get, set }); defaults make the dialog harmless if a caller omits it.
  function openPluginConfig(file, access = { get: () => ({}), set: () => {} }) {
    const entry = catalog.find(p => p.file === file)
    if (!entry?.configHtml) return  // configurable but ships no dialog → nothing to open
    let overlay = overlays.get(file)
    if (!overlay) { overlay = buildOverlay(entry); overlays.set(file, overlay) }
    bindControls(overlay, access)
    overlay.classList.remove('hidden')
  }

  // Escape closes whichever plugin config overlay is currently open.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    for (const ov of overlays.values())
      if (!ov.classList.contains('hidden')) ov.classList.add('hidden')
  })

  return { openPluginConfig }
}
