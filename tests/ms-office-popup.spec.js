const { test, expect } = require('@playwright/test')
const path = require('node:path')

// Unit tests for the ms-office plugin's popupKind() — the window.open classifier that decides whether
// a popup is the document launcher / a host-less placeholder (allowed hidden + routed) or a real
// external URL (self-claim / route / browser). Plain Node assertions (no browser): it is pure URL
// logic, and the routing/launch side effects are an Electron-runtime path not exercised here.
//
// The regression it guards: OneDrive opens a document by first reserving an about:blank popup
// synchronously (anti-popup-blocker), then navigating it to the doc URL. Classing about:blank as
// 'external' sent it to openExternal() → a stray empty browser tab before the doc opened.

const { popupKind } = require(path.join(__dirname, '..', 'webapps', 'plugins', 'ms-office', 'ms-office.js'))

const APP_ORIGIN = 'https://ituconsult040-my.sharepoint.com'

// Setup:    about:blank and other host-less popup URLs (the kind OneDrive reserves on click).
// Action:   Classify them.
// Expected: 'placeholder' — they must be allowed hidden and watched, never sent to the browser.
test('popupKind treats about:blank and host-less URLs as placeholders', () => {
  expect(popupKind('about:blank', APP_ORIGIN, [])).toBe('placeholder')
  expect(popupKind('data:text/html,<p>x', APP_ORIGIN, [])).toBe('placeholder')
})

// Setup:    A same-origin launcher URL and a whitelisted internal-domain URL.
// Action:   Classify them.
// Expected: 'internal' — the document launcher / internal popups, also allowed hidden and routed.
test('popupKind treats same-origin and internal-domain URLs as internal', () => {
  expect(popupKind(`${APP_ORIGIN}/personal/u/_layouts/15/Doc.aspx?sourcedoc=x`, APP_ORIGIN, [])).toBe('internal')
  expect(popupKind('https://login.microsoftonline.com/common', APP_ORIGIN, ['microsoftonline.com'])).toBe('internal')
  expect(popupKind('https://sub.microsoftonline.com/x', APP_ORIGIN, ['microsoftonline.com'])).toBe('internal')
})

// Setup:    A foreign URL and an unparseable string.
// Action:   Classify them.
// Expected: 'external' — these go through the self-claim / route / browser path (a parse failure is
//           safely external rather than throwing).
test('popupKind treats foreign and unparseable URLs as external', () => {
  expect(popupKind('https://example.com/x', APP_ORIGIN, [])).toBe('external')
  expect(popupKind('::not a url::', APP_ORIGIN, [])).toBe('external')
})
