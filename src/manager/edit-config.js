// Deep-link interface: open the Manager straight into the edit dialog for a specific app. An app's
// "configure" button (re)launches the Manager with --voltage-edit-config=<profile>. Two paths:
//   - cold start: the renderer pulls the pending profile once via manager:initial-edit-profile.
//   - already running: main.js's second-instance handler pushes it via the manager:open-edit event.
// Wiring lives in main.js (manager mode); the renderer side is in src/manager/manager.js.

const EDIT_CONFIG_ARG = '--voltage-edit-config='

// Extracts the profile to edit from a process argv list, or null when the flag is absent or empty.
function editProfileFromArgv(argv) {
  const hit = (argv || []).find(a => typeof a === 'string' && a.startsWith(EDIT_CONFIG_ARG))
  return hit ? (hit.slice(EDIT_CONFIG_ARG.length) || null) : null
}

// The profile parsed from the cold-start argv, consumed exactly once by the renderer on startup so a
// later manual reload doesn't re-pop the dialog.
let pendingEditProfile = null
function setPendingEditProfile(profile) { pendingEditProfile = profile || null }

// IPC: the renderer asks once, after init, which app (if any) to open directly in the edit dialog.
// Lazy-require electron so the pure parser above stays unit-testable in a plain Node context.
function registerEditConfigIpc() {
  const { ipcMain } = require('electron')
  ipcMain.handle('manager:initial-edit-profile', () => {
    const profile = pendingEditProfile
    pendingEditProfile = null
    return profile
  })
}

module.exports = { EDIT_CONFIG_ARG, editProfileFromArgv, setPendingEditProfile, registerEditConfigIpc }
