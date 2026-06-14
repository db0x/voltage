// Obsidian plugin integration: detect whether Obsidian handles obsidian:// links,
// list known vaults with install status, and copy the bundled plugin into each vault.

const { ipcMain } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const os   = require('node:os')

const { APP_ROOT } = require('../lib/paths')
const { runAsync } = require('../lib/subprocess')

// Returns the path to obsidian.json, trying multiple packaging formats in order:
// standard XDG (AppImage, .deb, .rpm, native), Flatpak, Snap.
function resolveObsidianJson(configHome) {
  const candidates = [
    path.join(configHome, 'obsidian', 'obsidian.json'),
    path.join(os.homedir(), '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
    path.join(os.homedir(), 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'),
  ]
  return candidates.find(p => fs.existsSync(p)) ?? candidates[0]
}

// Pre-warm Obsidian availability at module load (resolved before the first IPC call).
// In test mode, VOLTAGE_TEST_OBSIDIAN_AVAILABLE forces the drawer entry on without
// requiring a real obsidian:// MIME registration on the host.
const prefetchedObsidianAvailable = process.env.VOLTAGE_TEST
  ? Promise.resolve(process.env.VOLTAGE_TEST_OBSIDIAN_AVAILABLE === '1')
  : runAsync('xdg-mime', ['query', 'default', 'x-scheme-handler/obsidian'], 2000).then(out => !!out.trim())

module.exports = function registerObsidianHandlers() {
  ipcMain.handle('manager:obsidian-available', () => prefetchedObsidianAvailable)

  // Returns the list of known Obsidian vaults with the plugin install status for each.
  // Vault list is read from the Obsidian app config (obsidian.json) at query time.
  // isObsidianFlatpak signals that the user needs to grant the Flatpak sandbox
  // access to spawn AppImages from $HOME (see dialog hint).
  ipcMain.handle('manager:obsidian-plugin-status', () => {
    const configHome    = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    // Different packaging formats store config in different locations.
    // We try standard XDG first (AppImage, .deb, .rpm), then Flatpak, then Snap.
    const obsidianJson  = resolveObsidianJson(configHome)
    const flatpakObsidianJson = path.join(os.homedir(), '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json')
    // VOLTAGE_TEST_OBSIDIAN_FLATPAK forces detection on/off in tests so the dialog hint
    // can be exercised without an actual Flatpak Obsidian install on the host.
    // VOLTAGE_FORCE_OBSIDIAN_FLATPAK=1 enables the same override outside test mode —
    // useful for previewing the hint locally on a native Obsidian install.
    const isObsidianFlatpak   = process.env.VOLTAGE_FORCE_OBSIDIAN_FLATPAK === '1'
      || (process.env.VOLTAGE_TEST
        ? process.env.VOLTAGE_TEST_OBSIDIAN_FLATPAK === '1'
        : fs.existsSync(flatpakObsidianJson))
    const bundledManifest = path.join(APP_ROOT, 'src', 'plugins', 'obsidian', 'manifest.json')

    let bundledVersion = null
    try { bundledVersion = JSON.parse(fs.readFileSync(bundledManifest, 'utf8')).version } catch {}

    let vaults = []
    try {
      const data = JSON.parse(fs.readFileSync(obsidianJson, 'utf8'))
      vaults = Object.values(data.vaults || {})
        .filter(v => v.path && fs.existsSync(v.path))
        .map(v => {
          const pluginDir      = path.join(v.path, '.obsidian', 'plugins', 'voltage')
          const manifestFile   = path.join(pluginDir, 'manifest.json')
          const mainFile       = path.join(pluginDir, 'main.js')
          let installedVersion = null
          if (fs.existsSync(manifestFile) && fs.existsSync(mainFile)) {
            try { installedVersion = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version } catch {}
          }
          return { path: v.path, name: path.basename(v.path), installedVersion }
        })
    } catch {}

    return { bundledVersion, vaults, isObsidianFlatpak }
  })

  // Copies manifest.json and main.js into every known Obsidian vault.
  ipcMain.handle('manager:obsidian-plugin-install', () => {
    const configHome   = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    const obsidianJson = resolveObsidianJson(configHome)
    const srcDir       = path.join(APP_ROOT, 'src', 'plugins', 'obsidian')

    let vaultPaths = []
    try {
      const data = JSON.parse(fs.readFileSync(obsidianJson, 'utf8'))
      vaultPaths = Object.values(data.vaults || {})
        .filter(v => v.path && fs.existsSync(v.path))
        .map(v => v.path)
    } catch {}

    let count = 0
    for (const vaultPath of vaultPaths) {
      try {
        const dest = path.join(vaultPath, '.obsidian', 'plugins', 'voltage')
        fs.mkdirSync(dest, { recursive: true })
        fs.copyFileSync(path.join(srcDir, 'manifest.json'), path.join(dest, 'manifest.json'))
        fs.copyFileSync(path.join(srcDir, 'main.js'),       path.join(dest, 'main.js'))
        count++
      } catch {}
    }
    return { success: count > 0, count }
  })
}
