// "About" panel for an app window, toggled with F12 (Shift+F12 stays DevTools).
//
// Rendered in its OWN WebContentsView laid over the app window — NOT injected into the page.
// This is the whole point: the panel runs in a web context we control, so it is immune to the
// host page's CSP, Trusted Types, and SPA quirks. The previous approach (executeJavaScript into
// the page) broke per-app whenever a site shipped a stricter policy — exactly the fragility we
// want gone. The view holds our own HTML (rclone-dialog look) with a solid dark backdrop;
// page-level transparency is unreliable on Linux/Wayland, so the backdrop is opaque.

const { WebContentsView, ipcMain, app } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const os   = require('node:os')

const pkg      = require(app.getAppPath() + '/package.json')
const APP_ROOT = app.getAppPath()
const { appName } = require('./app-naming')

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

// Builds the complete About HTML document loaded into the overlay view. Because this runs in
// our own context (no foreign CSP), plain innerHTML/inline styles are safe here.
function buildAboutHtml(info) {
  const de = app.getLocale().split('-')[0].toLowerCase() === 'de'
  const displayName = pkg.displayName || pkg.profile
  const t = de
    ? { titlePrefix: 'Über ', subtitle: 'voltage-AppImage', domain: 'Aktuelle Domain', appName: 'App', plugins: 'Geladene Plugins',
        versions: 'Versionen', voltageHint: 'Stand der AppImage-Erstellung',
        electronHint: 'zugrundeliegendes Electron-Framework', chromiumHint: 'Render-Engine / Browser-Kern',
        builtWith: 'Erstellt mit voltage', electron: 'Electron', close: 'Schließen',
        sbSafe: 'Google Safe Browsing: keine Bedrohung bekannt', sbUnsafe: 'Google Safe Browsing: als gefährlich gemeldet' }
    : { titlePrefix: 'About ', subtitle: 'voltage AppImage', domain: 'Current domain', appName: 'App', plugins: 'Loaded plugins',
        versions: 'Versions', voltageHint: 'when this AppImage was built',
        electronHint: 'underlying Electron framework', chromiumHint: 'render engine / browser core',
        builtWith: 'Built with voltage', electron: 'Electron', close: 'Close',
        sbSafe: 'Google Safe Browsing: no known threat', sbUnsafe: 'Google Safe Browsing: flagged as dangerous' }

  const appIcon = appIconDataUrl()
  const plugins = (pkg.plugins ?? []).map(pluginDisplay)

  const headerIcon = appIcon ? `<img src="${appIcon}" alt="">` : ''

  const pluginsField = plugins.length ? `
    <div class="wa-field"><div class="wa-label">${esc(t.plugins)}</div>
      <ul class="wa-plugins">${plugins.map(p =>
        `<li>${p.icon ? `<img src="${p.icon}" alt="">` : ''}<span>${esc(p.label)}</span></li>`).join('')}</ul>
    </div>` : ''

  const ver = (name, hint) =>
    `<div class="wa-ver"><span class="wa-ver-name">${esc(name)}</span><span class="wa-ver-hint">${esc(hint)}</span></div>`

  return `<!doctype html><html lang="${de ? 'de' : 'en'}"><head><meta charset="utf-8"><style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--wa-card-bg:#fff;--wa-card-fg:#1e1e1e;--wa-label:#888;--wa-div:#e4e4e4}
    @media (prefers-color-scheme: dark){
      :root{--wa-card-bg:#2c2c2c;--wa-card-fg:#f0f0f0;--wa-label:#aaa;--wa-div:#444}
    }
    /* Transparent html/body + a semi-transparent backdrop so the app shows through, dimmed.
       The view itself is set transparent in main; if the compositor ignores that, this still
       degrades to a darker (but not fully opaque) overlay. */
    html,body{height:100%;background:transparent}
    body{display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);
      font-family:'Ubuntu',system-ui,sans-serif;color-scheme:light dark}
    .wa-card{background:var(--wa-card-bg);color:var(--wa-card-fg);border-radius:12px;width:440px;
      max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.5);overflow:hidden}
    .wa-header{background:linear-gradient(135deg,#5ab4f0 0%,#1a7bc4 100%);
      padding:12px 20px;display:flex;align-items:center;gap:12px}
    .wa-icon-wrap{width:32px;height:32px;flex-shrink:0}
    .wa-icon-wrap>img{width:32px;height:32px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.25))}
    .wa-htitles{display:flex;flex-direction:column;line-height:1.2}
    .wa-htitle{color:#fff;font-size:15px;font-weight:600}
    .wa-hsub{color:rgba(255,255,255,0.8);font-size:11px}
    .wa-body{padding:18px 24px 20px;display:flex;flex-direction:column;gap:14px}
    .wa-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--wa-label)}
    .wa-val{font-size:13px;margin-top:2px;word-break:break-all;padding-left:10px}
    .wa-domain{display:flex;align-items:center;gap:6px}
    .wa-domain img{width:15px;height:15px;flex-shrink:0}
    .wa-vers{display:flex;flex-direction:column;gap:6px;margin-top:3px;padding-left:10px}
    .wa-ver{display:flex;flex-direction:column;line-height:1.25}
    .wa-ver-name{font-size:13px}
    .wa-ver-hint{font-size:11px;color:var(--wa-label)}
    .wa-plugins{list-style:none;margin:4px 0 0;padding:0 0 0 10px;display:flex;flex-direction:column;gap:5px}
    .wa-plugins li{display:flex;align-items:center;gap:8px;font-size:13px}
    .wa-plugins img{width:18px;height:18px;flex-shrink:0;object-fit:contain}
    .wa-branding{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:4px;
      padding-top:12px;border-top:1px solid var(--wa-div)}
    .wa-branding a{display:flex;align-items:center;gap:6px;font-size:12px;color:#3584e4;
      text-decoration:none;cursor:pointer}
    .wa-branding a:hover span{text-decoration:underline}
    .wa-branding img{width:20px;height:20px;flex-shrink:0}
    .wa-actions{display:flex;justify-content:flex-end;margin-top:2px}
    .wa-actions button{padding:7px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;
      font-weight:500;font-family:inherit;background:#1a73e8;color:#fff;transition:opacity .15s}
    .wa-actions button:hover{opacity:.85}
  </style></head><body>
    <div class="wa-card">
      <div class="wa-header"><div class="wa-icon-wrap">${headerIcon}</div>
        <div class="wa-htitles">
          <span class="wa-htitle">${esc(t.titlePrefix + displayName)}</span>
          <span class="wa-hsub">${esc(t.subtitle)}</span>
        </div></div>
      <div class="wa-body">
        <div class="wa-field"><div class="wa-label">${esc(t.domain)}</div>
          <div class="wa-val wa-domain"><img id="wa-sb" alt="" hidden><span>${esc(info.domain)}</span></div></div>
        <div class="wa-field"><div class="wa-label">${esc(t.appName)}</div><div class="wa-val">${esc(pkg.name || pkg.profile)}</div></div>
        <div class="wa-field"><div class="wa-label">${esc(t.versions)}</div>
          <div class="wa-vers">
            ${ver('voltage ' + pkg.version, t.voltageHint)}
            ${ver('Electron ' + process.versions.electron, t.electronHint)}
            ${ver('Chromium ' + process.versions.chrome, t.chromiumHint)}
          </div></div>
        ${pluginsField}
        <div class="wa-branding">
          <a href="https://github.com/db0x/wrapweb" target="_blank" rel="noreferrer">
            ${githubIcon ? `<img src="${githubIcon}" alt="">` : ''}<span>${esc(t.builtWith)}</span></a>
          <a href="https://www.electronjs.org/" target="_blank" rel="noreferrer"><span>${esc(t.electron)}</span></a>
        </div>
        <div class="wa-actions"><button id="wa-close">${esc(t.close)}</button></div>
      </div>
    </div>
    <script>
      const close = () => window.aboutAPI.close();
      document.getElementById('wa-close').addEventListener('click', close);
      // Backdrop click (outside the card) closes.
      document.body.addEventListener('click', e => { if (e.target === document.body) close(); });
      // F12 (toggle) and Esc close from within the overlay; the main process also intercepts
      // F12 globally, but the focused overlay needs its own handler to react.
      document.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'F12') { e.preventDefault(); close(); } });
      // External links: hand off to the system browser via the host's default handling.
      for (const a of document.querySelectorAll('a[target="_blank"]')) {
        a.addEventListener('click', e => { e.preventDefault(); window.open(a.href, '_blank'); });
      }
      // Safe Browsing badge — async; only shown for a definite verdict.
      const sb = document.getElementById('wa-sb');
      const D = ${JSON.stringify({ fullUrl: info.fullUrl, safeIcon, unsafeIcon, sbSafe: t.sbSafe, sbUnsafe: t.sbUnsafe })};
      if (window.aboutAPI && window.aboutAPI.checkSafeBrowsing) {
        window.aboutAPI.checkSafeBrowsing(D.fullUrl).then(r => {
          if (r === 'safe'   && D.safeIcon)   { sb.src = D.safeIcon;   sb.title = D.sbSafe;   sb.hidden = false; }
          if (r === 'unsafe' && D.unsafeIcon) { sb.src = D.unsafeIcon; sb.title = D.sbUnsafe; sb.hidden = false; }
        }).catch(() => {});
      }
    </script>
  </body></html>`
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

  // Fill the whole content area, on top of the page.
  const { width, height } = win.getContentBounds()
  view.setBounds({ x: 0, y: 0, width, height })
  win.contentView.addChildView(view)

  // Keep the overlay matched to the window size while it's open.
  const onResize = () => {
    if (!win._voltageAboutView) return
    const b = win.getContentBounds()
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
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
