// Per-profile data directory management: delete a profile's stored data and report
// on-disk sizes for the profiles dialog.

const { ipcMain, app } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const { spawnSync } = require('node:child_process')

const { CONFIGS_DIR } = require('../lib/paths')
const { profileDir }  = require('../../../app-paths')

module.exports = function registerProfileHandlers() {
  const VOLTAGE_DATA = path.join(app.getPath('appData'), 'voltage')

  // Reads an app's config by raw profile (private wins over embedded) so the per-app profileDir
  // override is honoured. Falls back to a bare {profile} = default location.
  function readCfgByProfile(profile) {
    for (const f of [`build.private.${profile}.json`, `build.${profile}.json`]) {
      const p = path.join(CONFIGS_DIR, f)
      try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
    }
    return { profile }
  }

  ipcMain.handle('manager:delete-profile-data', (event, profile) => {
    const dir = profileDir(readCfgByProfile(profile), VOLTAGE_DATA)
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('manager:profile-sizes', () => {
    // Deduplicate by profile. A profile can have both an embedded (build.*) and a private
    // (build.private.*) config; the private one wins because it carries the editable profileDir
    // override. (readdir order is not guaranteed, so prefer private explicitly rather than relying
    // on which file is read last.)
    const byProfile = new Map()
    for (const f of fs.readdirSync(CONFIGS_DIR).filter(f => /^build\..+\.json$/.test(f))) {
      let cfg
      try { cfg = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8')) } catch { continue }
      const isPrivate = f.startsWith('build.private.')
      if (!byProfile.has(cfg.profile) || isPrivate) {
        byProfile.set(cfg.profile, { profile: cfg.profile, name: cfg.name || null, profileDir: cfg.profileDir || null })
      }
    }
    const configs = [...byProfile.values()]
    return configs.map(({ profile, name, profileDir: override }) => {
      // Honour the per-app profileDir override so a relocated profile still shows up here.
      const dir = profileDir({ profile, profileDir: override }, VOLTAGE_DATA)
      const custom = !!override
      if (!fs.existsSync(dir)) return { profile, name, dir, bytes: 0, exists: false, custom }
      const r = spawnSync('du', ['-sb', dir], { encoding: 'utf8' })
      const bytes = r.status === 0 ? parseInt((r.stdout || '').split('\t')[0]) || 0 : 0
      return { profile, name, dir, bytes, exists: true, custom }
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
