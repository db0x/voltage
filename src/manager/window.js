// Creates and manages the voltage manager window.
// Persists window bounds and the user's last-known theme across sessions:
// bounds restore the preferred size; the theme flag is used as the BrowserWindow
// backgroundColor so the freshly created window is painted in the user's chosen
// theme color from the very first frame. Combined with the renderer-side
// visibility gate (body becomes .ready only after all init has run), the user
// sees a uniform theme-colored window that snaps to the fully-assembled UI
// instead of watching components mount one by one.

const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const { t } = require('../i18n')

const APP_ROOT         = app.getAppPath()
const managerStatePath = path.join(app.getPath('appData'), 'voltage', 'manager-state.json')

// Theme-matching backgrounds keep the initial window frame visually consistent
// with what the renderer will draw a moment later — must mirror --bg in manager.css.
const BG_LIGHT = '#f0f0f0'
const BG_DARK  = '#1e1e1e'

function loadManagerState() {
  try {
    return JSON.parse(fs.readFileSync(managerStatePath, 'utf8')) || {}
  } catch { return {} }
}

function saveManagerState(patch) {
  try {
    const current = loadManagerState()
    fs.mkdirSync(path.dirname(managerStatePath), { recursive: true })
    fs.writeFileSync(managerStatePath, JSON.stringify({ ...current, ...patch }), 'utf8')
  } catch {}
}

function saveManagerBounds(win) {
  try {
    const { width, height } = win.getBounds()
    if (width > 0 && height > 0) saveManagerState({ width, height })
  } catch {}
}

// Persists the dark flag on every toggle so the next cold start paints
// the correct backgroundColor before manager.js can apply the body class.
// Registered once per process — ipc.js owns all the app-data IPC handlers, but
// this one belongs here because it's load-bearing for the next launch's chrome.
let darkIpcRegistered = false
function registerDarkIpc() {
  if (darkIpcRegistered) return
  darkIpcRegistered = true
  ipcMain.handle('manager:set-dark', (_event, dark) => {
    saveManagerState({ dark: !!dark })
  })
}

function openManager() {
  registerDarkIpc()
  const saved = loadManagerState()
  const width  = saved.width  > 0 ? saved.width  : 780
  const height = saved.height > 0 ? saved.height : 820
  const dark   = saved.dark === true
  const win = new BrowserWindow({
    width, height,
    minWidth:  400,
    minHeight: 400,
    title: 'Voltage',
    backgroundColor: dark ? BG_DARK : BG_LIGHT,
    webPreferences: {
      preload: path.join(APP_ROOT, 'src', 'manager', 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })
  win.on('close', () => saveManagerBounds(win))
  win.webContents.on('context-menu', (_event, params) => {
    const i18n = t()
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'cut',   label: i18n.cut   },
        { role: 'copy',  label: i18n.copy  },
        { role: 'paste', label: i18n.paste },
      ]).popup({ window: win })
    } else if (params.selectionText) {
      Menu.buildFromTemplate([
        { role: 'copy', label: i18n.copy },
      ]).popup({ window: win })
    }
  })
  win.loadFile(path.join(APP_ROOT, 'src', 'manager', 'manager.html'))
}

module.exports = { openManager }
