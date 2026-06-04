const { test, expect } = require('./fixtures')

// Header icons + titles for the create / edit / info dialogs. These dialogs gained an app icon
// next to the heading (create: the default app icon; edit/info: the specific app's icon), and
// the edit/info titles now include the app's name.

// ── Create dialog ───────────────────────────────────────────────────────────────

// Setup:    Manager open.
// Action:   Open the create dialog via the add-card.
// Expected: The header shows an icon (the default app icon) before the title — i.e. the
//           create dialog is no longer icon-less.
test('create dialog: header shows the default app icon', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  const icon = managerPage.locator('.create-dialog .dialog-header img')
  await expect(icon).toBeVisible()
  // Has a real source (the {{appDefaultSrc}} substitution ran), not an empty src.
  await expect(icon).toHaveAttribute('src', /.+/)
})

// ── Edit dialog ─────────────────────────────────────────────────────────────────

// Setup:    A private/user app card exists.
// Action:   Open its edit dialog.
// Expected: The header has an icon and the title contains the app's name (not a static
//           "Edit app"), proving the per-app title substitution works.
test('edit dialog: header shows app icon and name in the title', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await expect(managerPage.locator('#edit-header-icon')).toBeVisible()
  await expect(managerPage.locator('#edit-title')).toContainText('Test User App')
})

// ── Info dialog ───────────────────────────────────────────────────────────────────

// Setup:    A built/embedded app card with an info button exists.
// Action:   Open its info dialog.
// Expected: The header shows the app icon (replacing the former static info glyph).
test('info dialog: header shows the app icon', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test App' })
  await card.hover()
  await card.locator('[data-action="info"]').click()
  await expect(managerPage.locator('#info-header-icon')).toBeVisible()
})
