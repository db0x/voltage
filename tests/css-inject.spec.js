const { test, expect } = require('@playwright/test')
const path = require('node:path')

// Unit tests for css-inject's pure config→output functions: buildCss() (per-app config → the
// injected stylesheet) and preloadArgs() (that stylesheet → the document-start additionalArgument
// the preload reads). Plain Node assertions (no browser) because the logic is string assembly, not
// visible Manager UI — the config dialog's persistence is covered in plugins.spec.js, and the
// end-to-end document-start injection is an Electron-runtime path not exercised here.

const CSS_INJECT = path.join(__dirname, '..', 'webapps', 'plugins', 'css-inject', 'css-inject.js')
const { buildCss, preloadArgs, PRELOAD_ARG } = require(CSS_INJECT)

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

// Setup:    Only the free-text custom CSS block configured (no overrides, focus-ring off).
// Action:   Build the stylesheet.
// Expected: The custom CSS verbatim — it is injected as-is (user-authored CSS for their own app),
//           trimmed of surrounding whitespace.
test('buildCss emits the custom CSS block verbatim', () => {
  expect(buildCss({ customCss: '  .ad { display: none; }  ' })).toBe('.ad { display: none; }')
})

// Setup:    A blank / whitespace-only custom CSS field and nothing else configured.
// Action:   Build the stylesheet.
// Expected: null — an empty free-text field must not turn an otherwise-unconfigured app into an
//           injection target.
test('buildCss ignores blank custom CSS', () => {
  expect(buildCss({ customCss: '   ' })).toBeNull()
  expect(buildCss({ customCss: '' })).toBeNull()
})

// Setup:    A variable override, the focus-ring toggle on, and a custom CSS block — all three.
// Action:   Build the stylesheet.
// Expected: All three present in order (variable block, focus-ring rule, then custom CSS last) — the
//           custom block is appended last so it wins at equal specificity over the structured rules.
test('buildCss appends custom CSS after the variable and focus-ring rules', () => {
  const css = buildCss({
    rules: [{ varName: '--color-bg', color: '#112233' }],
    removeFocusRing: true,
    customCss: '.ad { display: none; }',
  })
  expect(css).toBe(
    ':root, body { --color-bg: #112233 !important; }\n' +
    ':focus-visible { outline: none !important; }\n' +
    '.ad { display: none; }'
  )
})

// Setup:    A config that produces no stylesheet (nothing configured).
// Action:   Ask the plugin for its preload arguments.
// Expected: An empty array — without CSS the document-start arg must be absent, so the preload's
//           reader finds nothing and no-ops (no flicker path, no wasted argv entry).
test('preloadArgs returns nothing when no CSS is configured', () => {
  expect(preloadArgs({})).toEqual([])
  expect(preloadArgs(undefined)).toEqual([])
})

// Setup:    A config that yields a stylesheet (one variable override).
// Action:   Ask the plugin for its preload arguments.
// Expected: Exactly one --voltage-css-inject= entry carrying the URI-encoded stylesheet — this is
//           what window.js bakes into additionalArguments and the preload decodes + insertCSSes at
//           document-start. Round-tripping the decode must reproduce buildCss's output verbatim.
test('preloadArgs carries the encoded stylesheet for the preload', () => {
  const config = { rules: [{ varName: '--color-bg', color: '#112233' }], customCss: '.ad { display: none; }' }
  const args = preloadArgs(config)
  expect(args).toHaveLength(1)
  expect(args[0].startsWith(PRELOAD_ARG)).toBe(true)
  expect(decodeURIComponent(args[0].slice(PRELOAD_ARG.length))).toBe(buildCss(config))
})
