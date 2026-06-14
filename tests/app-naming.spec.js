const { test, expect } = require('@playwright/test')
const { appName, profileFromAppName, wmClass } = require('../src/app-naming')

// Pure-logic unit tests for the artifact-naming helper. No Electron/browser needed — these run
// in the plain Playwright node runner and guard the round-trip relied on by the build scripts
// (forward: profile → artifact name) and the runtime routing/icon lookups (inverse).

test.describe('appName — profile → artifact name', () => {
  // Setup:    a single-word lowercase profile, the common case.
  // Action:   derive the user-facing artifact name.
  // Expected: leading "v" + upper-cased first letter ("teams" → "vTeams"), per the rename scheme.
  test('upper-cases only the first letter', () => {
    expect(appName('teams')).toBe('vTeams')
  })

  // Setup:    a hyphenated profile.
  // Action:   derive the artifact name.
  // Expected: only the first letter is upper-cased so the inverse can recover the exact profile.
  test('leaves the rest of a hyphenated profile untouched', () => {
    expect(appName('google-docs')).toBe('vGoogle-docs')
  })
})

test.describe('wmClass — window↔launcher matching token', () => {
  // Setup:    the capitalised artifact name and the Wayland reality.
  // Action:   derive the WM class used for .desktop StartupWMClass and the wm-class switch.
  // Expected: the lowercased artifact name, because Chromium forces the Wayland app_id lowercase
  //           ("vTeams" → "vteams") and GNOME matches it case-sensitively against StartupWMClass.
  test('is the lowercased artifact name', () => {
    expect(wmClass('teams')).toBe('vteams')
    expect(wmClass('google-docs')).toBe('vgoogle-docs')
  })
})

test.describe('profileFromAppName — artifact name → profile', () => {
  // Setup:    a new-scheme artifact name.
  // Action:   recover the build profile.
  // Expected: the original lowercase profile, the inverse of appName().
  test('inverts appName for the new scheme', () => {
    expect(profileFromAppName('vTeams')).toBe('teams')
    expect(profileFromAppName('vGoogle-docs')).toBe('google-docs')
  })

  // Setup:    every profile that ships as a build config.
  // Action:   round-trip profile → appName → profile.
  // Expected: lossless, otherwise renamed AppImages would fail to route back to their profile.
  test('round-trips for representative profiles', () => {
    for (const p of ['teams', 'gmail', 'google-docs', 'one-note']) {
      expect(profileFromAppName(appName(p))).toBe(p)
    }
  })
})
