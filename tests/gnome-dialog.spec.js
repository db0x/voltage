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
