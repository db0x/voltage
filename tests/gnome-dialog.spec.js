const { test: baseTest, gnomeTest: test, expect } = require('./fixtures')
const fs   = require('node:fs')
const path = require('node:path')

// Opens the side menu in a layout-agnostic way. Below 875px the drawer is a slide-in overlay
// reached via the hamburger; at/above 875px it is a persistent panel and the hamburger is
// display:none. Some desktops force new windows wide (persistent layout), so clicking the
// hamburger unconditionally would fail there — only click it when it is actually visible.
async function openDrawer(page) {
  const hamburger = page.locator('#menu-btn')
  if (await hamburger.isVisible()) await hamburger.click()
}

// ── Drawer entry gating (GNOME-only) ──────────────────────────────────────────

// Setup:    Standard Manager launch — VOLTAGE_TEST_GNOME_AVAILABLE is unset, so the integration
//           reports "not a GNOME session" (the same outcome as running under KDE/others).
// Action:   Inspect the side menu.
// Expected: The GNOME Integration entry is absent from the DOM — the feature only makes sense
//           under GNOME, where its Shell extension can actually run. (Layout-independent: the
//           drawer removes the node entirely, so no need to open the overlay.)
baseTest('GNOME entry is hidden when not under a GNOME session', async ({ managerPage }) => {
  await expect(managerPage.locator('#menu-gnome')).toHaveCount(0)
})

// Setup:    Manager launched under a (faked) GNOME session.
// Action:   Open the drawer.
// Expected: The GNOME Integration entry is present — the gate lets it through only on GNOME.
test('GNOME entry is shown under a GNOME session', async ({ managerPageGnomeWayland }) => {
  const { page } = managerPageGnomeWayland
  await openDrawer(page)
  await expect(page.locator('#menu-gnome')).toBeVisible()
})

// ── Availability + initial status ─────────────────────────────────────────────

// Setup:    Manager launched under a (faked) GNOME session with no extension installed
//           yet (fresh temp extensions dir).
// Action:   Open the drawer and click the GNOME Integration entry.
// Expected: The dialog opens and reports "Not installed" — the entry is only present
//           under GNOME and the status reflects the empty install target.
test('shows not-installed status under a GNOME session', async ({ managerPageGnomeWayland }) => {
  const { page } = managerPageGnomeWayland
  await openDrawer(page)
  await page.click('#menu-gnome')
  await expect(page.locator('.gnome-dialog')).toBeVisible()
  await expect(page.locator('#gnome-status-badge')).toHaveText('Not installed')
  await expect(page.locator('#gnome-install')).toBeEnabled()
})

// ── Install copies the extension + shows the Wayland relog hint ────────────────

// Setup:    GNOME session on Wayland, extension not installed, and the faked
//           `gnome-extensions list` reports it as not enabled even after install.
// Action:   Open the dialog and click Install.
// Expected: extension.js + geometry.js + metadata.json land in the (temp) extensions dir, the
//           status flips to "Disabled" (copied but not yet loaded), and the relog hint appears —
//           on Wayland GNOME only loads the extension after a re-login. geometry.js is asserted
//           because extension.js imports it; a missing file would break loading at runtime.
test('install copies files and surfaces the relog hint on Wayland', async ({ managerPageGnomeWayland }) => {
  const { page, gnomeExtDir } = managerPageGnomeWayland
  await openDrawer(page)
  await page.click('#menu-gnome')
  await page.click('#gnome-install')

  await expect(page.locator('#gnome-relog-hint')).toBeVisible()
  await expect(page.locator('#gnome-status-badge')).toHaveText('Disabled')

  const installed = path.join(gnomeExtDir, 'voltage@db0x.de')
  expect(fs.existsSync(path.join(installed, 'extension.js'))).toBe(true)
  expect(fs.existsSync(path.join(installed, 'geometry.js'))).toBe(true)
  expect(fs.existsSync(path.join(installed, 'metadata.json'))).toBe(true)
})

// ── GNOME shortcut icon in the About dialog ────────────────────────────────────
// The width is forced below the 875px breakpoint so the drawer is a slide-in overlay (which
// scrolls), keeping the bottom-pinned About entry reachable regardless of the default window size.

// Setup:    Manager not under a GNOME session; About dialog opened from the drawer.
// Action:   Inspect the About dialog's integration icons.
// Expected: The GNOME icon stays hidden — it mirrors the drawer entry's GNOME-only gating, unlike
//           the always-present Obsidian/rclone icons whose own gating is independent.
baseTest('about dialog hides the GNOME icon when not under GNOME', async ({ electronApp, managerPage }) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 1000))
  await openDrawer(managerPage)
  await managerPage.click('#menu-about')
  await expect(managerPage.locator('.about-dialog')).toBeVisible()
  await expect(managerPage.locator('#about-gnome')).not.toBeVisible()
})

// Setup:    Manager under a (faked) GNOME session; About dialog open.
// Action:   Click the GNOME integration icon in the About dialog.
// Expected: The About dialog closes and the GNOME Integration dialog opens — the icon is the
//           shortcut into that dialog, like the Obsidian/rclone icons beside it.
test('about dialog GNOME icon opens the GNOME dialog under GNOME', async ({ electronAppGnomeWayland, managerPageGnomeWayland }) => {
  await electronAppGnomeWayland.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 1000))
  const { page } = managerPageGnomeWayland
  await openDrawer(page)
  await page.click('#menu-about')
  await expect(page.locator('#about-gnome')).toBeVisible()

  await page.locator('#about-gnome').click()
  await expect(page.locator('.about-dialog')).not.toBeVisible()
  await expect(page.locator('.gnome-dialog')).toBeVisible()
})
