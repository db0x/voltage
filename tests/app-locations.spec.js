const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const path = require('node:path')

// Per-app custom locations: where the AppImage is built (outputDir) and where the app keeps its
// profile/session data (profileDir). Both are chosen via a native folder dialog, so these tests
// stub managerAPI.pickFolder and verify the config round-trip + the default placeholder.

const WEBAPPS_DIR = path.join(__dirname, '..', 'webapps')
const CHOSEN = '/tmp/voltage-e2e-location'

// Setup:    Edit dialog for the private test-user-app; the native folder picker is stubbed to a
//           fixed path so no OS dialog is needed.
// Action:   Pick a folder for both the AppImage and the profile, then save.
// Expected: Both paths persist to the private config as outputDir / profileDir.
test('edit dialog: chosen AppImage and profile folders persist to the config', async ({ electronApp, managerPage }) => {
  // The folder picker opens a native OS dialog; override its IPC handler in the main process to
  // return a fixed path (the contextBridge-exposed managerAPI can't be stubbed from the renderer).
  await electronApp.evaluate(({ ipcMain }, p) => {
    ipcMain.removeHandler('manager:pick-folder')
    ipcMain.handle('manager:pick-folder', () => p)
  }, CHOSEN)

  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-outputdir-btn')
  await expect(managerPage.locator('#edit-outputdir-name')).toHaveText(CHOSEN)
  await managerPage.click('#edit-profiledir-btn')
  await expect(managerPage.locator('#edit-profiledir-name')).toHaveText(CHOSEN)

  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch { return {} }
  }).toMatchObject({ outputDir: CHOSEN, profileDir: CHOSEN })
})

// Setup:    Edit dialog for test-user-app, which has no custom folders set.
// Action:   Open the dialog.
// Expected: With no override, each field shows the resolved default path (the dist/ output folder
//           and the profile folder) and hides the clear (✕) button — proving the field doubles as
//           the path display, and that an unset folder means "use the default location".
test('edit dialog: folder fields show the resolved default path when unset', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await expect(managerPage.locator('#edit-outputdir-name')).toContainText('dist')
  await expect(managerPage.locator('#edit-profiledir-name')).toContainText('test-user-app')
  await expect(managerPage.locator('#edit-outputdir-clear')).toBeHidden()
})
