// GNOME Shell extension integration: detect whether we run under a GNOME Shell session,
// report the bundled vs installed extension version (and whether it is enabled), and copy
// the bundled extension into the user's extensions directory + enable it.
//
// Mirrors the Obsidian integration: the extension is shipped inside the app (src/plugins/gnome)
// and "installed" by copying it to the well-known per-user location. The extension itself reads
// the .desktop launchers to decide which Voltage widget windows to hide from the dash/dock.

const { ipcMain } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const os   = require('node:os')

const { APP_ROOT } = require('../lib/paths')
const { runAsync } = require('../lib/subprocess')

// Must match metadata.json's uuid — the extensions directory is named after it.
const EXT_UUID = 'voltage@db0x.de'
const BUNDLED_DIR = path.join(APP_ROOT, 'src', 'plugins', 'gnome')
// Files that make up the extension; copied verbatim on install.
const EXT_FILES = ['extension.js', 'metadata.json']

function installedExtDir() {
  // VOLTAGE_TEST_GNOME_EXT_DIR redirects the install target in tests so the real
  // ~/.local/share/gnome-shell/extensions is never touched.
  const base = process.env.VOLTAGE_TEST && process.env.VOLTAGE_TEST_GNOME_EXT_DIR
    ? process.env.VOLTAGE_TEST_GNOME_EXT_DIR
    : path.join(os.homedir(), '.local', 'share', 'gnome-shell', 'extensions')
  return path.join(base, EXT_UUID)
}

// Reads the integer `version` from a metadata.json, or null when absent/unreadable.
function readMetadataVersion(metadataPath) {
  try { return JSON.parse(fs.readFileSync(metadataPath, 'utf8')).version ?? null } catch { return null }
}

// Pre-warm GNOME Shell availability at module load. We treat the integration as available
// when the current desktop is GNOME (the only place the extension can run). In test mode,
// VOLTAGE_TEST_GNOME_AVAILABLE forces the drawer entry on without a real GNOME session.
const prefetchedGnomeAvailable = process.env.VOLTAGE_TEST
  ? Promise.resolve(process.env.VOLTAGE_TEST_GNOME_AVAILABLE === '1')
  : Promise.resolve(/gnome/i.test(process.env.XDG_CURRENT_DESKTOP || ''))

module.exports = function registerGnomeHandlers() {
  ipcMain.handle('manager:gnome-available', () => prefetchedGnomeAvailable)

  // Returns bundled/installed extension versions, whether it is currently enabled, and whether
  // the session is Wayland (where a relog is required for GNOME to load the new extension).
  ipcMain.handle('manager:gnome-extension-status', async () => {
    const bundledVersion   = readMetadataVersion(path.join(BUNDLED_DIR, 'metadata.json'))
    const installedVersion = readMetadataVersion(path.join(installedExtDir(), 'metadata.json'))

    // `gnome-extensions list --enabled` is the reliable way to know the enabled set without
    // poking dconf directly. Absent binary / non-GNOME host yields '' → not enabled.
    const enabledList = process.env.VOLTAGE_TEST
      ? (process.env.VOLTAGE_TEST_GNOME_ENABLED || '')
      : await runAsync('gnome-extensions', ['list', '--enabled'], 3000)
    const enabled = enabledList.split('\n').map(s => s.trim()).includes(EXT_UUID)

    const isWayland = process.env.VOLTAGE_TEST
      ? process.env.VOLTAGE_TEST_GNOME_WAYLAND === '1'
      : (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland'

    return { bundledVersion, installedVersion, enabled, isWayland }
  })

  // Copies the extension files into the per-user extensions directory and enables it.
  // Enable can fail when GNOME has not yet rescanned (typical on Wayland until relog); we still
  // report success on the copy so the dialog can show the "relog required" hint.
  ipcMain.handle('manager:gnome-extension-install', async () => {
    const dest = installedExtDir()
    try {
      fs.mkdirSync(dest, { recursive: true })
      for (const file of EXT_FILES) {
        fs.copyFileSync(path.join(BUNDLED_DIR, file), path.join(dest, file))
      }
    } catch {
      return { success: false, enabled: false }
    }

    // Best-effort enable. On Wayland GNOME only discovers the new extension after a relog, so a
    // failure here is expected and surfaced to the user as a hint rather than an error.
    if (!process.env.VOLTAGE_TEST) {
      await runAsync('gnome-extensions', ['enable', EXT_UUID], 3000)
    }
    const enabledList = process.env.VOLTAGE_TEST
      ? (process.env.VOLTAGE_TEST_GNOME_ENABLED_AFTER || process.env.VOLTAGE_TEST_GNOME_ENABLED || '')
      : await runAsync('gnome-extensions', ['list', '--enabled'], 3000)
    const enabled = enabledList.split('\n').map(s => s.trim()).includes(EXT_UUID)

    return { success: true, enabled }
  })
}
