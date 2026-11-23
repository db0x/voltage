const { test, expect } = require('@playwright/test')
const { isUnreachableStatus, statusReason } = require('../src/load-status')
const { viewConfig } = require('../webapps/plugins/widget/widget.js')

// Unit tests for recognising an unreachable app behind a page that DID load (src/load-status.js),
// plus the widget's backdrop flag. Before this, only real network failures reached the "not
// reachable" page; a proxy's 502 or a 404 was shown as the app — and in a widget, on a transparent
// view, it was barely readable. The Electron wiring (did-navigate → error page, view backdrop) is in
// src/window.js and needs a running window.

// Setup:    The statuses a reverse proxy returns when the service behind it is gone, plus a plain 500.
// Action:   Classify them on a start load and on a later navigation.
// Expected: Unreachable in both cases — a 5xx top-level page leaves nothing usable, whenever it comes.
test('5xx is unreachable on every navigation', () => {
  for (const code of [500, 502, 503, 504]) {
    expect(isUnreachableStatus(code, true)).toBe(true)
    expect(isUnreachableStatus(code, false)).toBe(true)
  }
})

// Setup:    404 and 410 — the app's entry point is not there.
// Action:   Classify them on the start load and mid-session.
// Expected: Unreachable only on the start load. Mid-session a 404 can be the app's own "not found"
//           view, which must stay visible instead of being replaced by our error page.
test('404/410 count only when the app itself is being opened', () => {
  for (const code of [404, 410]) {
    expect(isUnreachableStatus(code, true)).toBe(true)
    expect(isUnreachableStatus(code, false)).toBe(false)
  }
})

// Setup:    The auth statuses, and other 4xx, on the start load.
// Action:   Classify them.
// Expected: Never unreachable. 401/403/407 mean "reachable, log in first" — an app behind basic auth
//           or an SSO answering 401 with its login form would otherwise disappear behind our error
//           page; the remaining 4xx are the app talking, not the app missing.
test('auth and other client errors are never treated as unreachable', () => {
  for (const code of [400, 401, 403, 407, 429]) expect(isUnreachableStatus(code, true)).toBe(false)
})

// Setup:    Normal outcomes, and a load without a status (our own data: pages, file: URLs).
// Action:   Classify them on the start load.
// Expected: Normal loads — the guard must never fire on success, redirects or status-less pages.
test('success, redirects and status-less loads are normal', () => {
  for (const code of [200, 204, 301, 302, 304, 0, undefined, null]) expect(isUnreachableStatus(code, true)).toBe(false)
})

// Setup:    The localized template with its {status} placeholder, with and without a status text.
// Action:   Build the reason line shown on the error page.
// Expected: Code and text joined; a missing text leaves just the code, and a missing template falls
//           back to English rather than showing a raw placeholder.
test('statusReason fills the localized line', () => {
  expect(statusReason('Der Server antwortet mit {status}', 502, 'Bad Gateway')).toBe('Der Server antwortet mit 502 Bad Gateway')
  expect(statusReason('Der Server antwortet mit {status}', 503, '')).toBe('Der Server antwortet mit 503')
  expect(statusReason(undefined, 404, 'Not Found')).toBe('The server responded with 404 Not Found')
})

// Setup:    Widget configs with the tint off (default) and on.
// Action:   Read the view config the window is built from.
// Expected: Transparent only with the tint — the one feature that blends with the desktop on purpose.
//           Every other widget gets an opaque backdrop, so a page without its own background (a bare
//           proxy error page) stays readable.
test('the widget view is transparent only when the tint asks for it', () => {
  expect(viewConfig({}).transparent).toBe(false)
  expect(viewConfig({ tintBackground: false }).transparent).toBe(false)
  expect(viewConfig({ tintBackground: true }).transparent).toBe(true)
})
