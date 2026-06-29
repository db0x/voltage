const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const path = require('node:path')

const WEBAPPS_DIR = path.join(__dirname, '..', 'webapps')
const DOCKER_PLUGIN = 'plugins/docker-integration/docker-integration.js'

// The docker-integration plugin's Manager-facing surface. The plugin itself is still a skeleton (no
// container/compose logic yet), but it already exercises two generic plugin-framework features:
//   - availability gating: a plugin can report unmet prerequisites (here: Docker/Compose missing) and
//     the Manager keeps it in the list but greys it out and makes it unselectable.
//   - URL ownership: a plugin can declare it manages the app URL (managesUrl), which locks the
//     create/edit dialog's URL field while it's selected.
// VOLTAGE_TEST_DOCKER forces the availability probe so these are deterministic without real Docker.

// Setup:    Create dialog open with Docker available; plugins discovered from the real tree.
// Action:   Open the plugin dropdown.
// Expected: docker-integration is offered and selectable — discovery picks up the plugin and its
//           availability probe reports OK, so it renders as a normal (enabled) dropdown item.
test('plugin list: docker-integration is offered when Docker is available', async ({ managerPageDockerOn: page }) => {
  await page.click('.card-add')
  await page.click('#create-plugin-trigger')
  const item = page.locator('.app-select-list .app-select-item', { hasText: 'docker-integration' })
  await expect(item).toHaveCount(1)
  await expect(item).not.toHaveClass(/app-select-item-disabled/)
})

// Setup:    Create dialog open with Docker forced UNAVAILABLE (VOLTAGE_TEST_DOCKER=0).
// Action:   Open the plugin dropdown, inspect the docker-integration entry, and try to click it.
// Expected: It is present but greyed (app-select-item-disabled) with a reason tooltip, and clicking
//           does NOT add it — proving the framework shows unmet-prerequisite plugins yet blocks
//           selection. This is the core grey-out behaviour requested for the docker integration.
test('plugin list: docker-integration is greyed out and unselectable when Docker is missing', async ({ managerPageDockerOff: page }) => {
  await page.click('.card-add')
  await page.click('#create-plugin-trigger')

  const item = page.locator('.app-select-list .app-select-item', { hasText: 'docker-integration' })
  await expect(item).toHaveCount(1)
  await expect(item).toHaveClass(/app-select-item-disabled/)
  await expect(item).toHaveAttribute('data-tooltip', /Docker/)

  // Clicking the disabled entry must not select it (no chip appears).
  await item.click()
  await expect(page.locator('#create-plugin-list .domain-item', { hasText: 'docker-integration' })).toHaveCount(0)
})

// Setup:    Create dialog open (Docker available), the docker-integration plugin added.
// Action:   Inspect the plugin's chip.
// Expected: It carries a configure (gear) button — the plugin exports configurable:true.
test('create dialog: docker-integration chip exposes a configure button', async ({ managerPageDockerOn: page }) => {
  await page.click('.card-add')
  await page.click('#create-plugin-trigger')
  await page.locator('.app-select-list .app-select-item', { hasText: 'docker-integration' }).click()

  const chip = page.locator('#create-plugin-list .domain-item', { hasText: 'docker-integration' })
  await expect(chip.locator('.domain-configure-btn')).toHaveCount(1)
})

// Setup:    Create dialog open (Docker available), docker-integration added, its configure clicked.
// Action:   Open the (empty) config dialog, then dismiss it via Cancel.
// Expected: The dialog renders with the plugin's title and closes again — the empty config.html is
//           valid markup the host can mount and tear down.
test('create dialog: docker-integration config dialog opens and closes', async ({ managerPageDockerOn: page }) => {
  await page.click('.card-add')
  await page.click('#create-plugin-trigger')
  await page.locator('.app-select-list .app-select-item', { hasText: 'docker-integration' }).click()
  await page.locator('#create-plugin-list .domain-item', { hasText: 'docker-integration' })
    .locator('.domain-configure-btn').click()

  const overlay = page.locator('.plugin-config-overlay:not(.hidden)')
  await expect(overlay).toHaveCount(1)
  await expect(overlay.locator('.dialog-title')).toHaveText('Docker integration')

  await overlay.locator('.plugin-config-cancel').click()
  await expect(page.locator('.plugin-config-overlay:not(.hidden)')).toHaveCount(0)
})

// Setup:    Create dialog open (Docker available), docker-integration added, its config opened.
// Action:   Inspect the Stack dropdown and where the Port field lives.
// Expected: The dropdown carries the bundled "draw.io" stack option (proving the host filled it from
//           the plugin's discovered stacks via data-config-options — the renderer has no file access
//           of its own), and the Port field sits inside the Advanced section as an optional override
//           (placeholder = Auto), since the AppImage now picks the port itself.
test('create dialog: docker config dialog is populated with bundled stacks', async ({ managerPageDockerOn: page }) => {
  await page.click('.card-add')
  await page.click('#create-plugin-trigger')
  await page.locator('.app-select-list .app-select-item', { hasText: 'docker-integration' }).click()
  await page.locator('#create-plugin-list .domain-item', { hasText: 'docker-integration' })
    .locator('.domain-configure-btn').click()

  const overlay = page.locator('.plugin-config-overlay:not(.hidden)')
  await expect(overlay).toHaveCount(1)
  await expect(overlay.locator('#docker-config-stack option[value="drawio"]')).toHaveText('draw.io')
  // Port is now an optional Advanced override (auto by default), not a prominent required field.
  await expect(overlay.locator('details.docker-config-advanced #docker-config-port')).toHaveCount(1)
  await expect(overlay.locator('#docker-config-port')).toHaveAttribute('placeholder', /Auto/)
  await expect(overlay.locator('#docker-config-port')).toHaveValue('')
})

// Setup:    Edit dialog for the private test-user-app (Docker available), docker-integration added.
// Action:   Open its config, choose the draw.io stack, Apply, then Save.
// Expected: The written config stores the choice under pluginConfig[<docker plugin>].stack — proving
//           the dynamic-dropdown selection round-trips through the generic config binding + buildAppCfg.
test('edit dialog: a chosen docker stack persists to the private config', async ({ managerPageDockerOn: page }) => {
  const card = page.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await page.click('#edit-plugin-trigger')
  await page.locator('.app-select-list .app-select-item', { hasText: 'docker-integration' }).click()
  await page.locator('#edit-plugin-list .domain-item', { hasText: 'docker-integration' })
    .locator('.domain-configure-btn').click()
  await page.locator('#docker-config-stack').selectOption('drawio')
  await page.locator('.plugin-config-overlay .plugin-config-apply').click()
  await page.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig?.[DOCKER_PLUGIN]?.stack } catch { return undefined }
  }).toBe('drawio')
})

// Setup:    Create dialog open (Docker available); the URL field is editable to start.
// Action:   Add the docker-integration plugin, then remove it again.
// Expected: Selecting a managesUrl plugin disables the URL field (the plugin owns the URL); removing
//           it re-enables the field — so no one hand-edits a URL the plugin controls.
test('create dialog: selecting docker-integration locks the URL field', async ({ managerPageDockerOn: page }) => {
  await page.click('.card-add')
  await expect(page.locator('#create-url')).toBeEnabled()

  await page.click('#create-plugin-trigger')
  await page.locator('.app-select-list .app-select-item', { hasText: 'docker-integration' }).click()
  await expect(page.locator('#create-url')).toBeDisabled()

  await page.locator('#create-plugin-list .domain-item', { hasText: 'docker-integration' })
    .locator('.domain-remove-btn').click()
  await expect(page.locator('#create-url')).toBeEnabled()
})
