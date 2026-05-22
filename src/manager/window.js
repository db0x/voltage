// Creates and manages the wrapweb manager window.
// Persists window bounds across sessions so the user's preferred size is restored on next launch.

const { app, BrowserWindow, Menu } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const { t } = require('../i18n')

const APP_ROOT         = app.getAppPath()
const managerStatePath = path.join(app.getPath('appData'), 'wrapweb', 'manager-state.json')

function loadManagerBounds() {
  try {
    const { width, height } = JSON.parse(fs.readFileSync(managerStatePath, 'utf8'))
    if (width > 0 && height > 0) return { width, height }
  } catch {}
  return null
}

function saveManagerBounds(win) {
  try {
    const { width, height } = win.getBounds()
    fs.mkdirSync(path.dirname(managerStatePath), { recursive: true })
    fs.writeFileSync(managerStatePath, JSON.stringify({ width, height }), 'utf8')
  } catch {}
}

function openManager() {
  const saved = loadManagerBounds()
  const win = new BrowserWindow({
    width:     saved?.width  ?? 780,
    height:    saved?.height ?? 820,
    minWidth:  400,
    minHeight: 400,
    title: 'wrapweb Manager',
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
