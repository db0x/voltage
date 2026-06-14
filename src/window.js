const { BrowserWindow, WebContentsView, shell, ipcMain, dialog, app } = require('electron')
const path   = require('node:path')
const fs     = require('node:fs')
const os     = require('node:os')
const crypto = require('node:crypto')
const https  = require('node:https')
const { spawn, spawnSync } = require('node:child_process')
const { createSession } = require('./session')
const { aspellSuggestions } = require('./context-menu')
const windowState = require('./window-state')
const { findRoute, normalizeRouting } = require('./routing-match')
const { appName, profileFromAppName } = require('./app-naming')
const { toggleAboutWindow } = require('./about-window')
const { t } = require('./i18n')

const ROUTING_FILE = path.join(app.getPath('appData'), 'voltage', 'plugins', 'routing', 'routing.json')

// In-memory cache: origin → { result: 'safe'|'unsafe', expiresAt }
// Avoids repeated API calls for the same domain during a browsing session.
const safeBrowsingCache = new Map()

// Tracks which profile is running in each BrowserWindow's webContents so the
// safe-browsing:check handler can apply per-app exclusions without needing a preload change.
const windowProfiles = new Map()  // webContentsId → profile

function safeBrowsingConfigPath() {
  const testDir = process.env.VOLTAGE_TEST_DATA_DIR
  return testDir
    ? path.join(testDir, 'safe-browsing.json')
    : path.join(app.getPath('appData'), 'voltage', 'safe-browsing.json')
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, search } = new URL(url)
    const req = https.request({
      hostname, path: pathname + search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ignoreExclude lets the About dialog check the base URL even for apps that opted out of
// passive Safe Browsing (excludedProfiles only suppresses the automatic link tooltip; an
// explicit About lookup should still report the status). apiKey + enabled are always required.
ipcMain.handle('safe-browsing:check', async (event, url, ignoreExclude = false) => {
  let origin
  try { origin = new URL(url).origin } catch { return 'unknown' }

  const cached = safeBrowsingCache.get(origin)
  if (cached && Date.now() < cached.expiresAt) return cached.result

  const config = (() => {
    try { return JSON.parse(fs.readFileSync(safeBrowsingConfigPath(), 'utf8')) } catch { return {} }
  })()
  if (!config.apiKey || !config.enabled) return 'unknown'

  // Skip check for apps that have opted out (e.g. Outlook, Teams with built-in protection),
  // unless the caller explicitly overrides it (the About dialog).
  const profile = windowProfiles.get(event.sender.id)
  if (!ignoreExclude && profile && Array.isArray(config.excludedProfiles) && config.excludedProfiles.includes(profile)) {
    return 'unknown'
  }

  // Only the origin is hashed — path and query never leave the device.
  const fullHash  = crypto.createHash('sha256').update(origin).digest()
  const prefixB64 = fullHash.slice(0, 4).toString('base64')

  const body = JSON.stringify({
    client:     { clientId: 'voltage', clientVersion: '1.0' },
    threatInfo: {
      threatTypes:      ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
      platformTypes:    ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries:    [{ hash: prefixB64 }],
    },
  })

  try {
    const data   = await httpsPost(`https://safebrowsing.googleapis.com/v4/fullHashes:find?key=${config.apiKey}`, body)
    const json   = JSON.parse(data)
    const myHash = fullHash.toString('base64')
    const unsafe = json.matches?.some(m => m.threat?.hash === myHash) ?? false
    const result = unsafe ? 'unsafe' : 'safe'
    // Google recommends caching safe lookups ≥5 min; keep unsafe results longer.
    safeBrowsingCache.set(origin, { result, expiresAt: Date.now() + (unsafe ? 30 : 5) * 60_000 })
    return result
  } catch {
    return 'unknown'
  }
})

function loadRouting() {
  try { return JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) } catch { return {} }
}

// Read once at module load — these are our own assets, always present.
function readSvgDataUrl(assetName) {
  try {
    const b64 = fs.readFileSync(path.join(__dirname, '..', 'assets', assetName)).toString('base64')
    return `data:image/svg+xml;base64,${b64}`
  } catch { return null }
}
const safeIconDataUrl   = readSvgDataUrl('safe-browsing.svg')
const unsafeIconDataUrl = readSvgDataUrl('security-low.svg')

// Read once — both files are stable for the module's lifetime.
const tooltipScript = fs.readFileSync(path.join(__dirname, 'tooltip-script.js'), 'utf8')
const tooltipCss    = fs.readFileSync(path.join(__dirname, 'tooltip.css'),        'utf8')

// Looks up a PNG icon file by name in standard hicolor theme locations.
// nativeImage.createFromPath() on Linux silently fails on SVG, so only PNG is used.
function resolveIconPath(iconName) {
  if (!iconName) return null
  const iconBases = [
    path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor'),
    '/usr/share/icons/hicolor',
  ]
  for (const base of iconBases) {
    for (const size of ['48x48', '32x32', '64x64', '256x256', '128x128']) {
      const p = path.join(base, size, 'apps', `${iconName}.png`)
      if (fs.existsSync(p)) return p
    }
  }
  const pixmap = `/usr/share/pixmaps/${iconName}.png`
  if (fs.existsSync(pixmap)) return pixmap
  return null
}

// Resolves the PNG icon path for the default handler of a given MIME/scheme type.
// Lazily called — xdg-mime is a subprocess and the result never changes at runtime.
function resolveHandlerIconPath(mimeType) {
  try {
    const r = spawnSync('xdg-mime', ['query', 'default', mimeType], { encoding: 'utf8', timeout: 500 })
    if (!r.stdout) return null
    const desktop = r.stdout.trim()
    const appDirs = [
      path.join(app.getPath('home'), '.local', 'share', 'applications'),
      '/usr/share/applications',
      '/usr/local/share/applications',
    ]
    let iconName = desktop.replace(/\.desktop$/, '')
    for (const dir of appDirs) {
      try {
        const match = fs.readFileSync(path.join(dir, desktop), 'utf8').match(/^Icon=(.+)$/m)
        if (match) { iconName = match[1].trim(); break }
      } catch {}
    }
    return resolveIconPath(iconName)
  } catch {}
  return null
}

let _browserIconPath
function getDefaultBrowserIconPath() {
  if (_browserIconPath !== undefined) return _browserIconPath
  return (_browserIconPath = resolveHandlerIconPath('x-scheme-handler/https'))
}

let _mailIconPath
function getDefaultMailIconPath() {
  if (_mailIconPath !== undefined) return _mailIconPath
  return (_mailIconPath = resolveHandlerIconPath('x-scheme-handler/mailto'))
}

// Some apps (e.g. Google) wrap external links as redirect URLs with the real
// target in a `?url=` parameter. Unwrap so routing matches the actual hostname.
function unwrapUrl(url) {
  try {
    const wrapped = new URL(url).searchParams.get('url')
    if (wrapped) { try { new URL(wrapped); return wrapped } catch {} }
  } catch {}
  return url
}

function resolveRoute(url, currentProfile) {
  const resolved = unwrapUrl(url)
  let targetHost, targetPath
  // Match against pathname+search: SharePoint's generic Doc.aspx links carry the only
  // app-distinguishing token (the .docx/.xlsx/.pptx filename) in the query string, so a
  // routing key like "*Doc.aspx*.docx*" needs the query to be part of the matched text.
  try { const u = new URL(resolved); targetHost = u.hostname; targetPath = u.pathname + u.search } catch { return null }
  // findRoute applies the routing-wins-over-base priority and skips ineligible targets
  // (this app itself, or an AppImage that isn't built) so resolution falls through.
  const match = findRoute(loadRouting(), targetHost, targetPath, (target) => {
    const p = typeof target === 'string' ? target : target.path
    if (!p) return false
    return profileFromAppName(path.basename(p)) !== currentProfile && fs.existsSync(p)
  })
  if (!match) return null
  const target       = match.entry
  const appImagePath = typeof target === 'string' ? target : target.path
  const name         = typeof target === 'string' ? null  : target.name
  const icon         = typeof target === 'string' ? null  : (target.icon ?? null)
  return { appImagePath, name, icon }
}

// Whether `currentProfile` is the app that RIGHTFULLY owns this URL. Resolves the owner across all
// built apps with the normal routing-wins-over-base priority and does NOT exclude the current app
// (unlike resolveRoute, which skips self so docs route to *another* app). The current app owns the
// URL only if it wins that global resolution — a mere base-key match must not self-claim a doc
// another app's higher-priority routing key owns. Concretely: a personal-OneDrive note lives under
// the same *-my.sharepoint.com host that is OneDrive's own base key, but OneNote claims it via a
// Doc.aspx routing key — so the note belongs to OneNote, not OneDrive, from either app. Plugins use
// this to decide "load in place here" vs. "route away".
function appClaimsUrl(url, currentProfile) {
  const resolved = unwrapUrl(url)
  let targetHost, targetPath
  try { const u = new URL(resolved); targetHost = u.hostname; targetPath = u.pathname + u.search } catch { return false }
  const match = findRoute(loadRouting(), targetHost, targetPath, (target) => {
    const p = typeof target === 'string' ? target : target.path
    return !!p && fs.existsSync(p)
  })
  if (!match) return false
  const winnerPath = typeof match.entry === 'string' ? match.entry : match.entry.path
  return profileFromAppName(path.basename(winnerPath)) === currentProfile
}

function routeExternalUrl(url, currentProfile) {
  const route = resolveRoute(url, currentProfile)
  if (!route) return false
  spawn(route.appImagePath, ['--no-sandbox', url], { detached: true, stdio: 'ignore' }).unref()
  return true
}

// Reads a PNG icon path into a data URL for menu items. SVG isn't supported by this path.
function iconToDataUrl(p) { try { return p ? `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` : null } catch { return null } }

// The app's own icon as a data URL. Prefers the installed per-app icon (what the About panel shows
// too) — resolveIconToHicolor (scripts/lib.js) places it under scalable/apps as either .svg OR .png
// (a private app's icon copied from a system theme is often a .png in that dir), so we check both
// there. Falls back to the bundled assets/webapps/<icon> set for non-installed / standard apps.
function appIconDataUrl(pkg) {
  const hicolor = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')
  const iconBase = appName(pkg.profile)
  const candidates = [
    [path.join(hicolor, 'scalable', 'apps', `${iconBase}.svg`), 'image/svg+xml'],
    [path.join(hicolor, 'scalable', 'apps', `${iconBase}.png`), 'image/png'],
    [path.join(hicolor, '48x48',    'apps', `${iconBase}.png`), 'image/png'],
  ]
  if (pkg.icon) candidates.push(
    [path.join(__dirname, '..', 'assets', 'webapps', pkg.icon + '.svg'), 'image/svg+xml'],
    [path.join(__dirname, '..', 'assets', 'webapps', pkg.icon + '.png'), 'image/png'],
  )
  for (const [p, mime] of candidates) {
    try { return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}` } catch {}
  }
  return null
}

// A mono SVG glyph as a { light, dark } pair of data URLs for built-in menu items (e.g. fullscreen).
// The overlay picks the variant matching its theme; the glyph colour #444444 is swapped to a light
// tone for the dark-menu variant. Same scheme the plugin glyphs use.
function themedSvgIcon(absPath) {
  let svg
  try { svg = fs.readFileSync(absPath, 'utf8') } catch { return null }
  const url = (colour) => `data:image/svg+xml;base64,${Buffer.from(svg.replace(/#444444/gi, colour)).toString('base64')}`
  return { light: url('#444444'), dark: url('#f0f0f0') }
}
const FULLSCREEN_ICON = themedSvgIcon(path.join(__dirname, '..', 'webapps', 'plugins', 'widget', 'fullscreen.svg'))

// ── Custom Ctrl+right-click context menu ────────────────────────────────────────────────────────
// The single, consistent way to reach our menu in every app: the preload renders an in-page layer
// on Ctrl+right-click and asks main for its items / runs the chosen action.
// Keyed by the app webContents id (the inset view's in widget/view mode). ONE pair of ipcMain
// handlers serves all windows — ipcMain.handle allows only one handler per channel — so each window
// registers its context here and the handlers resolve it via the sender.
const appMenuRegistry = new Map()  // appContents.id → { appContents, mainWindow, profile, actions }

// Flattens a plugin's contextMenuItems() (click fns + nativeImage icons + optional submenu) into a
// render-safe tree, recording each leaf's click under a fresh id in `actions` (the renderer only
// ever sends an id back). Separators pass through; submenus recurse.
function serializePluginMenu(list, actions, seq = { n: 0 }) {
  const out = []
  for (const it of list) {
    if (it.type === 'separator') { out.push({ type: 'separator' }); continue }
    const id = 'p' + (seq.n++)
    const entry = { id, label: it.label }
    if (it.shortcut) entry.shortcut = it.shortcut
    // icon may be: a plain data-URL string (used as-is), a { light, dark } pair of themed SVG glyphs
    // (the overlay picks per its theme), or a legacy nativeImage (→ data URL).
    if (typeof it.icon === 'string') entry.icon = it.icon
    else if (it.icon && (it.icon.light || it.icon.dark)) entry.icon = { light: it.icon.light, dark: it.icon.dark }
    else if (it.icon && typeof it.icon.toDataURL === 'function') {
      try { const d = it.icon.toDataURL(); if (d && !d.endsWith('base64,')) entry.icon = d } catch {}
    }
    if (Array.isArray(it.submenu)) entry.submenu = serializePluginMenu(it.submenu, actions, seq)
    else if (typeof it.click === 'function') actions[id] = it.click
    out.push(entry)
  }
  return out
}

// Builds the FULL menu's items (Ctrl+right-click) and records this window's action map. Cut/copy/
// paste act on the app's webContents; a link under the cursor adds Open-with/Open-in-browser; an
// image adds Save-image-as; plugin entries come last.
ipcMain.handle('voltage:menu-items', (event, { linkURL, imageURL } = {}) => {
  const ctx = appMenuRegistry.get(event.sender.id)
  if (!ctx) return { items: [] }
  const i18n = t()
  const ctrl = i18n.keyCtrl || 'Ctrl'
  const wc = ctx.appContents
  const actions = (ctx.actions = {})
  const items = [
    { id: 'cut',   label: i18n.cut,   shortcut: ctrl + '+X' },
    { id: 'copy',  label: i18n.copy,  shortcut: ctrl + '+C' },
    { id: 'paste', label: i18n.paste, shortcut: ctrl + '+V' },
  ]
  actions.cut = () => wc.cut(); actions.copy = () => wc.copy(); actions.paste = () => wc.paste()

  if (linkURL) {
    const linkItems = []
    const r = resolveRoute(linkURL, ctx.profile)
    if (r) {
      const icon = iconToDataUrl(r.icon)
      linkItems.push({ id: 'open-with', label: (i18n.openWithApp || 'Open with {name}').replace(/\{name\}/g, r.name), ...(icon && { icon }) })
      actions['open-with'] = () => spawn(r.appImagePath, ['--no-sandbox', unwrapUrl(linkURL)], { detached: true, stdio: 'ignore' }).unref()
    }
    const bIcon = iconToDataUrl(getDefaultBrowserIconPath())
    linkItems.push({ id: 'open-in-browser', label: i18n.openInBrowser, ...(bIcon && { icon: bIcon }) })
    actions['open-in-browser'] = () => shell.openExternal(unwrapUrl(linkURL))
    items.push({ type: 'separator' }, ...linkItems)
  }

  if (imageURL) {
    items.push({ type: 'separator' }, { id: 'save-image', label: i18n.saveAs })
    // Save the image: pick a path, intercept the download to that path, then trigger it. Mirrors the
    // old native "Save Image As" — needs the app's customSession to catch the will-download.
    actions['save-image'] = async () => {
      let name = 'image.jpg'
      try { const b = path.basename(new URL(imageURL).pathname); if (b) name = path.extname(b) ? b : b + '.jpg' } catch {}
      const { canceled, filePath } = await dialog.showSaveDialog(ctx.mainWindow, { defaultPath: name })
      if (canceled || !filePath) return
      ctx.customSession.prependOnceListener('will-download', (_e, item) => item.setSavePath(filePath))
      wc.downloadURL(imageURL)
    }
  }

  // Core entries (built here, not in a plugin), positioned among the plugin items via `order`:
  //   Fullscreen (F11) sits between the zoom plugin's "Zoom" (10) and "About" (990).
  //   "About {name}" (F12) sits just above the widget's "Quit" (1000).
  const fullscreenItem = {
    label: i18n.fullscreen,
    order: 500,
    shortcut: 'F11',
    ...(FULLSCREEN_ICON && { icon: FULLSCREEN_ICON }),
    click: () => ctx.mainWindow.setFullScreen(!ctx.mainWindow.isFullScreen()),
  }
  const aboutItem = {
    label: (i18n.aboutApp || 'About {name}').replace(/\{name\}/g, ctx.displayName),
    order: 990,
    shortcut: 'F12',
    ...(ctx.appIcon && { icon: ctx.appIcon }),
    click: () => toggleAboutWindow(ctx.mainWindow),
  }
  const pluginList = [
    ...(ctx.mainWindow._voltagePlugins ?? [])
      .flatMap(inst => { try { return inst.contextMenuItems?.() ?? [] } catch { return [] } }),
    fullscreenItem,
    aboutItem,
  ].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const pluginTree = serializePluginMenu(pluginList, actions)
  if (pluginTree.length) items.push({ type: 'separator' }, ...pluginTree)

  return { items }
})

ipcMain.on('voltage:menu-action', (event, { id } = {}) => {
  const ctx = appMenuRegistry.get(event.sender.id)
  try { ctx?.actions?.[id]?.() } catch {}
})

// Loads and attaches the main-process plugins declared in pkg.plugins (paths relative to
// webapps/, e.g. "plugins/onedrive/onedrive.js"). Plugin selection per app is configured in
// the Manager. The code convention: a plugin module exports attachPlugin(win, api) — that
// export is what marks a file as a main-process plugin. The api gives plugins what they need
// without reaching into window.js internals:
//   profile, appOrigin, internalDomains  — window identity / same-origin classification
//   launchArg                            — the raw CLI argument the app opened with (or null)
//   routeUrl(url) → bool                 — route a URL to another built app (true on a hit)
//   claimsUrl(url) → bool                — whether THIS app owns the URL (self, which routeUrl skips)
//   openExternal(url)                    — hand a URL to the system browser
//   mailto                               — { parseMailtoFields, typeMailtoFields } compose helpers
//   config                               — this plugin's per-app settings (pkg.pluginConfig[rel])
// config is per-plugin so it's added to a shallow copy of api inside the loop, not the shared api.
// attachPlugin may return a handler object; a returned onLaunch(arg) is re-invoked when a
// second instance forwards a new launch argument to this already-running window.
function loadPlugins(mainWindow, pkg, { appOrigin, internalDomains, launchArg, appContents }) {
  const api = {
    profile:         pkg.profile,
    // Human-readable app name (build-time displayName, else profile) — for plugin-built UI.
    displayName:     pkg.displayName || pkg.profile,
    appOrigin,
    internalDomains,
    launchArg:       launchArg ?? null,
    // The app's webContents — equals mainWindow.webContents normally, but the inset view's in view
    // mode. Plugins that inject CSS/JS into the app MUST use this, not mainWindow.webContents.
    webContents:     appContents ?? mainWindow.webContents,
    routeUrl:        (url) => routeExternalUrl(url, pkg.profile),
    claimsUrl:       (url) => appClaimsUrl(url, pkg.profile),
    openExternal:    (url) => shell.openExternal(url),
    quit:            () => mainWindow.close(),
    t:               require('./i18n').t,
    mailto:          require('./mailto'),
  }
  const instances = []
  for (const rel of pkg.plugins ?? []) {
    try {
      const mod = require(path.join(__dirname, '..', 'webapps', rel))
      // attachPlugin is optional: a plugin may only contribute windowOptions() (applied
      // earlier in collectPluginWindowOptions), e.g. the widget plugin. Only flag a module
      // that exports neither hook.
      if (typeof mod.attachPlugin !== 'function') {
        if (typeof mod.windowOptions !== 'function')
          console.error(`[plugin] ${rel} exports neither attachPlugin() nor windowOptions() — skipped`)
        continue
      }
      const config = pkg.pluginConfig?.[rel] || {}
      instances.push(mod.attachPlugin(mainWindow, { ...api, config }) || {})
    } catch (err) {
      console.error(`[plugin] failed to load ${rel}:`, err)
    }
  }
  return instances
}

// Collects BrowserWindow constructor options contributed by plugins (e.g. the widget plugin's
// frame:false). A plugin may export windowOptions(pkg) → object; these must be applied BEFORE
// the window is created, unlike attachPlugin() which runs afterwards. webPreferences is owned
// by createWindow and is intentionally not overridable here.
function collectPluginWindowOptions(pkg) {
  let merged = {}
  for (const rel of pkg.plugins ?? []) {
    try {
      const mod = require(path.join(__dirname, '..', 'webapps', rel))
      if (typeof mod.windowOptions === 'function') {
        const opts = mod.windowOptions(pkg) || {}
        delete opts.webPreferences  // createWindow keeps full control of webPreferences
        merged = { ...merged, ...opts }
      }
    } catch (err) {
      console.error(`[plugin] windowOptions failed for ${rel}:`, err)
    }
  }
  return merged
}

// True when the app loads the widget plugin (frameless window). A few behaviours key off this,
// e.g. opening DevTools detached since a frameless window has no room for a docked panel.
function usesWidgetPlugin(pkg) {
  return (pkg.plugins ?? []).some(p => /(^|\/)widget\//.test(p))
}

// True when the app loads the zoom plugin, which owns the per-app Ctrl+wheel zoom. Apps without it
// have no way to change zoom, so window.js resets their (Electron-persisted) zoom to 100% on load —
// see the did-finish-load handler. Zoom-plugin apps are left alone so their zoom can stand.
function usesZoomPlugin(pkg) {
  return (pkg.plugins ?? []).some(p => /(^|\/)zoom\//.test(p))
}

// View mode: a plugin may render the app in an inset WebContentsView so the host window can draw
// a drop shadow + rounded corners AROUND it, leaving the app's page completely untouched (native
// scrolling/layout — no clip-path/transform hacks). A plugin opts in by exporting viewConfig(cfg)
// → { margin, radius } and hostHtml(cfg) → the host page's HTML (the shadow). Returns the resolved
// { margin, radius, hostHtml } of the first such plugin, or null (normal full-window app).
function collectPluginViewMode(pkg) {
  for (const rel of pkg.plugins ?? []) {
    try {
      const mod = require(path.join(__dirname, '..', 'webapps', rel))
      if (typeof mod.viewConfig === 'function' && typeof mod.hostHtml === 'function') {
        const config = pkg.pluginConfig?.[rel] || {}
        const vc = mod.viewConfig(config) || {}
        return { margin: vc.margin ?? 0, radius: vc.radius ?? 0, hostHtml: String(mod.hostHtml(config) ?? '') }
      }
    } catch (err) {
      console.error(`[plugin] viewConfig failed for ${rel}:`, err)
    }
  }
  return null
}

function createWindow(pkg, opts = {}) {
  const customSession = createSession(pkg.profile, { fileSystem: !!pkg.fileHandler })

  const saved = !pkg.geometry ? windowState.load() : null

  // The app's webPreferences — applied to the window's own webContents normally, or to the inset
  // WebContentsView in view mode (so the app keeps its preload/session/flags either way).
  const appWebPreferences = {
    preload: path.join(__dirname, '..', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    // Load the preload in EVERY frame, not just the top one. Apps like Word for the web run the
    // actual editing surface in a cross-origin iframe (the Office/WOPI editor frame); without this
    // our Ctrl+right-click listener never exists there, so the menu only worked on the top-frame
    // pages (e.g. the document picker). The preload stays sandboxed (no Node) — it only needs DOM +
    // ipcRenderer + contextBridge, which are available in sub-frames too.
    nodeIntegrationInSubFrames: true,
    session: customSession,
    ...(pkg.crossOriginIsolation && { enableBlinkFeatures: 'SharedArrayBuffer' }),
    ...(pkg.fileHandler && { additionalArguments: ['--voltage-file-handler'] }),
  }

  const viewMode = collectPluginViewMode(pkg)

  const mainWindow = new BrowserWindow({
    width:  pkg.geometry?.width  ?? saved?.width  ?? 1280,
    height: pkg.geometry?.height ?? saved?.height ?? 1024,
    x:      pkg.geometry?.x,
    y:      pkg.geometry?.y,
    // Plugin-contributed constructor options (e.g. frame:false from the widget plugin).
    // Spread before webPreferences so a plugin can't clobber it.
    ...collectPluginWindowOptions(pkg),
    // In view mode the window only hosts the shadow page (minimal webPreferences); the app runs in
    // the view with appWebPreferences. Otherwise the window IS the app.
    webPreferences: viewMode
      ? { preload: appWebPreferences.preload, contextIsolation: true, nodeIntegration: false, session: customSession }
      : appWebPreferences,
  })

  // appContents = where the app actually lives: the window's own webContents normally, or the
  // inset view's webContents in view mode. ALL app-facing wiring below targets appContents — which
  // is identical to mainWindow.webContents when not in view mode, so normal apps are unaffected.
  let appContents
  if (viewMode) {
    const appView = new WebContentsView({ webPreferences: appWebPreferences })
    mainWindow.contentView.addChildView(appView)
    appContents = appView.webContents
    // Transparent view background: without this the view paints an opaque (white) backdrop, so a
    // semi-transparent tint blends with THAT instead of the desktop. (On some Linux/Wayland setups
    // WebContentsView still composites opaquely — a known limitation.)
    appView.setBackgroundColor('#00000000')
    // Round the view's corners natively (Electron ≥30); guarded so an older runtime degrades to
    // square corners instead of throwing.
    if (typeof appView.setBorderRadius === 'function') appView.setBorderRadius(viewMode.radius)
    // Keep the view inset by the shadow gutter as the window resizes.
    const layoutView = () => {
      const { width, height } = mainWindow.getContentBounds()
      const m = viewMode.margin
      appView.setBounds({ x: m, y: m, width: Math.max(0, width - 2 * m), height: Math.max(0, height - 2 * m) })
    }
    layoutView()
    mainWindow.on('resize', layoutView)
    // The host page draws the shadow in the gutter behind the view.
    mainWindow.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(viewMode.hostHtml))
  } else {
    appContents = mainWindow.webContents
  }
  // Lets other modules (e.g. the About overlay) reach the app's webContents in view mode.
  mainWindow._voltageAppContents = appContents

  if (!pkg.geometry) mainWindow.on('close', () => windowState.save(mainWindow))

  // Register profile for safe-browsing:check exclusion lookups; clean up on close.
  // webContentsId is captured now — webContents is already destroyed when 'closed' fires.
  const webContentsId = appContents.id
  windowProfiles.set(webContentsId, pkg.profile)
  mainWindow.on('closed', () => windowProfiles.delete(webContentsId))

  // Context for the custom context-menu's shared ipcMain handlers (see appMenuRegistry).
  const displayName = pkg.displayName || pkg.profile
  appMenuRegistry.set(webContentsId, {
    appContents, mainWindow, profile: pkg.profile, customSession, actions: {},
    displayName, appIcon: appIconDataUrl(pkg),
  })
  mainWindow.on('closed', () => appMenuRegistry.delete(webContentsId))

  if (pkg.userAgent) appContents.setUserAgent(pkg.userAgent)
  appContents.loadURL(pkg.url)

  const appOrigin = new URL(pkg.url).origin
  const internalDomains = pkg.internalDomains ?
    (Array.isArray(pkg.internalDomains) ? pkg.internalDomains : [pkg.internalDomains]) :
    []

  appContents.setWindowOpenHandler(({ url }) => {
    try {
      const targetUrl = new URL(url)
      // Allow same-origin URLs (OAuth redirects, etc.)
      if (targetUrl.origin === appOrigin) {
        return { action: 'allow' }
      }
      // Allow whitelisted internal domains (e.g., accounts.google.com)
      if (internalDomains.some(domain =>
        targetUrl.hostname === domain || targetUrl.hostname.endsWith('.' + domain)
      )) {
        return { action: 'allow' }
      }
      // External URLs: route to another voltage app or open in system browser
      if (!routeExternalUrl(url, pkg.profile)) shell.openExternal(url)
      return { action: 'deny' }
    } catch (err) {
      return { action: 'deny' }
    }
  })

  customSession.on('will-download', (_event, item) => {
    if (item.getSavePath()) return  // already handled by context-menu Save As

    // Electron requires a synchronous save path — use a temp file and move it
    // to the user-chosen location afterwards.
    const filename = item.getFilename()
    const tmpPath  = path.join(app.getPath('temp'), `voltage-${Date.now()}-${filename}`)
    item.setSavePath(tmpPath)

    // Register the done listener BEFORE opening the dialog to avoid a race
    // condition where small files finish downloading while the dialog is still open.
    // Both the dialog result and the download completion write to shared state;
    // whichever arrives last triggers the actual file move.
    let chosenPath  = null  // set by dialog once user confirms
    let doneState   = null  // set by download once it finishes

    const tryMove = () => {
      if (doneState !== 'completed' || chosenPath === null) return
      try {
        fs.renameSync(tmpPath, chosenPath)
      } catch {
        try { fs.copyFileSync(tmpPath, chosenPath); fs.rmSync(tmpPath) } catch {}
      }
    }

    item.once('done', (_e, state) => {
      doneState = state
      tryMove()
    })

    const defaultPath = path.join(app.getPath('downloads'), filename)
    dialog.showSaveDialog(mainWindow, { defaultPath }).then(({ canceled, filePath }) => {
      if (!canceled && filePath) {
        chosenPath = filePath
        tryMove()
      } else {
        item.cancel()
        try { fs.rmSync(tmpPath, { force: true }) } catch {}
      }
    })
  })

  if (pkg.fileHandler) {
    // draw.io detects window.electron and switches to a custom IPC protocol
    // (rendererReq/mainResp) instead of the browser File System Access API.
    // We mirror the draw.io-desktop protocol so Save/Save As work natively.
    const onRendererReq = async (event, args) => {
      if (event.sender !== appContents) return
      try {
        let ret = null
        switch (args.action) {
          case 'showSaveDialog': {
            const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
              defaultPath: args.defaultPath,
              filters:     args.filters || [],
            })
            ret = canceled ? null : { path: filePath }
            break
          }
          case 'saveFile':
            fs.writeFileSync(args.fileObject.path, args.data, 'utf8')
            ret = fs.statSync(args.fileObject.path)
            break
          case 'loadFile':
            ret = fs.readFileSync(args.fileObject.path, 'utf8')
            break
        }
        event.reply('mainResp', { success: true, data: ret, reqId: args.reqId })
      } catch (e) {
        event.reply('mainResp', { error: true, msg: e.message, reqId: args.reqId })
      }
    }
    ipcMain.on('rendererReq', onRendererReq)
    mainWindow.on('closed', () => ipcMain.removeListener('rendererReq', onRendererReq))
  }

  // Plain right-click → the SLIM menu, rendered with the SAME custom overlay as Ctrl+right-click
  // (no native menu anywhere). Content: spelling suggestions + cut/copy/paste. The native
  // `context-menu` event is used only as the DATA source (it's the only place the misspelled word +
  // edit flags are exposed); we build the items here and push them to the originating frame to
  // render. Apps that handle contextmenu themselves (suppress the event) still show their own menu.
  appContents.on('context-menu', (event, params) => {
    const ctx = appMenuRegistry.get(webContentsId)
    if (!ctx) return
    const i18n = t()
    const actions = (ctx.actions = {})
    const items = []

    if (params.misspelledWord) {
      const sugg = (params.dictionarySuggestions && params.dictionarySuggestions.length)
        ? params.dictionarySuggestions.slice(0, 6)
        : aspellSuggestions(params.misspelledWord)
      if (sugg.length) {
        sugg.forEach((s, i) => {
          const id = 'spell:' + i
          items.push({ id, label: s })
          actions[id] = () => appContents.replaceMisspelling(s)
        })
      } else {
        items.push({ id: 'nospell', label: i18n.noSuggestions, enabled: false })
      }
      items.push({ type: 'separator' })
    }

    const ef = params.editFlags || {}
    const ctrl = i18n.keyCtrl || 'Ctrl'
    items.push({ id: 'cut',   label: i18n.cut,   shortcut: ctrl + '+X', enabled: !!ef.canCut })
    items.push({ id: 'copy',  label: i18n.copy,  shortcut: ctrl + '+C', enabled: !!ef.canCopy })
    items.push({ id: 'paste', label: i18n.paste, shortcut: ctrl + '+V', enabled: !!ef.canPaste })
    actions.cut = () => appContents.cut(); actions.copy = () => appContents.copy(); actions.paste = () => appContents.paste()

    // Render in the frame the click came from (params.x/y are that frame's coordinates), falling
    // back to the top frame. The preload's voltage:menu-show handler pops the overlay.
    try { (event.senderFrame || appContents).send('voltage:menu-show', { items, x: params.x, y: params.y }) }
    catch { try { appContents.send('voltage:menu-show', { items, x: params.x, y: params.y }) } catch {} }
  })

  // F12 toggles the About panel; Shift+F12 toggles DevTools; F11 toggles fullscreen. before-input-event
  // fires ahead of the page, and preventDefault() swallows the key so the web app never sees it.
  appContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault()
      if (input.shift) {
        const wc = appContents
        // Widget apps are frameless and have no room for a docked DevTools panel, so they open
        // it in a detached window. Every other app keeps the default docked toggle.
        if (usesWidgetPlugin(pkg)) {
          if (wc.isDevToolsOpened()) wc.closeDevTools()
          else                       wc.openDevTools({ mode: 'detach' })
        } else {
          wc.toggleDevTools()
        }
      } else {
        toggleAboutWindow(mainWindow)
      }
    } else if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault()
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
    }
  })

  const toDataUrl = p => { try { return p ? `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` : null } catch { return null } }
  const browserIconDataUrl = toDataUrl(getDefaultBrowserIconPath())
  const mailIconDataUrl    = toDataUrl(getDefaultMailIconPath())

  // Pre-compute route entries with icons so the tooltip can show the target app's icon.
  // Sorted longest-prefix-first so path-specific entries win over hostname-only entries.
  const routingTable = normalizeRouting(loadRouting())
  const buildRouteEntry = ([key, target]) => {
    const appImagePath   = typeof target === 'string' ? target : target.path
    const name           = typeof target === 'string' ? null   : (target.name ?? null)
    const iconName       = typeof target === 'string' ? null   : (target.icon ?? null)
    const matchedProfile = profileFromAppName(path.basename(appImagePath))
    if (matchedProfile === pkg.profile || !fs.existsSync(appImagePath)) return null
    // Fall back to the installed per-app icon (appName(<profile>), e.g. vTeams) when the
    // build-config icon name doesn't resolve — installed AppImages always register their icon
    // under this name.
    const iconDataUrl = toDataUrl(resolveIconPath(iconName) ?? resolveIconPath(appName(matchedProfile)))
    // The raw routing key is passed through; the tooltip script matches it with a
    // keyMatches() port (page-injected JS cannot require routing-match.js).
    return { key, iconDataUrl, name: name || matchedProfile }
  }
  const byKeyLen = (a, b) => b[0].length - a[0].length
  // Routing entries come first so the tooltip's first-match find() mirrors findRoute's
  // routing-wins-over-base priority; within each kind the longest key wins.
  const routeEntries = [
    ...Object.entries(routingTable.routing).sort(byKeyLen),
    ...Object.entries(routingTable.base).sort(byKeyLen),
  ].map(buildRouteEntry).filter(Boolean)

  // Builds the tooltip injection script for the main frame.
  // The tooltip DOM always lives in the main frame so position:fixed anchors to the main window bottom —
  // even when the hovered link is inside a same-origin iframe.
  function buildTooltipScript() {
    // Mirrors i18n.js keys mailtoCompose (de/en) — window.js cannot import the ES module.
    const mailtoLabel = app.getPreferredSystemLanguages()[0]?.startsWith('de')
      ? 'Mail an {addr} verfassen'
      : 'Compose mail to {addr}'
    const vars = [
      `const browserIconUrl  = ${JSON.stringify(browserIconDataUrl)};`,
      `const mailIconUrl     = ${JSON.stringify(mailIconDataUrl)};`,
      `const safeSrc         = ${JSON.stringify(safeIconDataUrl)};`,
      `const unsafeSrc       = ${JSON.stringify(unsafeIconDataUrl)};`,
      `const appOrigin       = ${JSON.stringify(appOrigin)};`,
      `const internalDomains = ${JSON.stringify(internalDomains)};`,
      `const routeEntries    = ${JSON.stringify(routeEntries)};`,
      `const mailtoLabel     = ${JSON.stringify(mailtoLabel)};`,
    ].join('\n')
    return `(() => {\n${vars}\n${tooltipScript}\n})()`
  }

  // Apps not managed by the zoom plugin can't change zoom, but Electron persists the zoom factor per
  // origin — so an app zoomed earlier (or before zoom became a plugin) would reopen zoomed with no
  // way back. Reset those to 100% on load. The zoom plugin, when present, owns the zoom instead.
  const zoomManaged = usesZoomPlugin(pkg)

  // A frameless widget must not be closeable by the page itself: apps like Teams call window.close()
  // from their own bootstrap right after loading, which would kill the widget. Neutralise the page's
  // window.close() (a no-op) rather than blocking the BrowserWindow's close — so GNOME/WM close and
  // our context-menu Quit (both go through the window, not window.close) keep working normally. Only
  // for widget apps; framed apps may legitimately self-close. Injected early (dom-ready) + on every
  // load so it's in place before the app's close call.
  if (usesWidgetPlugin(pkg)) {
    const NEUTRALISE_CLOSE = '(function(){try{window.close=function(){};}catch(e){' +
      'try{Object.defineProperty(window,"close",{value:function(){},configurable:true});}catch(_){}}})();'
    appContents.on('dom-ready',       () => appContents.executeJavaScript(NEUTRALISE_CLOSE).catch(() => {}))
    appContents.on('did-finish-load', () => appContents.executeJavaScript(NEUTRALISE_CLOSE).catch(() => {}))
  }

  appContents.on('did-finish-load', () => {
    if (!zoomManaged) appContents.setZoomFactor(1)
    appContents.insertCSS(`
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.4); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.7); }
      ::-webkit-scrollbar-corner { background: transparent; }
      ${tooltipCss}
    `)
    appContents.executeJavaScript(`
      ${buildTooltipScript()}
    `)
  })

  // Main-process plugins selected for this app (config-driven, no longer hardcoded). Stored
  // on the window so app-window.js can forward a second-instance launch argument to them.
  mainWindow._voltagePlugins = loadPlugins(mainWindow, pkg, {
    appOrigin, internalDomains, launchArg: opts.launchArg, appContents,
  })

  return mainWindow
}

// Re-dispatches a new launch argument (from a second-instance activation) to a window's
// plugins, so e.g. the strato mail plugin can act on a fresh mailto: while already running.
function dispatchLaunchArg(win, arg) {
  for (const inst of win._voltagePlugins ?? []) {
    try { inst.onLaunch?.(arg) } catch (err) { console.error('[plugin] onLaunch failed:', err) }
  }
}

module.exports = { createWindow, dispatchLaunchArg }
