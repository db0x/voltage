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

    // Capture the packaged app's own stdout/stderr so a failure to open a window (seen only on CI)
    // surfaces the real reason — a main-process exception or a Chromium startup error — instead of a
    // bare Playwright timeout.
    const appLog = []
    app.process().stdout?.on('data', d => appLog.push(`[out] ${d}`))
    app.process().stderr?.on('data', d => appLog.push(`[err] ${d}`))

    // A cold-extracted binary plus software rendering is slow to first paint on CI runners.
    let page
    try {
      page = await app.firstWindow({ timeout: 60_000 })
    } catch (err) {
      console.log('--- packaged app output (no window appeared) ---\n' + appLog.join('') + '\n--- end ---')
      throw err
    }
    await page.waitForLoadState('domcontentloaded')
    // The static page actually loaded inside the packaged app.
    await expect(page).toHaveTitle('E2E Static Test Page')

    // Toggle the About overlay. F12 is intercepted in window.js via before-input-event; injecting it
    // with sendInputEvent from the main process is more reliable than a Playwright keypress, which
    // depends on the window holding OS keyboard focus on a live desktop.
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
  } finally {
    if (app) await app.close().catch(() => {})
    await new Promise(resolve => server.close(resolve))
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
