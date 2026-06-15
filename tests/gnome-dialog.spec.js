const { gnomeTest: test, expect } = require('./fixtures')
const fs   = require('node:fs')
const path = require('node:path')

// ── Availability + initial status ─────────────────────────────────────────────

// Setup:    Manager launched under a (faked) GNOME session with no extension installed
//           yet (fresh temp extensions dir).
// Action:   Open the drawer and click the GNOME Integration entry.
// Expected: The dialog opens and reports "Not installed" — the entry is only present
//           under GNOME and the status reflects the empty install target.
test('shows not-installed status under a GNOME session', async ({ managerPageGnomeWayland }) => {
  const { page } = managerPageGnomeWayland
  await page.click('#menu-btn')
  await page.click('#menu-gnome')
  await expect(page.locator('.gnome-dialog')).toBeVisible()
  await expect(page.locator('#gnome-status-badge')).toHaveText('Not installed')
  await expect(page.locator('#gnome-install')).toBeEnabled()
})

// ── Install copies the extension + shows the Wayland relog hint ────────────────

// Setup:    GNOME session on Wayland, extension not installed, and the faked
//           `gnome-extensions list` reports it as not enabled even after install.
// Action:   Open the dialog and click Install.
// Expected: extension.js + metadata.json land in the (temp) extensions dir, the status
//           flips to "Disabled" (copied but not yet loaded), and the relog hint appears —
//           on Wayland GNOME only loads the extension after a re-login.
test('install copies files and surfaces the relog hint on Wayland', async ({ managerPageGnomeWayland }) => {
  const { page, gnomeExtDir } = managerPageGnomeWayland
  await page.click('#menu-btn')
  await page.click('#menu-gnome')
  await page.click('#gnome-install')

  await expect(page.locator('#gnome-relog-hint')).toBeVisible()
  await expect(page.locator('#gnome-status-badge')).toHaveText('Disabled')

  const installed = path.join(gnomeExtDir, 'voltage@db0x.de')
  expect(fs.existsSync(path.join(installed, 'extension.js'))).toBe(true)
  expect(fs.existsSync(path.join(installed, 'metadata.json'))).toBe(true)
})
