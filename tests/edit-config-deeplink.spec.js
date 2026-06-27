const path = require('node:path')
const { editConfigTest, expect } = require('./fixtures')
const { test } = require('@playwright/test')
const { editProfileFromArgv } = require('../src/manager/edit-config')
const { expandConfig } = require('../scripts/build')

// Covers the Manager's "open straight into the edit dialog" interface: the --voltage-edit-config=
// <profile> launch flag (used by an app's configure button). The pure argv parser is unit-tested;
// the cold-start path is exercised end-to-end through a real Manager launch.

// Setup:    Various argv arrays.
// Action:   Parse the edit-config flag.
// Expected: Returns the profile when the flag carries one, null when it is absent or empty — so a
//           normal launch never triggers the deep link.
test('editProfileFromArgv reads the profile from the flag, else null', () => {
  expect(editProfileFromArgv(['/electron', '/app', '--voltage-edit-config=test-user-app'])).toBe('test-user-app')
  expect(editProfileFromArgv(['/electron', '/app', '--no-sandbox'])).toBeNull()
  expect(editProfileFromArgv(['--voltage-edit-config='])).toBeNull()
  expect(editProfileFromArgv([])).toBeNull()
})

// Setup:    A minimal app config passed through the build's config expander.
// Action:   Read the metadata baked into the AppImage.
// Expected: The repo root travels as appRoot — that's what a running app reads to relaunch the
//           Manager (src/window.js openConfigInManager); without it the configure button is a no-op.
test('expandConfig bakes the repo root as appRoot', () => {
  const meta = expandConfig({ profile: 'demo', url: 'https://example.com' }).extraMetadata
  expect(meta.appRoot).toBe(path.resolve(__dirname, '..'))
  expect(meta.profile).toBe('demo')
})

// Setup:    Manager launched with --voltage-edit-config=test-user-app (an editable private app).
// Action:   Wait for the UI to finish initialising.
// Expected: The edit dialog auto-opens for exactly that app — its profile label shows the profile —
//           without any user interaction, proving the deep link reaches the existing edit flow.
editConfigTest('launching with --voltage-edit-config opens that app’s edit dialog', async ({ managerPageEditConfig: page }) => {
  await expect(page.locator('#edit-profile-label')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('#edit-profile-label')).toHaveText('test-user-app')
})
