// App-config domain helpers: version comparison, the .version sidecar, and building
// the app objects the manager UI renders from a build.<profile>.json config file.

const { app } = require('electron')
const path    = require('node:path')
const fs      = require('node:fs')
const os      = require('node:os')

const { APP_ROOT, CONFIGS_DIR, pkg } = require('./paths')
const { resolveIconsByGtk }          = require('./icons')

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

// True when a config loads the rclone-sync plugin. rclone is a plugin now, so this replaces
// the old standalone `rcloneFileHandler` config flag everywhere the manager needs to know an
// app is rclone-capable (the rclone dialog's app list, the app object it returns).
function usesRcloneSync(cfg) {
  return (cfg.plugins ?? []).some(p => /(^|\/)rclone-sync\//.test(p))
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
    routingUrls: cfg.routingUrls || null,
    mimeTypes: cfg.mimeTypes || null, plugins: cfg.plugins || null,
    isDefaultMailHandler: defaultMailDesktop === `wrapweb-${cfg.profile}.desktop`,
    category: cfg.category || null,
    builtVersion, builtRclone, rcloneFileHandler: usesRcloneSync(cfg),
    needsRebuild: needsRebuild(built, builtVersion, minVer),
  }
}

// Config keys the create/edit form fully owns. Everything else in an existing config
// (category, rcloneFileHandler, mimeExtensions, mimeIcons, mailtoTemplate, …) is passed
// through unchanged on edit so copying an embedded app to private and then editing it
// does not silently drop fields the form cannot represent.
const FORM_MANAGED_KEYS = new Set([
  'profile', 'url', 'name', 'icon', 'geometry', 'userAgent',
  'internalDomains', 'routingUrls', 'crossOriginIsolation', 'singleInstance',
  'mimeTypes', 'plugins',
])

// Builds a config object from create/edit form data, omitting falsy/default fields.
// `existing` is the config currently on disk (empty for create): its non-form-managed
// keys are preserved, and its mimeTypes are kept (the form only toggles the mailto entry).
function buildAppCfg({ profile, name, url, icon, width, height, userAgent, internalDomains, routingUrls, crossOriginIsolation, singleInstance, mailHandler, plugins }, existing = {}) {
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
  // routingUrls makes other apps route matching links to this one. Always stored as an
  // array so updateRoutingTable() and the overlap check see a consistent shape.
  if (Array.isArray(routingUrls)) {
    const urls = routingUrls.map(u => u.trim()).filter(Boolean)
    if (urls.length) cfg.routingUrls = urls
  }
  // The form's mail-handler toggle only governs the mailto scheme; any other MIME types
  // the app already declared (e.g. a draw.io file handler) are preserved.
  const otherMimeTypes = (Array.isArray(existing.mimeTypes) ? existing.mimeTypes : [])
    .filter(t => t !== 'x-scheme-handler/mailto')
  const mimeTypes = mailHandler ? [...otherMimeTypes, 'x-scheme-handler/mailto'] : otherMimeTypes
  if (mimeTypes.length) cfg.mimeTypes = mimeTypes
  // Per-app main-process plugins, selected in the dialog (decoupled from the mailto toggle).
  // Stored as webapps-relative paths; an empty selection omits the key entirely.
  if (Array.isArray(plugins)) {
    const list = plugins.map(p => p.trim()).filter(Boolean)
    if (list.length) cfg.plugins = list
  }

  // Carry over every field the form does not manage (category, rclone*, mime icons, …).
  for (const [k, v] of Object.entries(existing)) {
    if (!FORM_MANAGED_KEYS.has(k)) cfg[k] = v
  }
  return cfg
}

module.exports = { semverLt, readVersionSidecar, needsRebuild, buildSingleApp, buildAppCfg, usesRcloneSync }
