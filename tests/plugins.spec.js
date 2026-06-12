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
// Expected: The dropdown lists the shipped plugins (ms-office, strato-webmail) with their
//           icon + name, proving discovery reaches nested plugin files and renders them.
test('create dialog: shipped plugins are offered in the dropdown', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await managerPage.click('#create-plugin-trigger')
  const items = managerPage.locator('.app-select-list .app-select-item')
  await expect(items.filter({ hasText: 'ms-office' })).toHaveCount(1)
  await expect(items.filter({ hasText: 'strato-webmail' })).toHaveCount(1)
  // Each item carries an icon image.
  await expect(items.first().locator('img')).toBeVisible()
  // Helper modules inside a plugin dir (e.g. widget/move-overlay.js) must NOT appear — only the
  // <dir>/<dir>.js entry file counts as a selectable plugin.
  await expect(items.filter({ hasText: 'move-overlay' })).toHaveCount(0)
  await expect(items.filter({ hasText: 'widget' })).toHaveCount(1)
  await managerPage.keyboard.press('Escape')
})

// Setup:    Create dialog open; the configurable widget plugin and the non-configurable ms-office
//           plugin are both offered.
// Action:   Add the widget plugin to the chip list, then add ms-office.
// Expected: Only the widget chip carries a configure button (before its remove button), proving
//           the configure affordance appears solely for plugins that declare `configurable`.
test('create dialog: only configurable plugins get a configure button on their chip', async ({ managerPage }) => {
  await managerPage.click('.card-add')

  await managerPage.click('#create-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()
  await managerPage.click('#create-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'ms-office' }).click()

  const widgetChip    = managerPage.locator('#create-plugin-list .domain-item', { hasText: 'widget' })
  const msOfficeChip  = managerPage.locator('#create-plugin-list .domain-item', { hasText: 'ms-office' })
  await expect(widgetChip.locator('.domain-configure-btn')).toHaveCount(1)
  await expect(msOfficeChip.locator('.domain-configure-btn')).toHaveCount(0)

  // Configure button must precede the remove button within the chip.
  const buttons = await widgetChip.locator('button').evaluateAll(
    els => els.map(e => e.className)
  )
  expect(buttons).toEqual(['domain-configure-btn', 'domain-remove-btn'])

  await managerPage.keyboard.press('Escape')
})

// Setup:    Edit dialog open for the private test-user-app; the configurable widget plugin added.
// Action:   Click the configure (gear) button on the widget chip, then close the dialog via ✕.
// Expected: The widget plugin's own config dialog (shipped as its config.html) opens and then
//           closes — proving the configure button opens the plugin-provided dialog and the host
//           wires its close control.
test('edit dialog: the configure button opens the plugin config dialog, which can be closed', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()

  const overlay = managerPage.locator('.plugin-config-overlay')
  await expect(overlay).toHaveCount(0)  // built lazily — not present until opened

  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()
  await expect(overlay).toBeVisible()

  await overlay.locator('.dialog-close').click()
  await expect(overlay).not.toBeVisible()
})

// Setup:    Edit dialog for test-user-app with the widget plugin added; its config dialog opened.
// Action:   Move the corner-radius slider to 20px, click Apply, then save the app.
// Expected: The config persists the value under pluginConfig keyed by the plugin file path, and
//           the live output mirrors it — proving the per-app/per-plugin setting round-trips and
//           is scoped to the right plugin.
test('edit dialog: the widget corner radius persists per app under pluginConfig', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()

  // The slider seeds from the default (14) when the app has no stored value yet.
  const slider = managerPage.locator('#widget-config-radius')
  await expect(slider).toHaveValue('14')

  // Range inputs need an explicit input event for the host's oninput binding to fire.
  await slider.evaluate(el => { el.value = '20'; el.dispatchEvent(new Event('input', { bubbles: true })) })
  await expect(managerPage.locator('.plugin-config-overlay output[data-config-value="radius"]')).toHaveText('20px')

  // Apply commits the change (and marks the edit form dirty); only then does Save persist it.
  await managerPage.locator('.plugin-config-overlay .plugin-config-apply').click()
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig ?? null } catch { return null }
  }).toEqual({ 'plugins/widget/widget.js': { radius: 20 } })
})

// Setup:    Edit dialog for test-user-app with the widget plugin added; its config dialog opened.
// Action:   The resizable toggle defaults on; turn it off, Apply, and save.
// Expected: The toggle starts active (default yes) and persists resizable:false when turned off —
//           proving the boolean toggle binds and round-trips alongside the value controls.
test('edit dialog: the widget resizable toggle defaults on and persists when turned off', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()

  const toggle = managerPage.locator('.plugin-config-overlay .dialog-field-toggle[data-config-key="resizable"]')
  await expect(toggle).toHaveClass(/active/)  // default yes

  await toggle.click()
  await expect(toggle).not.toHaveClass(/active/)
  await managerPage.locator('.plugin-config-overlay .plugin-config-apply').click()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig ?? null } catch { return null }
  }).toEqual({ 'plugins/widget/widget.js': { resizable: false } })
})

// Setup:    Edit dialog for test-user-app with the widget plugin added; its config dialog opened.
// Action:   The suppress-app-titlebar toggle defaults off; turn it on, Apply, and save.
// Expected: The toggle starts inactive (default off — opt-in, it changes how the page sees its
//           environment) and persists suppressAppTitlebar:true when enabled.
test('edit dialog: the widget suppress-titlebar toggle defaults off and persists when turned on', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()

  const toggle = managerPage.locator('.plugin-config-overlay .dialog-field-toggle[data-config-key="suppressAppTitlebar"]')
  await expect(toggle).not.toHaveClass(/active/)  // default off

  await toggle.click()
  await expect(toggle).toHaveClass(/active/)
  await managerPage.locator('.plugin-config-overlay .plugin-config-apply').click()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig ?? null } catch { return null }
  }).toEqual({ 'plugins/widget/widget.js': { suppressAppTitlebar: true } })
})

// Setup:    Edit dialog for test-user-app with the widget plugin added; its config dialog opened.
// Action:   The shadow toggle defaults on; turn it off, Apply, and save.
// Expected: The toggle starts active (default yes) and persists shadow:false when turned off.
test('edit dialog: the widget shadow toggle defaults on and persists when turned off', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()

  const toggle = managerPage.locator('.plugin-config-overlay .dialog-field-toggle[data-config-key="shadow"]')
  await expect(toggle).toHaveClass(/active/)  // default yes

  await toggle.click()
  await expect(toggle).not.toHaveClass(/active/)
  await managerPage.locator('.plugin-config-overlay .plugin-config-apply').click()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig ?? null } catch { return null }
  }).toEqual({ 'plugins/widget/widget.js': { shadow: false } })
})

// Setup:    Edit dialog for test-user-app with the widget plugin added; its config dialog opened.
// Action:   The background-transparency toggle defaults off; turn it on, Apply, and save.
// Expected: The toggle starts inactive (default off — the effect is opt-in because it only works on
//           some pages) and persists tintBackground:true when enabled.
test('edit dialog: the widget background toggle defaults off and persists when turned on', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()

  const toggle = managerPage.locator('.plugin-config-overlay .dialog-field-toggle[data-config-key="tintBackground"]')
  await expect(toggle).not.toHaveClass(/active/)  // default off

  await toggle.click()
  await expect(toggle).toHaveClass(/active/)
  await managerPage.locator('.plugin-config-overlay .plugin-config-apply').click()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig ?? null } catch { return null }
  }).toEqual({ 'plugins/widget/widget.js': { tintBackground: true } })
})

// Setup:    Edit dialog for test-user-app with the widget plugin added; its config dialog opened.
// Action:   The shadow width slider defaults to 8 (gated by the shadow toggle); set it to 4, save.
// Expected: The width persists as shadowWidth:4 and the field is gated by the shadow toggle.
test('edit dialog: the shadow width persists per app under pluginConfig', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()

  const slider     = managerPage.locator('#widget-config-shadow-width')
  const widthField = managerPage.locator('.plugin-config-overlay [data-config-enabled-by="shadow"]')
  await expect(slider).toHaveValue('8')                          // default = max
  await expect(widthField).not.toHaveClass(/config-disabled/)   // enabled while shadow is on (default)

  await slider.evaluate(el => { el.value = '4'; el.dispatchEvent(new Event('input', { bubbles: true })) })
  await expect(managerPage.locator('.plugin-config-overlay output[data-config-value="shadowWidth"]')).toHaveText('4px')

  await managerPage.locator('.plugin-config-overlay .plugin-config-apply').click()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig ?? null } catch { return null }
  }).toEqual({ 'plugins/widget/widget.js': { shadowWidth: 4 } })
})

// Setup:    Edit dialog for test-user-app with the widget plugin added; its config dialog opened.
// Action:   Move the radius slider, but dismiss the dialog with Cancel instead of Apply.
// Expected: The form stays clean (Save disabled) and re-opening shows the default again —
//           proving Cancel discards the working copy without touching the app's config.
test('edit dialog: cancelling the config dialog discards the radius change', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()

  await managerPage.locator('#widget-config-radius')
    .evaluate(el => { el.value = '20'; el.dispatchEvent(new Event('input', { bubbles: true })) })
  await managerPage.locator('.plugin-config-overlay .plugin-config-cancel').click()

  // Adding the plugin already made the form dirty, so isolate the radius edit: the discarded
  // change must not survive into the dialog on re-open (default 14, not 20).
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()
  await expect(managerPage.locator('#widget-config-radius')).toHaveValue('14')
})

// Setup:    test-user-app with the widget plugin added and radius applied to 20 within this test.
// Action:   Save, then re-open the edit dialog and the widget config dialog.
// Expected: The slider loads the stored 20px rather than the default — proving load-from-config.
test('edit dialog: a stored widget radius loads back into the config dialog', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')

  // First open: add widget, set radius to 20, apply, save (establishes the stored value).
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'widget' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()
  await managerPage.locator('#widget-config-radius')
    .evaluate(el => { el.value = '20'; el.dispatchEvent(new Event('input', { bubbles: true })) })
  await managerPage.locator('.plugin-config-overlay .plugin-config-apply').click()
  await managerPage.click('#edit-save')

  // Second open: the dialog should reflect the stored value, not the default.
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'widget' })
    .locator('.domain-configure-btn').click()
  await expect(managerPage.locator('#widget-config-radius')).toHaveValue('20')
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
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'ms-office' }).click()
  // The chip appears in the list and the form is now dirty.
  await expect(managerPage.locator('#edit-plugin-list .domain-item')).toHaveCount(1)
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).plugins ?? [] } catch { return [] }
  }).toContain('plugins/ms-office/ms-office.js')
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

// Setup:    Edit dialog for test-user-app with the robot plugin (a <select> target + a text input)
//           added and its config dialog opened. The robot plugin is the only shipped plugin whose
//           config uses a dropdown, so this is what guards the host's select binding.
// Action:   Change the target dropdown (button → link) and type an aria-label, then Apply + Save.
// Expected: The dropdown seeds from its default ("button"), and both the select value and the text
//           input round-trip into pluginConfig — proving select[data-config-key] binds (value +
//           onchange) exactly like the text input next to it.
test('edit dialog: the robot target dropdown + identifier persist per app under pluginConfig', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'robot' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'robot' })
    .locator('.domain-configure-btn').click()

  // The dropdown seeds from data-config-default ("button") when the app has no stored value yet.
  const target = managerPage.locator('#robot-config-target')
  await expect(target).toHaveValue('button')

  await target.selectOption('link')
  await managerPage.fill('#robot-config-aria-label', 'Anmelden')

  // Apply commits the change (and marks the edit form dirty); only then does Save persist it.
  await managerPage.locator('.plugin-config-overlay .plugin-config-apply').click()
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig ?? null } catch { return null }
  }).toEqual({ 'plugins/robot/robot.js': { target: 'link', ariaLabel: 'Anmelden' } })
})

// Setup:    Edit dialog for test-user-app with the zoom plugin (extracted ctrl+wheel zoom) added;
//           its config dialog opened.
// Action:   The step slider defaults to 0.1; move it to 0.2, Apply, and save.
// Expected: The step persists as step:0.2 under the zoom plugin's key — proving the extracted zoom
//           feature is now a discoverable, configurable plugin that round-trips its per-app config.
test('edit dialog: the zoom step persists per app under pluginConfig', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'zoom' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'zoom' })
    .locator('.domain-configure-btn').click()

  // The slider seeds from the default (0.1) when the app has no stored value yet.
  const slider = managerPage.locator('#zoom-config-step')
  await expect(slider).toHaveValue('0.1')

  // Range inputs need an explicit input event for the host's oninput binding to fire.
  await slider.evaluate(el => { el.value = '0.2'; el.dispatchEvent(new Event('input', { bubbles: true })) })
  await expect(managerPage.locator('.plugin-config-overlay output[data-config-value="step"]')).toHaveText('0.2')

  await managerPage.locator('.plugin-config-overlay .plugin-config-apply').click()
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig ?? null } catch { return null }
  }).toEqual({ 'plugins/zoom/zoom.js': { step: 0.2 } })
})
