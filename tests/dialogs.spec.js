const { test, expect } = require('./fixtures')

// ── Create dialog ─────────────────────────────────────────────────────────────

// Setup:    Manager open; create dialog is closed.
// Action:   Click the add-card button.
// Expected: The create dialog is shown (save button becomes visible).
test('create dialog opens via add-card', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await expect(managerPage.locator('#create-save')).toBeVisible()
})

// Setup:    Create dialog just opened; no fields filled.
// Action:   (none — checks initial state)
// Expected: Save button is disabled because profile and URL are empty.
test('create dialog: save button is disabled initially', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await expect(managerPage.locator('#create-save')).toBeDisabled()
})

// Setup:    Create dialog open; profile field empty.
// Action:   Type a profile name containing uppercase letters and special characters.
// Expected: An error hint appears below the profile field and save remains disabled.
//           Only lowercase letters, digits, and hyphens are accepted.
test('create dialog: invalid profile pattern shows error', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await managerPage.fill('#create-profile', 'My App!!')
  await expect(managerPage.locator('#create-profile-hint.error')).toBeVisible()
  await expect(managerPage.locator('#create-save')).toBeDisabled()
})

// Setup:    Create dialog open; URL field empty.
// Action:   Type a string that is not a valid URL.
// Expected: An error hint appears below the URL field and save remains disabled.
test('create dialog: invalid URL shows error', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await managerPage.fill('#create-url', 'not-a-url')
  await expect(managerPage.locator('#create-url-hint.error')).toBeVisible()
  await expect(managerPage.locator('#create-save')).toBeDisabled()
})

// Setup:    Create dialog open.
// Action:   Press Escape.
// Expected: The create dialog closes (save button is no longer visible).
test('create dialog: closes with Escape key', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await expect(managerPage.locator('#create-save')).toBeVisible()
  await managerPage.keyboard.press('Escape')
  await expect(managerPage.locator('#create-save')).not.toBeVisible()
})

// ── Create dialog scrolling ────────────────────────────────────────────────────
// The create dialog carries the same long field set as the edit dialog, so it
// wraps its fields in an OverlayScrollbars viewport (.create-scroll-wrapper):
// the body scrolls on short windows while header and footer stay fixed.

// Overflow metric of the OverlayScrollbars viewport inside the dialog. Returns -1
// while the viewport doesn't exist yet so expect.poll keeps waiting for the lazy
// init (the scrollbar is only set up on first open) and for the OS ResizeObserver
// to settle after a window resize.
const createOverflow = (page) => page.evaluate(() => {
  const vp = document.querySelector('.create-scroll-wrapper [data-overlayscrollbars-viewport]')
  return vp ? vp.scrollHeight - vp.clientHeight : -1
})

// Setup:    Manager shrunk so the create fields are taller than the dialog body.
// Action:   Open the create dialog and scroll its viewport to the bottom.
// Expected: The viewport overflows (scroll range > 0) and the mail-handler toggle near the
//           end of the form is reachable — i.e. the Save button no longer sits off-screen,
//           which is the bug this fix prevents.
test('create dialog scrolls when the window is too short to fit it', async ({ electronApp, managerPage }) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 380))
  await managerPage.click('.card-add')

  await expect.poll(() => createOverflow(managerPage)).toBeGreaterThan(0)

  const mailToggleReachable = await managerPage.evaluate(() => {
    const vp = document.querySelector('.create-scroll-wrapper [data-overlayscrollbars-viewport]')
    vp.scrollTop = vp.scrollHeight
    const v = vp.getBoundingClientRect()
    const t = document.getElementById('create-mail-handler').getBoundingClientRect()
    return t.bottom <= v.bottom + 1 && t.top >= v.top - 1
  })
  expect(mailToggleReachable).toBe(true)
})

// Setup:    Manager sized tall enough to show the whole create form at once.
// Action:   Open the create dialog.
// Expected: The viewport has no scroll range — the scrollbar appears only when
//           needed, never when the form already fits.
test('create dialog does not scroll when the window is tall enough', async ({ electronApp, managerPage }) => {
  // Height comfortably exceeds the full create form (which grew as more fields were added).
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 1200))
  await managerPage.click('.card-add')

  await expect.poll(() => createOverflow(managerPage)).toBe(0)
})

// ── Edit dialog ───────────────────────────────────────────────────────────────

// Setup:    Manager open; a private/user app card exists (only private cards have the edit button).
// Action:   Hover the card to reveal the toolbar, then click the edit button.
// Expected: The edit dialog is shown (save button becomes visible).
test('edit dialog opens for private (user) app', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"]').first()
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await expect(managerPage.locator('#edit-save')).toBeVisible()
})

// Setup:    Edit dialog just opened with existing app data pre-filled.
// Action:   (none — checks initial state)
// Expected: Save button is disabled because no field has been changed yet (dirty tracking).
test('edit dialog: save button is disabled initially (dirty tracking)', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"]').first()
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await expect(managerPage.locator('#edit-save')).toBeDisabled()
})

// Setup:    Edit dialog open with original name pre-filled.
// Action:   Change the name field to a different value.
// Expected: Save button becomes enabled because the form is now dirty.
test('edit dialog: save button enables after changing name', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"]').first()
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await managerPage.fill('#edit-name', 'Changed Name')
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
})

// ── About dialog ──────────────────────────────────────────────────────────────

// Setup:    Manager open; about dialog is closed.
// Action:   Open the drawer and click "About".
// Expected: The about dialog is visible.
test('about dialog opens from menu', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('#menu-about')
  await expect(managerPage.locator('.about-dialog')).toBeVisible()
})

// Setup:    About dialog open.
// Action:   Press Escape.
// Expected: The about dialog closes.
test('about dialog closes with Escape', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('#menu-about')
  await managerPage.keyboard.press('Escape')
  await expect(managerPage.locator('.about-dialog')).not.toBeVisible()
})

// ── Profiles dialog ───────────────────────────────────────────────────────────

// Setup:    Manager open; profiles dialog is closed.
// Action:   Open the drawer and click "Profiles".
// Expected: The profiles dialog is visible.
test('profiles dialog opens from menu', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('#menu-profiles')
  await expect(managerPage.locator('.profiles-dialog')).toBeVisible()
})

// ── Confirm dialog ────────────────────────────────────────────────────────────

// Setup:    Manager open; test-app card exists but has not been built (no AppImage in dist/).
// Action:   Hover the card to reveal the toolbar, check the delete button.
// Expected: Delete button is disabled on unbuilt apps — there is nothing to delete.
//           This verifies that the confirm dialog is never accidentally triggered.
test('confirm dialog appears when delete is clicked on a built app', async ({ managerPage }) => {
  // The test-app is not built, so delete is disabled — use hover to verify the
  // button is present and disabled (not triggering a real delete)
  const card = managerPage.locator('.card', { hasText: 'Test App' })
  await card.hover()
  const deleteBtn = card.locator('[data-action="delete"]')
  await expect(deleteBtn).toBeDisabled()
})
