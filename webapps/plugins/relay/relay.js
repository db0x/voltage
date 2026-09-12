// relay plugin (main-process module). The voltage-side client for a self-hosted **relay** server
// (Express backend + OnlyOffice DocumentServer; relay keeps its own desktop as the backend). Today
// it covers relay's document editing: double-click a .docx → the AppImage uploads it via relay's
// file API, navigates to relay's editor page, and pulls the edited file back over the local one
// when the window closes. Named after the service, not that one feature — further
// relay capabilities land here rather than in a second plugin. Mirrors the rclone-sync plugin's
// architecture (launch-arg takeover, loading page, conflict dialog, sync-back on close) with plain
// REST instead of the rclone binary.
//
// Backend contract (see the relay README, "File API"). EVERYTHING below authenticates with the
// app profile's relay LOGIN SESSION — the same cookie the editor page needs. There is no second
// credential any more:
//   GET    <base>/api/session        — { user, csrf } — who are we, and the proof the writing
//                                      calls need (the API is cookie-authenticated, so it is
//                                      covered by relay's CSRF check like every form)
//   GET    <base>/api/files          — list  → { files: [names] }
//   PUT    <base>/api/files/<name>   — upload/overwrite, RAW body        (X-CSRF-Token)
//   GET    <base>/api/files/<name>   — download
//   POST   <base>/api/files/<name>/forcesave                             (X-CSRF-Token)
//   GET    <base>/edit/<name>        — the editor page; /login carries ?next= so the editor
//                                      target survives the first login.
//
// The cookie lives in the app's own persistent partition, so the user logs in ONCE in the app
// window and stays logged in until the profile is discarded (relay sets rolling 90-day sessions).
// This replaces the API token that used to be baked into the AppImage: that was an unlimited
// full-account credential sitting in plaintext in the build, and revoking it meant re-issuing one
// for every client at once.
//
// Reaching the cookie jar is the reason every request goes through `ses.fetch` (Electron's
// Session#fetch, i.e. Chromium's network stack) instead of Node's global fetch — the latter has
// its own stack and would send no cookie at all.
//
// Config: none. The backend root is the app's own `url` (see configuredBaseUrl), and the
// credential is the profile's login session — so there is nothing left to set. The gear dialog
// stays in place for relay capabilities that land here later.

const { app, ipcMain } = require('electron')
const path   = require('node:path')
const fs     = require('node:fs')
const os     = require('node:os')
const crypto = require('node:crypto')

const pkg      = require(app.getAppPath() + '/package.json')
const APP_ROOT = app.getAppPath()
const TAG      = '[relay-plugin]'

// Mustache-style {{key}} substitution for the data: URL HTML pages (no DOM in Node).
function fillHtml(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

const loadingTemplate  = fs.readFileSync(path.join(__dirname, 'loading.html'),  'utf8')
const promptTemplate   = fs.readFileSync(path.join(__dirname, 'prompt.html'),   'utf8')
const conflictTemplate = fs.readFileSync(path.join(__dirname, 'conflict.html'), 'utf8')

// Human-readable byte size for the conflict comparison table.
function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB'
  return b + ' B'
}

// Icons for the conflict dialog header, each as a self-contained data: URL (the page is a data: URL,
// so it can't load file paths). Any missing icon degrades to an empty string in the template.
//   assetDataUrl   — a shared voltage asset (assets/voltage.svg).
//   pluginIconUrl  — this plugin's own badge (plugin.svg next to this file).
//   appIconDataUrl — the installed app icon; installIcon writes it into the "voltage" icon theme, so
//                    that path is tried first, then hicolor (svg preferred, png fallback).
function assetDataUrl(name) {
  const p = path.join(APP_ROOT, 'assets', name)
  return fs.existsSync(p) ? `data:image/svg+xml;base64,${fs.readFileSync(p).toString('base64')}` : null
}
function pluginIconUrl() {
  const p = path.join(__dirname, 'plugin.svg')
  return fs.existsSync(p) ? `data:image/svg+xml;base64,${fs.readFileSync(p).toString('base64')}` : null
}
function appIconDataUrl() {
  try {
    const { appName } = require(path.join(APP_ROOT, 'src', 'app-naming'))
    const name  = appName(pkg.profile)
    const icons = path.join(os.homedir(), '.local', 'share', 'icons')
    const candidates = [
      [path.join(icons, 'voltage', 'scalable', 'apps', `${name}.svg`), 'image/svg+xml'],
      [path.join(icons, 'hicolor', 'scalable', 'apps', `${name}.svg`), 'image/svg+xml'],
      [path.join(icons, 'hicolor', '48x48',    'apps', `${name}.png`), 'image/png'],
    ]
    for (const [p, mime] of candidates)
      if (fs.existsSync(p)) return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`
  } catch { /* no profile / icon theme — the file-row icon is decorative, omit it */ }
  return null
}

const isDe = () => app.getLocale().split('-')[0].toLowerCase() === 'de'

// Normalises a backend root: trims, drops trailing slashes, requires http(s). null = unusable.
// Deliberately does NOT reduce to the origin — a relay behind a reverse proxy lives under a path
// prefix (http://black/relay), and that prefix is part of the root.
function resolveBaseUrl(raw) {
  const url = String(raw ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\/.+/.test(url) ? url : null
}

// The two REST/editor URLs. The filename is a single path segment on the server (secure_filename
// strips separators there), so it is URI-encoded as one component.
function apiFileUrl(base, name) { return `${base}/api/files/${encodeURIComponent(name)}` }
function editUrl(base, name)    { return `${base}/edit/${encodeURIComponent(name)}` }

// Normalises a launch argument to an absolute local file path, or null if it isn't one.
function fileFromArg(raw) {
  if (!raw) return null
  try {
    const p = raw.startsWith('file://') ? new URL(raw).pathname : raw
    return path.isAbsolute(p) && fs.existsSync(p) ? p : null
  } catch { return null }
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// How long the close-time sync waits for the DocumentServer's save round-trip, and how often it polls.
// Normally a forcesave (see forceSave) makes the status-6 callback write the file within ~1s, so the
// short poll catches it in a step or two. The 15s ceiling is only the fallback for an older backend
// without the forcesave endpoint (then we wait out the DS's own ~10s post-disconnect grace).
const SAVE_WAIT_MS = 15_000
const SAVE_POLL_MS = 600

// One call against the backend's file API, authenticated by the app profile's relay session.
//
// `ctx` is that session in the form the rest of this file passes around:
//   ses  — the Electron Session of the app's WebContents. Its fetch() goes through CHROMIUM's
//          network stack, which is the only one that carries the profile's cookie jar; Node's
//          global fetch has its own stack and would arrive unauthenticated.
//   base — the normalised backend root.
//   csrf — the proof from GET /api/session. Needed on everything but GET: the API hangs on a
//          cookie now, so relay checks it like any form (see its csrf.js). It rides in the header
//          rather than the body because a PUT body is raw file bytes, read only AFTER the check.
//
// Returns the Response; throws on network failure/timeout (callers treat any throw as "backend
// unreachable" → online fallback).
function apiFetch(ctx, url, { method = 'GET', body, timeoutMs = 120_000 } = {}) {
  return ctx.ses.fetch(url, {
    method, body,
    credentials: 'include',
    headers: method === 'GET' ? {} : { 'X-CSRF-Token': ctx.csrf ?? '' },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

// Who is this profile logged in to relay as, and what CSRF proof do the writing calls need?
//   { user, csrf } — logged in
//   'anonymous'    — reachable, but not logged in (401)
//   'offline'      — backend unreachable; the caller falls back to loading pkg.url
// Asking a dedicated endpoint rather than scraping <meta name="csrf-token"> out of a page is
// deliberate: at launch the window sits on this plugin's own data: loading page, with no relay
// document to read.
async function sessionInfo(ctx) {
  try {
    const res = await ctx.ses.fetch(`${ctx.base}/api/session`, { credentials: 'include' })
    return res.ok ? await res.json() : 'anonymous'
  } catch { return 'offline' }
}

// Make sure the profile is logged in, sending the user through relay's own login page once if it
// isn't. This is the one thing the API token used to buy: with a baked secret the app was always
// "authenticated", at the price of carrying a permanent full-account credential. Now a 401 simply
// means "log in", which is a page — not a broken configuration — so we show it and carry on.
//
// The password is typed into relay's own form; voltage never sees it, it only ends up holding the
// resulting cookie.
async function ensureSession(win, ctx) {
  const first = await sessionInfo(ctx)
  if (first !== 'anonymous') return first

  const contents = win._voltageAppContents
  contents.loadURL(`${ctx.base}/login`)
  // Wait until relay navigates away from /login — that is the successful sign-in. A closed window
  // resolves too, so this never outlives its window.
  await new Promise(resolve => {
    const done = () => {
      contents.removeListener('did-navigate', onNav)
      win.removeListener('closed', onClosed)
      resolve()
    }
    const onNav    = (_e, url) => { if (!String(url).startsWith(`${ctx.base}/login`)) done() }
    const onClosed = () => done()
    contents.on('did-navigate', onNav)
    win.once('closed', onClosed)
  })
  if (win.isDestroyed()) return 'anonymous'
  // Still not through (e.g. relay sent them to "set your password first")? Then leave them where
  // they are — the caller must not yank the window off that page.
  return await sessionInfo(ctx)
}

function buildLoadingPage(text) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(fillHtml(loadingTemplate, { text }))}`
}

// Two-button prompt page (the sync-back-on-close question). Reuses the generic rclone-confirm preload
// bridge — the page calls window.electronAPI.rcloneConfirm(0|1), which reaches ipcMain 'rclone-confirm';
// the channel is plugin-agnostic plumbing despite its historical name, so no preload change is needed.
function buildPromptPage(vars) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(fillHtml(promptTemplate, vars))}`
}

// Rich overwrite/conflict page: a local-vs-server comparison (modified time + size) so the user sees
// what differs before choosing. `remote` carries what we learned from the download the caller already
// did — mtime from the Last-Modified header (res.download sets it), size from the body length — so no
// extra metadata endpoint is needed. Either value may be null on an odd server and degrades gracefully.
function buildConfirmPage(filename, localStat, remote, de) {
  const html = fillHtml(conflictTemplate, {
    title:       de ? 'Datei überschreiben?' : 'Overwrite file?',
    btnOpen:     de ? 'Bestehende öffnen'    : 'Open existing',
    btnOver:     de ? 'Überschreiben'        : 'Overwrite',
    labelLocal:  de ? 'Lokal'                : 'Local',
    labelServer: 'relay',
    labelMod:    de ? 'Geändert'             : 'Modified',
    labelSize:   de ? 'Größe'                : 'Size',
    localMod:    localStat.mtime.toLocaleString(),
    localSize:   fmtBytes(localStat.size),
    remMod:      remote.mtime ? new Date(remote.mtime).toLocaleString() : (de ? 'unbekannt' : 'unknown'),
    remSize:     remote.size != null ? fmtBytes(remote.size) : '–',
    filename,
    voltageIconHtml: assetDataUrl('voltage.svg') ? `<img src="${assetDataUrl('voltage.svg')}" alt="voltage">` : '',
    syncIconHtml:    pluginIconUrl() ? `<span class="header-sync-badge"><img src="${pluginIconUrl()}" alt=""></span>` : '',
    appIconHtml:     appIconDataUrl() ? `<img class="file-icon" src="${appIconDataUrl()}" alt="">` : '',
  })
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

// Loads a confirm page (built by the caller) and resolves 0 (primary button) / 1 (secondary). A closed
// window counts as 1 (the non-destructive choice), and the IPC listener is always detached.
function awaitConfirm(win, pageUrl) {
  return new Promise(resolve => {
    const done    = (v) => { ipcMain.removeListener('rclone-confirm', onIpc); win.removeListener('closed', onClose); resolve(v) }
    const onIpc   = (_e, v) => done(v)
    const onClose = ()      => done(1)
    ipcMain.once('rclone-confirm', onIpc)
    win.once('closed', onClose)
    if (!win.isDestroyed()) win._voltageAppContents.loadURL(pageUrl)
  })
}

// The simple two-button prompt (sync-back on close) goes through the same plumbing.
function askPrompt(win, vars) {
  return awaitConfirm(win, buildPromptPage(vars))
}

// Polls the server file until its content differs from `baselineHash` (the state at editor-open) —
// i.e. until the DocumentServer's post-close save callback has landed — and returns the new bytes.
// Returns null when nothing changed within the window: a viewed-only session never triggers a save,
// so there is nothing to pull. The first probe runs immediately, catching mid-session saves at once.
async function waitForSavedVersion(ctx, name, baselineHash, waitMs = SAVE_WAIT_MS) {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const res = await apiFetch(ctx, apiFileUrl(ctx.base, name), { timeoutMs: 10_000 })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        if (md5(buf) !== baselineHash) return buf
      }
    } catch { /* transient poll failure — keep trying until the deadline */ }
    if (Date.now() >= deadline) return null
    await sleep(SAVE_POLL_MS)
  }
}

// Asks the backend to forcesave the open editor session NOW (see the backend's /forcesave endpoint),
// so the edited file is written within ~1s instead of after the DocumentServer's ~10s post-disconnect
// grace. Returns { saved, reason } | null. null = endpoint missing/unreachable (older backend) → the
// caller falls back to plain polling. `saved:false, reason:"no-changes"` means nothing to sync.
async function forceSave(ctx, name) {
  try {
    const res = await apiFetch(ctx, `${apiFileUrl(ctx.base, name)}/forcesave`, { method: 'POST', timeoutMs: 10_000 })
    if (res.ok) return await res.json()
  } catch { /* unreachable / not implemented → fall back */ }
  return null
}

// On window close, pull the edited server file back over the local path. `baselineHash` is the
// server-side content at editor-open time; the close waits (bounded) for a save NEWER than that —
// see SAVE_WAIT_MS for why downloading immediately would fetch the pre-edit state.
//   prompt      — ask first (used when the user chose the server version over their local file; the
//                 local copy must not be overwritten without consent). Silent otherwise: uploading
//                 was the commitment to the local→server→local round-trip.
//   alwaysWrite — write the server version even when no NEW save arrives (the open-existing path:
//                 the server file already differed from local, so "overwrite" must apply it).
// Best-effort: failures leave the local file untouched and never block the window from closing.
function registerSyncBack(win, ctx, name, localPath, baselineHash, { prompt = false, alwaysWrite = false } = {}) {
  if (win.isDestroyed()) return
  const de = isDe()
  win.once('close', async (event) => {
    event.preventDefault()
    if (prompt) {
      const choice = await askPrompt(win, {
        title:   de ? 'Lokale Datei aktualisieren?' : 'Update local file?',
        message: de
          ? `„${name}" wurde auf dem Server geöffnet. Soll die lokale Datei mit der Server-Version überschrieben werden?`
          : `“${name}” was opened on the server. Overwrite the local file with the server version?`,
        btnPrimary:   de ? 'Überschreiben'  : 'Overwrite',
        btnSecondary: de ? 'Lokal behalten' : 'Keep local',
      })
      if (choice !== 0) { if (!win.isDestroyed()) win.destroy(); return }
    }
    // Ask the server to save the open session now. Its result tells us whether a NEW write is being
    // produced — it does NOT mean the server file matches what we uploaded: the DocumentServer
    // autosaves during editing, so by close time the edits are often already on the server and
    // forcesave then correctly reports "no-changes" while the server copy still DIFFERS from our
    // upload. So the pull decision is always the content comparison below (md5 vs. baseline); the
    // forcesave result only bounds how long we wait for a still-pending write to land. (Trusting
    // "no-changes" to skip the pull silently dropped every autosaved edit — the sync-back regression.)
    const forced = await forceSave(ctx, name)
    const noNewSave = forced?.saved === false && forced.reason === 'no-changes'
    if (!win.isDestroyed()) win._voltageAppContents.loadURL(buildLoadingPage(de ? 'Wird synchronisiert …' : 'Syncing …'))
    try {
      // noNewSave → nothing further is being written, but the session may already have autosaved
      // edits; waitForSavedVersion probes immediately, so those are caught at once and a short wait
      // suffices (a truly view-only close then returns fast instead of hanging the ceiling). Otherwise
      // wait the full window for the pending save (forcesave lands it in ~1s; the older-backend
      // fallback, forced === null, waits out the DS's ~10s grace).
      const waitMs = noNewSave ? 1500 : SAVE_WAIT_MS
      let buf = await waitForSavedVersion(ctx, name, baselineHash, waitMs)
      if (!buf && alwaysWrite) {
        const res = await apiFetch(ctx, apiFileUrl(ctx.base, name))
        if (res.ok) buf = Buffer.from(await res.arrayBuffer())
      }
      if (buf) { fs.writeFileSync(localPath, buf); console.log(TAG, `synced back: ${localPath}`) }
      else console.log(TAG, 'sync-back: no newer server version — local file left as-is')
    } catch (err) { console.log(TAG, 'sync-back failed:', err.message) }
    if (!win.isDestroyed()) win.destroy()
  })
}

// Uploads the local file (raw-body PUT, matching `curl -T`) and returns whether the server took it.
async function upload(ctx, name, localPath) {
  const res = await apiFetch(ctx, apiFileUrl(ctx.base, name), { method: 'PUT', body: fs.readFileSync(localPath) })
  if (!res.ok) console.log(TAG, `upload failed: server answered ${res.status}`)
  return res.ok
}

// The full launch flow: decide upload vs. conflict, register the sync-back, return the editor URL —
// or null on any failure (the caller then falls back to pkg.url, the backend's file list).
async function resolveLaunchUrl(win, ctx, localPath) {
  const name = path.basename(localPath)
  const de   = isDe()

  // Does the file already exist in the user's server folder? (List = names only, so content is
  // compared by downloading + hashing — Office files are small enough for that to be instant.)
  const listRes = await apiFetch(ctx, `${ctx.base}/api/files`, { timeoutMs: 15_000 })
  if (!listRes.ok) { console.log(TAG, `file list failed: server answered ${listRes.status}`); return null }
  const { files = [] } = await listRes.json().catch(() => ({}))

  const localHash = md5(fs.readFileSync(localPath))

  if (files.includes(name)) {
    const remoteRes = await apiFetch(ctx, apiFileUrl(ctx.base, name))
    const remoteBuf = remoteRes.ok ? Buffer.from(await remoteRes.arrayBuffer()) : null
    if (remoteBuf && md5(remoteBuf) === localHash) {
      // Identical → nothing to upload; still sync back silently (the server copy may get edited).
      registerSyncBack(win, ctx, name, localPath, localHash)
      return editUrl(ctx.base, name)
    }
    // Same name, different content → the user decides which version wins, shown a local-vs-server
    // comparison. Server mtime/size come from the download we just did (res.download sets Last-Modified
    // + Content-Length), so no extra metadata call is needed.
    const choice = await awaitConfirm(win, buildConfirmPage(name, fs.statSync(localPath), {
      mtime: remoteRes.headers.get('last-modified'),
      size:  remoteBuf ? remoteBuf.length : null,
    }, de))
    if (win.isDestroyed()) return null
    if (choice !== 0) {
      // Keep the server version: local stays untouched for now, so ask before pulling it back — and
      // if the user then confirms, apply the server version even without a NEW save (it differed
      // from local from the start; baseline = the server state we just downloaded).
      registerSyncBack(win, ctx, name, localPath, remoteBuf ? md5(remoteBuf) : localHash,
        { prompt: true, alwaysWrite: true })
      return editUrl(ctx.base, name)
    }
    win._voltageAppContents.loadURL(buildLoadingPage(de ? 'Wird hochgeladen …' : 'Uploading …'))
  }

  if (!await upload(ctx, name, localPath)) return null
  // Baseline = exactly what was uploaded: only a DS save NEWER than that must be pulled back.
  registerSyncBack(win, ctx, name, localPath, localHash)
  return editUrl(ctx.base, name)
}

// ---- Host-side helpers (called by window.js, not by attachPlugin) -----------------------------
// The widget drag-zone's home button is a relay feature rendered by the host: window.js asks
// THIS module about the backend's URL space instead of hardcoding it, so the layout knowledge
// (<base>/edit/… vs. the document list at <base>/) stays in the plugin — including the
// reverse-proxy path-prefix case (http://black/relay), where origin-root heuristics fail.

// The backend root of a BUILT app: its own start URL. There is no separate setting for this, and
// deliberately so — a relay app opens the document list, and that list IS the instance root, the
// same root /api/ and /edit/ hang off. A second field would only be another place for the two to
// drift apart (they did: an app once pointed at localhost while its home button went to a public
// host). null when the app doesn't load this plugin, or its URL isn't usable — inert either way.
function configuredBaseUrl(pkg) {
  const rel = (pkg.plugins ?? []).find(p => /(^|\/)relay\//.test(p))
  return rel ? resolveBaseUrl(pkg.url) : null
}

// Whether `url` is one of the backend's editor pages — the drag-zone shows the home button only
// there (on the document list it would be a no-op). With an unusable app URL fall back to a
// bare-path check so manual testing still behaves sensibly.
function isEditorUrl(pkg, url) {
  const base = configuredBaseUrl(pkg)
  if (base) return String(url ?? '').startsWith(`${base}/edit/`)
  try { return new URL(url).pathname.startsWith('/edit/') } catch { return false }
}

// The home button's target: the backend's document list — the app's own URL, normalised.
function homeUrl(pkg) {
  const base = configuredBaseUrl(pkg)
  return base ? `${base}/` : pkg.url
}

function attachPlugin(win, api) {
  const filePath = fileFromArg(api.launchArg)
  if (!filePath) return  // launched without a file → normal window (file list; log in there once)

  const base = resolveBaseUrl(pkg.url)
  if (!base) {
    console.log(TAG, `app URL unusable as a backend root (${pkg.url}) — plugin inactive`)
    return
  }

  // Take over the initial load (window.js already kicked off pkg.url): loading page now, editor URL
  // once the upload settles. All page swaps target win._voltageAppContents — with the widget plugin
  // the app lives in an inset view, where win.webContents is only the transparent host page.
  const contents = win._voltageAppContents
  contents.stop()
  contents.loadURL(buildLoadingPage(isDe() ? 'Wird hochgeladen …' : 'Uploading …'))

  // The app's own Session carries the relay login cookie — see apiFetch for why it has to be this
  // one and not Node's fetch.
  const ctx = { ses: contents.session, base, csrf: null }

  ensureSession(win, ctx)
    .then(async info => {
      if (win.isDestroyed()) return
      // Backend down → behave exactly as a failed API call always did: load the app's URL.
      if (info === 'offline') { contents.loadURL(pkg.url); return }
      // Login didn't complete (cancelled, or relay is insisting on a password change first). The
      // window is sitting on relay's own page for that — leave it there rather than navigating
      // away from what the user still has to do.
      if (info === 'anonymous') { console.log(TAG, 'not signed in — leaving the user on relay'); return }

      ctx.csrf = info.csrf
      contents.loadURL(buildLoadingPage(isDe() ? 'Wird hochgeladen …' : 'Uploading …'))
      const url = await resolveLaunchUrl(win, ctx, filePath)
      if (!win.isDestroyed()) contents.loadURL(url ?? pkg.url)
    })
    .catch(err => {
      console.log(TAG, 'launch flow failed:', err.message)
      if (!win.isDestroyed()) contents.loadURL(pkg.url)
    })
}

// Helpers exported for the unit tests; configurable → gear dialog (config.html).
module.exports = { attachPlugin, fileFromArg, resolveBaseUrl, apiFileUrl, editUrl, sessionInfo, waitForSavedVersion, forceSave, buildConfirmPage, fmtBytes, configuredBaseUrl, isEditorUrl, homeUrl, configurable: true }
