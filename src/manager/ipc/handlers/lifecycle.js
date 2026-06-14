// App lifecycle: launch a built AppImage, build a profile, install a desktop entry.
// All three shell out to scripts/ or the AppImage and stream stdout/stderr back.

const { ipcMain } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')

const { APP_ROOT } = require('../lib/paths')
const { appName }  = require('../../../app-naming')

module.exports = function registerLifecycleHandlers() {
  ipcMain.handle('manager:launch', (event, profile) => {
    const appImagePath = path.join(APP_ROOT, 'dist', appName(profile))
    if (!fs.existsSync(appImagePath)) return { success: false }
    const child = spawn(appImagePath, ['--no-sandbox'], { detached: true, stdio: 'ignore' })
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
            const raw  = fs.readFileSync(path.join(APP_ROOT, 'dist', `${appName(configLabel)}.version`), 'utf8').trim()
            const meta = JSON.parse(raw)
            builtRclone = meta.rcloneFileHandler ?? false
          } catch { /* version file missing or old plain-string format */ }
        }
        resolve({ success: code === 0, stdout, stderr, builtRclone })
      })
      child.on('error', err => resolve({ success: false, stdout, stderr: err.message, builtRclone: false }))
    })
  })
}
