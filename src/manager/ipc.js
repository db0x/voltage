// Registers all IPC handlers for the wrapweb manager.
// Called once at startup in manager mode (pkg.profile is not set).

const { app, ipcMain, shell } = require('electron')
const path      = require('node:path')
const fs        = require('node:fs')
const os        = require('node:os')
const { spawnSync, spawn } = require('node:child_process')

const pkg            = require(app.getAppPath() + '/package.json')
const { t }          = require('../i18n')
const { checkForUpdate } = require('../update-check')

const APP_ROOT    = app.getAppPath()
const CONFIGS_DIR = path.join(APP_ROOT, 'webapps')

// Inline semver comparison — avoids pulling in a dedicated package just for this.
function semverLt(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true
    if ((pa[i] || 0) > (pb[i] || 0)) return false
  }
  return false
}

const GTK_ICON_SCRIPT = `
import gi, sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
theme = Gtk.IconTheme.get_default()
for name in sys.argv[1:]:
    info = theme.lookup_icon(name, 64, 0)
    print(info.get_filename() if info else '')
`

// Resolves GTK icon names to absolute file paths using the system icon theme.
// A single Python/GTK subprocess handles all names in one call to amortize startup cost.
// Returns null for names that are not found in any installed theme.
function resolveIconsByGtk(names) {
  if (names.length === 0) return {}
  const r = spawnSync('python3', ['-c', GTK_ICON_SCRIPT, ...names], { encoding: 'utf8', timeout: 3000 })
  if (r.error || r.status !== 0) return {}
  const lines = (r.stdout || '').split('\n')
  return Object.fromEntries(names.map((name, i) => [name, lines[i] || null]))
}

// Runs a command asynchronously and resolves with stdout string ('' on error or timeout).
function runAsync(cmd, args, timeoutMs = 3000) {
  return new Promise(resolve => {
    let stdout = ''
    let settled = false
    const done = val => { if (!settled) { settled = true; resolve(val) } }
    try {
      const child = spawn(cmd, args)
      const timer = setTimeout(() => { child.kill(); done('') }, timeoutMs)
      child.stdout.on('data', d => { stdout += d })
      child.on('close', () => { clearTimeout(timer); done(stdout) })
      child.on('error', () => { clearTimeout(timer); done('') })
    } catch { done('') }
  })
}

// Async variant of resolveIconsByGtk — returns a Promise so the call can be pre-warmed.
function resolveIconsByGtkAsync(names) {
  if (names.length === 0) return Promise.resolve({})
  return runAsync('python3', ['-c', GTK_ICON_SCRIPT, ...names], 3000).then(stdout => {
    const lines = stdout.split('\n')
    return Object.fromEntries(names.map((name, i) => [name, lines[i] || null]))
  })
}

// Pre-warm slow subprocess results the moment this module is loaded — Electron's app.whenReady()
// and BrowserWindow creation run in parallel, so these are usually resolved before the first IPC call.
// The Python/GTK call is skipped in tests (no display server in headless Playwright).
// xdg-mime and which run in tests too — rclone tests inject a fake binary and rely on the real check.
const prefetchedAppDefaultIcon    = process.env.WRAPWEB_TEST ? Promise.resolve({}) : resolveIconsByGtkAsync(['application-default-icon'])
const prefetchedObsidianAvailable = runAsync('xdg-mime', ['query', 'default', 'x-scheme-handler/obsidian'], 2000).then(out => !!out.trim())
const prefetchedRcloneAvailable   = runAsync('which', ['rclone'], 2000).then(out => ({ available: !!out.trim() }))

// Returns the current default mailto handler desktop filename, or null.
// In test mode, WRAPWEB_TEST_MAIL_HANDLER overrides the real xdg-mime query.
function getDefaultMailDesktop() {
  if (process.env.WRAPWEB_TEST) return process.env.WRAPWEB_TEST_MAIL_HANDLER || null
  try {
    const r = spawnSync('xdg-mime', ['query', 'default', 'x-scheme-handler/mailto'], { encoding: 'utf8', timeout: 2000 })
    return r.stdout.trim() || null
  } catch { return null }
}

// Reads the builtVersion and builtRclone flags from a .version sidecar file.
// Returns { builtVersion: null, builtRclone: false } when the file is absent or unreadable.
function readVersionSidecar(profile) {
  try {
    const raw = fs.readFileSync(path.join(APP_ROOT, 'dist', `wrapweb-${profile}.version`), 'utf8').trim()
    try {
      // Current format: JSON with version + optional capability flags.
      const meta = JSON.parse(raw)
      return { builtVersion: meta.version ?? null, builtRclone: meta.rcloneFileHandler ?? false }
    } catch {
      return { builtVersion: raw, builtRclone: false }  // backward compat: plain version string
    }
  } catch {
    return { builtVersion: null, builtRclone: false }
  }
}

// Determines whether a built AppImage needs rebuilding based on the sidecar version.
// In test mode, only flags as outdated when a .version file is actually present and older —
// avoids false positives for AppImages built without the sidecar.
function needsRebuild(built, builtVersion, minVer) {
  if (!built) return false
  return process.env.WRAPWEB_TEST
    ? builtVersion !== null && semverLt(builtVersion, minVer)
    : semverLt(builtVersion ?? '0.0.0', minVer)
}

// Builds a full app object for a single config file, resolving icon paths individually.
// Used when a single restored app needs to be returned after a delete operation.
function buildSingleApp(configFile, defaultMailDesktop) {
  const f   = path.basename(configFile)
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  const configLabel  = f.replace(/^build\.(.+)\.json$/, '$1')
  const built        = fs.existsSync(path.join(APP_ROOT, 'dist', `wrapweb-${cfg.profile}`))
  const desktopFile  = path.join(os.homedir(), '.local', 'share', 'applications', `wrapweb-${cfg.profile}.desktop`)
  const installed    = fs.existsSync(desktopFile)
  let   iconValue    = cfg.icon || null
  if (installed) {
    const m = fs.readFileSync(desktopFile, 'utf8').match(/^Icon=(.+)$/m)
    if (m) iconValue = m[1].trim()
  }
  const { builtVersion, builtRclone } = readVersionSidecar(cfg.profile)
  const minVer = pkg.minAppImageVersion ?? pkg.version
  let iconPath = null
  if (iconValue && iconValue !== 'wrapweb') {
    if (path.isAbsolute(iconValue) && fs.existsSync(iconValue)) {
      iconPath = iconValue
    } else {
      const bundled  = path.join(APP_ROOT, 'assets', 'webapps', `${iconValue}.svg`)
      const resolved = resolveIconsByGtk([iconValue])
      iconPath = resolved[iconValue] || (fs.existsSync(bundled) ? bundled : null)
    }
  }
  return {
    profile: cfg.profile, configLabel, name: cfg.name, url: cfg.url,
    built, installed, isPrivate: f.startsWith('build.private.'),
    iconPath,
    appImagePath: path.join(APP_ROOT, 'dist', `wrapweb-${cfg.profile}`),
    profilePath:  path.join(app.getPath('appData'), 'wrapweb', cfg.profile),
    icon: cfg.icon || null, geometry: cfg.geometry || null,
    userAgent: cfg.userAgent || null, crossOriginIsolation: cfg.crossOriginIsolation || false,
    singleInstance: cfg.singleInstance || false, internalDomains: cfg.internalDomains || null,
    mimeTypes: cfg.mimeTypes || null, mailtoJs: cfg.mailtoJs || null,
    isDefaultMailHandler: defaultMailDesktop === `wrapweb-${cfg.profile}.desktop`,
    category: cfg.category || null,
    builtVersion, builtRclone, rcloneFileHandler: cfg.rcloneFileHandler || false,
    needsRebuild: needsRebuild(built, builtVersion, minVer),
  }
}

// Builds a config object from create/edit form data, omitting falsy/default fields.
function buildAppCfg({ profile, name, url, icon, width, height, userAgent, internalDomains, crossOriginIsolation, singleInstance, mailHandler, mailtoJs }) {
  const cfg = { profile, url }
  if (name)  cfg.name = name
  if (icon)  cfg.icon = icon
  const w = parseInt(width), h = parseInt(height)
  if (w > 0 || h > 0) {
    cfg.geometry = {}
    if (w > 0) cfg.geometry.width  = w
    if (h > 0) cfg.geometry.height = h
  }
  if (userAgent) cfg.userAgent = userAgent
  if (crossOriginIsolation) cfg.crossOriginIsolation = true
  if (singleInstance) cfg.singleInstance = true
  if (internalDomains) {
    const domains = internalDomains.split(',').map(d => d.trim()).filter(Boolean)
    if (domains.length === 1) cfg.internalDomains = domains[0]
    else if (domains.length > 1) cfg.internalDomains = domains
  }
  if (mailHandler) cfg.mimeTypes = ['x-scheme-handler/mailto']
  if (mailHandler && mailtoJs) cfg.mailtoJs = mailtoJs
  return cfg
}

// WRAPWEB_TEST_DATA_DIR redirects configs into a temp dir in tests
// so tests never read or write the user's real data files.
function rcloneConfigPath() {
  const testDir = process.env.WRAPWEB_TEST_DATA_DIR
  return testDir
    ? path.join(testDir, 'rclone.json')
    : path.join(app.getPath('appData'), 'wrapweb', 'rclone.json')
}

function globalSettingsConfigPath() {
  const testDir = process.env.WRAPWEB_TEST_DATA_DIR
  return testDir
    ? path.join(testDir, 'global-settings.json')
    : path.join(app.getPath('appData'), 'wrapweb', 'global-settings.json')
}

function safeBrowsingConfigPath() {
  const testDir = process.env.WRAPWEB_TEST_DATA_DIR
  return testDir
    ? path.join(testDir, 'safe-browsing.json')
    : path.join(app.getPath('appData'), 'wrapweb', 'safe-browsing.json')
}

module.exports = function registerManagerIpc() {
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
          mimeTypes: cfg.mimeTypes || null, mailtoJs: cfg.mailtoJs || null,
          isDefaultMailHandler: defaultMailDesktop === `wrapweb-${cfg.profile}.desktop`,
          category: cfg.category || null,
          builtVersion, builtRclone, rcloneFileHandler: cfg.rcloneFileHandler || false,
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

  ipcMain.handle('manager:version',    () => pkg.version)
  ipcMain.handle('manager:i18n',       () => t())
  ipcMain.handle('manager:ua-presets', () => {
    try { return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'src', 'ua-presets.json'), 'utf8')) } catch { return [] }
  })

  // Reads all HTML template files from src/manager at startup so the renderer
  // does not need fetch() or file:// access — IPC is the reliable transport.
  ipcMain.handle('manager:templates', () => {
    const tplDir = path.join(APP_ROOT, 'src', 'manager')
    const read   = rel => fs.readFileSync(path.join(tplDir, rel), 'utf8')
    return {
      about:         read('dialogs/about.html'),
      confirm:       read('dialogs/confirm.html'),
      info:          read('dialogs/info.html'),
      profiles:      read('dialogs/profiles.html'),
      rebuildNotice: read('dialogs/rebuild-notice.html'),
      updateNotice:  read('dialogs/update-notice.html'),
      globalSettings: read('dialogs/global-settings.html'),
      mailHandler:   read('dialogs/mail-handler.html'),
      rclone:        read('dialogs/rclone.html'),
      obsidian:      read('dialogs/obsidian.html'),
      safeBrowsing:  read('dialogs/safe-browsing.html'),
      iconPicker:    read('dialogs/icon-picker.html'),
      create:        read('dialogs/create.html'),
      edit:          read('dialogs/edit.html'),
      drawer:        read('drawer.html'),
    }
  })

  ipcMain.handle('manager:ui-icons', async () => {
    const a = name => path.join(APP_ROOT, 'assets', name)

    // All UI chrome icons are bundled under assets/ to avoid missing icons on
    // desktops that don't ship the full GNOME icon set (e.g. KDE Plasma).
    // Only the generic app placeholder tries the system theme first so it blends
    // in with the desktop; the bundled SVG is the fallback.
    // Uses the pre-warmed Promise so no subprocess is started at this point.
    const r          = await prefetchedAppDefaultIcon
    const appDefault = r['application-default-icon'] || a('webapps/application-default-icon.svg')

    const icons = {
      sun:            a('weather-clear.svg'),
      moon:           a('weather-clear-night.svg'),
      info:           a('state-information.svg'),
      build:          a('system-run.svg'),
      install:        a('system-software-install-symbolic.svg'),
      delete:         a('entry-delete.svg'),
      appDefault,
      menu:           a('open-menu.svg'),
      filterAll:      a('view-app-grid-symbolic.svg'),
      filterPublic:   a('applications-internet-symbolic.svg'),
      filterPrivate:  a('avatar-default.svg'),
      filterMicrosoft: a('view-grid.svg'),
      filterGoogle:    a('view-grid.svg'),
      hideFilter:     a('view-filter.svg'),
      edit:           a('edit.svg'),
      github:         a('github.svg'),
      updateNotifier: a('system-software-update.svg'),
      profiles:       a('profiles.svg'),
      configure:          a('configure.svg'),
      settings:           a('settings.svg'),
      mail:               a('mail.svg'),
      mailApp:            a('webapps/mail.svg'),
      rclone:             a('rclone.svg'),
      'google-drive':     a('webapps/google-drive.svg'),
      googleSafeBrowsing: a('safe-browsing.svg'),
      eyeVisible:         a('visible.svg'),
      eyeHidden:          a('hidden.svg'),
      plus:               a('plus.svg'),
      minus:              a('minus.svg'),
      globe:              a('globe.svg'),
      obsidianMenu:       a('obsidian.svg'),
      obsidian:           a('plugins/obsidian.svg'),
      rclonePlugin:       a('plugins/rclone.svg'),
      pluginBadge:        a('plugins/plugin.svg'),
    }

    // In tests, WRAPWEB_TEST_FILTER_ICONS replaces the category filter icons with a
    // single known path so tests can assert on icon presence without coupling to
    // specific filenames.
    if (process.env.WRAPWEB_TEST) {
      const fi = process.env.WRAPWEB_TEST_FILTER_ICONS || null
      if (fi) return { ...icons, filterMicrosoft: fi, filterGoogle: fi }
    }
    return icons
  })

  ipcMain.handle('manager:launch', (event, profile) => {
    const appImagePath = path.join(APP_ROOT, 'dist', `wrapweb-${profile}`)
    if (!fs.existsSync(appImagePath)) return { success: false }
    const child = spawn(appImagePath, ['--no-sandbox'], { detached: true, stdio: 'ignore' })
    child.unref()
    return { success: true }
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
          const desktopName = `wrapweb-${configLabel.replace(/^private\./, '')}.desktop`
          spawnSync('xdg-mime', ['default', desktopName, 'x-scheme-handler/mailto'], { timeout: 2000 })
        }
        resolve({ success: code === 0, stdout, stderr })
      })
      child.on('error', err => resolve({ success: false, stdout, stderr: err.message }))
    })
  })

  ipcMain.handle('manager:reveal-path', (event, targetPath) => {
    const isDir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
    isDir ? shell.openPath(targetPath) : shell.showItemInFolder(targetPath)
  })

  ipcMain.handle('manager:check-profile', (event, profile) => {
    return [`build.private.${profile}.json`, `build.${profile}.json`]
      .some(f => fs.existsSync(path.join(CONFIGS_DIR, f)))
  })

  ipcMain.handle('manager:plugins', () => {
    const pluginsDir = path.join(CONFIGS_DIR, 'plugins')
    if (!fs.existsSync(pluginsDir)) return []
    const entries = []
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        entries.push({ file: `plugins/${entry.name}`, label: entry.name.replace(/\.js$/, ''), category: null })
      } else if (entry.isDirectory()) {
        const subDir = path.join(pluginsDir, entry.name)
        for (const sub of fs.readdirSync(subDir, { withFileTypes: true })) {
          if (sub.isFile() && sub.name.endsWith('.js'))
            entries.push({ file: `plugins/${entry.name}/${sub.name}`, label: sub.name.replace(/\.js$/, ''), category: entry.name })
        }
      }
    }
    return entries
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
        mimeTypes:            cfg.mimeTypes || null,
        mailtoJs:             cfg.mailtoJs  || null,
      },
    }
  })

  ipcMain.handle('manager:update-app', (event, data) => {
    const filePath = path.join(CONFIGS_DIR, `build.private.${data.profile}.json`)
    if (!fs.existsSync(filePath)) return { success: false, error: 'not found' }
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
        name:                 data.name || null,
        url:                  data.url,
        icon:                 data.icon || null,
        iconPath,
        geometry:             (w > 0 || h > 0) ? cfg.geometry : null,
        userAgent:            data.userAgent || null,
        crossOriginIsolation: data.crossOriginIsolation || false,
        singleInstance:       data.singleInstance || false,
        internalDomains:      data.internalDomains ? cfg.internalDomains : null,
        mimeTypes:            cfg.mimeTypes || null,
        mailtoJs:             cfg.mailtoJs  || null,
      },
    }
  })

  ipcMain.handle('manager:all-icons', () => {
    const script = `
import gi, sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
theme = Gtk.IconTheme.get_default()
for name in sorted(theme.list_icons(None)):
    info = theme.lookup_icon(name, 48, 0)
    if info:
        fn = info.get_filename()
        if fn:
            sys.stdout.write(name + '\\t' + fn + '\\n')
`
    const r = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024 })
    if (r.error || r.status !== 0) return []
    return (r.stdout || '').trim().split('\n').filter(Boolean).map(line => {
      const tab = line.indexOf('\t')
      if (tab === -1) return null
      return { name: line.slice(0, tab), path: line.slice(tab + 1) }
    }).filter(Boolean)
  })

  ipcMain.handle('manager:check-update', () => checkForUpdate(pkg.version))

  ipcMain.handle('manager:get-mail-handler', () => getDefaultMailDesktop())

  // Sets the default mail handler using xdg-mime.
  // desktopName is the full filename, e.g. "wrapweb-gmail.desktop".
  // In test mode, the xdg-mime call is skipped to avoid touching the real system config.
  ipcMain.handle('manager:set-mail-handler', (event, desktopName) => {
    if (process.env.WRAPWEB_TEST) return true
    const r = spawnSync('xdg-mime', ['default', desktopName, 'x-scheme-handler/mailto'], { timeout: 2000 })
    return r.status === 0
  })

  // Both handlers return pre-warmed results — the subprocesses were already started
  // when this module loaded, so by the time the renderer calls these, they are resolved.
  ipcMain.handle('manager:obsidian-available', () => prefetchedObsidianAvailable)

  ipcMain.handle('manager:rclone-status', () => prefetchedRcloneAvailable)

  // Returns the list of known Obsidian vaults with the plugin install status for each.
  // Vault list is read from the Obsidian app config (obsidian.json) at query time.
  ipcMain.handle('manager:obsidian-plugin-status', () => {
    const configHome    = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    const obsidianJson  = path.join(configHome, 'obsidian', 'obsidian.json')
    const bundledManifest = path.join(APP_ROOT, 'src', 'plugins', 'obsidian', 'manifest.json')

    let bundledVersion = null
    try { bundledVersion = JSON.parse(fs.readFileSync(bundledManifest, 'utf8')).version } catch {}

    let vaults = []
    try {
      const data = JSON.parse(fs.readFileSync(obsidianJson, 'utf8'))
      vaults = Object.values(data.vaults || {})
        .filter(v => v.path && fs.existsSync(v.path))
        .map(v => {
          const pluginDir      = path.join(v.path, '.obsidian', 'plugins', 'wrapweb')
          const manifestFile   = path.join(pluginDir, 'manifest.json')
          const mainFile       = path.join(pluginDir, 'main.js')
          let installedVersion = null
          if (fs.existsSync(manifestFile) && fs.existsSync(mainFile)) {
            try { installedVersion = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version } catch {}
          }
          return { path: v.path, name: path.basename(v.path), installedVersion }
        })
    } catch {}

    return { bundledVersion, vaults }
  })

  // Copies manifest.json and main.js into every known Obsidian vault.
  ipcMain.handle('manager:obsidian-plugin-install', () => {
    const configHome   = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    const obsidianJson = path.join(configHome, 'obsidian', 'obsidian.json')
    const srcDir       = path.join(APP_ROOT, 'src', 'plugins', 'obsidian')

    let vaultPaths = []
    try {
      const data = JSON.parse(fs.readFileSync(obsidianJson, 'utf8'))
      vaultPaths = Object.values(data.vaults || {})
        .filter(v => v.path && fs.existsSync(v.path))
        .map(v => v.path)
    } catch {}

    let count = 0
    for (const vaultPath of vaultPaths) {
      try {
        const dest = path.join(vaultPath, '.obsidian', 'plugins', 'wrapweb')
        fs.mkdirSync(dest, { recursive: true })
        fs.copyFileSync(path.join(srcDir, 'manifest.json'), path.join(dest, 'manifest.json'))
        fs.copyFileSync(path.join(srcDir, 'main.js'),       path.join(dest, 'main.js'))
        count++
      } catch {}
    }
    return { success: count > 0, count }
  })

  // Returns names of all rclone remotes configured as Google Drive (type = drive).
  ipcMain.handle('manager:rclone-drive-remotes', () => {
    const r = spawnSync('rclone', ['config', 'dump'], { encoding: 'utf8', timeout: 5000 })
    if (r.status !== 0) return []
    try {
      const config = JSON.parse(r.stdout)
      return Object.entries(config)
        .filter(([, v]) => v.type === 'drive')
        .map(([name]) => name)
    } catch { return [] }
  })

  ipcMain.handle('manager:rclone-load-config', () => {
    try { return JSON.parse(fs.readFileSync(rcloneConfigPath(), 'utf8')) } catch { return {} }
  })

  ipcMain.handle('manager:rclone-save-config', (event, config) => {
    const cfgPath = rcloneConfigPath()
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2))
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('manager:global-settings-load', () => {
    try { return JSON.parse(fs.readFileSync(globalSettingsConfigPath(), 'utf8')) } catch { return {} }
  })

  ipcMain.handle('manager:global-settings-save', (event, config) => {
    const cfgPath = globalSettingsConfigPath()
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2))
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('manager:safe-browsing-load-config', () => {
    try { return JSON.parse(fs.readFileSync(safeBrowsingConfigPath(), 'utf8')) } catch { return {} }
  })

  ipcMain.handle('manager:safe-browsing-save-config', (event, config) => {
    const cfgPath = safeBrowsingConfigPath()
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2))
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('manager:open-external', (event, url) => {
    const allowed = /^https:\/\/github\.com\//
    if (allowed.test(url)) shell.openExternal(url)
  })

  ipcMain.handle('manager:delete-profile-data', (event, profile) => {
    const dir = path.join(app.getPath('appData'), 'wrapweb', profile)
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
      const dir = path.join(app.getPath('appData'), 'wrapweb', profile)
      if (!fs.existsSync(dir)) return { profile, name, bytes: 0, exists: false }
      const r = spawnSync('du', ['-sb', dir], { encoding: 'utf8' })
      const bytes = r.status === 0 ? parseInt((r.stdout || '').split('\t')[0]) || 0 : 0
      return { profile, name, bytes, exists: true }
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
            const raw  = fs.readFileSync(path.join(APP_ROOT, 'dist', `wrapweb-${configLabel}.version`), 'utf8').trim()
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
