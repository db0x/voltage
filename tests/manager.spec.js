const { test, expect } = require('./fixtures')

// Setup:    Manager launched with standard test configs (5 apps: public, private, MS, Google, mail).
// Action:   (none — reads window title attribute)
// Expected: Title starts with "Voltage" followed by the version string (no "Manager").
test('manager window has correct title', async ({ managerPage }) => {
  await expect(managerPage).toHaveTitle(/^Voltage \d+\.\d+\.\d+/)
})

// Setup:    Manager launched with standard test configs.
// Action:   (none — checks initial layout)
// Expected: The card grid and the add-card button are both visible on startup.
test('app grid is visible', async ({ managerPage }) => {
  await expect(managerPage.locator('#grid')).toBeVisible()
  await expect(managerPage.locator('.card-add')).toBeVisible()
})

// Setup:    Manager launched with build.test-app.json (public, not built).
// Action:   (none — reads card state)
// Expected: A card for "Test App" is rendered showing the "not built" badge.
test('public test-app card is rendered', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test App' })
  await expect(card).toBeVisible()
  await expect(card.locator('.badge.not-built')).toBeVisible()
})

// Setup:    Manager launched; test-app has no "icon" field in its config.
// Action:   (none — reads the card image src attribute)
// Expected: The fallback icon src starts with "file://" — meaning it was resolved
//           via the IPC/GTK path (application-default-icon or a local file path),
//           not via a hard-coded relative path like "../../assets/voltage.svg".
test('icon-less app card uses a resolved file:// icon, not a hard-coded relative path', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test App' })
  const imgSrc = await card.locator('img').first().getAttribute('src')
  expect(imgSrc).toMatch(/^file:\/\//)
})

// Setup:    Manager launched with build.private.test-user-app.json (private app).
// Action:   (none — reads card state)
// Expected: A card for "Test User App" is rendered with the "private" badge.
test('private test-user-app card is rendered', async ({ managerPage }) => {
  const card = managerPage.locator('.card', { hasText: 'Test User App' })
  await expect(card).toBeVisible()
  await expect(card.locator('.badge.private')).toBeVisible()
})

// Setup:    Manager open, drawer initially closed.
// Action:   Click the menu button to open the drawer, then press Escape.
// Expected: Drawer gains the "open" CSS class when opened, then loses it on Escape.
test('drawer opens and closes via menu button', async ({ managerPage }) => {
  const drawer = managerPage.locator('.drawer')
  await expect(drawer).not.toHaveClass(/open/)

  await managerPage.click('#menu-btn')
  await expect(drawer).toHaveClass(/open/)

  await managerPage.keyboard.press('Escape')
  await expect(drawer).not.toHaveClass(/open/)
})

// Setup:    Manager open with both private and public app cards.
// Action:   Open the drawer and click the "User Apps" (private) filter.
// Expected: Private cards are visible; public cards are hidden.
test('filter "User Apps" shows only private cards', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('[data-filter="private"]')

  // Private card must be visible
  const privateCard = managerPage.locator('.card[data-private="true"]')
  await expect(privateCard.first()).toBeVisible()

  // Public card must be hidden
  const publicCard = managerPage.locator('.card[data-private="false"]').first()
  await expect(publicCard).not.toBeVisible()
})

// Setup:    Manager open showing the add-card button.
// Action:   Open the drawer and click the "Embedded Apps" (public) filter.
// Expected: The add-card button is hidden because adding apps is only allowed in the "all" view.
test('filter "Embedded Apps" hides the add-card', async ({ managerPage }) => {
  await managerPage.click('#menu-btn')
  await managerPage.click('[data-filter="public"]')

  await expect(managerPage.locator('.card-add')).not.toBeVisible()
})

// Setup:    Manager open; dark mode is off (no "dark" class on body).
// Action:   Open the drawer and click the dark mode toggle.
// Expected: The "dark" class is added to the body element.
test('dark mode toggle adds dark class to body', async ({ managerPage }) => {
  await expect(managerPage.locator('body')).not.toHaveClass(/dark/)

  await managerPage.click('#menu-btn')
  await managerPage.click('#menu-darkmode')

  await expect(managerPage.locator('body')).toHaveClass(/dark/)
})
