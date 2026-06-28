const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const path = require('node:path')

// The create/edit dialogs' "Allow DevTools" toggle. Unlike the other capability toggles it defaults
// ON, so the inversion is the thing under test: the switch is active unless the config carries an
// explicit "devTools": false, and only that off-state is ever written back. The runtime effect (the
// webPreferences gate + the widget strip's DevTools button) lives in window.js / drag-zone.html and
// is covered separately; here we guard the dialog wiring and the config round-trip.

const WEBAPPS_DIR = path.join(__dirname, '..', 'webapps')

// Setup:    Edit dialog open for the private test-user-app, whose config has no devTools key.
// Action:   Inspect the DevTools toggle's state right after opening.
// Expected: Active — DevTools are on by default, so an app that never opted out shows the switch on
//           without marking the form dirty (save stays disabled).
test('edit dialog: DevTools toggle is on by default', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await expect(managerPage.locator('#edit-devtools')).toHaveClass(/active/)
  await expect(managerPage.locator('#edit-save')).toBeDisabled()
})

// Setup:    Edit dialog open for the private test-user-app (DevTools on by default).
// Action:   Turn the DevTools toggle off and save, then reopen the dialog.
// Expected: The written config gains "devTools": false and the reopened toggle is inactive — proving
//           the off-state both persists and round-trips back into the dialog.
test('edit dialog: turning DevTools off persists and round-trips', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-devtools')
  await expect(managerPage.locator('#edit-devtools')).not.toHaveClass(/active/)
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).devTools } catch { return undefined }
  }).toBe(false)

  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await expect(managerPage.locator('#edit-devtools')).not.toHaveClass(/active/)
})

// Setup:    Create dialog freshly opened.
// Action:   Inspect the DevTools toggle's initial state.
// Expected: Active — a brand-new app starts with DevTools enabled (only an explicit off is stored),
//           matching the runtime default in window.js.
test('create dialog: DevTools toggle starts on', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await expect(managerPage.locator('#create-devtools')).toHaveClass(/active/)
})
