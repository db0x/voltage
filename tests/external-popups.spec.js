const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const path = require('node:path')
const { expandConfig } = require('../scripts/build')

// The create/edit dialogs' "Open pop-ups in the default browser" toggle (config key externalPopups).
// It exists for apps that use target="_blank" on their OWN pages as a "new tab": without it each
// such link spawns a second Electron window. Off by default, so only an explicit opt-in is written.
// The runtime effect (setWindowOpenHandler in window.js) is not reachable from the Manager e2e
// harness; what is guarded here is the dialog wiring and the config round-trip.

const WEBAPPS_DIR = path.join(__dirname, '..', 'webapps')
const CFG_PATH = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')

const openEditDialog = async (managerPage) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  return card
}

// Setup:    Create dialog freshly opened.
// Action:   Inspect the pop-up toggle's initial state.
// Expected: Inactive — a same-origin pop-up belongs in the app window by default, so the redirect is
//           strictly opt-in and a new app's config stays free of the key.
test('create dialog: the pop-up toggle starts off', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await expect(managerPage.locator('#create-external-popups')).not.toHaveClass(/active/)
})

// Setup:    Edit dialog open for the private test-user-app, whose config has no externalPopups key.
// Action:   Inspect the toggle right after opening.
// Expected: Inactive, and the form is not dirty — reading a config without the key must not look
//           like an unsaved change.
test('edit dialog: an app without the key shows the toggle off and the form clean', async ({ managerPage }) => {
  await openEditDialog(managerPage)

  await expect(managerPage.locator('#edit-external-popups')).not.toHaveClass(/active/)
  await expect(managerPage.locator('#edit-save')).toBeDisabled()
})

// Setup:    Edit dialog open for the private test-user-app (toggle off).
// Action:   Turn the toggle on, save, then reopen the dialog.
// Expected: The config gains "externalPopups": true and the reopened toggle is active — the opt-in
//           both reaches disk and round-trips back into the dialog, which is what the build step
//           later bakes into the AppImage.
test('edit dialog: turning the pop-up redirect on persists and round-trips', async ({ managerPage }) => {
  const card = await openEditDialog(managerPage)

  await managerPage.click('#edit-external-popups')
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')

  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')).externalPopups } catch { return undefined }
  }).toBe(true)

  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await expect(managerPage.locator('#edit-external-popups')).toHaveClass(/active/)
})

// Setup:    The app from the previous test, now carrying "externalPopups": true.
// Action:   Turn the toggle back off and save.
// Expected: The key disappears from the config rather than being written as false — the file only
//           ever records the non-default, matching how the other capability toggles are stored.
test('edit dialog: turning it off again drops the key from the config', async ({ managerPage }) => {
  const card = await openEditDialog(managerPage)

  await managerPage.click('#edit-external-popups')
  await expect(managerPage.locator('#edit-external-popups')).toHaveClass(/active/)
  await managerPage.click('#edit-save')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')).externalPopups } catch { return undefined }
  }).toBe(true)

  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await managerPage.click('#edit-external-popups')
  await expect(managerPage.locator('#edit-external-popups')).not.toHaveClass(/active/)
  await managerPage.click('#edit-save')

  await expect.poll(() => {
    try { return 'externalPopups' in JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) } catch { return true }
  }).toBe(false)
})

// Setup:    App configs with the option off and on, passed through the build's config expander.
// Action:   Read the metadata baked into the AppImage's package.json.
// Expected: The key travels only when set. This is the seam that made the feature look broken at
//           first: the runtime reads pkg.externalPopups, but the build bakes an explicit whitelist —
//           a config key the whitelist omits is silently invisible to the app, rebuild or not.
test('expandConfig bakes externalPopups only when enabled', () => {
  const base = { profile: 'demo', url: 'https://example.com' }
  expect('externalPopups' in expandConfig(base).extraMetadata).toBe(false)
  expect(expandConfig({ ...base, externalPopups: true }).extraMetadata.externalPopups).toBe(true)
})
