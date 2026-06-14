// rclone-sync plugin (main-process module). Opens a local Office file (passed as a launch
// argument) in the matching Google web editor by uploading it to a configured rclone Google
// Drive remote, then syncs the edited file back to disk when the window closes.
//
// This used to live in the voltage base (src/rclone-file-handler.js + app-window.js); it is
// now an opt-in per-app plugin. The host only has to accept a bare file path as a launch arg
// (config flag `acceptsFileArg`) — everything rclone-specific is contained here.
//
// Config fields it reads from the embedded package.json:
//   rcloneEditUrlBase — e.g. "https://docs.google.com/document/d"; "<base>/<id>/edit" is the
//                       editor URL the window navigates to after upload.
// Runtime config (~/.config/voltage/rclone.json, written by the manager's rclone dialog):
//   googleDriveRemote, uploadFolders[profile].

const { app, ipcMain } = require('electron')
const path   = require('node:path')
const fs     = require('node:fs')
const os     = require('node:os')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')

// Whether the rclone binary is on PATH. Checked once, synchronously, at attach time: the
// window must decide immediately whether to take over the initial load, and without rclone
// the whole upload/sync flow can't run — so the plugin stays inert and the app loads normally.
function rcloneAvailable() {
  try { return spawnSync('which', ['rclone'], { timeout: 2000 }).status === 0 }
  catch { return false }
}

const pkg      = require(app.getAppPath() + '/package.json')
const APP_ROOT = app.getAppPath()
const TAG      = '[rclone-sync-plugin]'

// Mustache-style {{key}} substitution for the data: URL HTML pages (no DOM in Node).
function fillHtml(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

// Templates ship next to this plugin file.
const conflictTemplate = fs.readFileSync(path.join(__dirname, 'conflict.html'), 'utf8')
const loadingTemplate  = fs.readFileSync(path.join(__dirname, 'loading.html'),  'utf8')
const syncBackTemplate = fs.readFileSync(path.join(__dirname, 'sync-back.html'), 'utf8')

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB'
  return b + ' B'
}

// Installed app icon as a data URL (svg preferred), for the conflict page header.
function appIconDataUrl() {
  const { appName } = require(path.join(APP_ROOT, 'src', 'app-naming'))
  const hicolor = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')
  const svg = path.join(hicolor, 'scalable', 'apps', `${appName(pkg.profile)}.svg`)
  const png = path.join(hicolor, '48x48',    'apps', `${appName(pkg.profile)}.png`)
  if (fs.existsSync(svg)) return `data:image/svg+xml;base64,${fs.readFileSync(svg).toString('base64')}`
  if (fs.existsSync(png)) return `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`
  return null
}

function assetDataUrl(name) {
  const p = path.join(APP_ROOT, 'assets', name)
  return fs.existsSync(p) ? `data:image/svg+xml;base64,${fs.readFileSync(p).toString('base64')}` : null
}

// Self-contained local-vs-Drive comparison page; the user picks overwrite vs. open existing.
function buildConfirmPage(filename, existing, localStat, de) {
  const appIconUrl  = appIconDataUrl()
  const voltageIcon = assetDataUrl('voltage.svg')
  const rcloneIcon  = assetDataUrl('rclone.svg')
  const html = fillHtml(conflictTemplate, {
    title:      de ? 'Datei überschreiben?' : 'Overwrite file?',
    btnOpen:    de ? 'Bestehende öffnen'    : 'Open existing',
    btnOver:    de ? 'Überschreiben'        : 'Overwrite',
    labelLocal: de ? 'Lokal'                : 'Local',
    labelDrive: 'Google Drive',
    labelMod:   de ? 'Geändert'             : 'Modified',
    labelSize:  de ? 'Größe'                : 'Size',
    localMod:   localStat.mtime.toLocaleString(),
    localSize:  fmtBytes(localStat.size),
    remMod:     new Date(existing.ModTime).toLocaleString(),
    remSize:    fmtBytes(existing.Size),
    filename,
    voltageIconHtml: voltageIcon ? `<img src="${voltageIcon}" alt="voltage">` : '',
    rcloneIconHtml:  rcloneIcon  ? `<span class="header-rclone-badge"><img src="${rcloneIcon}" alt=""></span>` : '',
    appIconHtml:     appIconUrl  ? `<img class="file-icon" src="${appIconUrl}" alt="">` : '',
  })
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

// Sync-back prompt shown on close when the user opened the existing Drive version: ask whether
// to write the (possibly edited) Drive file back over the local file. Same look as the conflict
// page, minus the comparison table.
function buildSyncBackPage(filename, de) {
  const appIconUrl  = appIconDataUrl()
  const voltageIcon = assetDataUrl('voltage.svg')
  const rcloneIcon  = assetDataUrl('rclone.svg')
  const html = fillHtml(syncBackTemplate, {
    title:        de ? 'Lokale Datei aktualisieren?' : 'Update local file?',
    message:      de
      ? 'Die Datei wurde in der Cloud geöffnet. Soll die lokale Datei mit der Cloud-Version überschrieben werden?'
      : 'The file was opened in the cloud. Overwrite the local file with the cloud version?',
    btnKeep:      de ? 'Lokal behalten'  : 'Keep local',
    btnOverwrite: de ? 'Überschreiben'   : 'Overwrite',
    filename,
    voltageIconHtml: voltageIcon ? `<img src="${voltageIcon}" alt="voltage">` : '',
    rcloneIconHtml:  rcloneIcon  ? `<span class="header-rclone-badge"><img src="${rcloneIcon}" alt=""></span>` : '',
    appIconHtml:     appIconUrl  ? `<img class="file-icon" src="${appIconUrl}" alt="">` : '',
  })
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

// Loading page shown while the upload/sync runs.
function buildLoadingPage(text) {
  const de = app.getLocale().split('-')[0].toLowerCase() === 'de'
  if (!text) text = de ? 'Wird hochgeladen …' : 'Uploading …'
  return `data:text/html;charset=utf-8,${encodeURIComponent(fillHtml(loadingTemplate, { text }))}`
}

function localMd5(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex')
}

// MD5 of a single remote rclone path via `rclone md5sum`; null when unsupported/failed.
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

// Polls until the remote hash matches (Drive lags a few seconds after upload) or times out.
async function waitForDriveSync(remotePath, expectedHash, win, de) {
  const processingText = de ? 'Wird verarbeitet …' : 'Processing …'
  if (!win.isDestroyed()) win._voltageAppContents.loadURL(buildLoadingPage(processingText))
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

// Copies the Drive file back over the local path; resolves when done (best-effort).
function copyRemoteToLocal(remotePath, localPath) {
  return new Promise(resolve => {
    const child = spawn('rclone', ['copyto', remotePath, localPath])
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })
}

// On window close, silently download the Drive file back to the local path before closing.
// Used after an upload (overwrite path): the user already committed to the local→Drive→local
// round-trip, so no extra prompt.
function registerSyncBack(win, remotePath, localPath, de) {
  if (win.isDestroyed()) return
  const syncText = de ? 'Wird synchronisiert …' : 'Syncing …'
  win.once('close', async (event) => {
    event.preventDefault()
    if (!win.isDestroyed()) win._voltageAppContents.loadURL(buildLoadingPage(syncText))
    await copyRemoteToLocal(remotePath, localPath)
    win.destroy()
  })
}

// On window close, ASK whether to overwrite the local file with the Drive version. Used in the
// "open existing" path: the user chose not to push their local file up, so the local copy must
// not be touched without consent (the previous behaviour silently left it stale). The confirm
// page reuses the rclone IPC channel (0 = overwrite, anything else = keep local).
function registerSyncBackPrompt(win, remotePath, localPath, filename, de) {
  if (win.isDestroyed()) return
  win.once('close', async (event) => {
    event.preventDefault()
    const choice = await new Promise(resolve => {
      const done    = (v) => { ipcMain.removeListener('rclone-confirm', onIpc); resolve(v) }
      const onIpc   = (_, v) => done(v)
      ipcMain.once('rclone-confirm', onIpc)
      if (!win.isDestroyed()) win._voltageAppContents.loadURL(buildSyncBackPage(filename, de))
    })
    if (choice === 0) {
      const syncText = de ? 'Wird synchronisiert …' : 'Syncing …'
      if (!win.isDestroyed()) win._voltageAppContents.loadURL(buildLoadingPage(syncText))
      await copyRemoteToLocal(remotePath, localPath)
    }
    if (!win.isDestroyed()) win.destroy()
  })
}

// Uploads the local file to Drive and returns its Google editor URL (or null on any failure).
async function resolveEditUrl(filePath, win) {
  const cfgPath = path.join(app.getPath('appData'), 'voltage', 'rclone.json')
  let remote, uploadFolder
  try {
    const cfgJson    = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    remote           = cfgJson.googleDriveRemote
    const folderName = cfgJson.uploadFolders?.[pkg.profile] ?? pkg.profile
    uploadFolder     = `${remote}:${folderName}`
  } catch { return null }
  if (!remote) return null

  const filename  = path.basename(filePath)
  const dest      = `${uploadFolder}/${filename}`
  const de        = app.getLocale().split('-')[0].toLowerCase() === 'de'
  const localStat = fs.statSync(filePath)
  const files     = await rcloneList(uploadFolder)
  const existing  = files.find(f => f.Name === filename)

  if (existing) {
    // Fast-path: identical file already on Drive → skip upload.
    if (existing.Size === localStat.size) {
      const lHash = localMd5(filePath)
      const rHash = await remoteMd5(dest)
      if (lHash && rHash && lHash === rHash) {
        registerSyncBack(win, dest, filePath, de)
        return `${pkg.rcloneEditUrlBase}/${existing.ID}/edit`
      }
    }
    // Ask the user via the confirm page; window close counts as "open existing".
    const choice = await new Promise(resolve => {
      const done    = (v) => {
        ipcMain.removeListener('rclone-confirm', onIpc)
        win.removeListener('closed', onClose)
        resolve(v)
      }
      const onIpc   = (_, v) => done(v)
      const onClose = ()     => done(1)
      ipcMain.once('rclone-confirm', onIpc)
      win.once('closed', onClose)
      win._voltageAppContents.loadURL(buildConfirmPage(filename, existing, localStat, de))
    })
    // "Open existing": don't push the local file up. The Drive copy may still get edited, so
    // on close ask whether to pull it back over the local file (instead of silently leaving the
    // local copy stale, the previous behaviour). Skip if the window is already gone (user closed
    // the confirm dialog itself — onClose resolved choice=1 — so there's nothing to prompt for).
    if (choice !== 0) {
      if (!win.isDestroyed()) registerSyncBackPrompt(win, dest, filePath, filename, de)
      return `${pkg.rcloneEditUrlBase}/${existing.ID}/edit`
    }
    if (!win.isDestroyed()) win._voltageAppContents.loadURL(buildLoadingPage())
  }

  // --no-check-dest forces the transfer even when rclone thinks the remote is up to date.
  const uploadOk = await new Promise(resolve => {
    const child = spawn('rclone', ['copyto', '--no-check-dest', filePath, dest])
    child.on('close', code => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
  if (!uploadOk) return null

  const uploadedHash = localMd5(filePath)
  await waitForDriveSync(dest, uploadedHash, win, de)
  registerSyncBack(win, dest, filePath, de)

  if (existing) return `${pkg.rcloneEditUrlBase}/${existing.ID}/edit`
  const updated = await rcloneList(uploadFolder)
  const id = updated.find(f => f.Name === filename)?.ID
  return id ? `${pkg.rcloneEditUrlBase}/${id}/edit` : null
}

// Normalises a launch argument to an absolute local file path, or null if it isn't one.
function fileFromArg(raw) {
  if (!raw) return null
  try {
    const p = raw.startsWith('file://') ? new URL(raw).pathname : raw
    return path.isAbsolute(p) && fs.existsSync(p) ? p : null
  } catch { return null }
}

function attachPlugin(win, { launchArg }) {
  const filePath = fileFromArg(launchArg)
  if (!filePath) return  // launched without a file → behave like a normal app window

  // Without the rclone binary the upload/sync flow can't run; stay inert so the window just
  // loads pkg.url normally instead of getting stuck on the loading page.
  if (!rcloneAvailable()) {
    console.log(TAG, 'rclone binary not found on PATH — plugin inactive')
    return
  }

  // The window was already told to load pkg.url; stop that and show the loading page instead,
  // then navigate to the editor URL once the upload finishes (fall back to pkg.url on error).
  // (In the old base flow app-window.js pre-loaded the loading page; a plugin runs after the
  // initial loadURL, so it cancels it here.)
  //
  // All the page swaps target win._voltageAppContents (set by window.js), NOT win.webContents: when
  // the app also loads the widget plugin it runs in an inset view, where win.webContents is the
  // empty host page — loading there would leave the app view untouched. The two are identical when
  // there's no view mode, so this is a no-op for the usual rclone apps.
  win._voltageAppContents.stop()
  win._voltageAppContents.loadURL(buildLoadingPage())

  resolveEditUrl(filePath, win)
    .then(editUrl => { if (!win.isDestroyed()) win._voltageAppContents.loadURL(editUrl ?? pkg.url) })
    .catch(()     => { if (!win.isDestroyed()) win._voltageAppContents.loadURL(pkg.url) })
}

module.exports = { attachPlugin }
