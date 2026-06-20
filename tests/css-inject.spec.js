const { test, expect } = require('@playwright/test')
const path = require('node:path')

// Unit tests for css-inject's buildCss(): a pure function turning the per-app config into the
// stylesheet the plugin injects. Plain Node assertions (no browser) because the logic is string
// assembly, not visible Manager UI — the config dialog's persistence is covered in plugins.spec.js.

const CSS_INJECT = path.join(__dirname, '..', 'webapps', 'plugins', 'css-inject', 'css-inject.js')
const { buildCss } = require(CSS_INJECT)

// Setup:    No overrides and the focus-ring toggle absent (a brand-new / empty config).
// Action:   Build the stylesheet.
// Expected: null — the plugin attaches but injects nothing, so an unconfigured app is untouched.
test('buildCss returns null when nothing is configured', () => {
  expect(buildCss({})).toBeNull()
  expect(buildCss(undefined)).toBeNull()
})

// Setup:    Only variable overrides configured, focus-ring toggle off.
// Action:   Build the stylesheet.
// Expected: Just the :root, body variable block — the focus-ring rule must NOT leak in when the
//           toggle is off (regression guard for the existing colour-override behaviour).
test('buildCss emits only the variable block when removeFocusRing is off', () => {
  const css = buildCss({ rules: [{ varName: '--color-bg', color: '#112233' }] })
  expect(css).toBe(':root, body { --color-bg: #112233 !important; }')
  expect(css).not.toContain('outline')
})

// Setup:    No overrides, focus-ring toggle on (boolean true, as the manager's toggle stores it).
// Action:   Build the stylesheet.
// Expected: Only the :focus-visible outline:none rule — removing the keyboard ring works on its
//           own, without requiring any colour override to be present.
test('buildCss emits the focus-ring rule when removeFocusRing is true', () => {
  expect(buildCss({ removeFocusRing: true })).toBe(':focus-visible { outline: none !important; }')
})

// Setup:    A hand-edited config storing the toggle as the string "true".
// Action:   Build the stylesheet.
// Expected: Still treated as on — the resolver accepts the stringified boolean a manual edit may
//           produce, not just the real boolean the dialog writes.
test('buildCss accepts the string "true" for removeFocusRing', () => {
  expect(buildCss({ removeFocusRing: 'true' })).toBe(':focus-visible { outline: none !important; }')
})

// Setup:    Both a variable override and the focus-ring toggle on.
// Action:   Build the stylesheet.
// Expected: Both rules present, the variable block first then the focus-ring rule — the two
//           features compose rather than overriding each other.
test('buildCss combines variable overrides and the focus-ring rule', () => {
  const css = buildCss({ rules: [{ varName: '--color-bg', color: '#112233' }], removeFocusRing: true })
  expect(css).toBe(':root, body { --color-bg: #112233 !important; }\n:focus-visible { outline: none !important; }')
})
