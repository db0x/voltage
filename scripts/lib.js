const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execSync } = require('node:child_process')
const { primaryKeyFromUrl, routingUrlKeys } = require('../src/routing-match')
const { appName, wmClass } = require('../src/app-naming')
const { appImagePath, profileDir } = require('../src/app-paths')
const { voltageIconThemeDir } = require('../src/icon-paths')
const { ensureLauncher, desktopExec } = require('../src/launcher')

const PROJECT_ROOT = path.resolve(__dirname, '..')

// Base of the per-app profile-data folders, mirroring Electron's app.getPath('appData')/voltage so
// the path baked into the launcher matches the runtime userData dir (see src/app-window.js).
const VOLTAGE_DATA_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'voltage')

function toDisplayName(profile) {
  return profile.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// scalable/apps dir of Voltage's private icon theme — see src/icon-paths.js for why we never write
// app icons into the shared hicolor theme.
function voltageAppsDir() {
  return path.join(voltageIconThemeDir(), 'scalable', 'apps')
}

// Writes the private theme's index.theme. Safe to (re)write unconditionally: no other software ships
// a `voltage` theme, so this overshadows nothing. Inherits=hicolor keeps the normal fallback chain.
function ensureVoltageIndexTheme() {
  const dir = voltageIconThemeDir()
  const subdirs = ['scalable/apps', '48x48/apps']
  const section = (d) => {
    const scalable = d.startsWith('scalable')
    const size = scalable ? 128 : parseInt(d) || 48
    return `[${d}]\nSize=${size}\nType=${scalable ? 'Scalable' : 'Fixed'}\nMinSize=1\nMaxSize=512\nContext=Applications`
  }
  const content = ['[Icon Theme]', 'Name=Voltage', 'Comment=Voltage application icons',
    'Inherits=hicolor', `Directories=${subdirs.join(',')}`, '', ...subdirs.map(section), ''].join('\n')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.theme'), content, 'utf8')
  return dir
}

function updateVoltageCache() {
  try {
    const dir = ensureVoltageIndexTheme()
    execSync(`gtk-update-icon-cache -f -t "${dir}"`, { stdio: 'ignore' })
  } catch { /* non-fatal */ }
}

// One-time repair for systems hit by an earlier bug: older Voltage versions fabricated a sparse
// ~/.local/share/icons/hicolor/index.theme. Because the spec reads the theme's Directories= list
// only from the highest-priority base dir, that file shadowed the complete system hicolor index and
// hid hundreds of unrelated system icons. Remove the self-generated file (signature: Name=Hicolor
// with no Context= keys — a real distro index.theme always carries Context=) so GTK falls back to
// the system index again, and drop any stale cache built from it.
function cleanupFabricatedHicolorIndex() {
  const hicolorDir = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')
  const indexFile  = path.join(hicolorDir, 'index.theme')
  try {
    const content = fs.readFileSync(indexFile, 'utf8')
    if (/Name=Hicolor/.test(content) && !/Context=/.test(content)) {
      fs.rmSync(indexFile, { force: true })
      fs.rmSync(path.join(hicolorDir, 'icon-theme.cache'), { force: true })
      console.log('  Removed Voltage-fabricated hicolor index.theme (restored system icon fallback)')
    }
  } catch { /* nothing to clean */ }
}

function installIcon() {
  cleanupFabricatedHicolorIndex()  // heal systems damaged by the old hicolor-index behaviour
  const src = path.join(PROJECT_ROOT, 'assets', 'voltage.svg')
  if (!fs.existsSync(src)) return

  const iconDir = voltageAppsDir()
  const dest = path.join(iconDir, 'voltage.svg')

  fs.mkdirSync(iconDir, { recursive: true })
  fs.copyFileSync(src, dest)
  console.log(`  Icon installed: ${dest}`)
  updateVoltageCache()
}

// Escape backslashes for .desktop file values (the only character requiring escaping in practice).
function escapeDesktop(s) {
  return String(s).replace(/\\/g, '\\\\')
}

// Installs the app's icon into Voltage's private theme and returns the ABSOLUTE path to the
// installed file. The .desktop entry references that path directly, so the launcher never relies on
// the icon being resolvable by *name* in the active theme — a private theme is not searched by name.
// Source precedence: a matching icon from any system theme, else the bundled assets/webapps/<name>.svg,
// else the generic assets/voltage.svg (shared by every default-icon app).
function resolveAppIcon(iconName, desktopName) {
  const appsDir        = voltageAppsDir()
  const destSvg        = path.join(appsDir, `${desktopName}.svg`)
  const destPng        = path.join(appsDir, `${desktopName}.png`)
  const voltageDefault = path.join(appsDir, 'voltage.svg')  // installed by installIcon()

  if (!iconName || iconName === 'voltage') return voltageDefault

  // Already installed under this name
  if (fs.existsSync(destSvg)) return destSvg
  if (fs.existsSync(destPng)) return destPng

  // Search icon themes for a matching file (apps/ subdir first, then root of icons dirs)
  const searchDirs = [
    path.join(os.homedir(), '.local', 'share', 'icons'),
    '/usr/local/share/icons',
    '/usr/share/icons',
  ]
  const exts = ['svg', 'png']
  const candidates = []
  for (const base of searchDirs) {
    for (const ext of exts) {
      // Standard theme path: <theme>/<size>/apps/<name>.<ext>
      candidates.push({ cmd: `find "${base}" -name "${iconName}.${ext}" -path "*/apps/*" 2>/dev/null | head -1` })
      // Non-standard: directly in icons root, e.g. ~/.local/share/icons/<name>.<ext>
      const rootFile = path.join(base, `${iconName}.${ext}`)
      if (fs.existsSync(rootFile)) candidates.unshift({ file: rootFile, ext })
    }
  }
  for (const c of candidates) {
    try {
      const found = c.file ?? execSync(c.cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (!found) continue
      const ext = c.ext ?? (found.endsWith('.svg') ? 'svg' : 'png')
      fs.mkdirSync(appsDir, { recursive: true })
      const dest = ext === 'svg' ? destSvg : destPng
      fs.copyFileSync(found, dest)
      console.log(`  Icon installed to voltage theme: ${dest}`)
      updateVoltageCache()
      return dest
    } catch { /* non-fatal */ }
  }
  // Bundled fallback: check assets/webapps/<iconName>.svg, then assets/voltage.svg
  const bundledWebapp = path.join(PROJECT_ROOT, 'assets', 'webapps', `${iconName}.svg`)
  const fallbackSvg = fs.existsSync(bundledWebapp)
    ? bundledWebapp
    : path.join(PROJECT_ROOT, 'assets', 'voltage.svg')
  if (fs.existsSync(fallbackSvg)) {
    try {
      fs.mkdirSync(appsDir, { recursive: true })
      fs.copyFileSync(fallbackSvg, destSvg)
      updateVoltageCache()
      return destSvg
    } catch { /* non-fatal */ }
  }
  return voltageDefault
}

function installDesktop(app) {
  const desktopName = appName(app.profile)
  const desktopsDir = path.join(os.homedir(), '.local', 'share', 'applications')
  const desktopFile = path.join(desktopsDir, `${desktopName}.desktop`)

  const appImageFile = appImagePath(app, path.resolve('dist'))
  const displayName = escapeDesktop(app.name || toDisplayName(app.profile))
  // Absolute path into Voltage's private icon theme. A path (rather than an icon name) is required
  // here: the private theme is not searched by name in the active theme, so only a direct path is
  // guaranteed to resolve in every launcher/desktop environment.
  const icon = resolveAppIcon(app.icon || 'voltage', desktopName)
  const mimeTypes = app.mimeTypes?.length ? app.mimeTypes.join(';') + ';' : null

  // Route the launcher through Voltage's shared indirection script so GNOME never drops the entry
  // when the AppImage's directory is encrypted/locked (see src/launcher.js). Ensure the script
  // exists before the .desktop references it.
  ensureLauncher()

  const lines = [
    '[Desktop Entry]',
    'Version=1.0',
    `Name=${displayName}`,
    `Comment=${displayName}`,
    `Exec=${desktopExec(appImageFile)}`,
    'Terminal=false',
    'Type=Application',
    `Icon=${icon}`,
    // Must equal the app_id Chromium emits on Wayland (the lowercased artifact name, e.g.
    // "vteams") so GNOME associates the window with this launcher; a capitalised value would
    // not match and GNOME would show the raw lowercase id instead.
    `StartupWMClass=${wmClass(app.profile)}`,
  ]
  // Marker read by the Voltage GNOME Shell extension: a frameless widget app must be kept out of
  // the dash/dock, which an AppImage cannot arrange for itself under Wayland. The launcher is the
  // extension's single source of truth, so the flag lives here. The widget plugin's per-app
  // `showInTaskbar` toggle controls it: absent/false (the default) hides the app; only an explicit
  // `true` keeps it in the taskbar (then no marker is written).
  const widgetPlugin = (app.plugins ?? []).find(p => /(^|\/)widget\//.test(p))
  if (widgetPlugin && app.pluginConfig?.[widgetPlugin]?.showInTaskbar !== true) {
    lines.push('X-Voltage-Widget=true')
  }
  // Written for EVERY Voltage app (not only widgets): tells the GNOME extension where this app
  // keeps its data so it can persist + restore the window's last position there. Absolute and
  // override-aware (honours a per-app `profileDir`), so the extension never has to guess the path.
  // It doubles as the "this is a Voltage app" marker — the window-position feature applies to all
  // Voltage AppImages whenever the extension is active, independent of the taskbar/widget setting.
  lines.push(`X-Voltage-ProfileDir=${profileDir(app, VOLTAGE_DATA_DIR)}`)
  if (mimeTypes) lines.push(`MimeType=${mimeTypes}`)
  lines.push('')

  fs.mkdirSync(desktopsDir, { recursive: true })
  fs.writeFileSync(desktopFile, lines.join('\n'), 'utf8')
  console.log(`  Installed: ${desktopFile}`)

  try {
    execSync(`update-desktop-database "${desktopsDir}"`, { stdio: 'ignore' })
  } catch {
    // non-fatal
  }

  // Render a 48×48 PNG from the app icon SVG so nativeImage.createFromPath() works in
  // context menus (Electron on Linux cannot load SVG via nativeImage). Both source and target live
  // in Voltage's private icon theme.
  const appIconSvg = path.join(voltageAppsDir(), `${desktopName}.svg`)
  if (fs.existsSync(appIconSvg)) {
    const pngConverter = ['rsvg-convert', 'inkscape', 'convert'].find(cmd => {
      try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true } catch { return false }
    })
    if (pngConverter) {
      const pngDir  = path.join(voltageIconThemeDir(), '48x48', 'apps')
      const pngPath = path.join(pngDir, `${desktopName}.png`)
      try {
        fs.mkdirSync(pngDir, { recursive: true })
        if (pngConverter === 'rsvg-convert') {
          execSync(`rsvg-convert -w 48 -h 48 -o "${pngPath}" "${appIconSvg}"`, { stdio: 'ignore', timeout: 5000 })
        } else if (pngConverter === 'inkscape') {
          execSync(`inkscape -o "${pngPath}" --export-width=48 "${appIconSvg}"`, { stdio: 'ignore', timeout: 10000 })
        } else {
          execSync(`convert -background none -resize 48x48 "${appIconSvg}" "${pngPath}"`, { stdio: 'ignore', timeout: 5000 })
        }
        if (fs.existsSync(pngPath)) console.log(`  App icon PNG rendered: ${pngPath}`)
      } catch { /* non-fatal */ }
    }
  }

  if (app.mimeIcons) {
    // Detect active GTK icon theme — PNG-only themes (e.g. Papirus) need PNGs
    // installed directly into the user theme override dir, because their system
    // icon-theme.cache takes precedence over the user's hicolor fallback.
    let activeTheme = 'hicolor'
    try {
      activeTheme = execSync('gsettings get org.gnome.desktop.interface icon-theme',
        { encoding: 'utf8', timeout: 2000 }).trim().replace(/'/g, '')
    } catch { /* fallback to hicolor */ }

    const converter = ['inkscape', 'rsvg-convert', 'convert'].find(cmd => {
      try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true } catch { return false }
    })

    // Papirus and similar themes store SVGs in per-size dirs rather than scalable/.
    // Detect this by checking for SVG files in the theme's size subdirs — if found,
    // we copy SVGs directly instead of rendering PNGs, so the user-local copy wins
    // over the system theme's icon-theme.cache (which GTK consults before scanning).
    const themeUsesSvgInSizeDirs = activeTheme !== 'hicolor' && (() => {
      try {
        const hit = execSync(
          `find /usr/share/icons/${activeTheme} -name "*.svg" -not -path "*/symbolic/*" 2>/dev/null | head -1`,
          { encoding: 'utf8', timeout: 3000 }
        )
        return hit.trim().length > 0
      } catch { return false }
    })()

    for (const [mimeType, assetFile] of Object.entries(app.mimeIcons)) {
      const src      = path.join(PROJECT_ROOT, 'assets', 'mimetypes', assetFile)
      if (!fs.existsSync(src)) continue
      const iconName = mimeType.replace('/', '-')

      // Always install SVG to hicolor scalable (covers scalable themes + fallback)
      const svgDir = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', 'scalable', 'mimetypes')
      fs.mkdirSync(svgDir, { recursive: true })
      fs.copyFileSync(src, path.join(svgDir, `${iconName}.svg`))
      console.log(`  MIME icon (SVG) installed: ${path.join(svgDir, iconName + '.svg')}`)

      if (activeTheme !== 'hicolor') {
        const themeSizes = [16, 22, 24, 32, 48, 64, 96, 128]
        if (themeUsesSvgInSizeDirs) {
          // SVG theme (e.g. Papirus): copy SVG into each size dir so the user-local
          // version shadows the system entry without relying on the hicolor fallback.
          for (const size of themeSizes) {
            const dir  = path.join(os.homedir(), '.local', 'share', 'icons', activeTheme, `${size}x${size}`, 'mimetypes')
            const dest = path.join(dir, `${iconName}.svg`)
            try {
              fs.mkdirSync(dir, { recursive: true })
              fs.copyFileSync(src, dest)
              console.log(`  MIME icon (SVG ${size}px override) installed: ${dest}`)
            } catch { /* non-fatal */ }
          }
        } else if (converter) {
          // PNG-only theme: render rasterised copies into the user theme override dir
          for (const size of themeSizes) {
            const pngDir  = path.join(os.homedir(), '.local', 'share', 'icons', activeTheme, `${size}x${size}`, 'mimetypes')
            const destPng = path.join(pngDir, `${iconName}.png`)
            try {
              fs.mkdirSync(pngDir, { recursive: true })
              if (converter === 'inkscape') {
                execSync(`inkscape -o "${destPng}" --export-width=${size} "${src}"`, { stdio: 'ignore', timeout: 10000 })
              } else if (converter === 'rsvg-convert') {
                execSync(`rsvg-convert -w ${size} -h ${size} -o "${destPng}" "${src}"`, { stdio: 'ignore', timeout: 5000 })
              } else {
                execSync(`convert -background none -resize ${size}x${size} "${src}" "${destPng}"`, { stdio: 'ignore', timeout: 5000 })
              }
              if (fs.existsSync(destPng))
                console.log(`  MIME icon (${size}px) installed: ${destPng}`)
            } catch { /* non-fatal */ }
          }
        }
      }
    }
    // No icon-cache rebuild here: MIME icons must stay resolvable by *name*, so they live in the
    // shared hicolor theme (and active-theme override dirs) rather than Voltage's private theme.
    // We deliberately do NOT touch those themes' index.theme — that was the system-wide-breakage
    // bug. Copying a file bumps the directory mtime, which invalidates any stale per-dir cache, so
    // GTK picks the new icons up via its live directory scan without a fabricated index/cache.
  }

  updateRoutingTable()

  if (app.mimeExtensions) {
    const mimePackagesDir = path.join(os.homedir(), '.local', 'share', 'mime', 'packages')
    const mimeXmlFile     = path.join(mimePackagesDir, `${appName(app.profile)}.xml`)
    const types = Object.entries(app.mimeExtensions).map(([type, exts]) =>
      `  <mime-type type="${type}">\n` +
      `    <comment>${escapeDesktop(app.name || type)}</comment>\n` +
      exts.map(e => `    <glob pattern="*.${e}"/>`).join('\n') + '\n' +
      `  </mime-type>`
    ).join('\n')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">\n${types}\n</mime-info>\n`
    fs.mkdirSync(mimePackagesDir, { recursive: true })
    fs.writeFileSync(mimeXmlFile, xml, 'utf8')
    console.log(`  MIME type registered: ${mimeXmlFile}`)
    try {
      execSync(`update-mime-database "${path.join(os.homedir(), '.local', 'share', 'mime')}"`, { stdio: 'ignore' })
    } catch {
      // non-fatal
    }
  }
}

// Rebuilds routing.json from all installed AppImages. Called after every
// install-app run so the routing table stays in sync without requiring a rebuild.
// The table is split into a `base` map (each app's primary URL) and a `routing` map
// (each app's routingUrls): the same key string may appear in both pointing at
// different apps, and at resolution time a routing claim wins over a base claim.
// Keys use path-prefix notation with optional '*' wildcards (e.g. docs.google.com/d/*).
// The 48×48 PNG is preferred over SVG because nativeImage cannot load SVG on Linux.
function updateRoutingTable() {
  const routingDir  = path.join(os.homedir(), '.config', 'voltage', 'plugins', 'routing')
  const routingFile = path.join(routingDir, 'routing.json')

  const routing = { base: {}, routing: {} }
  try {
    const webappsDir = path.join(PROJECT_ROOT, 'webapps')
    for (const f of fs.readdirSync(webappsDir).filter(f => /^build\..+\.json$/.test(f))) {
      let cfg
      try { cfg = JSON.parse(fs.readFileSync(path.join(webappsDir, f), 'utf8')) } catch { continue }
      const appImagePath = path.join(PROJECT_ROOT, 'dist', appName(cfg.profile))
      if (!fs.existsSync(appImagePath)) continue
      try {
        const name      = cfg.name || toDisplayName(cfg.profile)
        const iconName  = appName(cfg.profile)
        // Prefer Voltage's private theme (current layout), fall back to hicolor for older installs.
        // 48×48 PNG first because nativeImage cannot load SVG on Linux.
        const voltage   = voltageIconThemeDir()
        const hicolor   = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')
        const icon      = [
          path.join(voltage, '48x48',    'apps', `${iconName}.png`),
          path.join(voltage, 'scalable', 'apps', `${iconName}.png`),
          path.join(voltage, 'scalable', 'apps', `${iconName}.svg`),
          path.join(hicolor, '48x48',    'apps', `${iconName}.png`),
          path.join(hicolor, 'scalable', 'apps', `${iconName}.png`),
          path.join(hicolor, 'scalable', 'apps', `${iconName}.svg`),
        ].find(p => fs.existsSync(p)) || null
        const entry = { path: appImagePath, name, ...(icon && { icon }) }
        const baseKey = primaryKeyFromUrl(cfg.url)
        if (baseKey) routing.base[baseKey] = entry
        for (const key of routingUrlKeys(cfg)) routing.routing[key] = entry
      } catch {}
    }
  } catch {}

  fs.mkdirSync(routingDir, { recursive: true })
  fs.writeFileSync(routingFile, JSON.stringify(routing, null, 2), 'utf8')
  console.log(`  Routing table updated: ${routingFile}`)
}

module.exports = { toDisplayName, installDesktop, installIcon }
