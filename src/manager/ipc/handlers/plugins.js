// Discovers the main-process plugins shipped under webapps/plugins, so the create/edit
// dialogs can offer them for per-app selection. A plugin is the entry file of a plugin
// directory, named after that directory: plugins/<name>/<name>.js (e.g. onedrive/onedrive.js).
// Any other .js in the directory is a helper module (e.g. widget/move-overlay.js) and is NOT a
// selectable plugin — that's why we don't just list every .js. The returned `file` is the path
// relative to webapps/, exactly what an app config's `plugins` array stores and the loader resolves.

const { ipcMain } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')

const { CONFIGS_DIR } = require('../lib/paths')
const { t }           = require('../../../i18n')

// Collects each plugin directory's entry file (<dir>/<dir>.js), webapps-relative. One level of
// nesting; helper files alongside the entry are ignored.
function collectPluginFiles(pluginsDir, baseDir, out) {
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const entryFile = path.join(pluginsDir, entry.name, `${entry.name}.js`)
    if (fs.existsSync(entryFile)) out.push(path.relative(baseDir, entryFile))
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

// Whether a plugin exposes user-facing settings, read from its `configurable` export. require()
// runs the entry module — fine here (it's the same module window.js loads), but guarded so a
// throwing or absent flag just yields false (a plugin without config is the default).
function pluginConfigurable(relFile) {
  try {
    return require(path.join(CONFIGS_DIR, relFile)).configurable === true
  } catch { return false }
}

// A configurable plugin ships its config dialog as config.html next to its entry file — the
// dialog markup is part of the plugin. Read here so the renderer (which has no file access) can
// host it. Returns null when the plugin declares configurable but ships no dialog yet.
function pluginConfigHtml(relFile) {
  const html = path.join(CONFIGS_DIR, path.dirname(relFile), 'config.html')
  try { return fs.readFileSync(html, 'utf8') } catch { return null }
}

// Whether a plugin's prerequisites are met, read from its optional available() export (e.g.
// docker-integration probing for Docker + Compose). Returns { available, reason } where reason is an
// i18n key for the hover explanation. A plugin without the export — or one whose check throws — is
// treated as available, so a buggy probe never hides a plugin entirely (it just stays selectable).
function pluginAvailability(relFile) {
  try {
    const mod = require(path.join(CONFIGS_DIR, relFile))
    if (typeof mod.available !== 'function') return { available: true, reason: null }
    const r = mod.available()
    if (typeof r === 'boolean') return { available: r, reason: null }
    return { available: r?.available !== false, reason: r?.reason ?? null }
  } catch { return { available: true, reason: null } }
}

// Whether a plugin owns the app's URL (read from its `managesUrl` export). The create/edit dialogs
// lock the URL field while such a plugin is selected, so it isn't hand-edited out from under the
// plugin (docker-integration routes the app to a local container).
function pluginManagesUrl(relFile) {
  try { return require(path.join(CONFIGS_DIR, relFile)).managesUrl === true }
  catch { return false }
}

// Dynamic option lists a plugin offers its config dialog, read from its optional stacks() export
// (e.g. docker-integration's curated compose stacks). The renderer has no file access, so the
// plugin reads them main-side and the config-dialog host fills any <select data-config-options>
// from this. Returns null when the plugin has no such list.
function pluginStacks(relFile) {
  try {
    const mod = require(path.join(CONFIGS_DIR, relFile))
    if (typeof mod.stacks !== 'function') return null
    const list = mod.stacks()
    return Array.isArray(list) ? list : null
  } catch { return null }
}

module.exports = function registerPluginHandlers() {
  ipcMain.handle('manager:plugins', () => {
    const pluginsDir = path.join(CONFIGS_DIR, 'plugins')
    if (!fs.existsSync(pluginsDir)) return []
    const files = []
    collectPluginFiles(pluginsDir, CONFIGS_DIR, files)
    // Reason keys are resolved to localized text here (main-process t() matches the manager's active
    // language) so the renderer's plugin list can stay i18n-agnostic.
    const i18n = t()
    // Label from the filename without extension — e.g. "plugins/onedrive/onedrive.js" → "onedrive".
    // A leading "private." (the gitignored-private naming convention) is dropped from the
    // label only; the stored `file` path keeps it so the loader still resolves the real file.
    return files
      .map(file => {
        const configurable = pluginConfigurable(file)
        const { available, reason } = pluginAvailability(file)
        return {
          file,
          label: path.basename(file).replace(/\.js$/, '').replace(/^private\./, ''),
          icon:  pluginIconDataUrl(file),
          configurable,
          // Only configurable plugins carry their config dialog markup.
          configHtml: configurable ? pluginConfigHtml(file) : null,
          // Availability gates selection in the dropdown; managesUrl locks the dialog's URL field.
          available,
          unavailableReason: available ? null : (i18n[reason] || i18n.pluginUnavailable || ''),
          managesUrl: pluginManagesUrl(file),
          // Dynamic dropdown options for the config dialog (e.g. curated compose stacks).
          stacks: pluginStacks(file),
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  })
}
