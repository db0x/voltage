// rclone integration: detect the binary, list Google Drive remotes, and persist
// the manager's rclone config (which remote/folder maps to the Drive file handler).

const { ipcMain } = require('electron')
const { spawnSync } = require('node:child_process')

const { runAsync }      = require('../lib/subprocess')
const { makeJsonStore } = require('../lib/json-store')

const rcloneStore = makeJsonStore('rclone.json')

// Pre-warm the binary presence check at module load (resolved before the first IPC call).
const prefetchedRcloneAvailable = runAsync('which', ['rclone'], 2000).then(out => ({ available: !!out.trim() }))

module.exports = function registerRcloneHandlers() {
  ipcMain.handle('manager:rclone-status', () => prefetchedRcloneAvailable)

  // Returns names of all rclone remotes configured as Google Drive (type = drive).
  ipcMain.handle('manager:rclone-drive-remotes', () => {
    const r = spawnSync('rclone', ['config', 'dump'], { encoding: 'utf8', timeout: 5000 })
    if (r.status !== 0) return []
    try {
      const config = JSON.parse(r.stdout)
      return Object.entries(config)
        .filter(([, v]) => v.type === 'drive')
        .map(([name]) => name)
    } catch { return [] }
  })

  ipcMain.handle('manager:rclone-load-config', () => rcloneStore.load())
  ipcMain.handle('manager:rclone-save-config', (event, config) => rcloneStore.save(config))
}
