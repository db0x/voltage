const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { spawnSync, spawn } = require('node:child_process')
const pkg = require(app.getAppPath() + '/package.json')
const { checkForUpdate } = require('./src/update-check')
const CONFIGS_DIR = path.join(__dirname, 'webapps')

Menu.setApplicationMenu(null)

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

// Skip GPU/Wayland switches in tests — Playwright runs without a display server
// and some switches crash the headless Chromium instance used by tests.
if (!process.env.WRAPWEB_TEST) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'wayland')
  app.commandLine.appendSwitch('use-gl',              'angle')
  app.commandLine.appendSwitch('disable-vulkan')
  app.commandLine.appendSwitch('disable-features',   'Vulkan,UseSkiaRenderer')
  app.commandLine.appendSwitch('enable-features',    'WebRTCPipeWireCapturer')
  app.commandLine.appendSwitch('enable-webrtc-pipewire-capturer')
}

const { profile } = pkg

if (profile) {
  app.setAppUserModelId(pkg.appId)
  app.setName(`wrapweb-${profile}`)
  app.commandLine.appendSwitch('wm-class', `wrapweb-${profile}`)
  app.setPath('userData', path.join(app.getPath('appData'), 'wrapweb', profile))

  // Parses a mailto: URI (e.g. "mailto:a@b.com?subject=Hi") into a plain object.
  // URL() handles the parsing; the recipient is in the URL pathname, not a query param.
  function parseMailtoFields(raw) {
    try {
      const m = new URL(raw)
      return {
        to:      decodeURIComponent(m.pathname || ''),
        subject: m.searchParams.get('subject') || '',
        body:    m.searchParams.get('body')    || '',
        cc:      m.searchParams.get('cc')      || '',
        bcc:     m.searchParams.get('bcc')     || '',
      }
    } catch { return null }
  }

  // draw.io SVG files embed the diagram XML as HTML-escaped content= attribute value.
  function extractXmlFromDrawioSvg(content) {
    const match = content.match(/\bcontent="([^"]*)"/)
    if (!match) return null
    return match[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  }

  // draw.io PNG files embed the diagram XML as a PNG tEXt or zTXt chunk with key "mxfile".
  // zTXt chunks add zlib compression (2-byte header before the deflate stream).
  function extractXmlFromDrawioPng(buf) {
    let off = 8
    while (off + 12 <= buf.length) {
      const len  = buf.readUInt32BE(off)
      const type = buf.slice(off + 4, off + 8).toString('ascii')
      const data = buf.slice(off + 8, off + 8 + len)
      if (type === 'tEXt') {
        const ni = data.indexOf(0)
        if (ni > 0 && data.slice(0, ni).toString('ascii') === 'mxfile')
          try { return decodeURIComponent(data.slice(ni + 1).toString('utf8')) } catch { return null }
      } else if (type === 'zTXt') {
        const ni = data.indexOf(0)
        if (ni > 0 && data.slice(0, ni).toString('ascii') === 'mxfile') {
          try { return decodeURIComponent(zlib.inflateSync(data.slice(ni + 2)).toString('utf8')) } catch { return null }
        }
      } else if (type === 'IEND') break
      off += 12 + len
    }
    return null
  }

  // Uploads a local file to the configured rclone Google Drive remote and returns
  // the Google Docs edit URL for the uploaded file. Resolves to null on any error
  // (missing config, rclone failure, no file ID returned).
  // The window is opened at the default URL first so the user isn't staring at a
  // blank screen during the upload; navigation happens once the ID is known.
  function fmtBytes(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB'
    return b + ' B'
  }

  // Reads the installed app icon and returns a base64 data URL for inline embedding.
  // Prefers SVG over PNG; returns null if neither exists.
  function appIconDataUrl() {
    const desktopName = `wrapweb-${pkg.profile}`
    const hicolor     = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')
    const svgPath     = path.join(hicolor, 'scalable', 'apps', `${desktopName}.svg`)
    const pngPath     = path.join(hicolor, '48x48',    'apps', `${desktopName}.png`)
    if (fs.existsSync(svgPath)) return `data:image/svg+xml;base64,${fs.readFileSync(svgPath).toString('base64')}`
    if (fs.existsSync(pngPath)) return `data:image/png;base64,${fs.readFileSync(pngPath).toString('base64')}`
    return null
  }

  // Builds a self-contained confirm page with a local-vs-Drive comparison table.
  // localStat is an fs.Stats object; existing is an rclone lsjson entry.
  function buildConfirmPage(filename, existing, localStat, de) {
    const title      = de ? 'Datei überschreiben?' : 'Overwrite file?'
    const btnOpen    = de ? 'Bestehende öffnen'    : 'Open existing'
    const btnOver    = de ? 'Überschreiben'        : 'Overwrite'
    const labelLocal = de ? 'Lokal'                : 'Local'
    const labelDrive = 'Google Drive'
    const labelMod   = de ? 'Geändert'             : 'Modified'
    const labelSize  = de ? 'Größe'                : 'Size'

    const localMod    = localStat.mtime.toLocaleString()
    const localSize   = fmtBytes(localStat.size)
    const remMod      = new Date(existing.ModTime).toLocaleString()
    const remSize     = fmtBytes(existing.Size)
    const appIconUrl  = appIconDataUrl()
    const wrapwebSvg  = path.join(__dirname, 'assets', 'wrapweb.svg')
    const wrapwebIcon = fs.existsSync(wrapwebSvg)
      ? `data:image/svg+xml;base64,${fs.readFileSync(wrapwebSvg).toString('base64')}`
      : null
    const rcloneSvg  = path.join(__dirname, 'assets', 'rclone.svg')
    const rcloneIcon = fs.existsSync(rcloneSvg)
      ? `data:image/svg+xml;base64,${fs.readFileSync(rcloneSvg).toString('base64')}`
      : null

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
      :root{
        --bg:#f0f0f0;--card-bg:white;--card-fg:#1e1e1e;
        --card-url:#888;--muted-bg:#e9e9e9;--muted-fg:#666;
        --shadow:rgba(0,0,0,0.25);--div:#d8d8d8;
      }
      body{display:flex;align-items:center;justify-content:center;
           height:100vh;background:var(--bg);
           font-family:'Ubuntu',sans-serif;color:var(--card-fg);color-scheme:light}
      .dialog{background:var(--card-bg);border-radius:12px;width:460px;max-width:90vw;
              box-shadow:0 8px 32px var(--shadow);
              display:flex;flex-direction:column;overflow:hidden}
      .dialog-header{
        background:linear-gradient(135deg,#5ab4f0 0%,#1a7bc4 100%);
        padding:8px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0}
      .header-icon-wrap{position:relative;width:32px;height:32px;flex-shrink:0}
      .header-icon-wrap>img{width:32px;height:32px;
                            filter:drop-shadow(0 1px 3px rgba(0,0,0,0.25))}
      .header-rclone-badge{position:absolute;bottom:-3px;right:-3px;
        width:16px;height:16px;border-radius:50%;
        background:rgba(255,255,255,0.9);
        box-shadow:0 1px 3px rgba(0,0,0,0.30);
        display:flex;align-items:center;justify-content:center}
      .header-rclone-badge img{width:10px;height:10px}
      .dialog-body{padding:20px 24px 18px;display:flex;flex-direction:column;gap:16px}
      .title{font-size:15px;font-weight:600}
      .file-row{display:flex;align-items:center;gap:7px;margin-bottom:8px}
      .file-icon{width:16px;height:16px;flex-shrink:0;object-fit:contain}
      .filename{font-size:13px;font-weight:600;word-break:break-all;color:var(--card-fg)}
      .compare{background:var(--muted-bg);border-radius:6px;padding:10px 12px;
               display:grid;grid-template-columns:auto 1fr 1fr;
               gap:5px 16px;align-items:center}
      .col-head{font-size:11px;font-weight:600;text-transform:uppercase;
                letter-spacing:.05em;color:var(--card-url);text-align:center;
                padding-bottom:3px;border-bottom:1px solid var(--div)}
      .col-head:first-child{border-bottom:none}
      .row-label{font-size:12px;color:var(--card-url)}
      .row-val{font-size:13px;color:var(--card-fg);text-align:center}
      .actions{display:flex;justify-content:flex-end;gap:8px}
      button{padding:7px 18px;border-radius:8px;border:none;cursor:pointer;
             font-size:13px;font-weight:500;font-family:'Ubuntu',sans-serif;
             transition:opacity .15s}
      button:hover{opacity:.85}
      .btn-sec{background:var(--muted-bg);color:var(--muted-fg)}
      .btn-pri{background:#1a73e8;color:#fff}
    </style></head><body>
    <div class="dialog">
      <div class="dialog-header">
        <div class="header-icon-wrap">
          ${wrapwebIcon ? `<img src="${wrapwebIcon}" alt="wrapweb">` : ''}
          ${rcloneIcon  ? `<span class="header-rclone-badge"><img src="${rcloneIcon}" alt=""></span>` : ''}
        </div>
      </div>
      <div class="dialog-body">
        <span class="title">${title}</span>
        <div>
          <div class="file-row">
            ${appIconUrl ? `<img class="file-icon" src="${appIconUrl}" alt="">` : ''}
            <span class="filename">${filename}</span>
          </div>
          <div class="compare">
            <span></span>
            <span class="col-head">${labelLocal}</span>
            <span class="col-head">${labelDrive}</span>

            <span class="row-label">${labelMod}</span>
            <span class="row-val">${localMod}</span>
            <span class="row-val">${remMod}</span>

            <span class="row-label">${labelSize}</span>
            <span class="row-val">${localSize}</span>
            <span class="row-val">${remSize}</span>
          </div>
        </div>
        <div class="actions">
          <button class="btn-sec" onclick="c(1)">${btnOpen}</button>
          <button class="btn-pri" onclick="c(0)">${btnOver}</button>
        </div>
      </div>
    </div>
    <script>function c(v){window.electronAPI.rcloneConfirm(v)}<\/script>
    </body></html>`
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  }

  // Computes the MD5 hash of a local file.
  function localMd5(filePath) {
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex')
  }

  // Fetches the MD5 hash of a single remote rclone path via `rclone md5sum`.
  // Returns null if the remote doesn't support MD5 or the call fails.
  // Uses spawn (not spawnSync) to avoid blocking the main process.
  function remoteMd5(remotePath) {
    return new Promise(resolve => {
      const child = spawn('rclone', ['md5sum', remotePath])
      let out = ''
      child.stdout?.on('data', d => { out += d.toString() })
      child.on('close', code => {
        if (code !== 0) { resolve(null); return }
        const match = out.trim().match(/^([0-9a-f]{32})/)
        resolve(match ? match[1] : null)
      })
      child.on('error', () => resolve(null))
    })
  }

  // Polls remoteMd5 until it matches expectedHash or the deadline is reached.
  // Used after upload to wait for Drive to finish processing the new file before
  // navigating — Drive can lag several seconds between upload and content availability.
  async function waitForDriveSync(remotePath, expectedHash, win, de) {
    const processingText = de ? 'Wird verarbeitet …' : 'Processing …'
    if (!win.isDestroyed()) win.webContents.loadURL(buildRcloneLoadingPage(processingText))
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const remoteHash = await remoteMd5(remotePath)
      if (remoteHash === expectedHash) return
      await new Promise(r => setTimeout(r, 1500))
    }
  }

  function rcloneList(folder) {
    return new Promise(resolve => {
      const child = spawn('rclone', ['lsjson', folder])
      let out = ''
      child.stdout?.on('data', d => { out += d.toString() })
      child.on('close', code => {
        if (code !== 0) { resolve([]); return }
        try { resolve(JSON.parse(out)) } catch { resolve([]) }
      })
      child.on('error', () => resolve([]))
    })
  }

  // Registers a one-shot 'close' handler that downloads the Drive file back to the
  // original local path before allowing the window to close. Only called when an
  // actual upload happened — not when the user chose "open existing" without uploading.
  function registerRcloneSyncBack(win, remotePath, localPath, de) {
    if (win.isDestroyed()) return
    const syncText = de ? 'Wird synchronisiert …' : 'Syncing …'
    win.once('close', async (event) => {
      event.preventDefault()
      if (!win.isDestroyed()) win.webContents.loadURL(buildRcloneLoadingPage(syncText))
      await new Promise(resolve => {
        const child = spawn('rclone', ['copyto', remotePath, localPath])
        child.on('close', () => resolve())
        child.on('error', () => resolve())
      })
      win.destroy()
    })
  }

  // Uploads a local file to the configured rclone Google Drive remote and returns
  // the Google Docs edit URL. Checks for an existing Drive file first and asks
  // the user whether to overwrite; if declined, opens the existing file directly.
  async function resolveRcloneFileUrl(raw, win) {
    if (!raw || !pkg.rcloneFileHandler) return null
    const filePath = raw.startsWith('file://') ? new URL(raw).pathname : raw
    if (!path.isAbsolute(filePath)) return null

    const cfgPath = path.join(app.getPath('appData'), 'wrapweb', 'rclone.json')
    let remote, uploadFolder
    try {
      const cfgJson    = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      remote           = cfgJson.googleDriveRemote
      // Per-app folder name, defaults to the app profile if not explicitly configured.
      const folderName = cfgJson.uploadFolders?.[pkg.profile] ?? pkg.profile
      uploadFolder     = `${remote}:${folderName}`
    } catch { return null }
    if (!remote) return null

    const filename = path.basename(filePath)
    const dest     = `${uploadFolder}/${filename}`
    const de           = app.getLocale().split('-')[0].toLowerCase() === 'de'

    // Check whether the file already exists on Drive before uploading.
    const localStat = fs.statSync(filePath)   // file existence already verified above
    const files     = await rcloneList(uploadFolder)
    const existing  = files.find(f => f.Name === filename)

    if (existing) {
      // Fast-path: skip upload entirely when local and Drive file are identical.
      // Size is checked first (free); hashes only compared when sizes match.
      if (existing.Size === localStat.size) {
        const lHash = localMd5(filePath)
        const rHash = await remoteMd5(dest)
        if (lHash && rHash && lHash === rHash) {
          registerRcloneSyncBack(win, dest, filePath, de)
          return `${pkg.rcloneEditUrlBase}/${existing.ID}/edit`
        }
      }

      // Show the HTML confirm page and wait for the user's button click via IPC.
      // Clean up both listeners (IPC + window close) whichever fires first.
      const choice = await new Promise(resolve => {
        const done = (v) => {
          ipcMain.removeListener('rclone-confirm', onIpc)
          win.removeListener('closed', onClose)
          resolve(v)
        }
        const onIpc   = (_, v) => done(v)
        const onClose = ()     => done(1)   // treat window close as "open existing"
        ipcMain.once('rclone-confirm', onIpc)
        win.once('closed', onClose)
        win.webContents.loadURL(buildConfirmPage(filename, existing, localStat, de))
      })

      // User chose not to overwrite — open the existing Drive file directly.
      if (choice !== 0) return `${pkg.rcloneEditUrlBase}/${existing.ID}/edit`

      // Show loading page while the overwrite upload runs.
      if (!win.isDestroyed()) win.webContents.loadURL(buildRcloneLoadingPage())
    }

    // Upload (overwrite or new file). --no-check-dest bypasses rclone's skip logic so
    // the local file is always transferred, even if rclone considers the remote up to date.
    const uploadOk = await new Promise(resolve => {
      const child = spawn('rclone', ['copyto', '--no-check-dest', filePath, dest])
      child.on('close', code => resolve(code === 0))
      child.on('error', () => resolve(false))
    })
    if (!uploadOk) return null

    // Wait for Drive to finish processing the uploaded file before navigating.
    // Without this, Google Docs may open the previous cached version.
    const uploadedHash = localMd5(filePath)
    await waitForDriveSync(dest, uploadedHash, win, de)

    // Register sync-back: on window close, copy the Drive file back to the local path.
    registerRcloneSyncBack(win, dest, filePath, de)

    // Drive keeps the same ID when overwriting; for new files fetch it from the listing.
    if (existing) return `${pkg.rcloneEditUrlBase}/${existing.ID}/edit`

    const updated = await rcloneList(uploadFolder)
    const id = updated.find(f => f.Name === filename)?.ID
    return id ? `${pkg.rcloneEditUrlBase}/${id}/edit` : null
  }

  function resolveFileUrl(raw) {
    if (!raw || !pkg.fileHandler) return null
    try {
      const filePath = raw.startsWith('file://') ? new URL(raw).pathname : raw
      if (!path.isAbsolute(filePath)) return null
      const title = encodeURIComponent(path.basename(filePath))
      let xml
      if (filePath.endsWith('.drawio.svg')) {
        xml = extractXmlFromDrawioSvg(fs.readFileSync(filePath, 'utf8'))
      } else if (filePath.endsWith('.drawio.png')) {
        xml = extractXmlFromDrawioPng(fs.readFileSync(filePath))
      } else {
        xml = fs.readFileSync(filePath, 'utf8')
      }
      if (!xml) return null
      return `${pkg.url}/?title=${title}#R${encodeURIComponent(xml)}`
    } catch { return null }
  }

  // Converts a command-line URL argument into a loadable URL.
  // mailto: is only forwarded if mailtoTemplate is configured; otherwise Electron would
  // try to render the raw mailto: URI, which produces a blank page.
  function resolveUrl(raw) {
    if (!raw) return null
    if (raw.startsWith('file:') || path.isAbsolute(raw)) return null  // handled by resolveFileUrl
    if (raw.startsWith('mailto:')) {
      if (pkg.mailtoJs) return null  // handled via JS injection; load default URL
      if (pkg.mailtoTemplate) {
        try {
          const fields = parseMailtoFields(raw)
          const map = pkg.mailtoParamMap || {}
          const params = new URLSearchParams()
          if (fields.to) params.set('to', fields.to)
          const m = new URL(raw)
          for (const [k, v] of m.searchParams) params.set(map[k] ?? k, v)
          const sep = (pkg.mailtoTemplate.includes('?') || pkg.mailtoTemplate.includes('#')) ? '&' : '?'
          return `${pkg.mailtoTemplate}${sep}${params.toString()}`
        } catch { return null }
      }
      return null  // no handler configured — load default URL rather than a mailto: URL Electron can't render
    }
    return raw
  }

  // Builds the JS snippet to inject after page load when mailtoJs is configured.
  // The template string uses {to}, {subject}, {body} etc. as placeholders.
  function resolveMailtoJs(raw) {
    if (!raw || !raw.startsWith('mailto:') || !pkg.mailtoJs) return null
    const fields = parseMailtoFields(raw)
    if (!fields) return null
    return pkg.mailtoJs.replace(/\{(\w+)\}/g, (_, k) => fields[k] ?? '')
  }

  // Polls until the compose-to input field is focused (detected by CSS class "tt-input"),
  // then simulates keyboard input to fill in the recipient and subject.
  // Native sendInputEvent is used because executeJavaScript cannot trigger
  // the web app's own keydown handlers reliably for token-input widgets.
  function typeMailtoFields(win, fields) {
    if (!fields || (!fields.to && !fields.subject)) return
    let attempts = 0
    function poll() {
      if (++attempts > 40 || win.isDestroyed()) return
      win.webContents.executeJavaScript('document.activeElement.className')
        .then(async cls => {
          if (typeof cls === 'string' && cls.includes('tt-input')) {
            if (fields.to) {
              for (const char of fields.to)
                win.webContents.sendInputEvent({ type: 'char', keyCode: char })
              win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
              win.webContents.sendInputEvent({ type: 'keyUp',   keyCode: 'Return' })
              await new Promise(r => setTimeout(r, 300))
            }
            if (fields.subject) {
              const ok = await win.webContents.executeJavaScript(
                `var s=document.querySelector('input[name="subject"]');s?(s.focus(),true):false`
              )
              if (ok) {
                await new Promise(r => setTimeout(r, 100))
                for (const char of fields.subject)
                  win.webContents.sendInputEvent({ type: 'char', keyCode: char })
              }
            }
          } else {
            setTimeout(poll, 300)
          }
        })
        .catch(() => setTimeout(poll, 300))
    }
    setTimeout(poll, 300)
  }

  const rawArg   = process.argv.slice(1).find(a => /^(https?:|mailto:|file:)/.test(a) ||
    ((pkg.fileHandler || pkg.rcloneFileHandler) && path.isAbsolute(a) && fs.existsSync(a)))
  const urlArg   = resolveUrl(rawArg) ?? resolveFileUrl(rawArg)
  const jsArg    = resolveMailtoJs(rawArg)
  const jsFields = (rawArg?.startsWith('mailto:') && pkg.mailtoJs) ? parseMailtoFields(rawArg) : null

  // Single-instance lock: if another process already holds it, quit immediately.
  // The second-instance handler lets the existing window handle the new URL argument.
  if (pkg.singleInstance) {
    const gotLock = app.requestSingleInstanceLock()
    if (!gotLock) { app.quit(); return }
    app.on('second-instance', (event, argv) => {
      const raw2     = argv.slice(1).find(a => /^(https?:|mailto:|file:)/.test(a) ||
        ((pkg.fileHandler || pkg.rcloneFileHandler) && path.isAbsolute(a) && fs.existsSync(a)))
      const url      = resolveUrl(raw2) ?? resolveFileUrl(raw2)
      const js       = resolveMailtoJs(raw2)
      const js2Fields = (raw2?.startsWith('mailto:') && pkg.mailtoJs) ? parseMailtoFields(raw2) : null
      const win      = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (url) win.webContents.loadURL(url)
        if (js) {
          win.webContents.executeJavaScript(js).catch(() => {})
          if (js2Fields) typeMailtoFields(win, js2Fields)
        }
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
  }

  // Builds a self-contained data: URL loading page shown while the rclone upload runs.
  // Ubuntu is a system font on Ubuntu Linux and picked up by Chromium without a network request.
  function buildRcloneLoadingPage(text) {
    const lang = app.getLocale().split('-')[0].toLowerCase()
    if (!text) text = lang === 'de' ? 'Wird hochgeladen …' : 'Uploading …'
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      * { margin: 0; padding: 0; box-sizing: border-box }
      body {
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; height: 100vh;
        background: #fff; font-family: 'Ubuntu', sans-serif; color: #3c4043;
        color-scheme: light;
      }
      .spinner {
        width: 48px; height: 48px;
        border: 4px solid #e8eaed; border-top-color: #4285f4;
        border-radius: 50%; animation: spin .9s linear infinite;
        margin-bottom: 20px;
      }
      @keyframes spin { to { transform: rotate(360deg) } }
      p { font-size: 15px; font-weight: 400 }
    </style></head><body>
      <div class="spinner"></div>
      <p>${text}</p>
    </body></html>`
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  }

  const { createWindow } = require('./src/window')
  app.whenReady().then(async () => {
    const useRclone = pkg.rcloneFileHandler && rawArg && !urlArg
    const initialUrl = useRclone ? buildRcloneLoadingPage() : (urlArg ?? null)
    const win = createWindow(initialUrl ? { ...pkg, url: initialUrl } : pkg)

    // rclone file handler: window shows a loading page while the upload runs,
    // then navigates to the edit URL (or falls back to the default URL on error).
    if (useRclone) {
      resolveRcloneFileUrl(rawArg, win).then(editUrl => {
        if (!win.isDestroyed()) win.webContents.loadURL(editUrl ?? pkg.url)
      }).catch(() => {
        if (!win.isDestroyed()) win.webContents.loadURL(pkg.url)
      })
    }

    if (jsArg) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.executeJavaScript(jsArg).catch(() => {})
        if (jsFields) typeMailtoFields(win, jsFields)
      })
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(pkg)
    })
  })
} else {
  // Returns the current default mailto handler desktop filename, or null.
  function getDefaultMailDesktop() {
    try {
      const r = spawnSync('xdg-mime', ['query', 'default', 'x-scheme-handler/mailto'], { encoding: 'utf8', timeout: 2000 })
      return r.stdout.trim() || null
    } catch { return null }
  }

  // Builds a full app object for a single config file, resolving icon paths individually.
  // Used when a single restored app needs to be returned after a delete operation.
  function buildSingleApp(configFile, defaultMailDesktop) {
    const f   = path.basename(configFile)
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    const configLabel  = f.replace(/^build\.(.+)\.json$/, '$1')
    const built        = fs.existsSync(path.join(__dirname, 'dist', `wrapweb-${cfg.profile}`))
    const desktopFile  = path.join(os.homedir(), '.local', 'share', 'applications', `wrapweb-${cfg.profile}.desktop`)
    const installed    = fs.existsSync(desktopFile)
    let   iconValue    = cfg.icon || null
    if (installed) {
      const m = fs.readFileSync(desktopFile, 'utf8').match(/^Icon=(.+)$/m)
      if (m) iconValue = m[1].trim()
    }
    const appImagePath = path.join(__dirname, 'dist', `wrapweb-${cfg.profile}`)
    const profilePath  = path.join(app.getPath('appData'), 'wrapweb', cfg.profile)
    const isDefaultMailHandler = defaultMailDesktop === `wrapweb-${cfg.profile}.desktop`
    let builtVersion = null
    let builtRclone  = false
    if (built) {
      try {
        const raw = fs.readFileSync(path.join(__dirname, 'dist', `wrapweb-${cfg.profile}.version`), 'utf8').trim()
        try {
          const meta  = JSON.parse(raw)
          builtVersion = meta.version          ?? null
          builtRclone  = meta.rcloneFileHandler ?? false
        } catch { builtVersion = raw }
      } catch {}
    }
    const minVer      = pkg.minAppImageVersion ?? pkg.version
    const needsRebuild = built && (
      process.env.WRAPWEB_TEST
        ? builtVersion !== null && semverLt(builtVersion, minVer)
        : semverLt(builtVersion ?? '0.0.0', minVer)
    )
    let iconPath = null
    if (iconValue && iconValue !== 'wrapweb') {
      if (path.isAbsolute(iconValue) && fs.existsSync(iconValue)) {
        iconPath = iconValue
      } else {
        const bundled  = path.join(__dirname, 'assets', 'webapps', `${iconValue}.svg`)
        const resolved = resolveIconsByGtk([iconValue])
        iconPath = resolved[iconValue] || (fs.existsSync(bundled) ? bundled : null)
      }
    }
    return {
      profile: cfg.profile, configLabel, name: cfg.name, url: cfg.url,
      built, installed, isPrivate: f.startsWith('build.private.'),
      iconPath, appImagePath, profilePath,
      icon: cfg.icon || null, geometry: cfg.geometry || null,
      userAgent: cfg.userAgent || null, crossOriginIsolation: cfg.crossOriginIsolation || false,
      singleInstance: cfg.singleInstance || false, internalDomains: cfg.internalDomains || null,
      mimeTypes: cfg.mimeTypes || null, mailtoJs: cfg.mailtoJs || null,
      isDefaultMailHandler, category: cfg.category || null,
      builtVersion, builtRclone, rcloneFileHandler: cfg.rcloneFileHandler || false, needsRebuild,
    }
  }

  ipcMain.handle('manager:apps', () => {
    // xdg-mime returns a .desktop filename (e.g. "wrapweb-thunderbird.desktop");
    // compare against each app's desktop name to determine the current mail handler.
    const defaultMailDesktop = getDefaultMailDesktop()

    const configs = fs.readdirSync(CONFIGS_DIR)
      .filter(f => /^build\..+\.json$/.test(f))
      .map(f => {
        const cfg = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8'))
        const configLabel = f.replace(/^build\.(.+)\.json$/, '$1')
        const built = fs.existsSync(path.join(__dirname, 'dist', `wrapweb-${cfg.profile}`))
        const desktopFile = path.join(os.homedir(), '.local', 'share', 'applications', `wrapweb-${cfg.profile}.desktop`)
        const installed = fs.existsSync(desktopFile)
        let iconValue = cfg.icon || null
        if (installed) {
          const m = fs.readFileSync(desktopFile, 'utf8').match(/^Icon=(.+)$/m)
          if (m) iconValue = m[1].trim()
        }
        const appImagePath = path.join(__dirname, 'dist', `wrapweb-${cfg.profile}`)
        const profilePath  = path.join(app.getPath('appData'), 'wrapweb', cfg.profile)
        const isDefaultMailHandler = defaultMailDesktop === `wrapweb-${cfg.profile}.desktop`
        let builtVersion = null
        let builtRclone  = false
        if (built) {
          try {
            const raw = fs.readFileSync(path.join(__dirname, 'dist', `wrapweb-${cfg.profile}.version`), 'utf8').trim()
            try {
              // New format: JSON with version + optional capability flags.
              const meta  = JSON.parse(raw)
              builtVersion = meta.version   ?? null
              builtRclone  = meta.rcloneFileHandler ?? false
            } catch {
              builtVersion = raw   // backward compat: plain version string from older builds
            }
          } catch {}
        }
        // In tests, only flag as outdated when a .version file is present and older
        // than minVer — avoids false positives for AppImages built without the sidecar.
        const minVer = pkg.minAppImageVersion ?? pkg.version
        const needsRebuild = built && (
          process.env.WRAPWEB_TEST
            ? builtVersion !== null && semverLt(builtVersion, minVer)
            : semverLt(builtVersion ?? '0.0.0', minVer)
        )
        return { profile: cfg.profile, configLabel, name: cfg.name, url: cfg.url, built, installed, isPrivate: f.startsWith('build.private.'), iconValue, appImagePath, profilePath, icon: cfg.icon || null, geometry: cfg.geometry || null, userAgent: cfg.userAgent || null, crossOriginIsolation: cfg.crossOriginIsolation || false, singleInstance: cfg.singleInstance || false, internalDomains: cfg.internalDomains || null, mimeTypes: cfg.mimeTypes || null, mailtoJs: cfg.mailtoJs || null, isDefaultMailHandler, category: cfg.category || null, builtVersion, builtRclone, rcloneFileHandler: cfg.rcloneFileHandler || false, needsRebuild }
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

    // Separate absolute paths from theme names — batch-resolve theme names via GTK
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
          const bundled = path.join(__dirname, 'assets', 'webapps', `${iconValue}.svg`)
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
  ipcMain.handle('manager:ua-presets', () => pkg.uaPresets ?? [])

  ipcMain.handle('manager:ui-icons', () => {
    if (process.env.WRAPWEB_TEST) {
      const fi = process.env.WRAPWEB_TEST_FILTER_ICONS || null
      // Resolve application-default-icon via GTK even in test mode so that local test
      // runs (which have a real icon theme) show the system generic icon, not the bundled fallback.
      // Falls back to the bundled SVG when GTK is unavailable (e.g. CI without a theme).
      const r = resolveIconsByGtk(['application-default-icon'])
      const appDefault = r['application-default-icon'] || path.join(__dirname, 'assets', 'webapps', 'application-default-icon.svg')
      const rclone = path.join(__dirname, 'assets', 'rclone.svg')
      const googledrive        = path.join(__dirname, 'assets', 'webapps', 'googledrive.svg')
      const googleSafeBrowsing = path.join(__dirname, 'assets', 'safe-browsing.svg')
      const eyeVisible = path.join(__dirname, 'assets', 'visible.svg')
      const eyeHidden  = path.join(__dirname, 'assets', 'hidden.svg')
      return fi
        ? { appDefault, rclone, googledrive, googleSafeBrowsing, eyeVisible, eyeHidden, filterMicrosoft: fi, filterGoogle: fi }
        : { appDefault, rclone, googledrive, googleSafeBrowsing, eyeVisible, eyeHidden }
    }
    const r = resolveIconsByGtk([
      'weather-clear-symbolic', 'weather-clear-night-symbolic',
      'dialog-information-symbolic', 'system-run-symbolic',
      'system-software-install-symbolic', 'edit-delete-symbolic',
      'application-default-icon', 'open-menu-symbolic',
      'view-app-grid-symbolic', 'applications-internet-symbolic',
      'avatar-default-symbolic', 'view-filter-symbolic',
      'document-edit-symbolic', 'github',
      'view-group', 'update-notifier',
    ])
    return {
      sun: r['weather-clear-symbolic'], moon: r['weather-clear-night-symbolic'],
      info: r['dialog-information-symbolic'], build: r['system-run-symbolic'],
      install: r['system-software-install-symbolic'], delete: r['edit-delete-symbolic'],
      appDefault: r['application-default-icon'] || path.join(__dirname, 'assets', 'webapps', 'application-default-icon.svg'),
      rclone:            path.join(__dirname, 'assets', 'rclone.svg'),
      googledrive:       path.join(__dirname, 'assets', 'webapps', 'googledrive.svg'),
      googleSafeBrowsing: path.join(__dirname, 'assets', 'safe-browsing.svg'),
      eyeVisible: path.join(__dirname, 'assets', 'visible.svg'),
      eyeHidden:  path.join(__dirname, 'assets', 'hidden.svg'),
      menu: r['open-menu-symbolic'],
      filterAll: r['view-app-grid-symbolic'], filterPublic: r['applications-internet-symbolic'],
      filterPrivate: r['avatar-default-symbolic'], hideFilter: r['view-filter-symbolic'],
      edit: r['document-edit-symbolic'], github: r['github'],
      filterMicrosoft: r['view-group'], filterGoogle: r['view-group'],
      updateNotifier: r['update-notifier'],
    }
  })

  ipcMain.handle('manager:launch', (event, profile) => {
    const appImagePath = path.join(__dirname, 'dist', `wrapweb-${profile}`)
    if (!fs.existsSync(appImagePath)) return { success: false }
    const child = spawn(appImagePath, ['--no-sandbox'], { detached: true, stdio: 'ignore' })
    child.unref()
    return { success: true }
  })

  ipcMain.handle('manager:delete', (event, { profile, configLabel, deleteConfig, deleteProfileData }) => {
    const desktopFile  = path.join(os.homedir(), '.local', 'share', 'applications', `wrapweb-${profile}.desktop`)
    const appImageFile = path.join(__dirname, 'dist', `wrapweb-${profile}`)
    const configFile   = configLabel ? path.join(CONFIGS_DIR, `build.${configLabel}.json`) : null
    const profileDir   = path.join(app.getPath('appData'), 'wrapweb', profile)
    try {
      if (fs.existsSync(desktopFile))                                    fs.rmSync(desktopFile)
      if (fs.existsSync(appImageFile))                                   fs.rmSync(appImageFile)
      if (deleteConfig     && configFile && fs.existsSync(configFile))   fs.rmSync(configFile)
      if (deleteProfileData && fs.existsSync(profileDir))                fs.rmSync(profileDir, { recursive: true })

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
      const child = spawn('node', [path.join(__dirname, 'scripts', 'install.js'), configLabel], { cwd: __dirname })
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
        profile:             data.profile,
        configLabel:         `private.${data.profile}`,
        name:                data.name || null,
        url:                 data.url,
        built: false, installed: false, isPrivate: true,
        iconPath,
        icon:                data.icon || null,
        geometry:            (w > 0 || h > 0) ? cfg.geometry : null,
        userAgent:           data.userAgent || null,
        crossOriginIsolation: data.crossOriginIsolation || false,
        singleInstance:      data.singleInstance || false,
        internalDomains:     data.internalDomains ? cfg.internalDomains : null,
        mimeTypes:           cfg.mimeTypes || null,
        mailtoJs:            cfg.mailtoJs  || null,
      }
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
        name:                data.name || null,
        url:                 data.url,
        icon:                data.icon || null,
        iconPath,
        geometry:            (w > 0 || h > 0) ? cfg.geometry : null,
        userAgent:           data.userAgent || null,
        crossOriginIsolation: data.crossOriginIsolation || false,
        singleInstance:      data.singleInstance || false,
        internalDomains:     data.internalDomains ? cfg.internalDomains : null,
        mimeTypes:           cfg.mimeTypes || null,
        mailtoJs:            cfg.mailtoJs  || null,
      }
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

  // Synchronous which-check: if rclone is not on PATH the status is 1.
  ipcMain.handle('manager:rclone-status', () => {
    const r = spawnSync('which', ['rclone'], { encoding: 'utf8', timeout: 2000 })
    return { available: r.status === 0 }
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

  // WRAPWEB_TEST_DATA_DIR redirects the rclone config into a temp dir in tests
  // so tests never read or write the user's real ~/.config/wrapweb/rclone.json.
  function rcloneConfigPath() {
    const testDir = process.env.WRAPWEB_TEST_DATA_DIR
    return testDir
      ? path.join(testDir, 'rclone.json')
      : path.join(app.getPath('appData'), 'wrapweb', 'rclone.json')
  }

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

  function safeBrowsingConfigPath() {
    const testDir = process.env.WRAPWEB_TEST_DATA_DIR
    return testDir
      ? path.join(testDir, 'safe-browsing.json')
      : path.join(app.getPath('appData'), 'wrapweb', 'safe-browsing.json')
  }

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
    const configs = fs.readdirSync(CONFIGS_DIR)
      .filter(f => /^build\..+\.json$/.test(f))
      .map(f => {
        const cfg = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8'))
        return { profile: cfg.profile, name: cfg.name || null }
      })
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
      const child = spawn('node', [path.join(__dirname, 'scripts', 'build.js'), configLabel], { cwd: __dirname })
      let stdout = '', stderr = ''
      child.stdout?.on('data', d => { stdout += d.toString() })
      child.stderr?.on('data', d => { stderr += d.toString() })
      child.on('close', code => {
        let builtRclone = false
        if (code === 0) {
          try {
            const raw  = fs.readFileSync(path.join(__dirname, 'dist', `wrapweb-${configLabel}.version`), 'utf8').trim()
            const meta = JSON.parse(raw)
            builtRclone = meta.rcloneFileHandler ?? false
          } catch { /* version file missing or old plain-string format */ }
        }
        resolve({ success: code === 0, stdout, stderr, builtRclone })
      })
      child.on('error', err => resolve({ success: false, stdout, stderr: err.message, builtRclone: false }))
    })
  })

  app.whenReady().then(() => {
    openManager()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openManager()
    })
  })
}

// Resolves GTK icon names to absolute file paths using the system icon theme.
// A single Python/GTK subprocess handles all names in one call to amortize startup cost.
// Returns empty strings for names that are not found in any installed theme.
function resolveIconsByGtk(names) {
  if (names.length === 0) return {}
  const script = `
import gi, sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
theme = Gtk.IconTheme.get_default()
for name in sys.argv[1:]:
    info = theme.lookup_icon(name, 64, 0)
    print(info.get_filename() if info else '')
`
  const r = spawnSync('python3', ['-c', script, ...names], { encoding: 'utf8', timeout: 3000 })
  if (r.error || r.status !== 0) return {}
  const lines = (r.stdout || '').split('\n')
  return Object.fromEntries(names.map((name, i) => [name, lines[i] || null]))
}

const { t } = require('./src/i18n')

const managerStatePath = path.join(app.getPath('appData'), 'wrapweb', 'manager-state.json')

function loadManagerBounds() {
  try {
    const { width, height } = JSON.parse(fs.readFileSync(managerStatePath, 'utf8'))
    if (width > 0 && height > 0) return { width, height }
  } catch {}
  return null
}

function saveManagerBounds(win) {
  try {
    const { width, height } = win.getBounds()
    fs.mkdirSync(path.dirname(managerStatePath), { recursive: true })
    fs.writeFileSync(managerStatePath, JSON.stringify({ width, height }), 'utf8')
  } catch {}
}

function openManager() {
  const saved = loadManagerBounds()
  const win = new BrowserWindow({
    width:  saved?.width  ?? 780,
    height: saved?.height ?? 820,
    minWidth: 400,
    minHeight: 400,
    title: 'wrapweb',
    webPreferences: {
      preload: path.join(__dirname, 'src', 'manager', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.on('close', () => saveManagerBounds(win))
  win.webContents.on('context-menu', (_event, params) => {
    const i18n = t()
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'cut',   label: i18n.cut   },
        { role: 'copy',  label: i18n.copy  },
        { role: 'paste', label: i18n.paste },
      ]).popup({ window: win })
    } else if (params.selectionText) {
      Menu.buildFromTemplate([
        { role: 'copy', label: i18n.copy },
      ]).popup({ window: win })
    }
  })

  win.loadFile(path.join(__dirname, 'src', 'manager', 'manager.html'))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
