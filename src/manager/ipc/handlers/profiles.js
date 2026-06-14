// Per-profile data directory management: delete a profile's stored data and report
// on-disk sizes for the profiles dialog.

const { ipcMain, app } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const { spawnSync } = require('node:child_process')

const { CONFIGS_DIR } = require('../lib/paths')

module.exports = function registerProfileHandlers() {
  ipcMain.handle('manager:delete-profile-data', (event, profile) => {
    const dir = path.join(app.getPath('appData'), 'voltage', profile)
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('manager:profile-sizes', () => {
    const all = fs.readdirSync(CONFIGS_DIR)
      .filter(f => /^build\..+\.json$/.test(f))
      .map(f => {
        const cfg = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8'))
        return { profile: cfg.profile, name: cfg.name || null }
      })
    // Deduplicate by profile — private and embedded configs share the same profile dir.
    // Files are read in alphabetical order, so build.private.* overwrites build.* in the Map.
    const configs = [...new Map(all.map(c => [c.profile, c])).values()]
    return configs.map(({ profile, name }) => {
      const dir = path.join(app.getPath('appData'), 'voltage', profile)
      if (!fs.existsSync(dir)) return { profile, name, dir, bytes: 0, exists: false }
      const r = spawnSync('du', ['-sb', dir], { encoding: 'utf8' })
      const bytes = r.status === 0 ? parseInt((r.stdout || '').split('\t')[0]) || 0 : 0
      return { profile, name, dir, bytes, exists: true }
    })
  })

  // Free space on the filesystem holding the profile data — shown next to the total in the
  // profiles dialog so the user can judge how much head-room is left. Returns 0 on failure.
  ipcMain.handle('manager:profile-disk-free', () => {
    try {
      const base = path.join(app.getPath('appData'), 'voltage')
      const stat = fs.statfsSync(fs.existsSync(base) ? base : app.getPath('appData'))
      return { free: stat.bavail * stat.bsize }
    } catch {
      return { free: 0 }
    }
  })
}
