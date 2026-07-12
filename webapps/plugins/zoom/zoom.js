// zoom plugin (main-process module). Restores Ctrl+mouse-wheel zoom for an app: a small wheel
// listener injected into the page reports each ctrl+wheel tick over the preload bridge, and the
// main process steps the view's zoom factor. The step size and the min/max zoom bounds are
// configurable per app (see config.html). Extracted from window.js so zoom is opt-in per app like
// every other plugin instead of being baked into every window.
//
// Why the zoom happens in main (not via page CSS): a page can't change its own webContents zoom —
// setZoomFactor is a webContents API. The renderer can only signal intent, which it does through
// the preload-exposed window.electronAPI.adjustZoom(direction) → ipc 'adjust-zoom'.
//
// The plugin also contributes a "Zoom" context-menu submenu (zoom in / out / reset) via the
// contextMenuItems() hook — the same path the widget plugin uses for its entries.

const { app, ipcMain } = require('electron')
const fs   = require('node:fs')
const path = require('node:path')

// The page-context script (ctrl+wheel listener + the percentage OSD), read once. Injected after
// every load; main calls window.__voltageZoomOsd.show(pct) through it after each zoom step.
const OSD_SCRIPT = fs.readFileSync(path.join(__dirname, 'zoom-osd.js'), 'utf8')

// zoom.svg as a data URL, handed to the OSD so no file:// path is needed in the page (same pattern
// as the widget plugin's move icon). null if the asset is missing/unreadable → OSD shows text only.
const ZOOM_ICON = (() => {
  try { return `data:image/svg+xml;base64,${fs.readFileSync(path.join(__dirname, 'zoom.svg')).toString('base64')}` }
  catch { return null }
})()

// Context-menu icons as { light, dark } pairs of SVG data URLs — the custom menu overlay renders SVG
// directly (no nativeImage/PNG needed) and picks the variant matching its theme. The mono glyph is
// #444444; we swap it to a light tone for the dark-menu variant. Sources: zoom.svg (plugin dir) +
// assets/{plus,minus}.svg. null per glyph if its source is missing.
//   light → dark glyph (for a light menu) · dark → light glyph (for a dark menu)
function themedSvgIcon(absPath) {
  let svg
  try { svg = fs.readFileSync(absPath, 'utf8') } catch { return null }
  const url = (colour) => `data:image/svg+xml;base64,${Buffer.from(svg.replace(/#444444/gi, colour)).toString('base64')}`
  return { light: url('#444444'), dark: url('#f0f0f0') }
}
const ASSETS = path.join(__dirname, '..', '..', '..', 'assets')
const MENU_ICONS = {
  zoom:  themedSvgIcon(path.join(__dirname, 'zoom.svg')),
  plus:  themedSvgIcon(path.join(ASSETS, 'plus.svg')),
  minus: themedSvgIcon(path.join(ASSETS, 'minus.svg')),
}

// Configurable knobs with their accepted ranges. The defaults reproduce the old hardcoded
// behaviour (0.1 step, 0.5–3.0 range) so an app that simply adds the plugin behaves as before.
// The slider min/max in config.html must stay in sync with these bounds.
const DEFAULT_STEP = 0.1, MIN_STEP = 0.05, MAX_STEP = 0.5
const DEFAULT_MIN  = 0.5, FLOOR_MIN = 0.3, CAP_MIN = 1.0
const DEFAULT_MAX  = 3.0, FLOOR_MAX = 1.5, CAP_MAX = 5.0

// Clamp a numeric config value into [lo, hi]; fall back to def for missing/NaN values.
function clampNum(raw, lo, hi, def) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

function resolveStep(config) { return clampNum(config?.step, MIN_STEP, MAX_STEP, DEFAULT_STEP) }
function resolveMin(config)  { return clampNum(config?.min,  FLOOR_MIN, CAP_MIN, DEFAULT_MIN) }
function resolveMax(config)  { return clampNum(config?.max,  FLOOR_MAX, CAP_MAX, DEFAULT_MAX) }

// Per-area zoom — opt-in (config.pathZoom, default OFF = the classic behaviour: one manual zoom
// level for the whole app). When enabled, the zoom the user sets is REMEMBERED per page area and
// restored on every navigation into that area; nothing needs configuring beyond the toggle. The
// re-apply is the point: Chromium persists zoom per ORIGIN, so when one origin serves differently
// dense areas (e.g. only-office's document list at "/" vs. its editor at "/edit/…"), a zoom set in
// one area would otherwise bleed into the other. An area without a remembered zoom starts at 100%.
function pathZoomEnabled(config) { return config?.pathZoom === true }

// The app's base path from its configured URL ("http://black/relay" → "/relay", a root-hosted app
// → ""). Areas are derived BELOW this base: an app served under a reverse-proxy path prefix would
// otherwise collapse all its pages into the prefix segment ("/relay") — one shared zoom again.
function baseAppPath(pkgUrl) {
  try {
    const u = new URL(String(pkgUrl ?? ''))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.pathname.replace(/\/+$/, '')
  } catch { return '' }
}

// The "area" a URL belongs to for per-area zoom: its first path segment below the app's base path
// ("/relay/edit/foo.docx" with base "/relay" → "/edit"; the app root itself → "/"). Coarser than the
// full path on purpose — every document under /edit/ shares one zoom level instead of each file
// remembering its own. URLs outside the base keep their own first segment. null for non-http(s)
// URLs (the plugins' data: loading/prompt pages): those keep the current zoom rather than resetting
// it mid-flow.
function zoomAreaKey(url, base = '') {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    let p = u.pathname
    // Strip the base only on a segment boundary ("/relay" must not eat "/relayout/…").
    if (base && (p === base || p.startsWith(`${base}/`))) p = p.slice(base.length)
    const seg = p.split('/').find(Boolean)
    return seg ? `/${seg}` : '/'
  } catch { return null }
}

function attachPlugin(win, api) {
  const wc   = api.webContents
  const step = resolveStep(api.config)
  const min  = resolveMin(api.config)
  const max  = resolveMax(api.config)

  // Set by the per-area block below (only when the feature is on): records a user-chosen zoom for
  // the current page's area so navigation can restore it.
  let rememberAreaZoom = null

  // Apply a zoom change to THIS app's view, then push the resulting percentage to the page's OSD.
  // direction: +1 zoom in, -1 zoom out, 0 reset to 100%. Shared by the ctrl+wheel ipc handler and
  // the context-menu items.
  const applyZoom = (direction) => {
    const current = wc.getZoomFactor()
    const next = direction === 0 ? 1
      : direction > 0 ? Math.min(current + step, max)
      : Math.max(current - step, min)
    wc.setZoomFactor(next)
    if (rememberAreaZoom) rememberAreaZoom(next)
    // pct is an integer literal from Math.round → safe to interpolate; the OSD may not be installed
    // yet (zoom before load finished), so the page guards the call.
    const pct = Math.round(next * 100)
    wc.executeJavaScript(`window.__voltageZoomOsd && window.__voltageZoomOsd.show(${pct})`).catch(() => {})
    return next
  }

  // The event.sender guard matters because ipcMain is process-global: with more than one window in a
  // single process, every window's handler would otherwise re-fire on the same tick and multiply the
  // step. The handler is removed when the view is destroyed.
  const onAdjust = (event, direction) => { if (event.sender === wc) applyZoom(direction) }
  ipcMain.on('adjust-zoom', onAdjust)
  wc.on('destroyed', () => ipcMain.removeListener('adjust-zoom', onAdjust))

  // Hide the OSD when Ctrl is released. Driven from main (not a page keyup) because before-input-event
  // fires even when the page has no keyboard focus — the common case here, since the user just scrolls
  // over the page without clicking into it, so a page-level keyup would never arrive.
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyUp' && input.key === 'Control')
      wc.executeJavaScript('window.__voltageZoomOsd && window.__voltageZoomOsd.hide()').catch(() => {})
  })

  // Inject the page-context script (wheel listener + OSD) after the initial load and every full
  // navigation; a fresh document drops the previous one. SPA soft-navigations keep it. The icon
  // data URL is set first so the OSD can read it on install (mirrors widget.js enterMoveMode).
  wc.on('did-finish-load', () => {
    wc.executeJavaScript(`window.__voltageZoomIcon = ${JSON.stringify(ZOOM_ICON)};`)
      .then(() => wc.executeJavaScript(OSD_SCRIPT))
      .catch(() => {})
  })

  // Per-area zoom (opt-in, see pathZoomEnabled): every user zoom is recorded for the CURRENT page's
  // area, and each navigation restores the target area's remembered level (100% for areas never
  // zoomed). Restores are silent — no OSD — because they set the page's baseline, not a user action.
  // The store lives next to window-state.json in the app's profile dir; it is re-read on every use
  // (and merged on write) so several windows of the same app share it instead of clobbering it.
  if (pathZoomEnabled(api.config)) {
    const storeFile = path.join(app.getPath('userData'), 'zoom-areas.json')
    // Base path from the app's configured URL, so a reverse-proxy prefix (http://black/relay) does
    // not become the only area every page maps to. Read here, not at module level: the plugin file
    // is also required by plain-node tests, where electron's app is not available.
    const base = baseAppPath(require(app.getAppPath() + '/package.json').url)
    const readAreas = () => {
      try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')) } catch { return {} }
    }
    rememberAreaZoom = (factor) => {
      const area = zoomAreaKey(wc.getURL(), base)
      if (!area) return
      try { fs.writeFileSync(storeFile, JSON.stringify({ ...readAreas(), [area]: factor })) } catch {}
    }
    const applyAreaZoom = () => {
      const area = zoomAreaKey(wc.getURL(), base)
      // Stored values are clamped on the way OUT so a hand-edited/corrupt store can't zoom wildly.
      if (area) wc.setZoomFactor(clampNum(readAreas()[area], FLOOR_MIN, CAP_MAX, 1))
    }
    wc.on('did-navigate', applyAreaZoom)
    // Covers client-side (history API) routing, should the wrapped app navigate without a load.
    wc.on('did-navigate-in-page', applyAreaZoom)
  }

  // Contribute a "Zoom" submenu to the context menu (window.js collects this from every plugin).
  // Icons are { light, dark } pairs; the overlay picks the variant for its theme. applyZoom is also
  // exposed so the widget plugin's drag-zone +/- buttons can drive the same zoom logic (window.js
  // finds it on the plugin instance); it returns the resulting zoom factor.
  return {
    applyZoom,
    contextMenuItems: () => {
      const t = api.t()
      const withIcon = (icon, item) => (icon ? { ...item, icon } : item)
      return [
        withIcon(MENU_ICONS.zoom, {
          // order: Zoom (10) above the widget's Move (20) → reads Zoom → Move → … → Quit.
          order: 10,
          label: t.zoomMenu,
          submenu: [
            withIcon(MENU_ICONS.plus,  { label: t.zoomMenuIn,  click: () => applyZoom(1)  }),
            withIcon(MENU_ICONS.minus, { label: t.zoomMenuOut, click: () => applyZoom(-1) }),
            { type: 'separator' },
            { label: t.zoomMenuReset, click: () => applyZoom(0) },
          ],
        }),
      ]
    },
  }
}

// configurable: the chip's configure button opens config.html, where the zoom step, the min/max
// zoom factors and the (opt-in) per-area zoom are set per app. zoomAreaKey/baseAppPath are exported
// for the unit tests.
module.exports = { attachPlugin, zoomAreaKey, baseAppPath, configurable: true }
