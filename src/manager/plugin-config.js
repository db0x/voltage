import { applyTemplate } from './template.js'

// Hosts the config dialog that a configurable plugin ships as its own config.html (surfaced as
// entry.configHtml by the manager:plugins discovery — see ipc/handlers/plugins.js). The dialog's
// markup belongs to the plugin; this host only renders it into the manager DOM, binds its
// controls to the per-app config, and owns the generic open/close behaviour. One overlay per
// plugin, built lazily and reused; controls are (re-)bound on every open to the current app.
//
// Controls bind declaratively so the host stays plugin-agnostic and no plugin JS runs in the
// renderer (which has no file access):
//   input[data-config-key]                — an input whose value is config[key]
//   select[data-config-key]               — a dropdown whose selected value is config[key]
//   .dialog-field-toggle[data-config-key] — a toggle button whose .active state is config[key]
//   data-config-default                   — seeds the control when unset ("true" = toggle on)
//   [data-config-value]                   — a live mirror of a key's value, suffixed by data-unit
//   [data-config-swatch]                   — a colour-preview element; gets the value as the CSS
//                                            var --swatch-color (style the element to use it)
//   [data-config-enabled-by="<toggleKey>"] — dimmed + disabled while that toggle is off
export function initPluginConfig({ i18n, icons, plugins }) {
  const catalog  = plugins || []
  const overlays = new Map()  // plugin file path -> overlay element

  function buildOverlay(entry) {
    // pluginIcon is the plugin's own icon (data URL from the catalog), shown in the dialog header.
    const overlay = applyTemplate(entry.configHtml, { i18n, icons, vars: { pluginIcon: entry.icon || '' } })
    document.body.appendChild(overlay)
    const close = () => overlay.classList.add('hidden')
    // ✕, Cancel and backdrop all discard: they close without running the commit. The working
    // copy lives only until close; the next open re-seeds the controls from the stored config.
    overlay.querySelector('.dialog-close')?.addEventListener('click', close)
    overlay.querySelector('.plugin-config-cancel')?.addEventListener('click', close)
    overlay.addEventListener('click', e => { if (e.target === overlay) close() })
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

  // (Re)bind every control to `access` for the app being edited. cfg is a working copy that edits
  // accumulate into; nothing is written back until Apply runs overlay._commit (so Cancel discards
  // by simply closing). oninput (property, not addEventListener) is reassigned per open, so
  // re-opening the same overlay for another app never stacks stale listeners.
  function bindControls(overlay, access) {
    const cfg = { ...access.get() }

    // Value controls (input range/number/text/color, or a select dropdown): config[key] <-> value.
    // A <select> is treated like a text input (string value); only range/number coerce to Number.
    // Both oninput and onchange are bound so selects (which fire change) round-trip like inputs.
    for (const el of overlay.querySelectorAll('input[data-config-key], select[data-config-key]')) {
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
