const { test, expect } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')

// Contract test: the in-app About overlay must always feel native and never be selectable web
// content. The no-select plugin only styles the app's own page, not this separate overlay document,
// so the overlay enforces it itself. A plain file assertion (no browser) — the regression is purely
// "is the rule present in the overlay's CSS", and the full overlay render is exercised in
// appimage-about.spec.js.
const ABOUT_HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'about-window.html'), 'utf8')

// Setup:    The About overlay markup as shipped.
// Action:   Inspect its global reset.
// Expected: It declares user-select:none (both the standard and -webkit form match this substring),
//           so selection is disabled unconditionally regardless of the no-select plugin.
test('about overlay disables text selection unconditionally', () => {
  expect(ABOUT_HTML.replace(/\s+/g, '')).toContain('user-select:none')
})
