const { test, expect, globalSettingsTest } = require('./fixtures')

// Helper: open drawer and click the settings button.
async function openGlobalSettings(page) {
  await page.click('#menu-btn')
  await page.click('#menu-settings')
  await page.waitForSelector('.global-settings-dialog:not(.hidden)', { timeout: 5_000 })
}

// ── Dialog open / close ───────────────────────────────────────────────────────

// Setup:    Manager open, drawer closed.
// Action:   Open drawer, click the settings (gear) button.
// Expected: The global settings dialog becomes visible.
test('global settings dialog opens via drawer settings button', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  await expect(managerPage.locator('.global-settings-dialog')).toBeVisible()
})

// Setup:    Global settings dialog open.
// Action:   Click Cancel.
// Expected: The dialog closes.
test('global settings dialog closes on Cancel', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  await managerPage.click('#global-settings-cancel')
  await expect(managerPage.locator('.global-settings-dialog')).not.toBeVisible()
})

// Setup:    Global settings dialog open.
// Action:   Click the ✕ close button.
// Expected: The dialog closes.
test('global settings dialog closes on ✕ button', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  await managerPage.click('#global-settings-close')
  await expect(managerPage.locator('.global-settings-dialog')).not.toBeVisible()
})

// Setup:    Global settings dialog open (UA add sub-dialog closed).
// Action:   Press Escape.
// Expected: The main dialog closes.
test('global settings dialog closes on Escape', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  await managerPage.keyboard.press('Escape')
  await expect(managerPage.locator('.global-settings-dialog')).not.toBeVisible()
})

// ── Hide embedded apps ────────────────────────────────────────────────────────

// Setup:    Global settings dialog open; test-app is public, not built, not installed.
// Action:   Click the app picker trigger.
// Expected: "Test App" appears in the dropdown as a hideable option.
test('hide-apps picker lists public non-built apps', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  await managerPage.click('#gs-app-trigger')
  await expect(managerPage.locator('.app-select-item', { hasText: 'Test App' })).toBeVisible()
})

// Setup:    Global settings dialog open; hidden list is empty.
// Action:   Open the picker and select "Test App".
// Expected: "Test App" appears in the hidden list; it no longer appears in the picker.
test('selecting an app adds it to the hidden list', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  await managerPage.click('#gs-app-trigger')
  await managerPage.locator('.app-select-item', { hasText: 'Test App' }).click()
  await expect(managerPage.locator('#gs-hidden-list .domain-item', { hasText: 'Test App' })).toBeVisible()
})

// Setup:    "Test App" was just added to the hidden list.
// Action:   Click the remove (−) button next to it.
// Expected: The entry disappears from the hidden list.
test('removing an app from the hidden list clears the entry', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  await managerPage.click('#gs-app-trigger')
  await managerPage.locator('.app-select-item', { hasText: 'Test App' }).click()
  const item = managerPage.locator('#gs-hidden-list .domain-item', { hasText: 'Test App' })
  await item.locator('.domain-remove-btn').click()
  await expect(item).not.toBeAttached()
})

// Setup:    "Test App" card is visible in the grid; global settings opened with test data dir.
// Action:   Add test-app to the hidden list, click Save.
// Expected: The test-app card is removed from the grid immediately after saving.
globalSettingsTest('saving a hidden app removes its card from the grid', async ({ managerPageWithGs }) => {
  const page = managerPageWithGs
  await expect(page.locator('.card[data-profile="test-app"]')).toBeVisible()
  await openGlobalSettings(page)
  await page.click('#gs-app-trigger')
  await page.locator('.app-select-item', { hasText: 'Test App' }).click()
  await page.click('#global-settings-save')
  await expect(page.locator('.card[data-profile="test-app"]')).not.toBeAttached()
})

// ── Scrolling ──────────────────────────────────────────────────────────────────
// Like every other dialog, global settings wraps its fields in an OverlayScrollbars
// viewport (.gs-scroll-wrapper) so the content scrolls when the window is too short,
// while the header and footer stay fixed.

// Overflow metric of the OverlayScrollbars viewport inside the dialog. Returns -1
// while the viewport doesn't exist yet so expect.poll keeps waiting for the lazy
// init (the scrollbar is only set up on first open) and for the OS ResizeObserver
// to settle after a window resize.
const gsOverflow = (page) => page.evaluate(() => {
  const vp = document.querySelector('.gs-scroll-wrapper [data-overlayscrollbars-viewport]')
  return vp ? vp.scrollHeight - vp.clientHeight : -1
})

// Setup:    Manager shrunk so the settings content is taller than the dialog body.
// Action:   Open global settings and scroll its viewport to the bottom.
// Expected: The viewport overflows (scroll range > 0) and the last fieldset (UA
//           presets) sits fully inside the viewport once scrolled — i.e. all content
//           is reachable, which is the bug this fix addresses.
test('global settings scrolls when the window is too short to fit it', async ({ electronApp, managerPage }) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 380))
  await openGlobalSettings(managerPage)

  await expect.poll(() => gsOverflow(managerPage)).toBeGreaterThan(0)

  const uaListReachable = await managerPage.evaluate(() => {
    const vp = document.querySelector('.gs-scroll-wrapper [data-overlayscrollbars-viewport]')
    vp.scrollTop = vp.scrollHeight
    const v = vp.getBoundingClientRect()
    const u = document.getElementById('gs-ua-list').getBoundingClientRect()
    return u.top <= v.bottom + 1 && u.top >= v.top - 1
  })
  expect(uaListReachable).toBe(true)
})

// Setup:    Manager sized tall enough to show the whole settings content at once.
// Action:   Open global settings.
// Expected: The viewport has no scroll range — the scrollbar appears only when
//           needed, never when the content already fits.
test('global settings does not scroll when the window is tall enough', async ({ electronApp, managerPage }) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 900))
  await openGlobalSettings(managerPage)

  await expect.poll(() => gsOverflow(managerPage)).toBe(0)
})

// ── UA presets — list content ─────────────────────────────────────────────────

// Setup:    Global settings dialog open.
// Action:   (none — reads initial state)
// Expected: All six built-in UA presets are listed.
test('global settings shows all built-in UA presets', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const items = managerPage.locator('.gs-ua-item.gs-ua-builtin')
  await expect(items).toHaveCount(6)
})

// Setup:    Global settings dialog open.
// Action:   (none — reads initial state)
// Expected: Each built-in UA item shows the "built-in" badge.
test('built-in UA presets show the built-in badge', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const badge = managerPage.locator('.gs-ua-item.gs-ua-builtin .gs-ua-badge').first()
  await expect(badge).toHaveText('built-in')
})

// Setup:    Global settings dialog open.
// Action:   (none — reads data attribute)
// Expected: The label span of each built-in UA preset carries a data-tooltip with the UA string.
test('built-in UA preset label has data-tooltip with the UA string', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const labelSpan = managerPage.locator('.gs-ua-item.gs-ua-builtin .gs-ua-label').first()
  const tooltip = await labelSpan.getAttribute('data-tooltip')
  expect(tooltip).toMatch(/^Mozilla\/5\.0/)
})

// ── UA presets — copy flow ────────────────────────────────────────────────────

// Setup:    Global settings dialog open.
// Action:   Hover over the first built-in UA preset, then click its copy button.
// Expected: The UA add sub-dialog opens.
test('copy button on built-in UA opens the add dialog', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const item = managerPage.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await expect(managerPage.locator('.gs-ua-dialog')).toBeVisible()
})

// Setup:    Copy button of the first built-in UA ("Chrome 142 · Linux x86_64") was clicked.
// Action:   (none — reads form state)
// Expected: The label field is pre-filled with the built-in preset's label.
test('copy button pre-fills the add dialog label', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const item = managerPage.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await expect(managerPage.locator('#gs-ua-d-label')).toHaveValue('Chrome 142 · Linux x86_64')
})

// Setup:    Copy button of the first built-in UA was clicked.
// Action:   (none — reads form state)
// Expected: The value textarea is pre-filled with the full UA string.
test('copy button pre-fills the add dialog UA string', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const item = managerPage.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  const value = await managerPage.locator('#gs-ua-d-value').inputValue()
  expect(value).toMatch(/^Mozilla\/5\.0/)
})

// Setup:    UA add dialog open with the first built-in UA pre-filled.
// Action:   Press Escape.
// Expected: The sub-dialog closes but the main global settings dialog stays open.
test('Escape closes the UA add sub-dialog without closing the main dialog', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const item = managerPage.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await managerPage.keyboard.press('Escape')
  await expect(managerPage.locator('.gs-ua-dialog')).not.toBeVisible()
  await expect(managerPage.locator('.global-settings-dialog')).toBeVisible()
})

// ── UA presets — add dialog validation ───────────────────────────────────────

// Setup:    UA add dialog open; label is pre-filled with an existing built-in name.
// Action:   (none — reads button state immediately after open)
// Expected: The Save button is disabled because the label is a duplicate.
test('add dialog Save is disabled when the label duplicates a built-in preset', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const item = managerPage.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await expect(managerPage.locator('#gs-ua-d-save')).toBeDisabled()
})

// Setup:    UA add dialog open with a duplicate label; error hint is shown.
// Action:   Change the label to something unique.
// Expected: The error hint disappears and the Save button becomes enabled.
test('add dialog Save enables after changing a duplicate label to a unique one', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const item = managerPage.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await managerPage.fill('#gs-ua-d-label', 'My Custom Chrome')
  await expect(managerPage.locator('#gs-ua-d-save')).toBeEnabled()
  await expect(managerPage.locator('#gs-ua-d-label-hint')).toHaveText('')
})

// Setup:    UA add dialog open; label changed to unique value, UA string present.
// Action:   Clear the label field entirely.
// Expected: The Save button is disabled (label is required).
test('add dialog Save is disabled when label is empty', async ({ managerPage }) => {
  await openGlobalSettings(managerPage)
  const item = managerPage.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await managerPage.fill('#gs-ua-d-label', '')
  await expect(managerPage.locator('#gs-ua-d-save')).toBeDisabled()
})

// ── UA presets — custom preset lifecycle ─────────────────────────────────────

// Setup:    Global settings dialog open with a temp data dir.
// Action:   Add a custom UA via the copy flow with a unique label, click Add.
// Expected: The new preset appears in the UA list without a built-in badge.
globalSettingsTest('adding a custom UA via copy shows it in the list', async ({ managerPageWithGs }) => {
  const page = managerPageWithGs
  await openGlobalSettings(page)
  const item = page.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await page.fill('#gs-ua-d-label', 'My Custom Chrome')
  await page.click('#gs-ua-d-save')
  const custom = page.locator('.gs-ua-item:not(.gs-ua-builtin)', { hasText: 'My Custom Chrome' })
  await expect(custom).toBeVisible()
  await expect(custom.locator('.gs-ua-badge')).not.toBeAttached()
})

// Setup:    A custom UA "My Custom Chrome" was just added to the list.
// Action:   Click its remove (−) button.
// Expected: The custom preset disappears from the list.
globalSettingsTest('deleting a custom UA removes it from the list', async ({ managerPageWithGs }) => {
  const page = managerPageWithGs
  await openGlobalSettings(page)
  const item = page.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await page.fill('#gs-ua-d-label', 'My Custom Chrome')
  await page.click('#gs-ua-d-save')
  const custom = page.locator('.gs-ua-item:not(.gs-ua-builtin)', { hasText: 'My Custom Chrome' })
  await custom.locator('.domain-remove-btn').click()
  await expect(custom).not.toBeAttached()
})

// Setup:    A custom UA "My Custom Chrome" was added and global settings saved.
// Action:   Open the create dialog and inspect the User-Agent select.
// Expected: The custom UA label appears as an option in the UA select.
globalSettingsTest('saved custom UA appears in the create dialog UA select', async ({ managerPageWithGs }) => {
  const page = managerPageWithGs
  await openGlobalSettings(page)
  const item = page.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await page.fill('#gs-ua-d-label', 'My Custom Chrome')
  await page.click('#gs-ua-d-save')
  await page.click('#global-settings-save')
  await page.click('.card-add')
  const options = await page.locator('#create-useragent option').allTextContents()
  expect(options).toContain('My Custom Chrome')
  await page.keyboard.press('Escape')
})

// Setup:    A custom UA has a tooltip on its label span showing the UA string.
// Action:   Add a custom UA, then read the data-tooltip on its label.
// Expected: The tooltip contains the UA string value that was entered.
globalSettingsTest('custom UA label has data-tooltip with the UA string', async ({ managerPageWithGs }) => {
  const page = managerPageWithGs
  await openGlobalSettings(page)
  const item = page.locator('.gs-ua-item.gs-ua-builtin').first()
  await item.hover()
  await item.locator('.gs-ua-copy-btn').click()
  await page.fill('#gs-ua-d-label', 'My Custom Chrome')
  await page.click('#gs-ua-d-save')
  const tooltip = await page
    .locator('.gs-ua-item:not(.gs-ua-builtin) .gs-ua-label', { hasText: 'My Custom Chrome' })
    .getAttribute('data-tooltip')
  expect(tooltip).toMatch(/^Mozilla\/5\.0/)
})
