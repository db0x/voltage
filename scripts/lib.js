const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execSync } = require('node:child_process')

const PROJECT_ROOT = path.resolve(__dirname, '..')

function toDisplayName(profile) {
  return profile.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function ensureHicolorIndexTheme() {
  const hicolorDir = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')

  // Build index.theme from directories that actually exist locally — a copied
  // system index.theme lists hundreds of missing dirs and makes gtk-update-icon-cache
  // generate an invalid cache.
  const sizeMap = { scalable: null }
  const subdirs = []
  try {
    for (const sizeEntry of fs.readdirSync(hicolorDir, { withFileTypes: true })) {
      if (!sizeEntry.isDirectory()) continue
      const size = sizeEntry.name
      const sizeDir = path.join(hicolorDir, size)
      for (const ctxEntry of fs.readdirSync(sizeDir, { withFileTypes: true })) {
        if (ctxEntry.isDirectory()) subdirs.push(`${size}/${ctxEntry.name}`)
      }
    }
  } catch { /* ignore */ }

  if (subdirs.length === 0) subdirs.push('scalable/apps', 'scalable/mimetypes')

  const sections = subdirs.map(d => {
    const size = d.startsWith('scalable') ? 128 : parseInt(d.split('/')[0]) || 48
    return `[${d}]\nSize=${size}\nType=${d.startsWith('scalable') ? 'Scalable' : 'Fixed'}\nMinSize=1\nMaxSize=256`
  })

  const content = ['[Icon Theme]', 'Name=Hicolor', 'Comment=Hicolor',
    `Directories=${subdirs.join(',')}`, '', ...sections, ''].join('\n')
  fs.writeFileSync(path.join(hicolorDir, 'index.theme'), content, 'utf8')
  return hicolorDir
}

function updateHicolorCache() {
  try {
    const hicolorDir = ensureHicolorIndexTheme()
    execSync(`gtk-update-icon-cache -f -t "${hicolorDir}"`, { stdio: 'ignore' })
  } catch { /* non-fatal */ }
}

function installIcon() {
  const src = path.join(PROJECT_ROOT, 'assets', 'wrapweb.svg')
  if (!fs.existsSync(src)) return

  const iconDir = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', 'scalable', 'apps')
  const dest = path.join(iconDir, 'wrapweb.svg')

  fs.mkdirSync(iconDir, { recursive: true })
  fs.copyFileSync(src, dest)
  console.log(`  Icon installed: ${dest}`)
  updateHicolorCache()
}

// Escape backslashes for .desktop file values (the only character requiring escaping in practice).
function escapeDesktop(s) {
  return String(s).replace(/\\/g, '\\\\')
}

// Copies a system icon into the user's hicolor theme under the app's desktop
// name (e.g. wrapweb-teams) so the .desktop entry always has a valid icon.
// Falls back to the bundled SVG from assets/webapps/ or assets/wrapweb.svg
// when no matching icon is found in any system theme.
function resolveIconToHicolor(iconName, desktopName) {
  if (!iconName || iconName === 'wrapweb') return iconName

  const hicolorDir = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', 'scalable', 'apps')
  const destName = desktopName  // e.g. 'wrapweb-teams'
  const destSvg  = path.join(hicolorDir, `${destName}.svg`)
  const destPng  = path.join(hicolorDir, `${destName}.png`)

  // Already installed under this name
  if (fs.existsSync(destSvg) || fs.existsSync(destPng)) return destName

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
      fs.mkdirSync(hicolorDir, { recursive: true })
      const dest = ext === 'svg' ? destSvg : destPng
      fs.copyFileSync(found, dest)
      console.log(`  Icon copied to hicolor: ${dest}`)
      updateHicolorCache()
      return destName
    } catch { /* non-fatal */ }
  }
  // Bundled fallback: check assets/webapps/<iconName>.svg, then assets/wrapweb.svg
  const bundledWebapp = path.join(PROJECT_ROOT, 'assets', 'webapps', `${iconName}.svg`)
  const fallbackSvg = fs.existsSync(bundledWebapp)
    ? bundledWebapp
    : path.join(PROJECT_ROOT, 'assets', 'wrapweb.svg')
  if (fs.existsSync(fallbackSvg)) {
    try {
      fs.mkdirSync(hicolorDir, { recursive: true })
      fs.copyFileSync(fallbackSvg, destSvg)
      updateHicolorCache()
      return destName
    } catch { /* non-fatal */ }
  }
  return iconName
}

function installDesktop(app) {
  const desktopName = `wrapweb-${app.profile}`
  const desktopsDir = path.join(os.homedir(), '.local', 'share', 'applications')
  const desktopFile = path.join(desktopsDir, `${desktopName}.desktop`)

  const appImagePath = path.resolve('dist', `wrapweb-${app.profile}`)
  const displayName = escapeDesktop(app.name || toDisplayName(app.profile))
  const icon = resolveIconToHicolor(app.icon || 'wrapweb', desktopName)
  const mimeTypes = app.mimeTypes?.length ? app.mimeTypes.join(';') + ';' : null

  const lines = [
    '[Desktop Entry]',
    'Version=1.0',
    `Name=${displayName}`,
    `Comment=${displayName}`,
    `Exec=${appImagePath} --no-sandbox %u`,
    'Terminal=false',
    'Type=Application',
    `Icon=${icon}`,
    `StartupWMClass=${desktopName}`,
  ]
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
  // context menus (Electron on Linux cannot load SVG via nativeImage).
  const appIconSvg = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', 'scalable', 'apps', `${desktopName}.svg`)
  if (fs.existsSync(appIconSvg)) {
    const pngConverter = ['rsvg-convert', 'inkscape', 'convert'].find(cmd => {
      try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true } catch { return false }
    })
    if (pngConverter) {
      const pngDir  = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '48x48', 'apps')
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
    updateHicolorCache()
  }

  updateRoutingTable()

  if (app.mimeExtensions) {
    const mimePackagesDir = path.join(os.homedir(), '.local', 'share', 'mime', 'packages')
    const mimeXmlFile     = path.join(mimePackagesDir, `wrapweb-${app.profile}.xml`)
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
// Keys use path-prefix notation (e.g. docs.google.com/spreadsheets) so that
// apps sharing a hostname can still be routed to different AppImages.
// The 48×48 PNG is preferred over SVG because nativeImage cannot load SVG on Linux.
function updateRoutingTable() {
  const routingDir  = path.join(os.homedir(), '.config', 'wrapweb', 'plugins', 'routing')
  const routingFile = path.join(routingDir, 'routing.json')

  const routing = {}
  try {
    const webappsDir = path.join(PROJECT_ROOT, 'webapps')
    for (const f of fs.readdirSync(webappsDir).filter(f => /^build\..+\.json$/.test(f))) {
      let cfg
      try { cfg = JSON.parse(fs.readFileSync(path.join(webappsDir, f), 'utf8')) } catch { continue }
      const appImagePath = path.join(PROJECT_ROOT, 'dist', `wrapweb-${cfg.profile}`)
      if (!fs.existsSync(appImagePath)) continue
      try {
        const name      = cfg.name || toDisplayName(cfg.profile)
        const hicolor   = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')
        const iconName  = `wrapweb-${cfg.profile}`
        const iconPng48 = path.join(hicolor, '48x48', 'apps', `${iconName}.png`)
        const iconPng   = path.join(hicolor, 'scalable', 'apps', `${iconName}.png`)
        const iconSvg   = path.join(hicolor, 'scalable', 'apps', `${iconName}.svg`)
        const icon      = fs.existsSync(iconPng48) ? iconPng48
                        : fs.existsSync(iconPng)   ? iconPng
                        : fs.existsSync(iconSvg)   ? iconSvg
                        : null
        const entry = { path: appImagePath, name, ...(icon && { icon }) }
        const routingKey = (u => {
          const first = u.pathname.replace(/^\//, '').split('/')[0]
          return first ? `${u.hostname}/${first}` : u.hostname
        })(new URL(cfg.url))
        routing[routingKey] = entry
        for (const extra of cfg.routingUrls ?? []) {
          try {
            const u = new URL(extra)
            const first = u.pathname.replace(/^\//, '').split('/')[0]
            const key = first ? `${u.hostname}/${first}` : u.hostname
            routing[key] = entry
          } catch {}
        }
      } catch {}
    }
  } catch {}

  fs.mkdirSync(routingDir, { recursive: true })
  fs.writeFileSync(routingFile, JSON.stringify(routing, null, 2), 'utf8')
  console.log(`  Routing table updated: ${routingFile}`)
}

module.exports = { toDisplayName, installDesktop, installIcon }
