const { test, expect, _electron: electron } = require('@playwright/test')
const fs   = require('node:fs')
const os   = require('node:os')
const path = require('node:path')

// e2e for the optional frameless "custom chrome" Manager window (src/manager/window.js + the side-menu
// toggle). The flag lives in manager-state.json under appData; we isolate appData via XDG_CONFIG_HOME
// so each launch starts from a known state and never touches the real config.

const ROOT = path.join(__dirname, '..')

// Launch the Manager with a pre-seeded manager-state.json. Returns the app plus the temp dirs to
// clean up (and so the test can read the persisted state back).
async function launchManager(state) {
  const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-cfg-'))
  fs.mkdirSync(path.join(cfgHome, 'voltage'), { recursive: true })
  fs.writeFileSync(path.join(cfgHome, 'voltage', 'manager-state.json'), JSON.stringify(state))
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-ud-'))
  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, XDG_CONFIG_HOME: cfgHome, VOLTAGE_TEST: '1', VOLTAGE_LANG: 'en', ELECTRON_RUN_AS_NODE: undefined },
  })
  return { app, cfgHome, userDataDir }
}

function cleanup(cfgHome, userDataDir) {
  fs.rmSync(cfgHome, { recursive: true, force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
}

// Setup:    Manager launched with customChrome enabled in manager-state.json.
// Action:   inspect the window chrome.
// Expected: <html> carries the custom-chrome class (frameless/rounded styling active) and the
//           header's own Close button is visible (no native controls in this mode).
test('custom-chrome mode renders the frameless shell with a Close button', async () => {
  const { app, cfgHome, userDataDir } = await launchManager({ customChrome: true, width: 800, height: 700 })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('html')).toHaveClass(/custom-chrome/)
    await expect(win.locator('#window-close')).toBeVisible()
    // Dialog backdrops are clipped to the rounded card (rounded corners), not square over the window.
    const radius = await win.locator('.confirm-overlay').first().evaluate(el => getComputedStyle(el).borderTopLeftRadius)
    expect(radius).not.toBe('0px')
  } finally {
    await app.close().catch(() => {})
    cleanup(cfgHome, userDataDir)
  }
})

// Setup:    a custom-chrome Manager window.
// Action:   click the header Close button.
// Expected: the window closes (→ app quits), proving the custom control replaces the missing native
//           one.
test('custom-chrome Close button closes the window', async () => {
  const { app, cfgHome, userDataDir } = await launchManager({ customChrome: true, width: 800, height: 700 })
  try {
    const win = await app.firstWindow()
    await win.locator('#window-close').click()
    await app.waitForEvent('close')
  } finally {
    await app.close().catch(() => {})
    cleanup(cfgHome, userDataDir)
  }
})

// Setup:    a normal (decorated) Manager window.
// Action:   inspect the chrome.
// Expected: no custom-chrome class and the header Close button stays hidden — the OS frame provides
//           the controls.
test('default mode keeps the native frame (no custom Close button)', async () => {
  const { app, cfgHome, userDataDir } = await launchManager({ width: 800, height: 700 })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('.window-shell')).toBeVisible()
    await expect(win.locator('html')).not.toHaveClass(/custom-chrome/)
    await expect(win.locator('#window-close')).toBeHidden()
  } finally {
    await app.close().catch(() => {})
    cleanup(cfgHome, userDataDir)
  }
})

// Setup:    a normal Manager window with the global settings dialog open.
// Action:   enable the "frameless window" toggle and Save.
// Expected: the flag persists to manager-state.json AND the window is recreated in custom-chrome mode
//           — covering both the persistence and the apply-on-save requirements.
test('settings-dialog toggle persists the flag and recreates the window in custom-chrome mode', async () => {
  const { app, cfgHome, userDataDir } = await launchManager({ width: 800, height: 700 })
  try {
    const win = await app.firstWindow()
    await win.locator('#menu-btn').click()
    await win.locator('#menu-settings').click()
    await expect(win.locator('#gs-custom-chrome')).toBeVisible()

    await win.locator('#gs-custom-chrome').click()
    const newWindow = app.waitForEvent('window')        // Save recreates the window
    await win.locator('#global-settings-save').click()
    const recreated = await newWindow

    await expect(recreated.locator('html')).toHaveClass(/custom-chrome/)
    const state = JSON.parse(fs.readFileSync(path.join(cfgHome, 'voltage', 'manager-state.json'), 'utf8'))
    expect(state.customChrome).toBe(true)
  } finally {
    await app.close().catch(() => {})
    cleanup(cfgHome, userDataDir)
  }
})
