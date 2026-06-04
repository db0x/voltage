const { test, expect } = require('./fixtures')

// Info dialog field set. The dialog gained Routing-URLs and a Plugins list (with each plugin's
// icon) and dropped the separate Icon row (the icon now lives in the header). test-google-app
// is configured with both a routingUrl and the rclone-sync plugin.

// Opens the info dialog for the google test app (non-private → has an info button).
// #info-fields is the dialog's own field container (unique id, unlike the shared
// .dialog-fields class used by several dialogs).
async function openInfo(managerPage) {
  const card = managerPage.locator('.card', { hasText: 'Test Google App' })
  await card.hover()
  await card.locator('[data-action="info"]').click()
  await expect(managerPage.locator('#info-fields')).toBeVisible()
}

// Setup:    Info dialog open for an app that declares a routingUrl.
// Action:   (none — reads the rendered fields)
// Expected: A field shows the configured routing URL.
test('info dialog: shows routing URLs', async ({ managerPage }) => {
  await openInfo(managerPage)
  await expect(managerPage.locator('#info-fields')).toContainText('routing-claim.example.net/app')
})

// Setup:    Info dialog open for an app that loads the rclone-sync plugin.
// Action:   (none — reads the rendered fields)
// Expected: A Plugins entry shows the plugin name with its icon image.
test('info dialog: lists plugins with their icon', async ({ managerPage }) => {
  await openInfo(managerPage)
  const item = managerPage.locator('.info-plugin', { hasText: 'rclone-sync' })
  await expect(item).toHaveCount(1)
  await expect(item.locator('img.info-plugin-icon')).toBeVisible()
})

// Setup:    Info dialog open.
// Action:   (none — reads the labels of the rendered fields)
// Expected: There is no standalone "Icon" row anymore — the app icon moved to the header.
test('info dialog: no separate icon field', async ({ managerPage }) => {
  await openInfo(managerPage)
  const labels = await managerPage.$$eval('#info-fields label', els => els.map(e => e.textContent.trim()))
  expect(labels).not.toContain('Icon')
})
