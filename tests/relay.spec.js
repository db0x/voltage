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

// Setup:    A built app launched normally, and the same app launched WITH a document URL — which
//           app-window.js turns into pkg.url while keeping the configured start URL as startUrl.
// Action:   Resolve the backend root in both.
// Expected: Both yield the service root. This is the case the PDF windows create: without startUrl
//           the second instance would take the document address itself for the backend root and
//           misplace every API call and the home button.
test('the backend root survives a URL launch argument', () => {
  const rel = 'plugins/relay/relay.js'
  const normal = { url: 'http://black/relay', plugins: [rel] }
  const gestartet = {
    url: 'http://black/relay/edit/thomas/bericht.pdf',   // what app-window.js loads
    startUrl: 'http://black/relay',                      // what it preserves
    plugins: [rel],
  }
  expect(plugin.configuredBaseUrl(normal)).toBe('http://black/relay')
  expect(plugin.configuredBaseUrl(gestartet)).toBe('http://black/relay')
  expect(plugin.homeUrl(gestartet)).toBe('http://black/relay/')
  expect(plugin.isEditorUrl(gestartet, 'http://black/relay/edit/thomas/bericht.pdf')).toBe(true)
})

// Setup:    The runtime marker the plugin asks the preload for.
// Action:   Read it.
// Expected: It names the runtime — this is the ONLY reason window.voltage appears in the page, so
//           an app without this plugin hands its pages no way to spawn windows.
test('preloadArgs carries the runtime marker that reveals voltage to the page', () => {
  expect(plugin.preloadArgs()).toEqual(['--voltage-runtime=relay'])
})

// Setup:    A backend hosted under a reverse-proxy path prefix, and addresses around it.
// Action:   Ask whether the page may have its own window for each.
// Expected: Only editor pages of THIS backend. The prefix is part of the bound — a neighbour at the
//           same origin must not pass, which a bare origin check would wave through. Without this
//           the page could talk the runtime into launching instances pointed anywhere.
test('a document window is bounded to this backend, path prefix included', () => {
  const base = 'http://black/relay'
  expect(plugin.mayOpenDocumentWindow(base, 'http://black/relay/edit/thomas/x.pdf')).toBe(true)
  expect(plugin.mayOpenDocumentWindow(base, 'http://black/relay/edit/')).toBe(false)
  expect(plugin.mayOpenDocumentWindow(base, 'http://black/relay/')).toBe(false)
  expect(plugin.mayOpenDocumentWindow(base, 'http://black/relay/admin')).toBe(false)
  expect(plugin.mayOpenDocumentWindow(base, 'http://black/other/edit/x.pdf')).toBe(false)
  expect(plugin.mayOpenDocumentWindow(base, 'http://evil.example/edit/x.pdf')).toBe(false)
  expect(plugin.mayOpenDocumentWindow(base, 'file:///etc/passwd')).toBe(false)
  expect(plugin.mayOpenDocumentWindow(base, '')).toBe(false)
  expect(plugin.mayOpenDocumentWindow(null, 'http://black/relay/edit/x.pdf')).toBe(false)
})

// Setup:    Editor addresses across the document families relay knows (DOCTYPE in its config.js)
//           plus one it does not.
// Action:   Derive the family.
// Expected: The four families the DocumentServer distinguishes — so ONE setting covers .docx,
//           .doc and .odt together instead of one knob per extension. Anything else is null and is
//           never handed out.
test('the document family comes from the extension, four families for all of them', () => {
  const f = (name) => plugin.familieFuer(`http://black/relay/edit/thomas/${name}`)
  expect(f('bericht.pdf')).toBe('pdf')
  expect([f('brief.docx'), f('brief.doc'), f('brief.odt'), f('notiz.txt')]).toEqual(
    ['word', 'word', 'word', 'word'])
  expect([f('zahlen.xlsx'), f('zahlen.ods'), f('liste.csv')]).toEqual(['cell', 'cell', 'cell'])
  expect([f('vortrag.pptx'), f('vortrag.odp')]).toEqual(['slide', 'slide'])
  expect(f('archiv.zip')).toBe(null)
  expect(f('ohne-endung')).toBe(null)
})

// Setup:    An assignment naming a real file for one family and nothing for the others.
// Action:   Resolve the target for each kind of document.
// Expected: Only the assigned family resolves. Everything else yields null — meaning "leave it in
//           relay", which is also what an unconfigured app does: handing documents out is opt-in,
//           so a fresh app behaves exactly like relay in a browser.
test('only an assigned family is handed out, and only to an app that exists', () => {
  const echt = __filename                       // irgendeine existierende Datei als "AppImage"
  const cfg  = { appPdf: echt, appWord: 'inline', appCell: '/nicht/vorhanden/vExcel' }
  const z = (name) => plugin.zielAppImage(cfg, `http://black/relay/edit/thomas/${name}`)

  expect(z('bericht.pdf')).toBe(echt)
  expect(z('brief.docx'), 'ausdrücklich "im relay-Fenster"').toBe(null)
  expect(z('zahlen.xlsx'), 'zugewiesene App gibt es nicht (mehr)').toBe(null)
  expect(z('vortrag.pptx'), 'gar nichts zugewiesen').toBe(null)
  expect(z('archiv.zip'), 'keine Dokumentart').toBe(null)
  expect(plugin.zielAppImage({}, `http://black/relay/edit/x.pdf`), 'unkonfiguriert').toBe(null)
})

// Setup:    The plugin's app discovery, as the manager calls it when opening the gear dialog.
// Action:   List the choosable targets.
// Expected: A first entry that keeps the document in relay, then one entry per BUILT app, each
//           identified by its AppImage PATH. The path is the identity because the runtime cannot
//           see the repo — a built AppImage carries neither webapps/ nor dist/.
test('the dialog offers the built apps, identified by their AppImage path', () => {
  const liste = plugin.stacks()
  expect(Array.isArray(liste)).toBe(true)
  expect(liste[0].id).toBe('inline')
  expect(liste[0].label, 'die Vorgabe braucht einen lesbaren Namen').toBeTruthy()
  for (const eintrag of liste.slice(1)) {
    expect(eintrag.id.startsWith('/'), `${eintrag.id} ist kein absoluter Pfad`).toBe(true)
    expect(eintrag.label).toBeTruthy()
  }
})

// Setup:    Two apps that BOTH load this plugin: the one owning the relay instance, and a viewer
//           that loads it only for local-file handling (a double-clicked .docx arrives as a launch
//           argument, which no other plugin reads). claimsUrl stands in for voltage's resolution.
// Action:   Ask whether the home button belongs in each.
// Expected: Only in the app the document list belongs to. Loading the plugin is deliberately NOT
//           the criterion any more — that would put a "back to the list" button into a viewer whose
//           home is the one document it was opened with, turning it into a second desktop.
test('the home button belongs to the app that owns the document list, not to every plugin user', () => {
  const rel = 'plugins/relay/relay.js'
  const pkg = { url: 'http://black/relay', plugins: [rel, 'plugins/widget/widget.js'] }
  const besitzer   = (url) => url === 'http://black/relay/'   // diese App gewinnt die Auflösung
  const betrachter = () => false                              // eine andere App besitzt die Liste

  expect(plugin.ownsDocumentList(pkg, besitzer)).toBe(true)
  expect(plugin.ownsDocumentList(pkg, betrachter)).toBe(false)

  // Die Frage wird gegen die Wurzel gestellt, nicht gegen irgendeine Editor-Adresse — sonst
  // beantwortete sie ein Betrachter mit seinem eigenen Dateityp-Anspruch mit "ja".
  const nurPdf = (url) => url.endsWith('.pdf')
  expect(plugin.ownsDocumentList(pkg, nurPdf)).toBe(false)

  // Ohne brauchbare App-URL gibt es keine Liste, auf die der Knopf zeigen könnte.
  expect(plugin.ownsDocumentList({ url: 'kaputt', plugins: [rel] }, besitzer)).toBe(false)
  // Und eine App ohne dieses Plugin hat ohnehin keinen.
  expect(plugin.ownsDocumentList({ url: 'http://black/relay', plugins: [] }, besitzer)).toBe(false)
  // Wirft die Auflösung, gilt das als "nein" statt den Fensteraufbau zu sprengen.
  expect(plugin.ownsDocumentList(pkg, () => { throw new Error('kein routing.json') })).toBe(false)
})

// Setup:    The three shapes a launch argument can have: a local file, a document ADDRESS (how a
//           document window is opened), and nothing at all.
// Action:   Classify the launch.
// Expected: Three distinct answers. The middle one is the point: a document window is started with
//           a URL, which is not a local file — reading that as "started with nothing" made a
//           single-type app overwrite the document it was just handed with its create dialog.
test('a launch with an ADDRESS is not a launch with nothing', () => {
  const tmp = path.join(os.tmpdir(), `voltage-relay-start-${process.pid}.docx`)
  fs.writeFileSync(tmp, 'x')
  try {
    expect(plugin.startArt(tmp)).toBe('datei')
    expect(plugin.startArt(`file://${tmp}`)).toBe('datei')

    expect(plugin.startArt('http://localhost:5001/edit/thomas/brief.docx')).toBe('ziel')
    expect(plugin.startArt('https://black/relay/edit/t/x.pdf')).toBe('ziel')
    // Auch ein Pfad, der nicht (mehr) existiert, ist ein Auftrag — nur eben keiner, den wir
    // ausfuehren koennen. "Neues Dokument" waere die falsche Antwort darauf.
    expect(plugin.startArt('/gibt/es/nicht.docx')).toBe('ziel')

    expect(plugin.startArt(null)).toBe('leer')
    expect(plugin.startArt('')).toBe('leer')
    expect(plugin.startArt(undefined)).toBe('leer')
  } finally { fs.rmSync(tmp, { force: true }) }
})

// Setup:    The app configs as built: the desktop app (no file type of its own) and the four
//           viewers, each declaring exactly one.
// Action:   Ask what a launch WITHOUT a file should create.
// Expected: The extension of that app's own type — starting a single-type app from the menu with no
//           document can only mean "a new one of these". The desktop app answers null and keeps its
//           file list. PDF answers null too: relay has no blank for it (backend/blank/), a PDF is
//           exported, not created.
test('an app for one file type knows what a fileless launch should create', () => {
  const W = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const C = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const S = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

  expect(plugin.neueDateiEndung({ mimeTypes: [W] })).toBe('docx')
  expect(plugin.neueDateiEndung({ mimeTypes: [C] })).toBe('xlsx')
  expect(plugin.neueDateiEndung({ mimeTypes: [S] })).toBe('pptx')
  expect(plugin.neueDateiEndung({ mimeTypes: ['application/pdf'] }), 'kein Blank fuer PDF').toBe(null)
  expect(plugin.neueDateiEndung({}), 'die Desktop-App').toBe(null)
  expect(plugin.neueDateiEndung({ mimeTypes: [] })).toBe(null)
  expect(plugin.neueDateiEndung({ mimeTypes: ['text/plain'] }), 'unbekannter Typ').toBe(null)
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
// Action:   Add relay, open its gear dialog, pick an app for PDF, Apply — then reopen.
// Expected: Four choosers, one per document family, each filled from the plugin's discovered apps
//           and each starting on "leave it in relay". The selection round-trips. The two FORMER
//           fields must be gone: the API token (the login session replaced it) and the server URL
//           (the app's own url is the backend root).
test('create dialog: relay offers one app chooser per document family', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await managerPage.click('#create-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'relay' }).click()
  await managerPage.locator('#create-plugin-list .domain-item', { hasText: 'relay' })
    .locator('.domain-configure-btn').click()

  const overlay = managerPage.locator('.plugin-config-overlay:not(.hidden)')
  await expect(overlay).toHaveCount(1)
  await expect(overlay.locator('#relay-config-baseurl')).toHaveCount(0)
  await expect(overlay.locator('#relay-config-apitoken')).toHaveCount(0)

  const waehler = overlay.locator('[data-config-stacks]')
  await expect(waehler).toHaveCount(4)
  for (const key of ['appPdf', 'appWord', 'appCell', 'appSlide'])
    await expect(overlay.locator(`[data-config-stacks="${key}"]`)).toHaveCount(1)

  // Der PDF-Waehler oeffnet die Liste; der erste Eintrag ist "im relay-Fenster lassen".
  await overlay.locator('[data-config-stacks="appPdf"]').click()
  const liste = managerPage.locator('.app-select-list:visible').last()
  await expect(liste.locator('.app-select-item').first()).toBeVisible()
  const gewaehlt = await liste.locator('.app-select-item').first().textContent()
  await liste.locator('.app-select-item').first().click()
  await expect(overlay.locator('[data-config-stacks="appPdf"]')).toContainText(gewaehlt.trim())

  await overlay.locator('.plugin-config-apply').click()
  await expect(managerPage.locator('.plugin-config-overlay:not(.hidden)')).toHaveCount(0)

  await managerPage.locator('#create-plugin-list .domain-item', { hasText: 'relay' })
    .locator('.domain-configure-btn').click()
  await expect(managerPage.locator('[data-config-stacks="appPdf"]')).toContainText(gewaehlt.trim())
})
