// App catalog and per-app CRUD: list configs, copy embedded → private, create / edit / delete,
// plus the small reveal-in-folder and profile-existence checks the cards use.

const { ipcMain, app, shell } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const os   = require('node:os')

const { APP_ROOT, CONFIGS_DIR, pkg }                       = require('../lib/paths')
const { resolveIconsByGtk }                                = require('../lib/icons')
const { readVersionSidecar, needsRebuild, buildSingleApp, buildAppCfg, usesRcloneSync } = require('../lib/app-config')
const { getDefaultMailDesktop }                            = require('./mail')
const { urlToRoutingKey, keyOverlaps, primaryKeyFromUrl, routingUrlKeys } = require('../../../routing-match')

module.exports = function registerAppHandlers() {
  ipcMain.handle('manager:apps', () => {
    // xdg-mime returns a .desktop filename (e.g. "wrapweb-thunderbird.desktop");
    // compare against each app's desktop name to determine the current mail handler.
    const defaultMailDesktop = getDefaultMailDesktop()
    const minVer = pkg.minAppImageVersion ?? pkg.version

    const configs = fs.readdirSync(CONFIGS_DIR)
      .filter(f => /^build\..+\.json$/.test(f))
      .map(f => {
        const cfg          = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8'))
        const configLabel  = f.replace(/^build\.(.+)\.json$/, '$1')
        const built        = fs.existsSync(path.join(APP_ROOT, 'dist', `wrapweb-${cfg.profile}`))
        const desktopFile  = path.join(os.homedir(), '.local', 'share', 'applications', `wrapweb-${cfg.profile}.desktop`)
        const installed    = fs.existsSync(desktopFile)
        let iconValue      = cfg.icon || null
        if (installed) {
          const m = fs.readFileSync(desktopFile, 'utf8').match(/^Icon=(.+)$/m)
          if (m) iconValue = m[1].trim()
        }
        const { builtVersion, builtRclone } = readVersionSidecar(cfg.profile)
        return {
          profile: cfg.profile, configLabel, name: cfg.name, url: cfg.url,
          built, installed, isPrivate: f.startsWith('build.private.'), iconValue,
          appImagePath: path.join(APP_ROOT, 'dist', `wrapweb-${cfg.profile}`),
          profilePath:  path.join(app.getPath('appData'), 'wrapweb', cfg.profile),
          icon: cfg.icon || null, geometry: cfg.geometry || null,
          userAgent: cfg.userAgent || null, crossOriginIsolation: cfg.crossOriginIsolation || false,
          singleInstance: cfg.singleInstance || false, internalDomains: cfg.internalDomains || null,
          routingUrls: cfg.routingUrls || null,
          mimeTypes: cfg.mimeTypes || null, plugins: cfg.plugins || null,
          isDefaultMailHandler: defaultMailDesktop === `wrapweb-${cfg.profile}.desktop`,
          category: cfg.category || null,
          builtVersion, builtRclone, rcloneFileHandler: usesRcloneSync(cfg),
          needsRebuild: needsRebuild(built, builtVersion, minVer),
        }
      })

    // When a private config and an embedded config share the same profile,
    // only the private one is shown — it takes precedence and becomes editable.
    const privateProfiles  = new Set(configs.filter(c => c.isPrivate).map(c => c.profile))
    const embeddedProfiles = new Set(configs.filter(c => !c.isPrivate).map(c => c.profile))
    const visible = configs
      .filter(c => c.isPrivate || !privateProfiles.has(c.profile))
      .map(c => c.isPrivate && embeddedProfiles.has(c.profile) ? { ...c, overridesEmbedded: true } : c)

    visible.sort((a, b) => {
      const nameA = (a.name || a.profile.replace(/^private\./, '').replace(/-/g, ' ')).toLowerCase()
      const nameB = (b.name || b.profile.replace(/^private\./, '').replace(/-/g, ' ')).toLowerCase()
      return nameA.localeCompare(nameB)
    })

    // Separate absolute paths from theme names — batch-resolve theme names via GTK.
    const themeNames = [...new Set(visible
      .map(c => c.iconValue)
      .filter(v => v && v !== 'wrapweb' && !path.isAbsolute(v))
    )]
    const resolved = resolveIconsByGtk(themeNames)

    return visible.map(({ iconValue, ...c }) => {
      let iconPath = null
      if (iconValue && iconValue !== 'wrapweb') {
        if (path.isAbsolute(iconValue) && fs.existsSync(iconValue)) {
          iconPath = iconValue
        } else {
          const bundled = path.join(APP_ROOT, 'assets', 'webapps', `${iconValue}.svg`)
          iconPath = resolved[iconValue] || (fs.existsSync(bundled) ? bundled : null)
        }
      }
      return { ...c, iconPath }
    })
  })

  // Copies an embedded config to build.private.<profile>.json, making it editable.
  // Returns the new configLabel so the client can update the card without a full reload.
  ipcMain.handle('manager:copy-to-private', (event, configLabel) => {
    const srcFile = path.join(CONFIGS_DIR, `build.${configLabel}.json`)
    if (!fs.existsSync(srcFile)) return { success: false, error: 'Source config not found' }
    try {
      const cfg     = JSON.parse(fs.readFileSync(srcFile, 'utf8'))
      const dstFile = path.join(CONFIGS_DIR, `build.private.${cfg.profile}.json`)
      fs.writeFileSync(dstFile, JSON.stringify(cfg, null, 2), 'utf8')
      return { success: true, privateConfigLabel: `private.${cfg.profile}` }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // Checks whether a candidate URL collides with another app's claim of the SAME kind.
  // The routing rules forbid base↔base and routing↔routing overlaps but explicitly allow
  // a routing-URL to overlap a base-URL (a routing claim then wins at resolution time), so
  // the check is scoped by `kind` ('base' | 'routing'). The app's own profile is excluded
  // so editing its existing URLs never reports a self-conflict.
  // Returns { conflict: <app display name> } on collision, else { conflict: null }.
  ipcMain.handle('manager:check-routing-overlap', (event, { profile, url, kind }) => {
    const candidate = kind === 'base' ? primaryKeyFromUrl(url) : urlToRoutingKey(url)
    if (!candidate) return { conflict: null, invalid: true }
    try {
      for (const f of fs.readdirSync(CONFIGS_DIR).filter(f => /^build\..+\.json$/.test(f))) {
        let cfg
        try { cfg = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8')) } catch { continue }
        if (!cfg.profile || cfg.profile === profile) continue
        const otherKeys = kind === 'base'
          ? [primaryKeyFromUrl(cfg.url)].filter(Boolean)
          : routingUrlKeys(cfg)
        if (otherKeys.some(key => keyOverlaps(candidate, key))) {
          return { conflict: cfg.name || cfg.profile }
        }
      }
    } catch {}
    return { conflict: null }
  })

  ipcMain.handle('manager:reveal-path', (event, targetPath) => {
    const isDir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
    isDir ? shell.openPath(targetPath) : shell.showItemInFolder(targetPath)
  })

  ipcMain.handle('manager:check-profile', (event, profile) => {
    return [`build.private.${profile}.json`, `build.${profile}.json`]
      .some(f => fs.existsSync(path.join(CONFIGS_DIR, f)))
  })

  ipcMain.handle('manager:delete', (event, { profile, configLabel, deleteConfig, deleteProfileData }) => {
    const desktopFile  = path.join(os.homedir(), '.local', 'share', 'applications', `wrapweb-${profile}.desktop`)
    const appImageFile = path.join(APP_ROOT, 'dist', `wrapweb-${profile}`)
    const configFile   = configLabel ? path.join(CONFIGS_DIR, `build.${configLabel}.json`) : null
    const profileDir   = path.join(app.getPath('appData'), 'wrapweb', profile)
    try {
      if (fs.existsSync(desktopFile))                                  fs.rmSync(desktopFile)
      if (fs.existsSync(appImageFile))                                 fs.rmSync(appImageFile)
      if (deleteConfig     && configFile && fs.existsSync(configFile)) fs.rmSync(configFile)
      if (deleteProfileData && fs.existsSync(profileDir))              fs.rmSync(profileDir, { recursive: true })

      // When a private config is deleted, check if an embedded config for the same
      // profile exists so the client can restore the (now visible again) embedded card.
      let restoredApp = null
      if (deleteConfig && configLabel?.startsWith('private.')) {
        const embeddedLabel = configLabel.replace(/^private\./, '')
        const embeddedFile  = path.join(CONFIGS_DIR, `build.${embeddedLabel}.json`)
        if (fs.existsSync(embeddedFile)) {
          restoredApp = buildSingleApp(embeddedFile, getDefaultMailDesktop())
        }
      }

      return { success: true, restoredApp }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('manager:create-app', (event, data) => {
    const filePath = path.join(CONFIGS_DIR, `build.private.${data.profile}.json`)
    if (fs.existsSync(filePath)) return { success: false, error: 'exists' }
    const cfg = buildAppCfg(data)
    try {
      fs.writeFileSync(filePath, JSON.stringify(cfg, null, 4), 'utf8')
    } catch (err) {
      return { success: false, error: err.message }
    }
    let iconPath = null
    if (data.icon) {
      const resolved = resolveIconsByGtk([data.icon])
      iconPath = resolved[data.icon] || null
    }
    const w = parseInt(data.width), h = parseInt(data.height)
    return {
      success: true,
      app: {
        profile:              data.profile,
        configLabel:          `private.${data.profile}`,
        name:                 data.name || null,
        url:                  data.url,
        built: false, installed: false, isPrivate: true,
        iconPath,
        icon:                 data.icon || null,
        geometry:             (w > 0 || h > 0) ? cfg.geometry : null,
        userAgent:            data.userAgent || null,
        crossOriginIsolation: data.crossOriginIsolation || false,
        singleInstance:       data.singleInstance || false,
        internalDomains:      data.internalDomains ? cfg.internalDomains : null,
        routingUrls:          cfg.routingUrls || null,
        mimeTypes:            cfg.mimeTypes || null,
        plugins:              cfg.plugins   || null,
        category:             cfg.category  || null,
      },
    }
  })

  ipcMain.handle('manager:update-app', (event, data) => {
    const filePath = path.join(CONFIGS_DIR, `build.private.${data.profile}.json`)
    if (!fs.existsSync(filePath)) return { success: false, error: 'not found' }
    // Merge over the existing config so fields the form cannot edit (category,
    // rcloneFileHandler, mimeExtensions/Icons, …) survive an edit instead of being dropped.
    let existing = {}
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch {}
    const cfg = buildAppCfg(data, existing)
    try {
      fs.writeFileSync(filePath, JSON.stringify(cfg, null, 4), 'utf8')
    } catch (err) {
      return { success: false, error: err.message }
    }
    let iconPath = null
    if (data.icon) {
      const resolved = resolveIconsByGtk([data.icon])
      iconPath = resolved[data.icon] || null
    }
    const w = parseInt(data.width), h = parseInt(data.height)
    return {
      success: true,
      app: {
        name:                 data.name || null,
        url:                  data.url,
        icon:                 data.icon || null,
        iconPath,
        geometry:             (w > 0 || h > 0) ? cfg.geometry : null,
        userAgent:            data.userAgent || null,
        crossOriginIsolation: data.crossOriginIsolation || false,
        singleInstance:       data.singleInstance || false,
        internalDomains:      data.internalDomains ? cfg.internalDomains : null,
        routingUrls:          cfg.routingUrls || null,
        mimeTypes:            cfg.mimeTypes || null,
        plugins:              cfg.plugins   || null,
        category:             cfg.category  || null,
      },
    }
  })
}
