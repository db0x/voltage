// App catalog and per-app CRUD: list configs, copy embedded → private, create / edit / delete,
// plus the small reveal-in-folder and profile-existence checks the cards use.

const { ipcMain, app, shell, dialog, BrowserWindow } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const os   = require('node:os')

const { APP_ROOT, CONFIGS_DIR, pkg }                       = require('../lib/paths')
const { resolveIconsByGtk }                                = require('../lib/icons')
const { readVersionSidecar, needsRebuild, buildSingleApp, buildAppCfg, usesRcloneSync } = require('../lib/app-config')
const { getDefaultMailDesktop }                            = require('./mail')
const { urlToRoutingKey, keyOverlaps, primaryKeyFromUrl, routingUrlKeys } = require('../../../routing-match')
const { appName }                                          = require('../../../app-naming')
const { appImagePath, profileDir }                         = require('../../../app-paths')

// Default locations the per-app overrides fall back to.
const DIST_DIR     = path.join(APP_ROOT, 'dist')
const VOLTAGE_DATA = path.join(app.getPath('appData'), 'voltage')

// Moves a file or directory, falling back to copy+remove across filesystems (a custom output/
// profile folder may sit on a different mount, where rename() fails with EXDEV).
function movePath(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try { fs.renameSync(src, dest) }
  catch { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }) }
}

module.exports = function registerAppHandlers() {
  ipcMain.handle('manager:apps', () => {
    // xdg-mime returns a .desktop filename (e.g. "vThunderbird.desktop");
    // compare against each app's desktop name to determine the current mail handler.
    const defaultMailDesktop = getDefaultMailDesktop()
    const minVer = pkg.minAppImageVersion ?? pkg.version

    const configs = fs.readdirSync(CONFIGS_DIR)
      .filter(f => /^build\..+\.json$/.test(f))
      .map(f => {
        const cfg          = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8'))
        const configLabel  = f.replace(/^build\.(.+)\.json$/, '$1')
        const built        = fs.existsSync(appImagePath(cfg, DIST_DIR))
        const desktopFile  = path.join(os.homedir(), '.local', 'share', 'applications', `${appName(cfg.profile)}.desktop`)
        const installed    = fs.existsSync(desktopFile)
        let iconValue      = cfg.icon || null
        if (installed) {
          const m = fs.readFileSync(desktopFile, 'utf8').match(/^Icon=(.+)$/m)
          if (m) iconValue = m[1].trim()
        }
        const { builtVersion, builtRclone } = readVersionSidecar(cfg)
        return {
          profile: cfg.profile, configLabel, name: cfg.name, url: cfg.url,
          built, installed, isPrivate: f.startsWith('build.private.'), iconValue,
          appImagePath: appImagePath(cfg, DIST_DIR),
          profilePath:  profileDir(cfg, VOLTAGE_DATA),
          outputDir: cfg.outputDir || null, profileDir: cfg.profileDir || null,
          icon: cfg.icon || null, geometry: cfg.geometry || null,
          userAgent: cfg.userAgent || null, crossOriginIsolation: cfg.crossOriginIsolation || false,
          singleInstance: cfg.singleInstance || false, internalDomains: cfg.internalDomains || null,
          routingUrls: cfg.routingUrls || null,
          mimeTypes: cfg.mimeTypes || null, plugins: cfg.plugins || null,
          pluginConfig: cfg.pluginConfig || null,
          isDefaultMailHandler: defaultMailDesktop === `${appName(cfg.profile)}.desktop`,
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
      .filter(v => v && v !== 'voltage' && !path.isAbsolute(v))
    )]
    const resolved = resolveIconsByGtk(themeNames)

    return visible.map(({ iconValue, ...c }) => {
      let iconPath = null
      if (iconValue && iconValue !== 'voltage') {
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

  // Native folder picker for the create/edit dialogs' output- and profile-folder fields.
  // Returns the chosen absolute path, or null when the user cancels. The start folder is the
  // nearest EXISTING ancestor of the current value — a non-existent defaultPath (e.g. a profile
  // folder that hasn't been created yet) leaves the GTK chooser in a state where nothing can be
  // confirmed, so we never hand it a path that doesn't exist.
  ipcMain.handle('manager:pick-folder', async (event, currentPath) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    let defaultPath = currentPath
    while (defaultPath && !fs.existsSync(defaultPath) && defaultPath !== path.dirname(defaultPath)) {
      defaultPath = path.dirname(defaultPath)
    }
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath && fs.existsSync(defaultPath) ? { defaultPath } : {}),
    })
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
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
    const configFile   = configLabel ? path.join(CONFIGS_DIR, `build.${configLabel}.json`) : null
    // Read the config so the AppImage/profile overrides are honoured when removing files.
    let cfg = { profile }
    try { if (configFile && fs.existsSync(configFile)) cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch {}
    const desktopFile  = path.join(os.homedir(), '.local', 'share', 'applications', `${appName(profile)}.desktop`)
    const appImageFile = appImagePath(cfg, DIST_DIR)
    const profileData  = profileDir(cfg, VOLTAGE_DATA)
    try {
      if (fs.existsSync(desktopFile))                                  fs.rmSync(desktopFile)
      if (fs.existsSync(appImageFile))                                 fs.rmSync(appImageFile)
      fs.rmSync(`${appImageFile}.version`, { force: true })
      if (deleteConfig     && configFile && fs.existsSync(configFile)) fs.rmSync(configFile)
      if (deleteProfileData && fs.existsSync(profileData))             fs.rmSync(profileData, { recursive: true })

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
        pluginConfig:         cfg.pluginConfig || null,
        category:             cfg.category  || null,
        outputDir:            cfg.outputDir || null,
        profileDir:           cfg.profileDir || null,
        appImagePath:         appImagePath(cfg, DIST_DIR),
        profilePath:          profileDir(cfg, VOLTAGE_DATA),
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

    // The output/profile folder changed: move the existing AppImage (+ its .version sidecar) and
    // the existing profile data to the new locations, and keep the installed launcher pointing at
    // the moved AppImage. Done before persisting so a failed move leaves config and files in sync.
    try {
      const oldImg = appImagePath(existing, DIST_DIR)
      const newImg = appImagePath(cfg, DIST_DIR)
      if (oldImg !== newImg && fs.existsSync(oldImg)) {
        movePath(oldImg, newImg)
        if (fs.existsSync(`${oldImg}.version`)) movePath(`${oldImg}.version`, `${newImg}.version`)
        const desktopFile = path.join(os.homedir(), '.local', 'share', 'applications', `${appName(data.profile)}.desktop`)
        if (fs.existsSync(desktopFile)) {
          const patched = fs.readFileSync(desktopFile, 'utf8').replace(/^Exec=.*$/m, `Exec=${newImg} --no-sandbox %u`)
          fs.writeFileSync(desktopFile, patched, 'utf8')
        }
      }
      const oldProfile = profileDir(existing, VOLTAGE_DATA)
      const newProfile = profileDir(cfg, VOLTAGE_DATA)
      if (oldProfile !== newProfile && fs.existsSync(oldProfile)) movePath(oldProfile, newProfile)
    } catch (err) {
      return { success: false, error: `Failed to move files: ${err.message}` }
    }

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
        pluginConfig:         cfg.pluginConfig || null,
        category:             cfg.category  || null,
        outputDir:            cfg.outputDir || null,
        profileDir:           cfg.profileDir || null,
        appImagePath:         appImagePath(cfg, DIST_DIR),
        profilePath:          profileDir(cfg, VOLTAGE_DATA),
      },
    }
  })
}
