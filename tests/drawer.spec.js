const { test, expect } = require('./fixtures')

// Filter button visibility and layout
// ------------------------------------
// The Microsoft and Google filter buttons must always show a text label,
// even when no icon is resolved from the system GTK theme (standard fixture).
// When an icon is available (electronAppWithFilterIcons fixture), they also show an image.

// Setup:    Manager open without any system icon resolution (VOLTAGE_TEST=1, no custom icons).
// Action:   Open the drawer.
// Expected: Microsoft filter button is present and visible even without an icon.
test('microsoft filter button is always visible even without icons', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await expect(managerPage.locator('[data-filter="microsoft"]')).toBeVisible()
})

// Setup:    Manager open without any system icon resolution.
// Action:   Open the drawer.
// Expected: Google filter button is present and visible even without an icon.
test('google filter button is always visible even without icons', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await expect(managerPage.locator('[data-filter="google"]')).toBeVisible()
})

// Setup:    Manager open; Microsoft filter button has no icon resolved.
// Action:   Open the drawer.
// Expected: The button's text label reads "Microsoft Apps" (not empty, not placeholder).
test('microsoft filter button always shows text label', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await expect(managerPage.locator('[data-filter="microsoft"] span')).toHaveText('Microsoft Apps')
})

// Setup:    Manager open; Google filter button has no icon resolved.
// Action:   Open the drawer.
// Expected: The button's text label reads "Google Apps".
test('google filter button always shows text label', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await expect(managerPage.locator('[data-filter="google"] span')).toHaveText('Google Apps')
})

// Setup:    Manager launched with VOLTAGE_TEST_FILTER_ICONS pointing to a valid SVG file,
//           so both filter buttons receive a resolved icon path.
// Action:   Open the drawer.
// Expected: Microsoft filter button shows both an <img> element and the "Microsoft Apps" text label.
test('microsoft filter button shows text label with icon when icon is available', async ({ managerPageWithFilterIcons }) => {
  await managerPageWithFilterIcons.click('#menu-btn')
  const btn = managerPageWithFilterIcons.locator('[data-filter="microsoft"]')
  await expect(btn.locator('img')).toBeVisible()
  await expect(btn.locator('span')).toHaveText('Microsoft Apps')
})

// Setup:    Manager launched with VOLTAGE_TEST_FILTER_ICONS pointing to a valid SVG file.
// Action:   Open the drawer.
// Expected: Google filter button shows both an <img> element and the "Google Apps" text label.
test('google filter button shows text label with icon when icon is available', async ({ managerPageWithFilterIcons }) => {
  await managerPageWithFilterIcons.click('#menu-btn')
  const btn = managerPageWithFilterIcons.locator('[data-filter="google"]')
  await expect(btn.locator('img')).toBeVisible()
  await expect(btn.locator('span')).toHaveText('Google Apps')
})

// Appearance row layout
// ----------------------
// The settings button sits on the left with a text label; the theme switch
// sits on the right as an icon-only button (its label moved to a hover tooltip).

// Setup:    Manager open with the standard fixture.
// Action:   Open the drawer.
// Expected: Within the appearance row the settings button comes before the theme
//           switch, confirming the left/right ordering after the swap.
test('settings button precedes the theme switch in the appearance row', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  const order = await managerPage.$$eval('.drawer-appearance-row > button', els => els.map(e => e.id))
  expect(order).toEqual(['menu-settings', 'menu-darkmode'])
})

// Setup:    Manager open with the standard fixture.
// Action:   Open the drawer.
// Expected: The settings button carries a non-empty text label (it is the labelled
//           item on the left).
test('settings button has a text label', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  const label = await managerPage.locator('#menu-settings span').textContent()
  expect(label.trim().length).toBeGreaterThan(0)
})

// Setup:    Manager open with the standard fixture.
// Action:   Open the drawer.
// Expected: The theme switch has no label span and instead exposes its label via
//           data-tooltip, so it renders icon-only.
test('theme switch is icon-only with a tooltip label', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await expect(managerPage.locator('#menu-darkmode span')).toHaveCount(0)
  await expect(managerPage.locator('#menu-darkmode')).toHaveAttribute('data-tooltip', /.+/)
})

// Category filtering
// ------------------

// Setup:    Manager open with cards for microsoft, google, and uncategorized apps.
// Action:   Open the drawer and click the Microsoft filter.
// Expected: Only microsoft-category cards are visible; google and uncategorized cards are hidden.
test('microsoft filter shows only microsoft-category cards', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('[data-filter="microsoft"]')

  await expect(managerPage.locator('.card[data-category="microsoft"]').first()).toBeVisible()
  await expect(managerPage.locator('.card[data-category="google"]').first()).not.toBeVisible()
  await expect(managerPage.locator('.card[data-category=""]').first()).not.toBeVisible()
})

// Setup:    Manager open with cards for microsoft, google, and uncategorized apps.
// Action:   Open the drawer and click the Google filter.
// Expected: Only google-category cards are visible; microsoft and uncategorized cards are hidden.
test('google filter shows only google-category cards', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('[data-filter="google"]')

  await expect(managerPage.locator('.card[data-category="google"]').first()).toBeVisible()
  await expect(managerPage.locator('.card[data-category="microsoft"]').first()).not.toBeVisible()
  await expect(managerPage.locator('.card[data-category=""]').first()).not.toBeVisible()
})

// Setup:    Manager open; add-card button is visible in the "all" view.
// Action:   Switch to the Microsoft filter.
// Expected: The add-card button is hidden (creating apps is only allowed in the "all" view).
test('microsoft filter hides the add-card', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('[data-filter="microsoft"]')
  await expect(managerPage.locator('.card-add')).not.toBeVisible()
})

// Setup:    Manager open; add-card button is visible in the "all" view.
// Action:   Switch to the Google filter.
// Expected: The add-card button is hidden.
test('google filter hides the add-card', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('[data-filter="google"]')
  await expect(managerPage.locator('.card-add')).not.toBeVisible()
})

// Setup:    Manager open; Microsoft filter is active (hiding other cards).
// Action:   Open the drawer again and click the "All Apps" filter.
// Expected: All category cards (microsoft, google, uncategorized) and the add-card button
//           are visible again, confirming the filter is fully reset.
test('"all" filter restores all cards after category filter', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('[data-filter="microsoft"]')
  await managerPage.click('#menu-btn')
  await managerPage.click('[data-filter="all"]')

  await expect(managerPage.locator('.card[data-category="microsoft"]').first()).toBeVisible()
  await expect(managerPage.locator('.card[data-category="google"]').first()).toBeVisible()
  await expect(managerPage.locator('.card-add')).toBeVisible()
})

// Drawer scrolling
// ----------------
// On short windows the menu used to be taller than the drawer with no way to
// reach the lower items. The drawer now wraps its menu in an OverlayScrollbars
// viewport (.drawer-scroll), so it scrolls only when the items don't fit.

// Overflow metric of the OverlayScrollbars viewport inside the drawer. Returns
// -1 while the viewport doesn't exist yet so expect.poll keeps waiting for the
// lazy init (the scrollbar is only set up on the first drawer open) and for the
// OS ResizeObserver to settle after a window resize.
const drawerOverflow = (page) => page.evaluate(() => {
  const vp = document.querySelector('.drawer-scroll [data-overlayscrollbars-viewport]')
  return vp ? vp.scrollHeight - vp.clientHeight : -1
})

// Setup:    Manager shrunk to the minimum height so the menu is taller than the drawer.
// Action:   Open the drawer and scroll its viewport to the bottom.
// Expected: The viewport actually overflows (scroll range > 0) and the last entry
//           (About) sits fully inside the viewport once scrolled — i.e. every menu
//           item is reachable, which was the original bug.
test('the drawer menu scrolls when the window is too short to fit it', async ({ electronApp, managerPage }) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(440, 380))
  await managerPage.click('#menu-btn')

  await expect.poll(() => drawerOverflow(managerPage)).toBeGreaterThan(0)

  const aboutReachable = await managerPage.evaluate(() => {
    const vp = document.querySelector('.drawer-scroll [data-overlayscrollbars-viewport]')
    vp.scrollTop = vp.scrollHeight
    const v = vp.getBoundingClientRect()
    const a = document.getElementById('menu-about').getBoundingClientRect()
    return a.bottom <= v.bottom + 1 && a.top >= v.top - 1
  })
  expect(aboutReachable).toBe(true)
})

// Setup:    Manager sized tall enough to show the whole menu at once.
// Action:   Open the drawer.
// Expected: The viewport has no scroll range — the scrollbar appears only when
//           needed, never when the menu already fits.
test('the drawer menu does not scroll when the window is tall enough', async ({ electronApp, managerPage }) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(440, 760))
  await managerPage.click('#menu-btn')

  await expect.poll(() => drawerOverflow(managerPage)).toBeLessThanOrEqual(0)
})
