// Persisted manager settings backed by simple JSON files: global settings and the
// Google Safe Browsing config. Both are plain load/save pairs via the shared store.

const { ipcMain } = require('electron')
const { makeJsonStore } = require('../lib/json-store')

const globalSettingsStore = makeJsonStore('global-settings.json')
const safeBrowsingStore   = makeJsonStore('safe-browsing.json')

module.exports = function registerSettingsHandlers() {
  ipcMain.handle('manager:global-settings-load', () => globalSettingsStore.load())
  ipcMain.handle('manager:global-settings-save', (event, config) => globalSettingsStore.save(config))

  ipcMain.handle('manager:safe-browsing-load-config', () => safeBrowsingStore.load())
  ipcMain.handle('manager:safe-browsing-save-config', (event, config) => safeBrowsingStore.save(config))
}
