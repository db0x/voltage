const { test, expect, _electron: electron } = require('@playwright/test')
const fs   = require('node:fs')
const os   = require('node:os')
const path = require('node:path')

// e2e for the "app unavailable" notice window — the Voltage-styled dialog the generic launcher
// (src/launcher.js) opens when an app's AppImage is unreachable (e.g. its project directory is still
// encrypted). It runs in Manager context via main.js's --voltage-notice dispatch, so this launches
// the app in that mode directly rather than through the shell launcher.

const ROOT = path.join(__dirname, '..')

// Setup:    launch the app in notice mode for app "Teams", English UI (VOLTAGE_LANG=en).
// Action:   read the rendered dialog.
// Expected: the localized title and body both carry the interpolated app name, plus a Close button.
test('notice window shows the localized unavailable message', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-notice-'))
  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--user-data-dir=${userDataDir}`, '--voltage-notice=Teams'],
    env: { ...process.env, VOLTAGE_TEST: '1', VOLTAGE_LANG: 'en', ELECTRON_RUN_AS_NODE: undefined },
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('#notice-title')).toContainText('Teams')
    await expect(win.locator('#notice-title')).toContainText('started')
    await expect(win.locator('#notice-body')).toContainText('AppImage')
    await expect(win.locator('#notice-body')).toContainText('Teams')
    await expect(win.locator('#notice-ok')).toHaveText('Close')
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
})

// Setup:    a HOME with the failed app's icon installed in Voltage's private theme
//           (~/.local/share/icons/voltage/scalable/apps/vIconTest.svg). HOME is isolated so the
//           test is deterministic regardless of what the real machine has installed.
// Action:   open the notice for artifact "vIconTest".
// Expected: the dialog shows THAT app's icon (not the generic Voltage logo), so the user sees which
//           app is affected.
test('notice window shows the failed app\'s own installed icon', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-home-'))
  const iconDir = path.join(home, '.local', 'share', 'icons', 'voltage', 'scalable', 'apps')
  fs.mkdirSync(iconDir, { recursive: true })
  fs.writeFileSync(path.join(iconDir, 'vIconTest.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-notice-'))
  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--user-data-dir=${userDataDir}`, '--voltage-notice=vIconTest'],
    env: { ...process.env, HOME: home, VOLTAGE_TEST: '1', VOLTAGE_LANG: 'en', ELECTRON_RUN_AS_NODE: undefined },
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('#notice-icon')).toHaveAttribute('src', /vIconTest\.svg$/)
    // The leading "v" is stripped for the human-readable display name.
    await expect(win.locator('#notice-body')).toContainText('IconTest')
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// Setup:    an isolated, empty HOME (no installed icons) so resolution is deterministic.
// Action:   open the notice for an artifact with no installed icon.
// Expected: the dialog falls back to the bundled Voltage logo rather than showing a broken image.
test('notice window falls back to the Voltage logo when no app icon is installed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-home-'))
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-notice-'))
  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--user-data-dir=${userDataDir}`, '--voltage-notice=vNoIcon'],
    env: { ...process.env, HOME: home, VOLTAGE_TEST: '1', VOLTAGE_LANG: 'en', ELECTRON_RUN_AS_NODE: undefined },
  })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('#notice-icon')).toHaveAttribute('src', /voltage\.svg$/)
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// Setup:    a notice window open for "Teams".
// Action:   click the Close button.
// Expected: closing the only window quits the process (main.js window-all-closed → app.quit()), so
//           the notice never lingers after acknowledgement.
test('closing the notice quits the app', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-notice-'))
  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--user-data-dir=${userDataDir}`, '--voltage-notice=Teams'],
    env: { ...process.env, VOLTAGE_TEST: '1', VOLTAGE_LANG: 'en', ELECTRON_RUN_AS_NODE: undefined },
  })
  try {
    const win = await app.firstWindow()
    await win.locator('#notice-ok').click()
    await app.waitForEvent('close')
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
})
