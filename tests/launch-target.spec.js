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

// ── Host aliases: a link on another hostname of the same service opens on the app's own origin ────
const { canonicalAppUrl } = require('../src/launch-target')
const { expandConfig } = require('../scripts/build')
const TEAMS_APP = { url: 'https://teams.cloud.microsoft', hostAliases: ['teams.microsoft.com'] }

// Setup:    Teams on teams.cloud.microsoft, a meeting link from Outlook on teams.microsoft.com.
// Action:   Canonicalize the link.
// Expected: Same path, query and hash on the app's own host. Loading the alias host put Teams on a
//           different origin — own cookies and storage, plus Microsoft's "new URL" banner — and it
//           stayed there.
test('a link on a host alias is rewritten to the app origin, path intact', () => {
  expect(canonicalAppUrl(TEAMS_APP, 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d#top'))
    .toBe('https://teams.cloud.microsoft/l/meetup-join/19%3ameeting_x/0?context=%7b%7d#top')
})

// Setup:    Links that are NOT on an alias: the app's own host, a foreign host, a non-web argument,
//           and an app without aliases.
// Action:   Canonicalize them.
// Expected: Returned unchanged. In particular links pulled in via routingUrls (SharePoint documents
//           for the Office apps) must keep their full URL — rewriting their host would break them.
test('links that are not on an alias pass through untouched', () => {
  expect(canonicalAppUrl(TEAMS_APP, 'https://teams.cloud.microsoft/v2/')).toBe('https://teams.cloud.microsoft/v2/')
  expect(canonicalAppUrl(TEAMS_APP, 'https://contoso.sharepoint.com/:w:/r/doc.docx')).toBe('https://contoso.sharepoint.com/:w:/r/doc.docx')
  expect(canonicalAppUrl(TEAMS_APP, 'mailto:a@b.c')).toBe('mailto:a@b.c')
  expect(canonicalAppUrl({ url: 'https://x.example' }, 'https://teams.microsoft.com/l/x')).toBe('https://teams.microsoft.com/l/x')
  expect(canonicalAppUrl(TEAMS_APP, null)).toBeNull()
})

// Setup:    An app that was itself launched on a deep link (startUrl is the configured start URL).
// Action:   Canonicalize an alias link.
// Expected: The configured origin is used, not the deep link's — the same rule plugins follow.
test('the configured start URL decides the origin', () => {
  const pkg = { ...TEAMS_APP, url: 'https://teams.cloud.microsoft/l/somewhere', startUrl: 'https://teams.cloud.microsoft' }
  expect(canonicalAppUrl(pkg, 'https://teams.microsoft.com/l/x')).toBe('https://teams.cloud.microsoft/l/x')
})

// Setup:    A config with hostAliases.
// Action:   Derive its routing keys, and run it through the build's config expander.
// Expected: The alias is a routing key (so the link reaches the app at all) and it is baked into the
//           AppImage (so the runtime can rewrite it) — one entry does both jobs.
test('hostAliases route to the app and are baked into the AppImage', () => {
  const { routingUrlKeys } = require('../src/routing-match')
  expect(routingUrlKeys(TEAMS_APP)).toContain('teams.microsoft.com')
  const base = { profile: 'demo', url: 'https://example.com' }
  expect('hostAliases' in expandConfig(base).extraMetadata).toBe(false)
  expect(expandConfig({ ...base, hostAliases: ['old.example.com'] }).extraMetadata.hostAliases).toEqual(['old.example.com'])
})
