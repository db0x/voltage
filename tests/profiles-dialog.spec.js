const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const os   = require('node:os')
const path = require('node:path')

const WEBAPPS_DIR = path.join(__dirname, '..', 'webapps')

// Opens the side menu regardless of layout (hamburger below 875px, persistent panel above).
async function openDrawer(page) {
  const hamburger = page.locator('#menu-btn')
  if (await hamburger.isVisible()) await hamburger.click()
}

// Profiles dialog additions: a header icon and a "free space" row alongside the total.
// (The per-row reveal button needs a real profile data directory with non-zero size, which the
// test harness doesn't create — the size list is empty here — so it isn't asserted.)

// Setup:    Manager open.
// Action:   Open the drawer and click Profiles.
// Expected: The dialog header shows an icon before the title.
test('profiles dialog: header shows an icon', async ({ managerPage }) => {
  await openDrawer(managerPage)
  await managerPage.click('#menu-profiles')
  await expect(managerPage.locator('.profiles-dialog .dialog-header img')).toBeVisible()
})

// Setup:    Profiles dialog open; size list finishes loading.
// Action:   (none — reads the rendered summary rows)
// Expected: A free-space row is present (label from i18n), reporting filesystem head-room
//           next to the total. expect.poll covers the async size/disk-free IPC.
test('profiles dialog: shows a free-space row', async ({ managerPage }) => {
  await openDrawer(managerPage)
  await managerPage.click('#menu-profiles')
  await expect.poll(async () =>
    managerPage.locator('.profile-size-free').count()
  ).toBeGreaterThan(0)
})

// Setup:    A profile that exists as BOTH an embedded and a private config (like whatsapp), where
//           only the private config carries a profileDir pointing to a temp folder with data — i.e.
//           a profile relocated out of the default ~/.config/voltage/<profile> location.
// Action:   Open the profiles dialog.
// Expected: The relocated profile still appears (the private config's override wins over the
//           embedded one, so its real folder is measured) and carries the "custom location" badge.
test('profiles dialog: a relocated profile appears and is marked as custom', async ({ managerPage }) => {
  const embeddedFile = path.join(WEBAPPS_DIR, 'build.test-relocated.json')
  const privateFile  = path.join(WEBAPPS_DIR, 'build.private.test-relocated.json')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-relocated-'))
  fs.writeFileSync(path.join(dataDir, 'Cookies'), 'x'.repeat(4096))   // non-zero size so it isn't filtered out
  // Embedded config has NO profileDir; the private one does — the handler must prefer the private.
  fs.writeFileSync(embeddedFile, JSON.stringify(
    { profile: 'test-relocated', name: 'Relocated App', url: 'https://example.com' }, null, 2))
  fs.writeFileSync(privateFile, JSON.stringify(
    { profile: 'test-relocated', name: 'Relocated App', url: 'https://example.com', profileDir: dataDir }, null, 2))

  try {
    await openDrawer(managerPage)
    await managerPage.click('#menu-profiles')

    const row = managerPage.locator('.profile-size-row[data-profile="test-relocated"]')
    await expect(row).toBeVisible()
    await expect(row.locator('.profile-custom-badge')).toBeVisible()
  } finally {
    fs.rmSync(embeddedFile, { force: true })
    fs.rmSync(privateFile, { force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
