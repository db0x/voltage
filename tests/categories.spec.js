const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const path = require('node:path')

// Per-app categories in the create/edit dialogs. A user app can be grouped under one or more
// categories; the picker (chips + a suggestion dropdown of existing categories) also lets the user
// create a new one by typing. These tests cover the round-trip into the config and the suggestion
// of categories already in use elsewhere.

const WEBAPPS_DIR = path.join(__dirname, '..', 'webapps')

// Opens the side menu regardless of layout: below 875px via the hamburger, at/above it the drawer
// is already a persistent panel (hamburger is display:none).
async function openDrawer(page) {
  const hamburger = page.locator('#menu-btn')
  if (await hamburger.isVisible()) await hamburger.click()
}

// Setup:    Edit dialog for the private test-user-app (no categories yet); the test catalog
//           includes apps already tagged "microsoft" and "google".
// Action:   Open the category dropdown via the input and pick the suggested "google".
// Expected: "google" — a category in use by another app — is offered as a suggestion and, once
//           clicked, becomes a chip. Proves existing categories are surfaced for reuse.
test('edit dialog: an existing category is suggested and can be picked', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-category-input')
  const suggestion = managerPage.locator('.app-select-item:visible', { hasText: 'google' })
  await expect(suggestion).toBeVisible()
  await suggestion.click()

  await expect(managerPage.locator('#edit-category-list .domain-item', { hasText: 'google' })).toHaveCount(1)
})

// Setup:    Edit dialog for the private test-user-app.
// Action:   Type a brand-new category name, add it with the "+" button, and save.
// Expected: The new category persists to the private config as an array under `category` —
//           proving free-text creation and the config round-trip.
test('edit dialog: a newly created category persists to the private config', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.fill('#edit-category-input', 'productivity')
  await managerPage.click('#edit-category-add')
  await expect(managerPage.locator('#edit-category-list .domain-item', { hasText: 'productivity' })).toHaveCount(1)

  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).category ?? null } catch { return null }
  }).toEqual(['productivity'])
})

// Setup:    Edit dialog for test-user-app; a category has been added (form is dirty).
// Action:   Remove the chip via its "−" button.
// Expected: The chip disappears, leaving no categories — proving removal works and the picker
//           round-trips an empty selection.
test('edit dialog: a category chip can be removed', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.fill('#edit-category-input', 'temp')
  await managerPage.click('#edit-category-add')
  const chip = managerPage.locator('#edit-category-list .domain-item', { hasText: 'temp' })
  await expect(chip).toHaveCount(1)

  await chip.locator('.domain-remove-btn').click()
  await expect(managerPage.locator('#edit-category-list .domain-item')).toHaveCount(0)
})

// ── Live drawer filter ────────────────────────────────────────────────────────

// Setup:    test-user-app has no categories; the drawer shows only the built-in category filters.
// Action:   Add a brand-new category to the app via the edit dialog and save, then open the drawer.
// Expected: A filter button for the new category appears automatically, and activating it shows
//           only the app in that category — proving new categories propagate into the menu live.
test('a newly assigned category appears as a drawer filter and filters', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await managerPage.fill('#edit-category-input', 'tools')
  await managerPage.click('#edit-category-add')
  await managerPage.click('#edit-save')

  await openDrawer(managerPage)
  const filterBtn = managerPage.locator('[data-filter="tools"]')
  await expect(filterBtn).toBeVisible()
  await expect(filterBtn.locator('span')).toHaveText('tools')

  await filterBtn.click()
  await expect(managerPage.locator('.card[data-profile="test-user-app"]')).toBeVisible()
  await expect(managerPage.locator('.card[data-profile="test-app"]')).not.toBeVisible()
})

// ── Per-category rebuild button ───────────────────────────────────────────────

// Setup:    The catalog has a "microsoft" category (Test MS App).
// Action:   Activate the Microsoft filter, then hover its row to reveal the rebuild button, click
//           it, and cancel the confirmation (so no real build runs).
// Expected: The rebuild button is shown only for the active category on hover, and asks for
//           confirmation before recreating + installing every app in the category.
test('the active category reveals a rebuild button that confirms before building', async ({ managerPage }) => {
  // Activate the category first — the rebuild button only appears for the selected category.
  await openDrawer(managerPage)
  await managerPage.click('[data-filter="microsoft"]')

  await openDrawer(managerPage)
  const row = managerPage.locator('.drawer-category-row', {
    has: managerPage.locator('[data-rebuild-category="microsoft"]'),
  })
  await row.hover()
  const rebuildBtn = row.locator('[data-rebuild-category="microsoft"]')
  await expect(rebuildBtn).toBeVisible()
  await rebuildBtn.click()

  const confirmMsg = managerPage.locator('.confirm-overlay:not(.hidden) #confirm-message')
  await expect(confirmMsg).toBeVisible()
  await expect(confirmMsg).toContainText('microsoft')
  // Cancel — this test must never kick off an actual AppImage build.
  await managerPage.click('#confirm-cancel')
})
