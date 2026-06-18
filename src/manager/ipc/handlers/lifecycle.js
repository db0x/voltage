// App lifecycle: launch a built AppImage, build a profile, install a desktop entry.
// All three shell out to scripts/ or the AppImage and stream stdout/stderr back.

const { ipcMain } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')

const { APP_ROOT, CONFIGS_DIR } = require('../lib/paths')
const { appName }  = require('../../../app-naming')
const { appImagePath } = require('../../../app-paths')

const DIST_DIR = path.join(APP_ROOT, 'dist')

// Reads an app's config by raw profile (private config wins over an embedded one), so launch/build
// can honour the per-app outputDir. Falls back to a bare {profile} (default dist/ location).
function readCfgByProfile(profile) {
  for (const f of [`build.private.${profile}.json`, `build.${profile}.json`]) {
    const p = path.join(CONFIGS_DIR, f)
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
  }
  return { profile }
}

module.exports = function registerLifecycleHandlers() {
  ipcMain.handle('manager:launch', (event, profile) => {
    const appImageFile = appImagePath(readCfgByProfile(profile), DIST_DIR)
    if (!fs.existsSync(appImageFile)) return { success: false }
    const child = spawn(appImageFile, ['--no-sandbox'], { detached: true, stdio: 'ignore' })
    child.unref()
    return { success: true }
  })

  ipcMain.handle('manager:install', (event, configLabel, setAsMailHandler) => {
    return new Promise((resolve) => {
      const child = spawn('node', [path.join(APP_ROOT, 'scripts', 'install.js'), configLabel], { cwd: APP_ROOT })
      let stdout = '', stderr = ''
      child.stdout?.on('data', d => { stdout += d.toString() })
      child.stderr?.on('data', d => { stderr += d.toString() })
      child.on('close', code => {
        // Register as default mail handler after install if requested.
        // Strip the "private." prefix — the desktop file name doesn't include it.
        if (code === 0 && setAsMailHandler) {
          const desktopName = `${appName(configLabel.replace(/^private\./, ''))}.desktop`
          spawnSync('xdg-mime', ['default', desktopName, 'x-scheme-handler/mailto'], { timeout: 2000 })
        }
        resolve({ success: code === 0, stdout, stderr })
      })
      child.on('error', err => resolve({ success: false, stdout, stderr: err.message }))
    })
  })

  ipcMain.handle('manager:build', (event, configLabel) => {
    return new Promise((resolve) => {
      const child = spawn('node', [path.join(APP_ROOT, 'scripts', 'build.js'), configLabel], { cwd: APP_ROOT })
      let stdout = '', stderr = ''
      child.stdout?.on('data', d => { stdout += d.toString() })
      child.stderr?.on('data', d => { stderr += d.toString() })
      child.on('close', code => {
        let builtRclone = false
        if (code === 0) {
          try {
            // Read the sidecar next to the (possibly relocated) AppImage. configLabel is the build
            // arg ("teams" or "private.teams"), i.e. the config file's name without build./.json.
            let cfg
            try { cfg = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, `build.${configLabel}.json`), 'utf8')) }
            catch { cfg = { profile: configLabel.replace(/^private\./, '') } }
            const meta = JSON.parse(fs.readFileSync(`${appImagePath(cfg, DIST_DIR)}.version`, 'utf8').trim())
            builtRclone = meta.rcloneFileHandler ?? false
          } catch { /* version file missing or old plain-string format */ }
        }
        resolve({ success: code === 0, stdout, stderr, builtRclone })
      })
      child.on('error', err => resolve({ success: false, stdout, stderr: err.message, builtRclone: false }))
    })
  })
}
