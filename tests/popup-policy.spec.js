const { test, expect } = require('@playwright/test')
const { isBlankPopup, opensInApp } = require('../src/popup-policy')

// Unit tests for which pop-ups an app keeps (src/popup-policy.js). The wiring into
// setWindowOpenHandler / did-create-window is in src/window.js and needs a running window; it was
// verified against Electron 45 directly (Document Picture-in-Picture reaches the handler as
// about:blank and opens once allowed).

const TEAMS = { appOrigin: 'https://teams.cloud.microsoft', internalDomains: [] }

// Setup:    What Chromium hands the open handler for Teams' floating call window (Document
//           Picture-in-Picture) and for window.open('').
// Action:   Classify them.
// Expected: Blank pop-ups. They are filled by the page itself and have no address of their own;
//           sent to the system browser they produced an empty tab and Teams got no call window.
test('Picture-in-Picture and window.open("") are blank pop-ups the app keeps', () => {
  expect(isBlankPopup('about:blank')).toBe(true)
  expect(isBlankPopup('')).toBe(true)
  expect(isBlankPopup('https://teams.cloud.microsoft/')).toBe(false)
  expect(isBlankPopup('about:srcdoc')).toBe(false)
})

// Setup:    A same-origin pop-up, and one on a foreign site.
// Action:   Decide whether each stays in the app.
// Expected: Same-origin stays (OAuth redirects and the like), foreign goes out — the long-standing rule.
test('same-origin pop-ups stay, foreign ones go out', () => {
  expect(opensInApp('https://teams.cloud.microsoft/v2/x', TEAMS)).toBe(true)
  expect(opensInApp('https://example.com/', TEAMS)).toBe(false)
})

// Setup:    A whitelisted SSO domain (and a subdomain of it), with externalPopups switched on.
// Action:   Decide.
// Expected: Kept in the app — the whitelist exists to keep exactly these pages in, so externalPopups
//           must not defeat it, or an SSO pop-up would break.
test('internal domains stay in the app even with externalPopups', () => {
  const policy = { appOrigin: 'http://localhost:9900', internalDomains: ['accounts.google.com'], externalPopups: true }
  expect(opensInApp('https://accounts.google.com/o/oauth2', policy)).toBe(true)
  expect(opensInApp('https://eu.accounts.google.com/x', policy)).toBe(true)
})

// Setup:    An app with externalPopups (trivialSlides' "present" link opens its own page in a new tab).
// Action:   Decide on a same-origin pop-up.
// Expected: It goes out to the browser — that is what the option is for.
test('externalPopups sends even same-origin pop-ups out', () => {
  expect(opensInApp('http://localhost:9900/d/x/present', { appOrigin: 'http://localhost:9900', externalPopups: true })).toBe(false)
})

// Setup:    Garbage instead of a URL.
// Action:   Decide.
// Expected: Not kept — the caller then treats it as external/denied rather than crashing.
test('an unparsable URL never stays in the app', () => {
  expect(opensInApp('not a url', TEAMS)).toBe(false)
})
