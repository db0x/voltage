import Coloris from '../../node_modules/@melloware/coloris/dist/esm/coloris.js'

// Wires the Coloris colour picker once for the whole manager. Any input marked `data-coloris`
// (e.g. a plugin config dialog's tint field) is enhanced on focus — including dialogs created
// later — because Coloris binds through delegated document listeners. alpha:true + format 'hex'
// make picked values #RRGGBB / #RRGGBBAA strings, which the generic plugin-config binding stores
// and the widget plugin parses directly. Configure with `el` must run ONCE: each call with `el`
// re-adds the delegated listeners, so theme changes go through setColorPickerTheme (no `el`).
let started = false

export function initColorPicker(isDark) {
  if (started) return
  Coloris.init()
  Coloris({
    el: '[data-coloris]',
    alpha: true,
    format: 'hex',
    swatches: [],
    themeMode: isDark ? 'dark' : 'light',
  })
  started = true
}

// Coloris uses its own class-based theme (not prefers-color-scheme), so the manager's light/dark
// toggle must push the mode in. Passing only themeMode avoids re-binding the inputs.
export function setColorPickerTheme(isDark) {
  if (started) Coloris({ themeMode: isDark ? 'dark' : 'light' })
}
