// Default mailto handler: query and set the desktop file that handles x-scheme-handler/mailto.

const { ipcMain } = require('electron')
const { spawnSync } = require('node:child_process')

// Returns the current default mailto handler desktop filename, or null.
// In test mode, WRAPWEB_TEST_MAIL_HANDLER overrides the real xdg-mime query.
function getDefaultMailDesktop() {
  if (process.env.WRAPWEB_TEST) return process.env.WRAPWEB_TEST_MAIL_HANDLER || null
  try {
    const r = spawnSync('xdg-mime', ['query', 'default', 'x-scheme-handler/mailto'], { encoding: 'utf8', timeout: 2000 })
    return r.stdout.trim() || null
  } catch { return null }
}

function registerMailHandlers() {
  ipcMain.handle('manager:get-mail-handler', () => getDefaultMailDesktop())

  // Sets the default mail handler using xdg-mime.
  // desktopName is the full filename, e.g. "vGmail.desktop".
  // In test mode, the xdg-mime call is skipped to avoid touching the real system config.
  ipcMain.handle('manager:set-mail-handler', (event, desktopName) => {
    if (process.env.WRAPWEB_TEST) return true
    const r = spawnSync('xdg-mime', ['default', desktopName, 'x-scheme-handler/mailto'], { timeout: 2000 })
    return r.status === 0
  })
}

// getDefaultMailDesktop is also consumed by the apps handler (manager:apps, delete restore),
// so it is exported alongside the register function.
module.exports = registerMailHandlers
module.exports.getDefaultMailDesktop = getDefaultMailDesktop
