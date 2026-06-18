// Resolves an app's two user-overridable locations: where its AppImage artifact lives and where it
// keeps its session/profile data. Both are optional per-app config fields (absolute paths); when
// unset, the long-standing defaults apply. Centralised here so the build scripts, the Manager
// handlers and the AppImage runtime all agree on the same locations.

const path = require('node:path')
const { appName } = require('./app-naming')

// Directory holding the AppImage artifact (+ its .version sidecar): the per-app `outputDir`
// override, or the shared dist/ folder. `distDir` is the default the caller supplies (APP_ROOT/dist
// in the Manager, the cwd's dist/ in the build scripts).
function appImageDir(cfg, distDir) {
  return cfg.outputDir ? path.resolve(cfg.outputDir) : distDir
}

// Full path to the built AppImage artifact (named after the profile, e.g. vTeams).
function appImagePath(cfg, distDir) {
  return path.join(appImageDir(cfg, distDir), appName(cfg.profile))
}

// The app's userData/session directory: the per-app `profileDir` override, or
// <voltageDataDir>/<profile> (voltageDataDir = <appData>/voltage). The override is baked into the
// AppImage at build time (extraMetadata.profileDir) so the runtime honours it too.
function profileDir(cfg, voltageDataDir) {
  return cfg.profileDir ? path.resolve(cfg.profileDir) : path.join(voltageDataDir, cfg.profile)
}

module.exports = { appImageDir, appImagePath, profileDir }
