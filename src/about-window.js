// "About" panel for an app window, toggled with F12 (Shift+F12 stays DevTools).
//
// Rendered in its OWN WebContentsView laid over the app window — NOT injected into the page.
// This is the whole point: the panel runs in a web context we control, so it is immune to the
// host page's CSP, Trusted Types, and SPA quirks. The previous approach (executeJavaScript into
// the page) broke per-app whenever a site shipped a stricter policy — exactly the fragility we
// want gone. The view holds our own HTML (rclone-dialog look) with a solid dark backdrop;
// page-level transparency is unreliable on Linux/Wayland, so the backdrop is opaque.

const { WebContentsView, ipcMain, app, shell } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const os   = require('node:os')

const pkg      = require(app.getAppPath() + '/package.json')
const APP_ROOT = app.getAppPath()
const { appName } = require('./app-naming')
const { t }       = require('./i18n')

// Reads an SVG asset as a base64 data URL for inline embedding; null if missing.
function svgDataUrl(absPath) {
  try { return `data:image/svg+xml;base64,${fs.readFileSync(absPath).toString('base64')}` } catch { return null }
}

// The installed per-app icon. resolveIconToHicolor places it under scalable/apps as .svg OR .png
// (a private app's icon copied from a system theme is often a .png there), so check both before the
// 48x48 fallback — otherwise such icons (e.g. mastodon) come up empty.
function appIconDataUrl() {
  const hicolor = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')
  const iconBase = appName(pkg.profile)
  const candidates = [
    [path.join(hicolor, 'scalable', 'apps', `${iconBase}.svg`), 'image/svg+xml'],
    [path.join(hicolor, 'scalable', 'apps', `${iconBase}.png`), 'image/png'],
    [path.join(hicolor, '48x48',    'apps', `${iconBase}.png`), 'image/png'],
  ]
  for (const [p, mime] of candidates) {
    if (fs.existsSync(p)) return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`
  }
  return null
}

// webapps-relative plugin path → { label, icon } (mirrors the manager's discovery labelling).
function pluginDisplay(rel) {
  const label = path.basename(rel).replace(/\.js$/, '').replace(/^private\./, '')
  const icon  = svgDataUrl(path.join(APP_ROOT, 'webapps', path.dirname(rel), 'plugin.svg'))
  return { label, icon }
}

// Read once — stable for the process lifetime.
const githubIcon = svgDataUrl(path.join(APP_ROOT, 'assets', 'github.svg'))
const safeIcon   = svgDataUrl(path.join(APP_ROOT, 'assets', 'safe-browsing.svg'))
const unsafeIcon = svgDataUrl(path.join(APP_ROOT, 'assets', 'security-low.svg'))

// HTML-escape for values placed into the page markup.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Mustache-style {{key}} substitution for the about template (no DOM in Node). Mirrors the
// rclone-sync plugin's data:-URL pages: structure/CSS live in the .html file, JS fills the holes.
function fillHtml(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

// The about overlay's markup ships as a sibling .html file (structure + CSS + the small inline
// script) so no HTML lives in this module. Read once — stable for the process lifetime.
const aboutTemplate = fs.readFileSync(path.join(__dirname, 'about-window.html'), 'utf8')

// Fills the About template for the current app/locale. Strings come from src/i18n/*.json via the
// shared i18n module (no UI text in this file). Runs in our own context (no foreign CSP); the
// *Html vars are pre-built markup fragments, the rest are escaped text.
function buildAboutHtml(info) {
  const i18n = t()
  const de = app.getLocale().split('-')[0].toLowerCase() === 'de'
  const displayName = pkg.displayName || pkg.profile

  const appIcon = appIconDataUrl()
  const plugins = (pkg.plugins ?? []).map(pluginDisplay)

  const pluginsFieldHtml = plugins.length ? `
    <div class="wa-field"><div class="wa-label">${esc(i18n.aboutPanelPlugins)}</div>
      <ul class="wa-plugins">${plugins.map(p =>
        `<li>${p.icon ? `<img src="${p.icon}" alt="">` : ''}<span>${esc(p.label)}</span></li>`).join('')}</ul>
    </div>` : ''

  const ver = (name, hint) =>
    `<div class="wa-ver"><span class="wa-ver-name">${esc(name)}</span><span class="wa-ver-hint">${esc(hint)}</span></div>`
  const versionRowsHtml =
    ver('Voltage ' + pkg.version, i18n.aboutPanelVoltageHint) +
    ver('Electron ' + process.versions.electron, i18n.aboutPanelElectronHint) +
    ver('Chromium ' + process.versions.chrome, i18n.aboutPanelChromiumHint)

  return fillHtml(aboutTemplate, {
    lang: de ? 'de' : 'en',
    headerIconHtml: appIcon ? `<img src="${appIcon}" alt="">` : '',
    title:         esc(i18n.aboutPanelTitle.replace(/\{name\}/g, displayName)),
    subtitle:      esc(i18n.aboutPanelSubtitle),
    domainLabel:   esc(i18n.aboutPanelDomain),
    domain:        esc(info.domain),
    appLabel:      esc(i18n.aboutPanelApp),
    appName:       esc(pkg.name || pkg.profile),
    versionsLabel: esc(i18n.aboutPanelVersions),
    versionRowsHtml,
    pluginsFieldHtml,
    githubIconHtml: githubIcon ? `<img src="${githubIcon}" alt="">` : '',
    builtWith:     esc(i18n.aboutPanelBuiltWith),
    electron:      esc(i18n.aboutPanelElectron),
    close:         esc(i18n.aboutPanelClose),
    // Embedded in the inline <script> as a JS object literal (parsed by the renderer).
    safeBrowsingData: JSON.stringify({ fullUrl: info.fullUrl, safeIcon, unsafeIcon, sbSafe: i18n.aboutPanelSbSafe, sbUnsafe: i18n.aboutPanelSbUnsafe }),
  })
}

// Toggles the About overlay view on a window: present → remove (F12 again closes), else create.
// The view is sized to fill the window and kept in sync on resize while open.
function toggleAboutWindow(win) {
  if (win._voltageAboutView) {
    closeAbout(win)
    return
  }

  // In view mode the app lives in an inset WebContentsView, not the window's own webContents.
  const appContents = win._voltageAppContents || win.webContents
  const fullUrl = appContents.getURL()
  const domain = (() => {
    try { const u = new URL(fullUrl); return `${u.protocol}//${u.host}` } catch { return fullUrl }
  })()

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'about-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // Make the view itself transparent so the semi-transparent CSS backdrop lets the app show
  // through (dimmed) instead of painting an opaque grey over everything. If the compositor
  // can't honour this, the backdrop simply looks more solid — never worse than before.
  try { view.setBackgroundColor('#00000000') } catch {}

  // In view mode the app is an inset, rounded WebContentsView; the overlay must match that exact
  // rect (and corner radius) so its backdrop stays inside the widget instead of bleeding into the
  // transparent shadow gutter / rounded corners. Non-view apps fill the whole content area (m=0).
  const inset = win._voltageViewInset || { margin: 0, radius: 0 }
  if (inset.radius && typeof view.setBorderRadius === 'function') view.setBorderRadius(inset.radius)
  const layout = (b) => {
    const m = inset.margin
    view.setBounds({ x: m, y: m, width: Math.max(0, b.width - 2 * m), height: Math.max(0, b.height - 2 * m) })
  }
  layout(win.getContentBounds())
  win.contentView.addChildView(view)

  // Keep the overlay matched to the window size while it's open.
  const onResize = () => {
    if (!win._voltageAboutView) return
    layout(win.getContentBounds())
  }
  win.on('resize', onResize)

  win._voltageAboutView = view
  win._voltageAboutCleanup = () => win.removeListener('resize', onResize)

  view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildAboutHtml({ domain, fullUrl })))
  view.webContents.once('did-finish-load', () => view.webContents.focus())
}

function closeAbout(win) {
  const view = win._voltageAboutView
  if (!view) return
  win._voltageAboutCleanup?.()
  try { win.contentView.removeChildView(view) } catch {}
  try { view.webContents.destroy() } catch {}
  win._voltageAboutView = null
  win._voltageAboutCleanup = null
  win.webContents.focus()
}

// The About footer links (Voltage repo, Electron site) must open in the system browser, not a
// child window. The overlay's renderer routes clicks here instead of calling window.open(); we only
// hand off https:// URLs to the OS handler.
ipcMain.on('about:open-external', (event, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url)
})

// 'about:close' is sent by the overlay's preload (close button / Esc / F12 / backdrop).
ipcMain.on('about:close', (event) => {
  for (const win of require('electron').BrowserWindow.getAllWindows()) {
    if (win._voltageAboutView && win._voltageAboutView.webContents.id === event.sender.id) {
      closeAbout(win)
      return
    }
  }
})

module.exports = { toggleAboutWindow }
