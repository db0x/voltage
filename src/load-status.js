// Deciding when a page that DID load is in fact the app being unreachable.
//
// The load guard in src/window.js used to react only to did-fail-load, i.e. real network failures
// (DNS, connection refused, timeout). A server that answers with an error PAGE — a reverse proxy
// saying 502/503/504 because the backend behind it is down, or a 404 because the configured URL is
// gone — counts as a successful load to Chromium, so that page was shown as the app. In a widget
// window it was barely readable on top of that: the view is transparent and such pages rarely paint
// a background of their own.
//
// Pure (no Electron) so the classification is unit-testable.

// Whether a main-frame response with this status means "the app is not there".
//  - 5xx always: 502/503/504 are what a proxy says when the service behind it is gone, and a 500 on
//    a top-level page leaves nothing usable either.
//  - 404/410 only for the START load (the configured URL, or a retry of it): if the app's own entry
//    point is not found, the app is not there. Mid-session a 404 can be a legitimate page of the app
//    itself — its own "not found" view — and must stay visible.
//  - Never the other 4xx. 401/403/407 mean "reachable, but log in first" — an app behind basic auth
//    or an SSO that answers 401 with its login form would otherwise vanish behind our error page —
//    and the rest (400, 429, …) are the app talking, not the app missing.
// Anything else (2xx, 3xx, a missing code on data:/file: loads) is a normal load.
const GONE = new Set([404, 410])
function isUnreachableStatus(code, isStartLoad) {
  if (!Number.isInteger(code)) return false
  if (code >= 500 && code <= 599) return true
  return !!isStartLoad && GONE.has(code)
}

// The reason line shown on the error page, e.g. "The server responded with 502 Bad Gateway".
// `template` is the localized text with {status} as the placeholder.
function statusReason(template, code, statusText) {
  const status = [code, statusText].filter(Boolean).join(' ')
  return String(template || 'The server responded with {status}').replace('{status}', status)
}

module.exports = { isUnreachableStatus, statusReason }
