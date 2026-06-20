const { test, expect, _electron: electron } = require('@playwright/test')
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs   = require('node:fs')
const os   = require('node:os')
const path = require('node:path')

// End-to-end test of the *built artifact*, not the Manager UI: it wraps a self-built static page
// into a real AppImage via the production build pipeline (scripts/build.js), launches that AppImage,
// opens the in-app About panel (F12) and verifies its contents — then removes everything it created.
//
// Heavy by nature (a real electron-builder run + launching the packaged app), so it carries its own
// long timeout. The build runs with HOME redirected to a temp dir so its desktop/icon/routing side
// effects are isolated (and wiped on cleanup), while the electron/electron-builder caches stay on
// the real HOME so the build reuses them instead of re-downloading.

const ROOT        = path.join(__dirname, '..')
const CONFIGS_DIR = path.join(ROOT, 'webapps')
const DIST        = path.join(ROOT, 'dist')
const STATIC_PAGE = path.join(__dirname, 'fixtures', 'static-app.html')
const pkg         = require(path.join(ROOT, 'package.json'))

const PROFILE     = 'e2e-about'
const BUILD_LABEL = 'private.e2e-about'                 // scripts/build.js argument
const ARTIFACT    = 'vE2e-about'                        // appName(profile)
const CONFIG_FILE = path.join(CONFIGS_DIR, `build.${BUILD_LABEL}.json`)
const APPIMAGE    = path.join(DIST, ARTIFACT)
const DISPLAY_NAME = 'E2E About App'

// Setup:    A locally served static page is wrapped into a freshly built AppImage via the real
//           build pipeline (HOME redirected so launcher/icon/routing side effects stay in a temp dir).
// Action:   Launch the built AppImage, load the static page, and toggle the About panel with F12.
// Expected: The About overlay reports the app's display name, the "Voltage <version>" build line,
//           the served page's origin as the current domain, and the Electron/Chromium versions —
//           proving the built artifact runs and surfaces correct metadata. Everything is cleaned up.
test('a freshly built AppImage launches and shows correct About content', async () => {
  test.setTimeout(360_000)

  const html   = fs.readFileSync(STATIC_PAGE, 'utf8')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url  = `http://127.0.0.1:${port}/`
  // Idempotent close so the test can make the origin unreachable mid-run and the finally is safe.
  let serverClosed = false
  const closeServer = () => new Promise(r => serverClosed ? r() : (serverClosed = true, server.close(() => r())))

  const tmpHome     = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-build-home-'))
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-about-ud-'))
  const extractDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-extract-'))
  let app

  try {
    // Temp build config pointing the app at the served static page.
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ profile: PROFILE, name: DISPLAY_NAME, url }, null, 2))

    // Build the AppImage through the production script. HOME → temp isolates install side effects;
    // the caches stay on the real HOME so electron isn't re-downloaded.
    await new Promise((resolve, reject) => {
      const child = spawn('node', [path.join('scripts', 'build.js'), BUILD_LABEL], {
        cwd: ROOT,
        env: {
          ...process.env,
          HOME: tmpHome,
          ELECTRON_CACHE:         path.join(os.homedir(), '.cache', 'electron'),
          ELECTRON_BUILDER_CACHE: path.join(os.homedir(), '.cache', 'electron-builder'),
        },
        stdio: 'inherit',
      })
      child.on('exit',  code => code === 0 ? resolve() : reject(new Error(`build.js exited with ${code}`)))
      child.on('error', reject)
    })
    expect(fs.existsSync(APPIMAGE)).toBe(true)

    // Extract the AppImage (built-in, needs no FUSE) and launch its packaged binary directly:
    // Playwright's automation pipe doesn't survive the AppImage runtime's self-extract/re-exec, so
    // driving the inner executable is the reliable way to test exactly what was packaged.
    await new Promise((resolve, reject) => {
      const child = spawn(APPIMAGE, ['--appimage-extract'], { cwd: extractDir, stdio: 'ignore' })
      child.on('exit',  code => code === 0 ? resolve() : reject(new Error(`--appimage-extract exited with ${code}`)))
      child.on('error', reject)
    })
    const innerExe = path.join(extractDir, 'squashfs-root', ARTIFACT)
    expect(fs.existsSync(innerExe)).toBe(true)

    // VOLTAGE_TEST=1 makes the app skip the Wayland/GPU command-line switches it normally sets —
    // those crash the Chromium instance Playwright drives (same reason the Manager tests set it).
    // ELECTRON_RUN_AS_NODE must be cleared: the test runner inherits it, which would make the
    // packaged Electron binary run as plain Node (rejecting --no-sandbox → "Process failed to launch").
    app = await electron.launch({
      executablePath: innerExe,
      // --disable-dev-shm-usage: CI containers give /dev/shm only a few MB, which makes Chromium
      // abort at startup (no window) — the Manager fixture passes it for the same reason.
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${tmpUserData}`],
      env: { ...process.env, VOLTAGE_TEST: '1', VOLTAGE_LANG: 'en', ELECTRON_ENABLE_LOGGING: '1', ELECTRON_RUN_AS_NODE: undefined },
    })

    // Drive everything through the main process via app.evaluate instead of Playwright page objects.
    // On CI, Playwright's page/firstWindow does not surface this packaged app's window (works
    // locally), but the main process is reachable — so we observe the app through Electron's own API.
    const windowInfo = () => app.evaluate(({ app: a, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return {
        count:   BrowserWindow.getAllWindows().length,
        title:   w ? w.webContents.getTitle() : null,
        loading: w ? w.webContents.isLoading() : null,
      }
    })

    // Wait for the app to open its window. If it never does, dump main-process diagnostics (is the
    // app ready? can it create a BrowserWindow at all?) so the CI log shows the real cause.
    try {
      await expect.poll(async () => (await windowInfo()).count, { timeout: 60_000 }).toBeGreaterThan(0)
    } catch (err) {
      const diag = await app.evaluate(({ app: a, BrowserWindow }) => {
        let manualWindow = 'ok'
        try { const w = new BrowserWindow({ show: false }); w.destroy() }
        catch (e) { manualWindow = String(e && e.stack || e) }
        return { ready: a.isReady(), windows: BrowserWindow.getAllWindows().length, manualWindow }
      }).catch(e => ({ evalError: String(e) }))
      console.log('--- main-process diagnostic ---\n' + JSON.stringify(diag, null, 2) + '\n--- end ---')
      throw err
    }

    // The static page actually loaded inside the packaged app (title is set once it finishes).
    await expect.poll(async () => (await windowInfo()).title, { timeout: 30_000 }).toBe('E2E Static Test Page')

    // Toggle the About overlay. F12 is intercepted in window.js via before-input-event; injecting it
    // with sendInputEvent from the main process is reliable regardless of OS keyboard focus.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.focus()
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })
    })

    // The About panel renders in its own WebContentsView laid over the window, so read its text
    // from the main process rather than as a Playwright page.
    const aboutText = () => app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w._voltageAboutView)
      if (!win) return null
      try { return await win._voltageAboutView.webContents.executeJavaScript('document.body.innerText') }
      catch { return null }
    })

    await expect.poll(aboutText, { timeout: 20_000 }).toContain(DISPLAY_NAME)
    const text = await aboutText()
    expect(text).toContain(`Voltage ${pkg.version}`)
    expect(text).toContain(`127.0.0.1:${port}`)
    expect(text).toContain('Electron')
    expect(text).toContain('Chromium')

    // The footer links must open in the system browser (shell.openExternal), not a child window.
    // Stub shell.openExternal to record the URL, click the first footer link, and assert no extra
    // window opened.
    await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = (u) => { global.__opened.push(u); return Promise.resolve() } })
    const windowsBefore = (await windowInfo()).count
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w._voltageAboutView)
      await win._voltageAboutView.webContents.executeJavaScript(`document.querySelector('a[target="_blank"]').click()`)
    })
    await expect.poll(() => app.evaluate(() => global.__opened || [])).toContain('https://github.com/db0x/voltage')
    expect((await windowInfo()).count).toBe(windowsBefore)   // no child window spawned

    // Error page: make the origin unreachable, navigate the app there, and confirm the standardized
    // error screen replaces the (otherwise blank) view rather than leaving nothing.
    await closeServer()
    // loadURL rejects when the guard aborts/replaces it — don't let that reject the evaluate.
    await app.evaluate(({ BrowserWindow }, u) => { BrowserWindow.getAllWindows()[0].webContents.loadURL(u).catch(() => {}) }, url)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('document.documentElement.dataset.voltageError || ""')
    ), { timeout: 20_000 }).toBe('1')

    // Error screen specifics: the brand icon is inlined as an SVG data URL (the page is itself a
    // data: URL and can't load a file:// asset), and a "Close app" button is wired to the preload
    // closeApp bridge — without it a widget app couldn't be dismissed (its window.close is blocked).
    const errorUi = JSON.parse(await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        'JSON.stringify({' +
        '  close: !!document.getElementById("close"),' +
        '  closeApi: typeof (window.electronAPI && window.electronAPI.closeApp),' +
        '  icon: ((document.querySelector("img.glyph")||{}).src||"").slice(0, 24)' +
        '})'
      )
    ))
    expect(errorUi.close).toBe(true)
    expect(errorUi.closeApi).toBe('function')
    expect(errorUi.icon.startsWith('data:image/svg+xml')).toBe(true)
  } finally {
    if (app) await app.close().catch(() => {})
    await closeServer()
    // Remove everything the test created: the config, all dist artifacts for this profile, and the
    // temp dirs (which hold the build's isolated launcher/icon/routing side effects).
    fs.rmSync(CONFIG_FILE, { force: true })
    try {
      for (const f of fs.readdirSync(DIST)) {
        if (f.startsWith(ARTIFACT)) fs.rmSync(path.join(DIST, f), { recursive: true, force: true })
      }
    } catch {}
    fs.rmSync(tmpHome,     { recursive: true, force: true })
    fs.rmSync(tmpUserData, { recursive: true, force: true })
    fs.rmSync(extractDir,  { recursive: true, force: true })
  }
})
