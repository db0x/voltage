const { test, expect } = require('./fixtures')

// Profiles dialog additions: a header icon and a "free space" row alongside the total.
// (The per-row reveal button needs a real profile data directory with non-zero size, which the
// test harness doesn't create — the size list is empty here — so it isn't asserted.)

// Setup:    Manager open.
// Action:   Open the drawer and click Profiles.
// Expected: The dialog header shows an icon before the title.
test('profiles dialog: header shows an icon', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('#menu-profiles')
  await expect(managerPage.locator('.profiles-dialog .dialog-header img')).toBeVisible()
})

// Setup:    Profiles dialog open; size list finishes loading.
// Action:   (none — reads the rendered summary rows)
// Expected: A free-space row is present (label from i18n), reporting filesystem head-room
//           next to the total. expect.poll covers the async size/disk-free IPC.
test('profiles dialog: shows a free-space row', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('#menu-profiles')
  await expect.poll(async () =>
    managerPage.locator('.profile-size-free').count()
  ).toBeGreaterThan(0)
})
