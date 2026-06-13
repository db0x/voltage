// Entry point for app-window mode (pkg.profile is set).
// Sets up URL resolution, draw.io file handling, and the single-instance lock, then opens the
// app window once Electron is ready. App-specific behaviour (mailto compose, OneDrive doc
// routing, …) lives in main-process plugins selected per app — see src/window.js loadPlugins().

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const zlib = require('node:zlib')

const pkg = require(app.getAppPath() + '/package.json')
const { createWindow, dispatchLaunchArg } = require('./window')
const { parseMailtoFields }         = require('./mailto')

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
    if (pkg.mailtoTemplate) {
      try {
        const fields = parseMailtoFields(raw)
        const map    = pkg.mailtoParamMap || {}
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


module.exports = function setupAppWindow() {
  // These must run synchronously before app.whenReady() — Electron reads them during startup.
  app.setAppUserModelId(pkg.appId)
  app.setName(`wrapweb-${pkg.profile}`)
  app.commandLine.appendSwitch('wm-class', `wrapweb-${pkg.profile}`)
  app.setPath('userData', path.join(app.getPath('appData'), 'wrapweb', pkg.profile))

  // acceptsFileArg lets an app receive a bare local file path as a launch argument; the file
  // itself is handled either by the built-in draw.io fileHandler (resolveFileUrl) or by a
  // plugin (e.g. rclone-sync, which reads launchArg). fileHandler implies it for back-compat.
  const findArg = (argv) => argv.slice(1).find(a => /^(https?:|mailto:|file:)/.test(a) ||
    ((pkg.fileHandler || pkg.acceptsFileArg) && path.isAbsolute(a) && fs.existsSync(a)))
  const rawArg   = findArg(process.argv)
  const urlArg   = resolveUrl(rawArg) ?? resolveFileUrl(rawArg)

  // Single-instance lock: if another process already holds it, quit immediately.
  // The second-instance handler forwards the new argument to the running window: a URL is
  // loaded directly, and the raw argument is also dispatched to plugins (e.g. the mail plugin
  // composing a fresh mailto:) so app-specific launch behaviour fires again.
  if (pkg.singleInstance) {
    const gotLock = app.requestSingleInstanceLock()
    if (!gotLock) { app.quit(); return }
    app.on('second-instance', (event, argv) => {
      const raw2 = findArg(argv)
      const url  = resolveUrl(raw2) ?? resolveFileUrl(raw2)
      const win  = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (url) win.webContents.loadURL(url)
        dispatchLaunchArg(win, raw2 ?? null)
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
  }

  app.whenReady().then(async () => {
    // A resolvable URL/file (draw.io) loads directly; otherwise pkg.url. A file destined for a
    // plugin (rclone-sync) leaves urlArg null and reaches the plugin via launchArg, which takes
    // over the initial load itself.
    createWindow(urlArg ? { ...pkg, url: urlArg } : pkg, { launchArg: rawArg ?? null })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(pkg)
    })
  })
}
