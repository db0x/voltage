const { BrowserWindow, shell, ipcMain, dialog, app } = require('electron')
const path   = require('node:path')
const fs     = require('node:fs')
const crypto = require('node:crypto')
const https  = require('node:https')
const { spawn, spawnSync } = require('node:child_process')
const { createSession } = require('./session')
const { showContextMenu } = require('./context-menu')
const windowState = require('./window-state')

const ROUTING_FILE = path.join(app.getPath('appData'), 'wrapweb', 'plugins', 'routing', 'routing.json')

// In-memory cache: origin → { result: 'safe'|'unsafe', expiresAt }
// Avoids repeated API calls for the same domain during a browsing session.
const safeBrowsingCache = new Map()

function safeBrowsingConfigPath() {
  const testDir = process.env.WRAPWEB_TEST_DATA_DIR
  return testDir
    ? path.join(testDir, 'safe-browsing.json')
    : path.join(app.getPath('appData'), 'wrapweb', 'safe-browsing.json')
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

ipcMain.handle('safe-browsing:check', async (_, url) => {
  let origin
  try { origin = new URL(url).origin } catch { return 'unknown' }

  const cached = safeBrowsingCache.get(origin)
  if (cached && Date.now() < cached.expiresAt) return cached.result

  const config = (() => {
    try { return JSON.parse(fs.readFileSync(safeBrowsingConfigPath(), 'utf8')) } catch { return {} }
  })()
  if (!config.apiKey || !config.enabled) return 'unknown'

  // Only the origin is hashed — path and query never leave the device.
  const fullHash  = crypto.createHash('sha256').update(origin).digest()
  const prefixB64 = fullHash.slice(0, 4).toString('base64')

  const body = JSON.stringify({
    client:     { clientId: 'wrapweb', clientVersion: '1.0' },
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

// Lazily resolved once per process — xdg-mime is a subprocess call and the
// result never changes while the app is running.
let _browserIconPath
function getDefaultBrowserIconPath() {
  if (_browserIconPath !== undefined) return _browserIconPath
  try {
    // xdg-mime returns the .desktop filename, not a path.
    const r = spawnSync('xdg-mime', ['query', 'default', 'x-scheme-handler/https'],
      { encoding: 'utf8', timeout: 500 })
    if (!r.stdout) return (_browserIconPath = null)
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

    // nativeImage.createFromPath() on Linux silently fails on SVG files —
    // only PNG is reliable for context menu icons.
    const iconBases = [
      path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor'),
      '/usr/share/icons/hicolor',
    ]
    for (const base of iconBases) {
      for (const size of ['48x48', '32x32', '64x64', '256x256', '128x128']) {
        const p = path.join(base, size, 'apps', `${iconName}.png`)
        if (fs.existsSync(p)) return (_browserIconPath = p)
      }
    }
    const pixmap = `/usr/share/pixmaps/${iconName}.png`
    if (fs.existsSync(pixmap)) return (_browserIconPath = pixmap)
  } catch {}
  return (_browserIconPath = null)
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
  try { ({ hostname: targetHost, pathname: targetPath } = new URL(resolved)) } catch { return null }
  const routing = loadRouting()
  // Sort longer keys first so path-specific entries (e.g. docs.google.com/spreadsheets)
  // take priority over hostname-only entries (e.g. docs.google.com).
  const entry = Object.entries(routing)
    .sort((a, b) => b[0].length - a[0].length)
    .find(([key]) => {
      const slash = key.indexOf('/')
      if (slash !== -1) {
        const keyHost = key.slice(0, slash)
        const keyPath = '/' + key.slice(slash + 1)
        return (targetHost === keyHost || targetHost.endsWith('.' + keyHost)) &&
               targetPath.startsWith(keyPath)
      }
      return targetHost === key || targetHost.endsWith('.' + key)
    })
  if (!entry) return null
  const [, target] = entry
  const appImagePath = typeof target === 'string' ? target : target.path
  const name         = typeof target === 'string' ? null  : target.name
  const icon         = typeof target === 'string' ? null  : (target.icon ?? null)
  const matchedProfile = path.basename(appImagePath).replace(/^wrapweb-/, '')
  if (matchedProfile === currentProfile || !fs.existsSync(appImagePath)) return null
  return { appImagePath, name, icon }
}

function routeExternalUrl(url, currentProfile) {
  const route = resolveRoute(url, currentProfile)
  if (!route) return false
  spawn(route.appImagePath, ['--no-sandbox', url], { detached: true, stdio: 'ignore' }).unref()
  return true
}

function createWindow(pkg) {
  const customSession = createSession(pkg.profile, { fileSystem: !!pkg.fileHandler })

  const saved = !pkg.geometry ? windowState.load() : null

  const mainWindow = new BrowserWindow({
    width:  pkg.geometry?.width  ?? saved?.width  ?? 1280,
    height: pkg.geometry?.height ?? saved?.height ?? 1024,
    x:      pkg.geometry?.x,
    y:      pkg.geometry?.y,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      session: customSession,
      ...(pkg.crossOriginIsolation && { enableBlinkFeatures: 'SharedArrayBuffer' }),
      ...(pkg.fileHandler && { additionalArguments: ['--wrapweb-file-handler'] }),
    },
  })

  if (!pkg.geometry) mainWindow.on('close', () => windowState.save(mainWindow))

  if (pkg.userAgent) mainWindow.webContents.setUserAgent(pkg.userAgent)
  mainWindow.loadURL(pkg.url)

  ipcMain.on('adjust-zoom', (event, delta) => {
    const wc = event.sender
    const current = wc.getZoomFactor()
    wc.setZoomFactor(delta > 0
      ? Math.min(current + 0.1, 3.0)
      : Math.max(current - 0.1, 0.5)
    )
  })

  const appOrigin = new URL(pkg.url).origin
  const internalDomains = pkg.internalDomains ?
    (Array.isArray(pkg.internalDomains) ? pkg.internalDomains : [pkg.internalDomains]) :
    []

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
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
      // External URLs: route to another wrapweb app or open in system browser
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
    const tmpPath  = path.join(app.getPath('temp'), `wrapweb-${Date.now()}-${filename}`)
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
      if (event.sender !== mainWindow.webContents) return
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

  mainWindow.webContents.on('context-menu', (_event, params) => {
    showContextMenu(mainWindow, customSession, params, {
      resolveRoute: (url) => { const r = resolveRoute(url, pkg.profile); return r ? { ...r, url: unwrapUrl(url) } : null },
      openInBrowser: (url) => shell.openExternal(url),
      browserIconPath: getDefaultBrowserIconPath(),
    })
  })

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12')
      mainWindow.webContents.toggleDevTools()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    const browserIconPath = getDefaultBrowserIconPath()
    const browserIconDataUrl = (() => {
      if (!browserIconPath) return null
      try {
        const b64 = fs.readFileSync(browserIconPath).toString('base64')
        return `data:image/png;base64,${b64}`
      } catch { return null }
    })()

    mainWindow.webContents.insertCSS(`
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.4); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.7); }
      ::-webkit-scrollbar-corner { background: transparent; }

      #wrapweb-link-tooltip {
        position: fixed;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        max-width: 60%;
        padding: 3px 10px 4px;
        font: 12px/1.5 -apple-system, system-ui, sans-serif;
        color: #fff;
        background: rgba(30, 30, 30, 0.85);
        border-top-left-radius: 5px;
        border-top-right-radius: 5px;
        pointer-events: none;
        display: none;
        backdrop-filter: blur(4px);
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      #wrapweb-link-tooltip img {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        object-fit: contain;
      }
      #wrapweb-link-shield {
        width: 16px;
        height: 16px;
        margin-right: 2px;
      }
      #wrapweb-link-tooltip span {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
    `)
    mainWindow.webContents.executeJavaScript(`
      window.addEventListener('wheel', (e) => {
        if (e.ctrlKey) window.electronAPI.adjustZoom(e.deltaY < 0 ? 1 : -1);
      }, { passive: true });

      (() => {
        const iconDataUrl    = ${JSON.stringify(browserIconDataUrl)};
        const safeSrc        = ${JSON.stringify(safeIconDataUrl)};
        const unsafeSrc      = ${JSON.stringify(unsafeIconDataUrl)};

        const tip = document.createElement('div');
        tip.id = 'wrapweb-link-tooltip';

        if (iconDataUrl) {
          const img = document.createElement('img');
          img.src = iconDataUrl;
          img.alt = '';
          tip.appendChild(img);
        }

        const shield = document.createElement('img');
        shield.id    = 'wrapweb-link-shield';
        shield.alt   = '';
        shield.style.display = 'none';
        tip.appendChild(shield);

        const label = document.createElement('span');
        tip.appendChild(label);

        document.body.appendChild(tip);

        // Sequence counter guards against stale async results: if the mouse moves
        // to a new link before the check finishes, the old result is discarded.
        let checkSeq = 0;

        document.addEventListener('mouseover', (e) => {
          const a = e.target.closest('a[href]');
          const url = a?.href ?? '';
          // Skip javascript: pseudo-links — they carry no real destination.
          if (url && !url.startsWith('javascript:')) {
            label.textContent = url;
            shield.style.display = 'none';
            tip.style.display = 'flex';
            const seq = ++checkSeq;
            window.electronAPI.checkSafeBrowsing(url).then(result => {
              if (seq !== checkSeq) return;
              if (result === 'safe' && safeSrc) {
                shield.src = safeSrc;
                shield.style.display = '';
              } else if (result === 'unsafe' && unsafeSrc) {
                shield.src = unsafeSrc;
                shield.style.display = '';
              }
            }).catch(() => {});
          } else {
            tip.style.display = 'none';
          }
        }, { passive: true });

        document.addEventListener('mouseout', (e) => {
          // Only hide when the cursor leaves the anchor entirely, not when
          // moving between child nodes inside the same link.
          if (!e.relatedTarget?.closest('a[href]')) {
            tip.style.display = 'none';
            ++checkSeq;
          }
        }, { passive: true });
      })();
    `)
  })

  return mainWindow
}

module.exports = { createWindow }
