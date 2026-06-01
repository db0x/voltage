const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const path = require('node:path')

// Per-app plugin selection in the create/edit dialogs. Plugins are the main-process modules
// shipped under webapps/plugins (discovered live by manager:plugins), selectable independently
// of the mail-handler toggle via a custom icon dropdown. These tests cover the UI wiring and
// config round-trip.

const WEBAPPS_DIR = path.join(__dirname, '..', 'webapps')

// Setup:    Create dialog open; plugins are discovered from the real webapps/plugins tree.
// Action:   Open the plugin dropdown via its trigger button.
// Expected: The dropdown lists the shipped plugins (onedrive, strato-webmail) with their
//           icon + name, proving discovery reaches nested plugin files and renders them.
test('create dialog: shipped plugins are offered in the dropdown', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await managerPage.click('#create-plugin-trigger')
  const items = managerPage.locator('.app-select-list .app-select-item')
  await expect(items.filter({ hasText: 'onedrive' })).toHaveCount(1)
  await expect(items.filter({ hasText: 'strato-webmail' })).toHaveCount(1)
  // Each item carries an icon image.
  await expect(items.first().locator('img')).toBeVisible()
  await managerPage.keyboard.press('Escape')
})

// Setup:    Edit dialog open for the private test-user-app (not built → no rebuild prompt).
// Action:   Open the dropdown, pick a plugin, and save.
// Expected: The written build.private.test-user-app.json lists the plugin in `plugins`,
//           proving the selection round-trips through buildAppCfg instead of being dropped.
test('edit dialog: a selected plugin persists to the private config', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'onedrive' }).click()
  // The chip appears in the list and the form is now dirty.
  await expect(managerPage.locator('#edit-plugin-list .domain-item')).toHaveCount(1)
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).plugins ?? [] } catch { return [] }
  }).toContain('plugins/onedrive/onedrive.js')
})

// Setup:    Edit dialog open for the private test-user-app, no field changed yet.
// Action:   Open the dropdown and pick a plugin.
// Expected: Save is disabled until the plugin is added, then enabled — confirming plugin
//           changes participate in the dialog's dirty detection.
test('edit dialog: adding a plugin marks the form dirty', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await expect(managerPage.locator('#edit-save')).toBeDisabled()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'strato-webmail' }).click()
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
})
