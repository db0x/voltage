// widget plugin (main-process module). Turns the app into a frameless, transparent, rounded
// "widget" with an optional drop shadow and a configurable tint, optionally hidden scrollbars, a context-menu
// "Move" mode and "Quit" entry.
//
// Rendering model — VIEW MODE (see src/window.js collectPluginViewMode): the app does NOT run in
// the window itself. The window is a transparent, frameless HOST that draws the drop shadow
// (host.html), and the app runs in an inset WebContentsView with rounded corners (the host insets
// the view by the shadow gutter and calls view.setBorderRadius). This keeps the app's page
// completely untouched → native scrolling/layout (no clip-path/transform tricks, which broke the
// page's own scroll containers). The plugin only injects a tint + hides scrollbars into the view.
//
// Plugin hooks used:
//   windowOptions()  — host BrowserWindow constructor options (frame:false, transparent).
//   viewConfig(cfg)  — { margin, radius } so window.js insets + rounds the app view.
//   hostHtml(cfg)    — the host page (the shadow), filled from host.html.
//   attachPlugin()   — injects the tint into the VIEW (api.webContents), sets resizable on the
//                      host window, and contributes context-menu items.

const fs   = require('node:fs')
const path = require('node:path')

// Corner-radius bounds. Must stay in sync with the slider in config.html (min/max/default).
const DEFAULT_RADIUS = 14
const MIN_RADIUS = 0
const MAX_RADIUS = 24

// Tint = a single CSS colour chosen via the Coloris picker in config.html, stored as a hex
// string (#RRGGBB / #RRGGBBAA). Default #000000a6 = black at ~0.65 alpha, the original look.
const DEFAULT_TINT  = '#000000a6'
const FALLBACK_TINT = 'rgba(0, 0, 0, 0.65)'
const MAX_TINT_ALPHA = 0.99

// Drop shadow (default on). Width (the blur) is configurable; offset + colour are fixed. The host
// insets the app view by a gutter so the shadow has room; the gutter is derived from the width.
// Width range matches the slider in config.html.
const SHADOW_OFFSET = 3
const SHADOW_COLOR  = 'rgba(0, 0, 0, 0.85)'
const MIN_SHADOW_WIDTH = 2
const MAX_SHADOW_WIDTH = 8
const DEFAULT_SHADOW_WIDTH = 8

// Building-block files, read once. Placeholders are filled per-app at attach/host time.
const TINT_CSS_TEMPLATE  = fs.readFileSync(path.join(__dirname, 'tint.css'), 'utf8')
const HOST_TEMPLATE      = fs.readFileSync(path.join(__dirname, 'host.html'), 'utf8')
const MOVE_SCRIPT        = fs.readFileSync(path.join(__dirname, 'move-overlay.js'), 'utf8')
const NO_TITLEBAR_SCRIPT = fs.readFileSync(path.join(__dirname, 'no-titlebar.js'), 'utf8')
const DRAG_ZONE_HTML     = fs.readFileSync(path.join(__dirname, 'drag-zone.html'), 'utf8')
// Absolute path to the overlay's preload — window.js needs it to build the drag-zone WebContentsView.
const DRAG_ZONE_PRELOAD  = path.join(__dirname, 'drag-zone-preload.js')

// move.svg as a data URL — handed to the page move-overlay so no file:// path is needed in the page.
const MOVE_ICON = (() => {
  try { return `data:image/svg+xml;base64,${fs.readFileSync(path.join(__dirname, 'move.svg')).toString('base64')}` }
  catch { return null }
})()

// "Move" context-menu icon as a { light, dark } pair of SVG data URLs — the custom menu overlay
// renders SVG directly (no nativeImage/PNG needed) and picks the variant matching its theme. The
// mono glyph is #444444; we swap it to a light tone for the dark-menu variant.
//   light → dark glyph (for a light menu) · dark → light glyph (for a dark menu)
function themedSvgIcon(absPath) {
  let svg
  try { svg = fs.readFileSync(absPath, 'utf8') } catch { return null }
  const url = (colour) => `data:image/svg+xml;base64,${Buffer.from(svg.replace(/#444444/gi, colour)).toString('base64')}`
  return { light: url('#444444'), dark: url('#f0f0f0') }
}
const MOVE_MENU_ICON = themedSvgIcon(path.join(__dirname, 'move.svg'))

// Clamp the configured radius to the supported range; fall back to the default for missing/invalid.
function resolveRadius(config) {
  const r = Number(config?.radius)
  if (!Number.isFinite(r)) return DEFAULT_RADIUS
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.round(r)))
}

// Parse a colour string into { r, g, b, a }. Accepts hex (#rgb/#rgba/#rrggbb/#rrggbbaa — the
// Coloris output) and rgb()/rgba() (for configs saved before the hex switch). null if no match.
function parseColor(raw) {
  const s = String(raw).trim()
  let m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : parseFloat(m[4]) }
  m = /^#([0-9a-f]{3,8})$/i.exec(s)
  if (m) {
    let h = m[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('')
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      }
    }
  }
  return null
}

// Normalise the configured tint into an rgba() string, alpha capped just below opaque so a fully
// opaque tint can't square off the rounded view corners. Falls back for missing/malformed values.
function resolveTint(config) {
  const c = parseColor(config?.tint ?? DEFAULT_TINT)
  if (!c) return FALLBACK_TINT
  const r = Math.min(255, c.r), g = Math.min(255, c.g), b = Math.min(255, c.b)
  let a = Number.isFinite(c.a) ? c.a : 1
  a = Math.min(Math.max(a, 0), MAX_TINT_ALPHA)
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`
}

// Whether the window can be resized. Default yes — only an explicit false locks the size.
function resolveResizable(config) {
  return config?.resizable !== false
}

// Whether to paint our tint over the page (and clear the app's root backgrounds so the desktop
// shows through). Default OFF — it only takes effect on pages whose own background is transparent
// (e.g. Home Assistant), and the broad root-clearing selector can strip backgrounds the app needs
// (e.g. draw.io's menus). So it's opt-in: on → tint + show-through, off → page left exactly as-is.
function tintEnabled(config) {
  return config?.tintBackground === true
}

// Whether to hide the app's scrollbars (keeping wheel/touchpad scrolling). Default yes — only an
// explicit false leaves the native scrollbars visible.
function scrollbarsHidden(config) { return config?.hideScrollbars !== false }

// The CSS that hides scrollbars; injected only when the toggle is on (see tint.css for why both
// the standard scrollbar-width and the -webkit pseudo are needed).
const HIDE_SCROLLBARS_CSS =
  '* { scrollbar-width: none !important; }\n' +
  '*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }'

// Whether to stop the app drawing its own titlebar / top drag-zone (see no-titlebar.js). Default
// OFF — like the tint, it changes how the page sees its environment, so it's opt-in: apps that draw
// such a strip when frameless (e.g. Microsoft Teams) enable it; the widget's own Move mode replaces
// the lost drag affordance.
function suppressTitlebar(config) { return config?.suppressAppTitlebar === true }

// Whether to render our own invisible top drag strip. Default ON — it is the only reliable way to
// move the frameless window for apps whose toolbar lives in a cross-origin OOPIF (e.g. the Office/
// WOPI editor frame): an app-region:drag region inside such a frame is NOT honored for the host
// window, but our overlay is our own top-frame view, so its drag region always works. An explicit
// false disables it (e.g. an app whose own titlebar already moves the window fine).
function dragZoneEnabled(config) { return config?.dragZone !== false }

// Whether the drag strip uses the light theme. Default OFF (dark) — the dark, translucent panel reads
// well over any page; an explicit true switches it to a light variant (chosen per app in config.html).
function dragZoneLight(config) { return config?.dragZoneLight === true }

// Neutralises every -webkit-app-region:drag region the app declares (Teams marks a top strip as one,
// which then moves the window and even maximises on double-click). The JS spoof (no-titlebar.js) only
// stops apps that GATE the strip on a detected display-mode; this CSS disables the drag behaviour
// regardless of how the region got there. The move overlay re-enables drag on itself with an inline
// !important, which beats this stylesheet rule (inline !important wins over author !important).
const NO_DRAG_CSS = '* { -webkit-app-region: no-drag !important; }'

function shadowEnabled(config) { return config?.shadow !== false }
function resolveShadowWidth(config) {
  const w = Number(config?.shadowWidth)
  if (!Number.isFinite(w)) return DEFAULT_SHADOW_WIDTH
  return Math.min(MAX_SHADOW_WIDTH, Math.max(MIN_SHADOW_WIDTH, Math.round(w)))
}

// frame:false → no titlebar/border; transparent → the rounded view's corners + the shadow gutter
// show the desktop. These apply to the HOST window (the app runs in the inset view).
function windowOptions() {
  return { frame: false, transparent: true, backgroundColor: '#00000000' }
}

// View geometry for window.js: how far to inset the app view (the shadow gutter) and its corner
// radius. Shadow off → margin 0 (the view fills the window, still rounded).
function viewConfig(config) {
  const margin = shadowEnabled(config) ? SHADOW_OFFSET + resolveShadowWidth(config) + 1 : 0
  return { margin, radius: resolveRadius(config) }
}

// The host page: a transparent rounded rectangle the size/position of the app view, carrying the
// box-shadow (so the shadow sits in the gutter behind the view). Shadow off → no shadow.
function hostHtml(config) {
  const on = shadowEnabled(config)
  const margin = on ? SHADOW_OFFSET + resolveShadowWidth(config) + 1 : 0
  const shadow = on ? `0 ${SHADOW_OFFSET}px ${resolveShadowWidth(config)}px ${SHADOW_COLOR}` : 'none'
  return HOST_TEMPLATE
    .replace(/\{\{margin\}\}/g, `${margin}px`)
    .replace(/\{\{radius\}\}/g, `${resolveRadius(config)}px`)
    .replace(/\{\{shadow\}\}/g, shadow)
}

// View-mode hook (collected by window.js alongside viewConfig/hostHtml): the drag-zone overlay's
// page + the absolute path to its preload, or null when disabled. window.js renders it as a
// WebContentsView on top of the app view, 1px when idle, expanded on hover. Only meaningful in view
// mode (a frameless host window), which is why it travels with the other view-mode hooks.
function dragZone(config) {
  return dragZoneEnabled(config)
    ? { html: DRAG_ZONE_HTML, preload: DRAG_ZONE_PRELOAD, light: dragZoneLight(config) }
    : null
}

// Enters move mode: hands the overlay its parameters via window.__voltageWidgetMove, then runs
// move-overlay.js in the page. `wc` is the app view's webContents.
function enterMoveMode(wc, t) {
  // Pass the current page zoom so the overlay can counter-scale its panel to a constant on-screen
  // size — otherwise a zoomed view (zoom plugin) would scale the move panel along with the page.
  const params = { icon: MOVE_ICON, hintText: t.widgetMoveHint, doneText: t.widgetMoveDone, zoom: wc.getZoomFactor() }
  wc.executeJavaScript(`window.__voltageWidgetMove = ${JSON.stringify(params)};`)
    .then(() => wc.executeJavaScript(MOVE_SCRIPT))
    .catch(() => {})
}

// Injects the tint into the app VIEW (api.webContents — NOT the host window). did-finish-load
// covers initial + SPA full navigations. Tint off → inject nothing (page untouched). Sets the
// host window resizable from config and contributes "Move"/"Quit" context-menu items.
function attachPlugin(win, api) {
  const wc = api.webContents
  const tintOn = tintEnabled(api.config)
  const suppress = suppressTitlebar(api.config)
  const css = TINT_CSS_TEMPLATE
    .replace(/\{\{htmlBackground\}\}/g, tintOn ? `background: ${resolveTint(api.config)} !important;` : '')
    .replace(/\{\{appRootTransparency\}\}/g, tintOn ? 'background-color: transparent !important;' : '')
    .replace(/\{\{hideScrollbars\}\}/g, scrollbarsHidden(api.config) ? HIDE_SCROLLBARS_CSS : '')
    + (suppress ? NO_DRAG_CSS : '')
  wc.on('did-finish-load', () => wc.insertCSS(css).catch(() => {}))

  // Suppress the app's self-drawn titlebar/drag-zone. Two prongs: the NO_DRAG_CSS above disables the
  // drag behaviour of any region the app marks, and this JS spoof (on dom-ready, earlier than
  // did-finish-load, so it beats the app's UI render) tries to stop the app rendering the strip at
  // all by hiding the standalone/WCO signals. The script guards against double-injection.
  if (suppress)
    wc.on('dom-ready', () => wc.executeJavaScript(NO_TITLEBAR_SCRIPT).catch(() => {}))

  // F10 toggles move mode (same overlay as the "Move" menu item — move-overlay.js toggles itself).
  // before-input-event fires ahead of the page, and preventDefault keeps F10 from reaching the app.
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F10') {
      event.preventDefault()
      enterMoveMode(wc, api.t())
    }
  })

  win.setResizable(resolveResizable(api.config))

  return {
    contextMenuItems: () => {
      const t = api.t()
      // order: Zoom (10) sits above Move (20); Quit is pinned last (high order) so other plugin /
      // core items (Fullscreen, About) land between them — see window.js.
      return [
        { label: t.widgetMove, order: 20, shortcut: 'F10', ...(MOVE_MENU_ICON && { icon: MOVE_MENU_ICON }), click: () => enterMoveMode(wc, t) },
        { label: t.widgetQuit.replace('{name}', api.displayName), order: 1000, click: () => api.quit() },
      ]
    },
  }
}

// configurable: the dialog's plugin chip shows a configure button (dialog = config.html). The
// widget exposes radius, tint, shadow and resizable; most plugins omit this (default false).
module.exports = { windowOptions, viewConfig, hostHtml, dragZone, attachPlugin, configurable: true }
