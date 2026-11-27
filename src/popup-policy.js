// Which pop-ups an app window opens itself, and which go elsewhere (another voltage app, or the
// system browser). Pure, so the whole decision is unit-testable; src/window.js wires it into
// setWindowOpenHandler.

// A pop-up the page fills ITSELF: window.open('') / about:blank, and — the case that made this
// necessary — Document Picture-in-Picture. Teams opens its floating call window that way when you
// leave a call to look at a chat; Chromium hands it to the open handler as about:blank. Such a window
// has no address of its own, so it can never belong in the system browser: sent there it produced an
// empty browser tab, and Teams got no call window at all.
function isBlankPopup(url) {
  return url === '' || url === 'about:blank'
}

// Whether a pop-up with a real URL stays inside the app (as an Electron window) rather than going
// out. Whitelisted internal domains come FIRST: that list exists precisely to keep e.g. an SSO page
// in the app, so externalPopups must not override it. Same-origin pages stay in too (OAuth redirects
// and the like) unless the app opted into handing every pop-up to the browser (externalPopups).
function opensInApp(url, { appOrigin, internalDomains = [], externalPopups = false } = {}) {
  let target
  try { target = new URL(url) } catch { return false }
  if (internalDomains.some(d => target.hostname === d || target.hostname.endsWith('.' + d))) return true
  return !externalPopups && target.origin === appOrigin
}

module.exports = { isBlankPopup, opensInApp }
