// Discovers the injectable plugins shipped under webapps/plugins.
// Top-level .js files are uncategorized; one level of subdirectory groups plugins by category.

const { ipcMain } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')

const { CONFIGS_DIR } = require('../lib/paths')

module.exports = function registerPluginHandlers() {
  ipcMain.handle('manager:plugins', () => {
    const pluginsDir = path.join(CONFIGS_DIR, 'plugins')
    if (!fs.existsSync(pluginsDir)) return []
    const entries = []
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        entries.push({ file: `plugins/${entry.name}`, label: entry.name.replace(/\.js$/, ''), category: null })
      } else if (entry.isDirectory()) {
        const subDir = path.join(pluginsDir, entry.name)
        for (const sub of fs.readdirSync(subDir, { withFileTypes: true })) {
          if (sub.isFile() && sub.name.endsWith('.js'))
            entries.push({ file: `plugins/${entry.name}/${sub.name}`, label: sub.name.replace(/\.js$/, ''), category: entry.name })
        }
      }
    }
    return entries
  })
}
