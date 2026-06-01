const { test, expect, mailHandlerTest } = require('./fixtures')

// ── Badge rendering ───────────────────────────────────────────────────────────

// Setup:    Manager open; test-mail-app config has mimeTypes: ['x-scheme-handler/mailto'].
// Action:   (none — reads card state)
// Expected: The mail-handler badge is present on the card for "Test Mail App".
test('mail handler badge is shown on card with mimeTypes', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test Mail App' })
  await expect(card.locator('[data-role="mail-handler-badge"]')).toBeVisible()
})

// Setup:    Manager open; test-user-app config has no mimeTypes field.
// Action:   (none — reads card state)
// Expected: No mail-handler badge is attached to the card for "Test User App".
test('mail handler badge is absent on card without mimeTypes', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test User App' })
  await expect(card.locator('[data-role="mail-handler-badge"]')).not.toBeAttached()
})

// ── Edit dialog state ─────────────────────────────────────────────────────────

// Setup:    Edit dialog opened for "Test Mail App" (has mimeTypes set).
// Action:   (none — reads toggle state)
// Expected: The mail-handler toggle is active because the app has x-scheme-handler/mailto.
test('edit dialog: mail-handler toggle is active for mail handler app', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test Mail App' })
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await expect(managerPage.locator('#edit-mail-handler')).toHaveClass(/active/)
  await managerPage.keyboard.press('Escape')
})

// Setup:    Edit dialog opened for "Test User App" (no mimeTypes field).
// Action:   (none — reads toggle state)
// Expected: The mail-handler toggle is inactive because the app has no MIME type configured.
test('edit dialog: mail-handler toggle is inactive for non-mail-handler app', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test User App' })
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await expect(managerPage.locator('#edit-mail-handler')).not.toHaveClass(/active/)
  await managerPage.keyboard.press('Escape')
})

// Setup:    Edit dialog opened for "Test User App"; mail-handler toggle is inactive.
// Action:   (none — reads plugin select visibility)
// Expected: The plugin picker is visible regardless of the mail-handler toggle — plugin
//           selection is decoupled from mailto handling.
test('edit dialog: plugin picker is visible independent of the mail-handler toggle', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test User App' })
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await expect(managerPage.locator('#edit-mail-handler')).not.toHaveClass(/active/)
  await expect(managerPage.locator('#edit-plugin-trigger')).toBeVisible()
  // Toggling mail-handler does not change the plugin picker's visibility.
  await managerPage.click('#edit-mail-handler')
  await expect(managerPage.locator('#edit-plugin-trigger')).toBeVisible()
  await managerPage.keyboard.press('Escape')
})

// ── Create dialog state ───────────────────────────────────────────────────────

// Setup:    Create dialog just opened.
// Action:   (none — reads plugin select visibility)
// Expected: The plugin picker is visible by default and stays visible when the mail-handler
//           toggle is flipped — the two are independent.
test('create dialog: plugin picker is visible independent of the mail-handler toggle', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await expect(managerPage.locator('#create-plugin-trigger')).toBeVisible()
  await managerPage.click('#create-mail-handler')
  await expect(managerPage.locator('#create-plugin-trigger')).toBeVisible()
  await managerPage.keyboard.press('Escape')
})

// ── Badge update after edit ───────────────────────────────────────────────────

// Setup:    "Test Mail App" has the mail-handler badge visible on its card.
// Action:   Open the edit dialog, deactivate the mail-handler toggle, and save.
// Expected: After saving, the mail-handler badge is no longer attached to the card
//           (the DOM element is removed, not just hidden).
test('mail handler badge is removed after toggling handler off and saving', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test Mail App' })
  await expect(card.locator('[data-role="mail-handler-badge"]')).toBeAttached()

  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await managerPage.click('#edit-mail-handler')
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')
  await expect(managerPage.locator('#edit-save')).not.toBeVisible()

  await expect(card.locator('[data-role="mail-handler-badge"]')).not.toBeAttached()
})

// Setup:    "Test User App" has no mail-handler badge on its card.
// Action:   Open the edit dialog, activate the mail-handler toggle, and save.
// Expected: After saving, the mail-handler badge is present on the card.
test('mail handler badge appears after toggling handler on and saving', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test User App' })
  await expect(card.locator('[data-role="mail-handler-badge"]')).not.toBeAttached()

  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await managerPage.click('#edit-mail-handler')
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')
  await expect(managerPage.locator('#edit-save')).not.toBeVisible()

  await expect(card.locator('[data-role="mail-handler-badge"]')).toBeAttached()
})

// ── Drawer menu item ──────────────────────────────────────────────────────────

// Setup:    Manager launched with a mail-capable app that is built AND installed.
// Action:   Open the side drawer.
// Expected: The mail-handler menu item is visible.
mailHandlerTest('mail handler menu item is visible when a mail app is built and installed', async ({ managerPageWithMailHandler }) => {
  const page = managerPageWithMailHandler
  await page.click('#menu-btn')
  await expect(page.locator('#menu-mail-handler')).toBeVisible()
})

// ── Dialog ────────────────────────────────────────────────────────────────────

// Setup:    Drawer open, mail-capable app is built and installed.
// Action:   Click the mail-handler menu item.
// Expected: The mail-handler dialog opens.
mailHandlerTest('mail handler dialog opens when menu item is clicked', async ({ managerPageWithMailHandler }) => {
  const page = managerPageWithMailHandler
  await page.click('#menu-btn')
  await page.click('#menu-mail-handler')
  await expect(page.locator('.mail-handler-dialog')).toBeVisible()
})

// Setup:    Mail-handler dialog is open; WRAPWEB_TEST_MAIL_HANDLER set to the test app.
// Action:   (none — reads initial state)
// Expected: The test app is listed in the dialog and shown as the active (selected) entry.
mailHandlerTest('mail handler dialog shows the current default app as selected', async ({ managerPageWithMailHandler }) => {
  const page = managerPageWithMailHandler
  await page.click('#menu-btn')
  await page.click('#menu-mail-handler')
  const item = page.locator('.mail-handler-item', { hasText: 'Test Mail Dialog App' })
  await expect(item).toBeVisible()
  await expect(item).toHaveClass(/active/)
})

// Setup:    Mail-handler dialog is open; the test app is the current default (active).
// Action:   Click Save without changing the selection.
// Expected: The dialog closes.
mailHandlerTest('mail handler dialog closes on Save', async ({ managerPageWithMailHandler }) => {
  const page = managerPageWithMailHandler
  await page.click('#menu-btn')
  await page.click('#menu-mail-handler')
  await page.click('#mail-handler-save')
  await expect(page.locator('.mail-handler-dialog')).not.toBeVisible()
})

// Setup:    Mail-handler dialog is open.
// Action:   Click Cancel.
// Expected: The dialog closes without saving.
mailHandlerTest('mail handler dialog closes on Cancel', async ({ managerPageWithMailHandler }) => {
  const page = managerPageWithMailHandler
  await page.click('#menu-btn')
  await page.click('#menu-mail-handler')
  await page.click('#mail-handler-cancel')
  await expect(page.locator('.mail-handler-dialog')).not.toBeVisible()
})
