const { obsidianTest: test, expect } = require('./fixtures')

// ── Flatpak-Hint visibility ───────────────────────────────────────────────────

// Setup:    Manager launched with VOLTAGE_TEST_OBSIDIAN_FLATPAK=1 so the status
//           IPC reports a Flatpak install; Obsidian drawer entry is enabled.
// Action:   Open drawer, click Obsidian Integration entry.
// Expected: The Flatpak hint section is visible and shows the exact override
//           command users must run. Confirms the dialog renders the help block
//           only when the sandboxed Obsidian variant was detected.
test('flatpak hint is visible when sandboxed Obsidian is detected', async ({ managerPageObsidianFlatpak }) => {
  const page = managerPageObsidianFlatpak
  await page.click('#menu-btn')
  await page.click('#menu-obsidian')
  await expect(page.locator('#obsidian-flatpak-hint')).toBeVisible()
  await expect(page.locator('#obsidian-flatpak-cmd')).toHaveText(
    'flatpak override --user --filesystem=home md.obsidian.Obsidian'
  )
})

// Setup:    Manager launched without VOLTAGE_TEST_OBSIDIAN_FLATPAK; Obsidian drawer
//           entry is enabled via VOLTAGE_TEST_OBSIDIAN_AVAILABLE only.
// Action:   Open drawer, click Obsidian Integration entry.
// Expected: The Flatpak hint section stays hidden — non-sandboxed users should not
//           see instructions for a permission they do not need.
test('flatpak hint is hidden on native Obsidian installs', async ({ managerPageObsidianNative }) => {
  const page = managerPageObsidianNative
  await page.click('#menu-btn')
  await page.click('#menu-obsidian')
  await expect(page.locator('.obsidian-dialog')).toBeVisible()
  await expect(page.locator('#obsidian-flatpak-hint')).toBeHidden()
})

// ── Copy mechanism ────────────────────────────────────────────────────────────

// Setup:    Flatpak hint visible (see fixture above).
// Action:   Click the copy button next to the override command.
// Expected: The button briefly shows a check mark (✓) and gains the `.copied`
//           class — proves the click handler ran and the user receives visible
//           feedback even when clipboard access fails silently (e.g. headless).
test('copy button gives feedback when clicked', async ({ managerPageObsidianFlatpak }) => {
  const page = managerPageObsidianFlatpak
  await page.click('#menu-btn')
  await page.click('#menu-obsidian')
  const copyBtn = page.locator('#obsidian-flatpak-copy')
  await copyBtn.click()
  await expect(copyBtn).toHaveClass(/copied/)
  await expect(copyBtn).toHaveText('✓')
})