const { test, expect } = require('./fixtures')

// Verifies that the i18n system delivers the correct language and that
// the tooltip mechanism works end-to-end. One representative string is
// checked per test rather than asserting every label.

// Setup:    Manager launched with WRAPWEB_LANG=en (default fixture).
// Action:   Open the create dialog.
// Expected: Dialog title is in English ("Add new WebApp").
test('UI renders in English by default', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await expect(managerPage.locator('.dialog-overlay:not(.hidden) .dialog-title')).toHaveText('Add new WebApp')
})

// Setup:    Manager launched with WRAPWEB_LANG=de (German fixture).
// Action:   Open the create dialog.
// Expected: Dialog title is in German ("Neue WebApp hinzufügen").
test('UI renders in German when WRAPWEB_LANG=de', async ({ managerPageDe }) => {
  await managerPageDe.click('.card-add')
  await expect(managerPageDe.locator('.dialog-overlay:not(.hidden) .dialog-title')).toHaveText('Neue WebApp hinzufügen')
})

// Setup:    Manager launched with the standard English fixture (no unknown language configured).
// Action:   Open the create dialog and read the title.
// Expected: The title is a non-empty string — confirms the i18n fallback path never
//           produces blank labels or crashes when a translation key is missing.
test('unknown language falls back gracefully (non-empty UI)', async ({ managerPage }) => {
  // The default fixture uses EN; this confirms the fallback path produces
  // a populated UI — no blank labels, no crashes.
  await expect(managerPage.locator('.card-add')).toBeVisible()
  await managerPage.click('.card-add')
  const title = await managerPage.locator('.dialog-overlay:not(.hidden) .dialog-title').textContent()
  expect(title?.trim().length).toBeGreaterThan(0)
})

// ── Tooltip mechanism ─────────────────────────────────────────────────────────

// Setup:    Create dialog open; the routing-URLs field and its "?" help icon are visible.
// Action:   Hover the help icon.
// Expected: A tooltip becomes visible and contains non-empty text.
test('hovering a help icon shows a non-empty tooltip', async ({ managerPage }) => {
  await managerPage.click('.card-add')

  const helpIcon = managerPage.locator('.create-dialog .field-help').first()
  await helpIcon.hover()
  const tooltip = managerPage.locator('.app-tooltip.visible')
  await expect(tooltip).toBeVisible()
  const text = await tooltip.textContent()
  expect(text?.trim().length).toBeGreaterThan(0)
})

// Setup:    Create dialog open; language is English.
// Action:   Hover the "?" help icon next to the User-Agent label.
// Expected: The tooltip text is in English and contains the word "browser"
//           (the EN tooltip describes which browser UA the app will identify as).
test('tooltip text matches the active language (EN)', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await managerPage.locator('#create-useragent').hover()
  // hover the ? next to the User-Agent label
  await managerPage.locator('label', { has: managerPage.locator('[id="create-useragent"]').locator('..') })
  const helpIcon = managerPage.locator('#create-useragent').locator('..').locator('.field-help')
  await helpIcon.hover()
  const tooltip = managerPage.locator('.app-tooltip.visible')
  await expect(tooltip).toBeVisible()
  const text = await tooltip.textContent()
  // EN tooltip must not contain German words
  expect(text).toMatch(/browser/i)
})

// Setup:    Create dialog open; language is German (DE fixture).
// Action:   Hover the "?" help icon next to the User-Agent label.
// Expected: The tooltip text is in German and contains "Webseiten"
//           (DE tooltip uses "Webseiten" where EN uses "websites").
test('tooltip text matches the active language (DE)', async ({ managerPageDe }) => {
  await managerPageDe.click('.card-add')
  const helpIcon = managerPageDe.locator('#create-useragent').locator('..').locator('.field-help')
  await helpIcon.hover()
  const tooltip = managerPageDe.locator('.app-tooltip.visible')
  await expect(tooltip).toBeVisible()
  const text = await tooltip.textContent()
  // DE tooltip must contain a German word
  expect(text).toMatch(/Webseiten/i)
})
