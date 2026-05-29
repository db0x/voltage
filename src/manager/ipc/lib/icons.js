// GTK icon-theme resolution. Maps icon names (e.g. "application-default-icon") to
// absolute file paths via a Python/GTK subprocess, batching all names in one call.

const { spawnSync } = require('node:child_process')
const { runAsync }  = require('./subprocess')

const GTK_ICON_SCRIPT = `
import gi, sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
theme = Gtk.IconTheme.get_default()
for name in sys.argv[1:]:
    info = theme.lookup_icon(name, 64, 0)
    print(info.get_filename() if info else '')
`

// Resolves GTK icon names to absolute file paths using the system icon theme.
// A single Python/GTK subprocess handles all names in one call to amortize startup cost.
// Returns null for names that are not found in any installed theme.
function resolveIconsByGtk(names) {
  if (names.length === 0) return {}
  const r = spawnSync('python3', ['-c', GTK_ICON_SCRIPT, ...names], { encoding: 'utf8', timeout: 3000 })
  if (r.error || r.status !== 0) return {}
  const lines = (r.stdout || '').split('\n')
  return Object.fromEntries(names.map((name, i) => [name, lines[i] || null]))
}

// Async variant of resolveIconsByGtk — returns a Promise so the call can be pre-warmed.
function resolveIconsByGtkAsync(names) {
  if (names.length === 0) return Promise.resolve({})
  return runAsync('python3', ['-c', GTK_ICON_SCRIPT, ...names], 3000).then(stdout => {
    const lines = stdout.split('\n')
    return Object.fromEntries(names.map((name, i) => [name, lines[i] || null]))
  })
}

// Pre-warm the generic app-placeholder lookup the moment this module is loaded — Electron's
// app.whenReady() and BrowserWindow creation run in parallel, so it is usually resolved
// before the first IPC call. Skipped in tests (no display server in headless Playwright).
const prefetchedAppDefaultIcon = process.env.WRAPWEB_TEST
  ? Promise.resolve({})
  : resolveIconsByGtkAsync(['application-default-icon'])

module.exports = { resolveIconsByGtk, resolveIconsByGtkAsync, prefetchedAppDefaultIcon }
