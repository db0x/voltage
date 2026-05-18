const { rcloneTest: test, expect } = require('./fixtures')

// ── Menu ──────────────────────────────────────────────────────────────────────

// Setup:    Manager launched with fake rclone binary in PATH (returns exit 0 for `which`).
// Action:   Open the side drawer.
// Expected: The rclone integration menu item is visible — rclone availability is detected.
test('rclone menu item visible when rclone is available', async ({ managerPageWithRclone }) => {
  const page = managerPageWithRclone
  await page.click('#menu-btn')
  await expect(page.locator('#menu-rclone')).toBeVisible()
})

// ── Dialog opening ────────────────────────────────────────────────────────────

// Setup:    Drawer open, rclone available.
// Action:   Click the rclone menu item.
// Expected: The rclone dialog appears with a Google Drive fieldset and remote selector.
test('rclone dialog opens and shows Google Drive fieldset', async ({ managerPageWithRclone }) => {
  const page = managerPageWithRclone
  await page.click('#menu-btn')
  await page.click('#menu-rclone')
  await expect(page.locator('.rclone-fieldset')).toBeVisible()
  await expect(page.locator('#rclone-remote-select')).toBeVisible()
})

// ── Remote list ───────────────────────────────────────────────────────────────

// Setup:    rclone dialog open; fake rclone returns one Drive remote "test-drive".
// Action:   (none — checks initial state after open)
// Expected: The remote dropdown contains the "test-drive" option from the fake config dump.
test('rclone dialog lists remotes from fake config dump', async ({ managerPageWithRclone }) => {
  const page = managerPageWithRclone
  await page.click('#menu-btn')
  await page.click('#menu-rclone')
  await page.waitForSelector('#rclone-remote-select')
  const options = await page.locator('#rclone-remote-select option').allTextContents()
  expect(options).toContain('test-drive')
})

// ── Upload-folder section visibility ─────────────────────────────────────────

// Setup:    rclone dialog open, no remote selected (default "none" option).
// Action:   (none — checks initial state)
// Expected: The upload-folder section is hidden until a remote is chosen.
test('upload-folder section hidden when no remote selected', async ({ managerPageWithRclone }) => {
  const page = managerPageWithRclone
  await page.click('#menu-btn')
  await page.click('#menu-rclone')
  await page.waitForSelector('#rclone-remote-select')
  await expect(page.locator('#rclone-folders-section')).toBeHidden()
})

// Setup:    rclone dialog open with one installed rclone app (test-rclone-app).
// Action:   Select "test-drive" from the remote dropdown.
// Expected: The upload-folder section becomes visible and the test app's folder row appears.
//           We don't assert an exact count — other real installed rclone apps may be present.
test('upload-folder section appears after selecting a remote', async ({ managerPageWithRclone }) => {
  const page = managerPageWithRclone
  await page.click('#menu-btn')
  await page.click('#menu-rclone')
  await page.waitForSelector('#rclone-remote-select')
  await page.selectOption('#rclone-remote-select', 'test-drive')
  await expect(page.locator('#rclone-folders-section')).toBeVisible()
  await expect(page.locator('#rclone-folders-section input[data-profile="test-rclone-app"]')).toBeVisible()
})

// ── Default folder value ──────────────────────────────────────────────────────

// Setup:    Upload-folder section visible, no saved config yet.
// Action:   (none — checks pre-filled value)
// Expected: The input defaults to the app's profile name ("test-rclone-app").
test('upload-folder input defaults to app profile name', async ({ managerPageWithRclone }) => {
  const page = managerPageWithRclone
  await page.click('#menu-btn')
  await page.click('#menu-rclone')
  await page.waitForSelector('#rclone-remote-select')
  await page.selectOption('#rclone-remote-select', 'test-drive')
  const value = await page.locator('.rclone-folder-row input[data-profile="test-rclone-app"]').inputValue()
  expect(value).toBe('test-rclone-app')
})

// ── Validation ────────────────────────────────────────────────────────────────

// Setup:    Upload-folder section visible; user clears the folder input.
// Action:   Click Save with an empty folder field.
// Expected: The input receives the .invalid class; the dialog stays open (save is blocked).
test('save is blocked and field marked invalid when folder input is empty', async ({ managerPageWithRclone }) => {
  const page = managerPageWithRclone
  await page.click('#menu-btn')
  await page.click('#menu-rclone')
  await page.waitForSelector('#rclone-remote-select')
  await page.selectOption('#rclone-remote-select', 'test-drive')
  await page.fill('.rclone-folder-row input', '')
  await page.click('#rclone-save')
  await expect(page.locator('.rclone-folder-row input.invalid')).toBeVisible()
  await expect(page.locator('.rclone-dialog')).toBeVisible()
})

// ── Save and reload ───────────────────────────────────────────────────────────

// Setup:    Upload-folder section visible with a valid folder name typed in.
// Action:   Click Save, then reopen the dialog.
// Expected: The saved remote and folder name are pre-selected on next open.
test('saved remote and folder name are restored on next open', async ({ managerPageWithRclone }) => {
  const page = managerPageWithRclone
  await page.click('#menu-btn')
  await page.click('#menu-rclone')
  await page.waitForSelector('#rclone-remote-select')
  await page.selectOption('#rclone-remote-select', 'test-drive')
  await page.fill('#rclone-folders-section input[data-profile="test-rclone-app"]', 'my-custom-folder')
  await page.click('#rclone-save')

  // Re-open the dialog.
  await page.click('#menu-btn')
  await page.click('#menu-rclone')
  await page.waitForSelector('#rclone-remote-select')

  expect(await page.locator('#rclone-remote-select').inputValue()).toBe('test-drive')
  const folderValue = await page.locator('.rclone-folder-row input[data-profile="test-rclone-app"]').inputValue()
  expect(folderValue).toBe('my-custom-folder')
})
