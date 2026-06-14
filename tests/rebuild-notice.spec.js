const { base, expect } = require('./fixtures')
const { _electron: electron } = require('@playwright/test')
const path = require('node:path')
const os   = require('node:os')
const fs   = require('node:fs')
const { appName } = require('../src/app-naming')

const ROOT        = path.join(__dirname, '..')
const CONFIGS_DIR = path.join(ROOT, 'webapps')
const DIST_DIR    = path.join(ROOT, 'dist')

const OUTDATED_PROFILE = 'test-rebuild-outdated'
const CURRENT_PROFILE  = 'test-rebuild-current'

// Writes a minimal build config for the given profile.
function writeConfig(profile) {
  fs.writeFileSync(
    path.join(CONFIGS_DIR, `build.${profile}.json`),
    JSON.stringify({ profile, url: 'https://example.com', name: profile }),
  )
}

// Simulates a built AppImage by creating an empty binary file and an optional
// .version sidecar file. Without the .version file the app is treated as
// having version 0.0.0, which is always older than minAppImageVersion.
function fakeBuilt(profile, version) {
  fs.mkdirSync(DIST_DIR, { recursive: true })
  fs.writeFileSync(path.join(DIST_DIR, appName(profile)), '')
  if (version != null)
    fs.writeFileSync(path.join(DIST_DIR, `${appName(profile)}.version`), version)
}

function cleanup(...profiles) {
  for (const p of profiles) {
    fs.rmSync(path.join(CONFIGS_DIR, `build.${p}.json`),      { force: true })
    fs.rmSync(path.join(DIST_DIR,    appName(p)),         { force: true })
    fs.rmSync(path.join(DIST_DIR,    `${appName(p)}.version`), { force: true })
  }
}

// Launches a fresh Manager instance without the standard test-config fixture set.
// Each rebuild-notice test manages its own configs so it can control built/version state.
async function launchManager() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapweb-test-'))
  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, WRAPWEB_TEST: '1', WRAPWEB_LANG: 'en', ELECTRON_RUN_AS_NODE: undefined },
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.card-add', { timeout: 30_000 })
  return { app, page, userDataDir }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const test = base.extend({
  // Provides a Manager page where the test-rebuild-outdated app exists as a built
  // AppImage with version "0.0.0" — always older than any real minAppImageVersion.
  pageOutdated: async ({}, use) => {
    writeConfig(OUTDATED_PROFILE)
    fakeBuilt(OUTDATED_PROFILE, '0.0.0')
    const { app, page, userDataDir } = await launchManager()
    await use(page)
    await app.close()
    cleanup(OUTDATED_PROFILE)
    fs.rmSync(userDataDir, { recursive: true, force: true })
  },

  // Provides a Manager page where the test-rebuild-current app exists as a built
  // AppImage with version "99.99.99" — always newer than any real minAppImageVersion.
  pageCurrent: async ({}, use) => {
    writeConfig(CURRENT_PROFILE)
    fakeBuilt(CURRENT_PROFILE, '99.99.99')
    const { app, page, userDataDir } = await launchManager()
    await use(page)
    await app.close()
    cleanup(CURRENT_PROFILE)
    fs.rmSync(userDataDir, { recursive: true, force: true })
  },
})

// ── Tests ─────────────────────────────────────────────────────────────────────

// Setup:    One outdated AppImage (version 0.0.0) exists on startup.
// Action:   (none — reads dialog state on load)
// Expected: The rebuild-notice dialog appears automatically with a visible "Got it" button.
test('rebuild notice appears when an app has an outdated version', async ({ pageOutdated }) => {
  await expect(pageOutdated.locator('#rebuild-notice-ok')).toBeVisible()
})

// Setup:    One outdated AppImage (version 0.0.0) exists on startup.
// Action:   (none — reads dialog content)
// Expected: The rebuild notice lists the profile name of the outdated app.
test('rebuild notice lists the outdated app', async ({ pageOutdated }) => {
  await expect(pageOutdated.locator('#rebuild-notice-list')).toContainText(OUTDATED_PROFILE)
})

// Setup:    Rebuild notice is visible (outdated app).
// Action:   Click the "Got it" button.
// Expected: The rebuild notice dialog is dismissed (button is no longer visible).
test('rebuild notice "Got it" button dismisses the dialog', async ({ pageOutdated }) => {
  await pageOutdated.click('#rebuild-notice-ok')
  await expect(pageOutdated.locator('#rebuild-notice-ok')).not.toBeVisible()
})

// Setup:    Rebuild notice was shown, then dismissed with "Got it".
// Action:   Check the card for the outdated app in the grid.
// Expected: The "outdated" badge is still shown on the card after dismissing the notice
//           (the notice only closes the dialog, it does not remove the badge).
test('outdated badge is shown on the card', async ({ pageOutdated }) => {
  await pageOutdated.click('#rebuild-notice-ok')
  const card = pageOutdated.locator(`.card[data-profile="${OUTDATED_PROFILE}"]`)
  await expect(card.locator('.badge.outdated')).toBeVisible()
})

// Setup:    Current-version AppImage (version 99.99.99) exists on startup.
// Action:   (none — reads card state)
// Expected: The "outdated" badge is absent from the card because the app is up to date.
test('outdated badge is absent when app version is current', async ({ pageCurrent }) => {
  const card = pageCurrent.locator(`.card[data-profile="${CURRENT_PROFILE}"]`)
  await expect(card.locator('.badge.outdated')).not.toBeVisible()
})

// Setup:    Current-version AppImage (version 99.99.99) exists on startup.
// Action:   Check whether the rebuild notice dialog appeared.
// Expected: If the dialog is visible (possible if other real AppImages on the machine are
//           outdated), the current-version profile must not appear in the list.
//           The test is conditional to be safe on any developer machine.
test('current-version app is not listed in rebuild notice', async ({ pageCurrent }) => {
  // Dialog may or may not appear (other real AppImages could be outdated),
  // but the current-version profile must never appear in the list.
  const list = pageCurrent.locator('#rebuild-notice-list')
  const isVisible = await pageCurrent.locator('#rebuild-notice-ok').isVisible()
  if (isVisible) {
    await expect(list).not.toContainText(CURRENT_PROFILE)
  }
})

// Setup:    One outdated AppImage exists; rebuild notice is visible.
// Action:   (none — reads dialog state on load)
// Expected: The "Rebuild all" button is visible in the rebuild notice dialog.
test('"Rebuild all" button is visible in rebuild notice', async ({ pageOutdated }) => {
  await expect(pageOutdated.locator('#rebuild-notice-rebuild-all')).toBeVisible()
})

// Setup:    One outdated AppImage (version 0.0.0) on disk.
// Action:   Launch the Manager, dismiss the notice with "Got it", close and relaunch.
// Expected: The rebuild notice reappears on the second launch because the AppImage
//           is still outdated (the notice is never permanently suppressed).
test('rebuild notice reappears on next launch while app is still outdated', async ({}) => {
  writeConfig(OUTDATED_PROFILE)
  fakeBuilt(OUTDATED_PROFILE, '0.0.0')

  const { app: app1, page: page1, userDataDir: dir1 } = await launchManager()
  await expect(page1.locator('#rebuild-notice-ok')).toBeVisible()
  await page1.click('#rebuild-notice-ok')
  await app1.close()
  fs.rmSync(dir1, { recursive: true, force: true })

  const { app: app2, page: page2, userDataDir: dir2 } = await launchManager()
  await expect(page2.locator('#rebuild-notice-ok')).toBeVisible()
  await app2.close()
  cleanup(OUTDATED_PROFILE)
  fs.rmSync(dir2, { recursive: true, force: true })
})
