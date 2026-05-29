// Registers all IPC handlers for the wrapweb manager.
// Called once at startup in manager mode (pkg.profile is not set).
//
// Each domain lives in its own handlers/* module. The requires run at module load
// (i.e. when main.js requires this file, before app.whenReady), which also kicks off
// the per-domain subprocess pre-warming (icons, obsidian, rclone) as early as possible.

const registerMeta      = require('./handlers/meta')
const registerApps      = require('./handlers/apps')
const registerLifecycle = require('./handlers/lifecycle')
const registerMail      = require('./handlers/mail')
const registerObsidian  = require('./handlers/obsidian')
const registerRclone    = require('./handlers/rclone')
const registerSettings  = require('./handlers/settings')
const registerPlugins   = require('./handlers/plugins')
const registerProfiles  = require('./handlers/profiles')

module.exports = function registerManagerIpc() {
  registerMeta()
  registerApps()
  registerLifecycle()
  registerMail()
  registerObsidian()
  registerRclone()
  registerSettings()
  registerPlugins()
  registerProfiles()
}
