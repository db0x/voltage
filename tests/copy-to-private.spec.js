const { test, expect } = require('./fixtures')
const path = require('node:path')
const fs   = require('node:fs')

const CONFIGS_DIR   = path.join(__dirname, '..')
const PRIVATE_FILE  = path.join(CONFIGS_DIR, 'webapps', 'build.private.test-app.json')

// Remove any private config that may have been created during the test.
test.afterEach(async () => {
  fs.rmSync(PRIVATE_FILE, { force: true })
})

// ── Info button / copy button visibility ─────────────────────────────────────

// Setup:    Manager open with an embedded (non-private) app card.
// Action:   Hover the card to reveal the toolbar.
// Expected: The info button is visible (embedded apps have info, not edit).
test('embedded app card shows info button, not edit', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="false"]').first()
  await card.hover()
  await expect(card.locator('[data-action="info"]')).toBeVisible()
  await expect(card.locator('[data-action="edit"]')).toHaveCount(0)
})

// Setup:    Manager open; info dialog is closed.
// Action:   Click the info button on an embedded app card.
// Expected: The "Copy to private config" button is visible in the info dialog footer.
test('info dialog shows copy button for embedded app', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="false"]').first()
  await card.hover()
  await card.locator('[data-action="info"]').click()
  await expect(managerPage.locator('#info-copy-btn')).toBeVisible()
})

// Setup:    Manager open; info dialog closed; a private app card exists.
// Action:   Private apps show edit instead of info — open via the card's edit button.
// Expected: The copy button footer is hidden because private apps can already be edited.
//
// Note: Private apps don't have an info button in the toolbar; we verify that the
// #info-footer stays hidden when the dialog is opened programmatically by looking
// at the data-private attribute of the first private card and confirming the footer
// is not displayed after opening the info dialog via the edit path.
// Instead, we test the inverse by verifying a private card has no info button at all.
test('private app card has no info button', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"]').first()
  await card.hover()
  await expect(card.locator('[data-action="info"]')).toHaveCount(0)
  await expect(card.locator('[data-action="edit"]')).toBeVisible()
})

// ── Copy to private ───────────────────────────────────────────────────────────

// Setup:    Manager open; embedded "Test App" card exists (data-private="false").
// Action:   Open info dialog and click "Copy to private config".
// Expected: The card becomes a private card (data-private="true"), shows the
//           "User" badge, and now has an edit button instead of an info button.
test('copy to private replaces embedded card with private card', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test App' })
  await card.hover()
  await card.locator('[data-action="info"]').click()
  await managerPage.locator('#info-copy-btn').click()

  // Dialog closes; card should now be private
  await expect(managerPage.locator('#info-copy-btn')).not.toBeVisible()
  await expect(card).toHaveAttribute('data-private', 'true')
  await expect(card.locator('.badge.private')).toBeVisible()
  await card.hover()
  await expect(card.locator('[data-action="edit"]')).toBeVisible()
  await expect(card.locator('[data-action="info"]')).toHaveCount(0)
})

// Setup:    Manager open; embedded "Test App" card exists.
// Action:   Open info dialog and click "Copy to private config".
// Expected: The private config file build.private.test-app.json is created on disk
//           with the same content as the original embedded config.
test('copy to private writes config file to disk', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test App' })
  await card.hover()
  await card.locator('[data-action="info"]').click()
  await managerPage.locator('#info-copy-btn').click()
  await expect(managerPage.locator('#info-copy-btn')).not.toBeVisible()

  expect(fs.existsSync(PRIVATE_FILE)).toBe(true)
  const written = JSON.parse(fs.readFileSync(PRIVATE_FILE, 'utf8'))
  expect(written.profile).toBe('test-app')
  expect(written.url).toBe('https://example.com')
})

// ── Deduplication ─────────────────────────────────────────────────────────────

// Setup:    Both build.test-app.json (embedded) and build.private.test-app.json exist
//           before the Manager starts (simulates a previously copied config).
// Action:   Launch the Manager.
// Expected: Only one card for "test-app" is shown, and it is private (data-private="true").
//           The embedded config is suppressed by the deduplication logic.
test('private config hides embedded config on startup', async ({ electronApp }) => {
  // Write the private config before opening the page so deduplication fires at load time.
  const embeddedContent = { profile: 'test-app', url: 'https://example.com', name: 'Test App' }
  fs.writeFileSync(PRIVATE_FILE, JSON.stringify(embeddedContent, null, 2))

  const page = await electronApp.firstWindow()
  await page.waitForSelector('.card-add', { timeout: 30_000 })

  const cards = page.locator('.card[data-profile="test-app"]')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toHaveAttribute('data-private', 'true')
})

// ── Delete private → restore embedded ────────────────────────────────────────

// Setup:    An embedded "Test App" has been copied to private; the private card is visible.
// Action:   Delete the private card with "Delete configuration" checked.
// Expected: The private card is removed; the original embedded card is restored in its place
//           (data-private="false", info button visible, no "User" badge).
test('deleting private config with deleteConfig restores embedded card', async ({ managerPage }) => {
  // First: copy to private so we have a private card to delete.
  const card = managerPage.locator('.card', { hasText: 'Test App' })
  await card.hover()
  await card.locator('[data-action="info"]').click()
  await managerPage.locator('#info-copy-btn').click()
  await expect(managerPage.locator('#info-copy-btn')).not.toBeVisible()
  await expect(card).toHaveAttribute('data-private', 'true')

  // Now delete the private card with deleteConfig enabled.
  await card.hover()
  await card.locator('[data-action="delete"]').click()
  // Enable "Delete configuration" toggle (off by default — must be clicked to activate).
  const configToggle = managerPage.locator('[data-key="deleteConfig"]')
  const isActive = await configToggle.evaluate(el => el.classList.contains('active'))
  if (!isActive) await configToggle.click()
  await managerPage.locator('#confirm-ok').click()

  // The embedded card must be restored.
  await expect(card).toHaveAttribute('data-private', 'false')
  await expect(card.locator('.badge.private')).toHaveCount(0)
  await card.hover()
  await expect(card.locator('[data-action="info"]')).toBeVisible()
  await expect(card.locator('[data-action="edit"]')).toHaveCount(0)
})
