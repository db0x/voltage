// widget plugin (main-process module). Turns the app window into a frameless, transparent,
// rounded "widget": no titlebar/border/buttons, a dark translucent tint, hidden scrollbars, a
// context-menu "Move" mode and "Quit" entry.
//
// Building blocks live as real files, not inline strings:
//   tint.css         — the page tint/rounding, injected via insertCSS (a frameless window can't
//                      load an external stylesheet under strict app CSPs).
//   move-overlay.js  — the move-mode overlay, run in the page via executeJavaScript.
//
// Why windowOptions() and not attachPlugin(): frame/transparent are BrowserWindow CONSTRUCTOR
// options and can't change after the window exists. attachPlugin() runs after creation, so it's
// too late. window.js collects each plugin's optional windowOptions(pkg) BEFORE creating the
// window and merges the result (webPreferences stays owned by window.js).

const fs   = require('node:fs')
const path = require('node:path')

const RADIUS = '14px'

// Read the building-block files once at load. tint.css has a {{radius}} placeholder.
const TINT_CSS    = fs.readFileSync(path.join(__dirname, 'tint.css'), 'utf8').replace(/\{\{radius\}\}/g, RADIUS)
const MOVE_SCRIPT = fs.readFileSync(path.join(__dirname, 'move-overlay.js'), 'utf8')

// move.svg as a data URL — loaded here (FS access) and handed to the page overlay, so no
// file:// path is needed from the page context. null if missing.
const MOVE_ICON = (() => {
  try { return `data:image/svg+xml;base64,${fs.readFileSync(path.join(__dirname, 'move.svg')).toString('base64')}` }
  catch { return null }
})()

// frame:false → no titlebar/border/buttons; transparent + transparent backgroundColor → no
// native window background so the page (and the desktop, where transparent) shows through.
// (Window transparency is Wayland-compositor dependent.)
function windowOptions() {
  return { frame: false, resizable: true, transparent: true, backgroundColor: '#00000000' }
}

// Enters move mode: hands the overlay its parameters via window.__wrapwebWidgetMove, then runs
// move-overlay.js in the page. Two executeJavaScript calls keep the params out of the script
// file; the param assignment is a plain JSON literal, the script file is verbatim.
function enterMoveMode(win, t) {
  const params = { icon: MOVE_ICON, hintText: t.widgetMoveHint, doneText: t.widgetMoveDone }
  win.webContents
    .executeJavaScript(`window.__wrapwebWidgetMove = ${JSON.stringify(params)};`)
    .then(() => win.webContents.executeJavaScript(MOVE_SCRIPT))
    .catch(() => {})
}

// Inject the tint on every load: insertCSS before the first load is lost, and SPA full
// navigations replace the document. did-finish-load covers both initial and later navigations.
// Returns context menu entries (window.js appends them): "Move widget" (enters drag mode, since
// a frameless window can't be dragged by a titlebar) and "Quit" (no window close button exists).
function attachPlugin(win, api) {
  win.webContents.on('did-finish-load', () => win.webContents.insertCSS(TINT_CSS).catch(() => {}))

  return {
    contextMenuItems: () => {
      const t = api.t()
      return [
        { label: t.widgetMove, click: () => enterMoveMode(win, t) },
        { label: t.widgetQuit.replace('{name}', api.displayName), click: () => api.quit() },
      ]
    },
  }
}

module.exports = { windowOptions, attachPlugin }
