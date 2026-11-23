const { test, expect } = require('@playwright/test')
const { launchTarget } = require('../src/launch-target')

// Unit tests for where a launch argument goes when it reaches an already running single-instance
// app (src/launch-target.js) — e.g. a Teams meeting link routed from Outlook. Plain objects stand in
// for BrowserWindows; the Electron wiring in app-window.js is a one-liner around this.

// Fake windows: a widget main window (app in an inset view, shadow host page in webContents), a plain
// app window, and an extra window such as a meeting pop-out that window.js never tagged.
const appView  = { id: 'app-view' }
const hostPage = { id: 'host-page' }
const widgetMain = { _voltageAppContents: appView, webContents: hostPage }
const plainMain  = { _voltageAppContents: { id: 'plain-wc' }, webContents: { id: 'plain-wc' } }
const popup      = { webContents: { id: 'popup-wc' } }

// Setup:    A widget app: the app lives in the inset view, webContents is the shadow host page.
// Action:   Resolve the target for an incoming URL.
// Expected: The app VIEW, never the host page. Loading into the host page is the reported bug: the
//           meeting rendered in the frame around the app, without plugins, zoom or the widget chrome.
test('a widget app receives the URL in its app view, not in the shadow host page', () => {
  const t = launchTarget([widgetMain])
  expect(t.contents).toBe(appView)
  expect(t.contents).not.toBe(hostPage)
})

// Setup:    A meeting pop-out happens to come FIRST in getAllWindows(), the main window second.
// Action:   Resolve the target.
// Expected: The main window — getAllWindows() has no guaranteed order, so "the first one" could hand
//           the URL to a pop-out or the About panel.
test('the main window is chosen even when another window comes first', () => {
  const t = launchTarget([popup, widgetMain])
  expect(t.win).toBe(widgetMain)
  expect(t.contents).toBe(appView)
})

// Setup:    An ordinary (non-widget) app, whose app does live in the window's own webContents.
// Action:   Resolve the target.
// Expected: That webContents — the fix must not change behaviour for apps without the widget plugin.
test('a plain app keeps receiving the URL in its own webContents', () => {
  expect(launchTarget([plainMain]).contents).toBe(plainMain._voltageAppContents)
})

// Setup:    No windows at all (the app is still starting up), and only an untagged window.
// Action:   Resolve the target.
// Expected: null for none; for an untagged window its own webContents as a last resort, so a launch
//           argument is never silently dropped.
test('no window yields null, an untagged window falls back to its webContents', () => {
  expect(launchTarget([])).toBeNull()
  expect(launchTarget([popup]).contents).toBe(popup.webContents)
})
