const { test, expect } = require('./fixtures')

// Backdrop clicks must NOT close Manager dialogs. Clicking the dim area beside a dialog used to
// dismiss it, which is easy to trigger accidentally on a trackpad. Dialogs now close only via ✕,
// Cancel/OK or Escape. These specs cover a representative sample of the dialog patterns (a form
// dialog opened from a card, the edit form, and a menu-driven info dialog); the backdrop handler
// was removed uniformly across every dialog module.

// Clicks the dim backdrop of the currently open overlay near its top-left corner. The overlay
// fills the viewport and centres its dialog, so a corner click always lands beside the dialog.
async function clickBackdrop(page, overlaySelector = '.dialog-overlay:not(.hidden)') {
  await page.locator(overlaySelector).click({ position: { x: 5, y: 5 } })
}

// Setup:    Create dialog open (Save button visible).
// Action:   Click the backdrop beside the dialog, then press Escape.
// Expected: The backdrop click leaves the dialog open; only Escape closes it — proving the
//           accidental-dismiss path is gone while real dismissals still work.
test('create dialog: backdrop click keeps it open, Escape still closes', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await expect(managerPage.locator('#create-save')).toBeVisible()

  await clickBackdrop(managerPage)
  await expect(managerPage.locator('#create-save')).toBeVisible()

  await managerPage.keyboard.press('Escape')
  await expect(managerPage.locator('#create-save')).not.toBeVisible()
})

// Setup:    Edit dialog open for a private app (Save button visible).
// Action:   Click the backdrop beside the dialog.
// Expected: The dialog stays open — a half-finished edit is never lost to a stray trackpad tap.
test('edit dialog: backdrop click keeps it open', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"]').first()
  await card.hover()
  await card.locator('[data-action="edit"]').click()
  await expect(managerPage.locator('#edit-save')).toBeVisible()

  await clickBackdrop(managerPage)
  await expect(managerPage.locator('#edit-save')).toBeVisible()
})

// Setup:    About dialog open from the drawer (width forced below the 875px persistent-drawer
//           breakpoint so #menu-btn is the reliable toggle).
// Action:   Click the backdrop beside the dialog, then the ✕ button.
// Expected: The backdrop click leaves it open; the ✕ button still closes it.
test('about dialog: backdrop click keeps it open, ✕ still closes', async ({ electronApp, managerPage }) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 1000))
  await managerPage.click('#menu-btn')
  await managerPage.click('#menu-about')
  await expect(managerPage.locator('.about-dialog')).toBeVisible()

  await clickBackdrop(managerPage)
  await expect(managerPage.locator('.about-dialog')).toBeVisible()

  await managerPage.click('#about-close')
  await expect(managerPage.locator('.about-dialog')).not.toBeVisible()
})
