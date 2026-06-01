// Discovers the main-process plugins shipped under webapps/plugins, so the create/edit
// dialogs can offer them for per-app selection. A plugin is any .js file under that tree
// (it must export attachPlugin(win, api) — see src/window.js loadPlugins). The returned
// `file` is the path relative to webapps/ (e.g. "plugins/onedrive/onedrive.js"), which is
// exactly what an app config stores in its `plugins` array and what the loader resolves.

const { ipcMain } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')

const { CONFIGS_DIR } = require('../lib/paths')

// Collects every .js file under dir, returning each as a webapps-relative path.
function collectPluginFiles(dir, baseDir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectPluginFiles(full, baseDir, out)
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.relative(baseDir, full))
    }
  }
}

// Reads a plugin's optional plugin.svg (sibling of the .js file) as a data URL so the
// dialog can show it without a file:// path. Returns null when the plugin ships no icon.
function pluginIconDataUrl(relFile) {
  const svg = path.join(CONFIGS_DIR, path.dirname(relFile), 'plugin.svg')
  try {
    return `data:image/svg+xml;base64,${fs.readFileSync(svg).toString('base64')}`
  } catch { return null }
}

module.exports = function registerPluginHandlers() {
  ipcMain.handle('manager:plugins', () => {
    const pluginsDir = path.join(CONFIGS_DIR, 'plugins')
    if (!fs.existsSync(pluginsDir)) return []
    const files = []
    collectPluginFiles(pluginsDir, CONFIGS_DIR, files)
    // Label from the filename without extension — e.g. "plugins/onedrive/onedrive.js" → "onedrive".
    return files
      .map(file => ({ file, label: path.basename(file).replace(/\.js$/, ''), icon: pluginIconDataUrl(file) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })
}
