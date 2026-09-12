const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const os   = require('node:os')
const path = require('node:path')

// The relay plugin: node-level tests for its pure helpers (URL building, config validation,
// launch-arg parsing — the REST flow itself needs the live backend and is not exercised in CI) plus
// Manager e2e for its config dialog.

const PLUGIN = path.join(__dirname, '..', 'webapps', 'plugins', 'relay', 'relay.js')

// The plugin is a main-process module and requires electron's `app` at load time; in Playwright's
// plain-node runner require('electron') resolves to the npm stub (a binary path string), not the
// API. For the pure helpers that context is irrelevant, so the electron entry in the require cache
// is swapped for a minimal `app` stub just long enough to load the module.
function loadPluginWithStub() {
  const electronPath = require.resolve('electron')
  const stub = {
    exports: {
      app: {
        getAppPath: () => path.join(__dirname, '..'),
        getLocale:  () => 'en-US',
        getPath:    () => os.tmpdir(),
      },
      ipcMain: { once: () => {}, removeListener: () => {} },
    },
  }
  const prev = require.cache[electronPath]
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: stub.exports }
  delete require.cache[require.resolve(PLUGIN)]
  try { return require(PLUGIN) }
  finally {
    if (prev) require.cache[electronPath] = prev
    else delete require.cache[electronPath]
  }
}
const plugin = loadPluginWithStub()

// Setup:    Configured base URLs in valid and broken shapes.
// Action:   Resolve them.
// Expected: Trailing slashes are trimmed, non-http(s)/empty values yield null — a broken URL must
//           leave the plugin inert instead of producing requests against garbage.
test('resolveBaseUrl normalises the server URL and rejects garbage', () => {
  expect(plugin.resolveBaseUrl('http://192.168.0.33:5001/')).toBe('http://192.168.0.33:5001')
  expect(plugin.resolveBaseUrl('https://oo.lan///')).toBe('https://oo.lan')
  // A reverse-proxy path prefix is PART of the root and must survive — reducing to the origin here
  // would send every API call to the wrong place.
  expect(plugin.resolveBaseUrl('http://black/relay/')).toBe('http://black/relay')
  expect(plugin.resolveBaseUrl('192.168.0.33:5001')).toBe(null)
  expect(plugin.resolveBaseUrl('')).toBe(null)
  expect(plugin.resolveBaseUrl(undefined)).toBe(null)
})

// Setup:    A base URL and filenames incl. one needing URI escaping.
// Action:   Build the API and editor URLs.
// Expected: The name is encoded as ONE path segment (matching the server's :fid route param), so
//           spaces/umlauts survive and a slash can't smuggle extra path segments in.
test('apiFileUrl/editUrl encode the filename as a single segment', () => {
  expect(plugin.apiFileUrl('http://x:5001', 'brief.docx')).toBe('http://x:5001/api/files/brief.docx')
  expect(plugin.editUrl('http://x:5001', 'brief.docx')).toBe('http://x:5001/edit/brief.docx')
  expect(plugin.apiFileUrl('http://x:5001', 'Änderung 2.docx')).toBe('http://x:5001/api/files/%C3%84nderung%202.docx')
  expect(plugin.editUrl('http://x:5001', 'a/b.docx')).toBe('http://x:5001/edit/a%2Fb.docx')
})

// Setup:    Launch arguments in the shapes app-window.js forwards (bare path, file:// URL, URLs,
//           nothing), with a real temp file for the positive cases.
// Action:   Parse them.
// Expected: Only an existing absolute local file resolves; everything else is null so the plugin
//           stays inert on a normal (file-less) launch.
test('fileFromArg accepts only existing absolute local files', () => {
  const tmp = path.join(os.tmpdir(), `voltage-oo-test-${process.pid}.docx`)
  fs.writeFileSync(tmp, 'x')
  try {
    expect(plugin.fileFromArg(tmp)).toBe(tmp)
    expect(plugin.fileFromArg(`file://${tmp}`)).toBe(tmp)
    expect(plugin.fileFromArg('/does/not/exist.docx')).toBe(null)
    expect(plugin.fileFromArg('https://example.com/x.docx')).toBe(null)
    expect(plugin.fileFromArg(null)).toBe(null)
  } finally { fs.rmSync(tmp, { force: true }) }
})

// Minimal stand-in for the backend's GET /api/files/<name>: serves `bytes` (mutable via setBytes)
// and records what the request carried. Runs on an ephemeral port; close() tears it down.
function stubBackend(initialBytes) {
  const http = require('node:http')
  let bytes = initialBytes
  let lastCookie = null
  const srv = http.createServer((req, res) => {
    lastCookie = req.headers.cookie
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(bytes)
  })
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`,
    setBytes:  (b) => { bytes = b },
    getCookie: () => lastCookie,
    close:     () => new Promise(r => srv.close(r)),
  })))
}

// The auth context the plugin passes around (see relay.js: apiFetch). In the app it is the
// WebContents' Electron Session, whose fetch() carries the profile's relay cookie; here a plain
// object with a fetch() is enough — the point of the tests is the protocol, not the cookie jar.
// The stand-in DOES send a cookie, so the tests can assert the calls are authenticated at all.
function ctxFor(base, { csrf = 'csrf-proof', cookie = 'relay.sid=s3ss10n' } = {}) {
  return {
    base,
    csrf,
    ses: {
      fetch: (url, init = {}) => fetch(url, {
        ...init,
        headers: { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
      }),
    },
  }
}

const md5 = (buf) => require('node:crypto').createHash('md5').update(buf).digest('hex')

// Setup:    A stub backend still serving the uploaded state; the "save" (new content) lands 300 ms
//           later — modelling the DocumentServer's post-close callback delay.
// Action:   waitForSavedVersion with the uploaded state's hash as baseline.
// Expected: It polls past the stale state and returns the NEW bytes (with the session cookie on
//           the requests) — the reason sync-back must wait instead of downloading immediately.
test('waitForSavedVersion waits out the DocumentServer save delay', async () => {
  const server = await stubBackend(Buffer.from('uploaded-state'))
  try {
    setTimeout(() => server.setBytes(Buffer.from('edited-state')), 300)
    const buf = await plugin.waitForSavedVersion(ctxFor(server.base), 'x.docx', md5(Buffer.from('uploaded-state')), 5000)
    expect(buf?.toString()).toBe('edited-state')
    expect(server.getCookie()).toBe('relay.sid=s3ss10n')
  } finally { await server.close() }
})

// Setup:    A stub backend whose content never changes (a viewed-only session — DS never saves).
// Action:   waitForSavedVersion with that content's hash and a short window.
// Expected: null — no newer version means the local file must be left untouched, not overwritten
//           with a re-download of what was uploaded.
test('waitForSavedVersion returns null when no save ever arrives', async () => {
  const server = await stubBackend(Buffer.from('uploaded-state'))
  try {
    const buf = await plugin.waitForSavedVersion(ctxFor(server.base), 'x.docx', md5(Buffer.from('uploaded-state')), 500)
    expect(buf).toBe(null)
  } finally { await server.close() }
})

// Setup:    A stub backend already serving content that differs from the baseline (a mid-session
//           save that landed before the window closed).
// Action:   waitForSavedVersion.
// Expected: Returns immediately on the first probe — the happy path costs no polling delay.
test('waitForSavedVersion returns immediately when the save already landed', async () => {
  const server = await stubBackend(Buffer.from('edited-state'))
  try {
    const t0 = Date.now()
    const buf = await plugin.waitForSavedVersion(ctxFor(server.base), 'x.docx', md5(Buffer.from('uploaded-state')), 5000)
    expect(buf?.toString()).toBe('edited-state')
    expect(Date.now() - t0).toBeLessThan(1000)
  } finally { await server.close() }
})

// Minimal stand-in for the backend's POST /api/files/<name>/forcesave: replies with a fixed JSON
// (or 404 to model an older backend without the endpoint) and records method, CSRF proof and URL.
function forcesaveStub(reply, status = 200) {
  const http = require('node:http')
  let seen = null
  const srv = http.createServer((req, res) => {
    seen = { method: req.method, csrf: req.headers['x-csrf-token'], url: req.url }
    if (status === 404) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply))
  })
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`,
    seen: () => seen,
    close: () => new Promise(r => srv.close(r)),
  })))
}

// Setup:    A backend reporting a forcesave result.
// Action:   Call forceSave.
// Expected: It POSTs to /api/files/<name>/forcesave carrying the CSRF proof (relay's file API is
//           cookie-authenticated and therefore CSRF-checked like any form) and returns the parsed
//           JSON — the signal the close handler uses to bound the sync-wait.
test('forceSave POSTs to the forcesave endpoint and returns the result', async () => {
  const server = await forcesaveStub({ saved: false, reason: 'no-changes' })
  try {
    const result = await plugin.forceSave(ctxFor(server.base, { csrf: 'proof9' }), 'x.docx')
    expect(result).toEqual({ saved: false, reason: 'no-changes' })
    expect(server.seen()).toEqual({ method: 'POST', csrf: 'proof9', url: '/api/files/x.docx/forcesave' })
  } finally { await server.close() }
})

// Setup:    An older backend without the endpoint (404).
// Action:   Call forceSave.
// Expected: null — a missing/unreachable endpoint must let the caller fall back to plain polling
//           rather than throwing or blocking the window close.
test('forceSave returns null when the endpoint is missing (older backend)', async () => {
  const server = await forcesaveStub(null, 404)
  try {
    expect(await plugin.forceSave(ctxFor(server.base), 'x.docx')).toBe(null)
  } finally { await server.close() }
})

// Setup:    Built-app package.json shapes: plugin configured (with a reverse-proxy path prefix),
//           plugin unconfigured, plugin absent.
// Action:   Resolve the backend root / editor detection / home target window.js asks the plugin for
//           (the drag-zone home button).
// Expected: configuredBaseUrl is the app's OWN url, normalised — there is no separate setting, so
//           the two can no longer disagree; isEditorUrl matches ONLY <base>/edit/… (a prefix-hosted
//           list page like /relay must not count as editor, and /relay/edit/ must count even though
//           its origin-root path isn't /edit/); homeUrl targets the list under the prefix, not "/"
//           of the origin. A pkg without this plugin, or with an unusable url, yields null.
test('configuredBaseUrl/isEditorUrl/homeUrl derive from the app URL and honour a path prefix', () => {
  const rel = 'plugins/relay/relay.js'
  const pkg = { url: 'http://black/relay/', plugins: [rel, 'plugins/widget/widget.js'] }
  expect(plugin.configuredBaseUrl(pkg)).toBe('http://black/relay')
  expect(plugin.isEditorUrl(pkg, 'http://black/relay/edit/brief.docx')).toBe(true)
  expect(plugin.isEditorUrl(pkg, 'http://black/relay/')).toBe(false)
  expect(plugin.isEditorUrl(pkg, 'http://black/edit/x.docx')).toBe(false)
  expect(plugin.isEditorUrl(pkg, 'data:text/html,spinner')).toBe(false)
  expect(plugin.homeUrl(pkg)).toBe('http://black/relay/')

  // A leftover pluginConfig block from an older build must not influence anything any more.
  const alt = { url: 'http://x:5001/', plugins: [rel], pluginConfig: { [rel]: { baseUrl: 'http://stale/' } } }
  expect(plugin.configuredBaseUrl(alt)).toBe('http://x:5001')
  expect(plugin.homeUrl(alt)).toBe('http://x:5001/')

  expect(plugin.configuredBaseUrl({ url: 'http://x/', plugins: ['plugins/widget/widget.js'] })).toBe(null)
  expect(plugin.configuredBaseUrl({ url: 'not-a-url', plugins: [rel] })).toBe(null)
})

// Setup:    Byte counts across the KB/MB/GB thresholds.
// Action:   Format them for the conflict comparison table.
// Expected: Compact human-readable units — the table must stay legible, not print raw byte counts.
test('fmtBytes renders compact human sizes', () => {
  expect(plugin.fmtBytes(512)).toBe('512 B')
  expect(plugin.fmtBytes(2048)).toBe('2 KB')
  expect(plugin.fmtBytes(5_400_000)).toBe('5.4 MB')
})

// Setup:    A local file stat and the server metadata learned from the download (Last-Modified + body
//           length), as the conflict branch passes them.
// Action:   Build the rich overwrite/conflict page.
// Expected: The data: URL embeds both columns' formatted size and the filename, so the user actually
//           sees local-vs-server before deciding; a missing server mtime falls back to a placeholder
//           instead of "Invalid Date".
test('buildConfirmPage embeds the local-vs-server comparison', () => {
  const localStat = { mtime: new Date('2026-01-02T03:04:05Z'), size: 12_345 }
  const withMod = decodeURIComponent(
    plugin.buildConfirmPage('brief.docx', localStat, { mtime: 'Wed, 01 Jan 2026 00:00:00 GMT', size: 20_000 }, true))
  expect(withMod).toContain('brief.docx')
  expect(withMod).toContain('12 KB')   // local size
  expect(withMod).toContain('20 KB')   // server size
  expect(withMod).toContain('relay')   // server column label

  // A server without a Last-Modified header must not produce "Invalid Date".
  const noMod = decodeURIComponent(plugin.buildConfirmPage('x.docx', localStat, { mtime: null, size: null }, false))
  expect(noMod).toContain('unknown')
  expect(noMod).not.toContain('Invalid Date')
})

// Setup:    Create dialog open; plugins discovered from the real webapps/plugins tree.
// Action:   Add relay, open its gear dialog, close it again with Apply.
// Expected: The dialog opens and asks for NOTHING — both former fields are gone on purpose: the
//           API token (the profile's login session replaces it) and the server URL (the app's own
//           url is the backend root, see relay.js: configuredBaseUrl). The empty shell is kept
//           deliberately for relay capabilities that land here later, so it must still open, show
//           its explanatory hint and close cleanly rather than throw on a dialog with no controls.
test('create dialog: relay ships a config dialog that asks for nothing', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await managerPage.click('#create-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'relay' }).click()
  await managerPage.locator('#create-plugin-list .domain-item', { hasText: 'relay' })
    .locator('.domain-configure-btn').click()

  const overlay = managerPage.locator('.plugin-config-overlay:not(.hidden)')
  await expect(overlay).toHaveCount(1)
  await expect(overlay.locator('[data-config-key]')).toHaveCount(0)
  await expect(overlay.locator('#relay-config-baseurl')).toHaveCount(0)
  await expect(overlay.locator('#relay-config-apitoken')).toHaveCount(0)
  await expect(overlay.locator('.field-hint')).not.toBeEmpty()

  await overlay.locator('.plugin-config-apply').click()
  await expect(managerPage.locator('.plugin-config-overlay:not(.hidden)')).toHaveCount(0)

  // and it reopens just as cleanly
  await managerPage.locator('#create-plugin-list .domain-item', { hasText: 'relay' })
    .locator('.domain-configure-btn').click()
  await expect(managerPage.locator('.plugin-config-overlay:not(.hidden)')).toHaveCount(1)
})
