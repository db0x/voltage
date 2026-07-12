const { test, expect } = require('./fixtures')
const path = require('node:path')

// The zoom plugin's per-area zoom (opt-in: remember the user's zoom level per page area and restore
// it on navigation): node-level tests for the area-key derivation, plus Manager e2e for the config
// dialog's toggle. The remember/restore wiring itself is an Electron-runtime path (did-navigate →
// setZoomFactor + a store in the app profile) not exercised here. Requiring the module directly is
// safe: its electron import only destructures app/ipcMain, which are used inside attachPlugin only.

const plugin = require(path.join(__dirname, '..', 'webapps', 'plugins', 'zoom', 'zoom.js'))

// Setup:    Typical app URLs across areas, with querystrings and nested paths.
// Action:   Derive their per-area zoom key.
// Expected: The FIRST path segment identifies the area — the root is its own area ("/"), and every
//           document under /edit/ maps to the SAME key, so all documents share one remembered zoom
//           instead of each file remembering its own.
test('zoomAreaKey groups URLs by their first path segment', () => {
  expect(plugin.zoomAreaKey('http://localhost:5001/')).toBe('/')
  expect(plugin.zoomAreaKey('http://localhost:5001/login?next=%2F')).toBe('/login')
  expect(plugin.zoomAreaKey('http://localhost:5001/edit/brief.docx')).toBe('/edit')
  expect(plugin.zoomAreaKey('http://localhost:5001/edit/Änderung%202.docx')).toBe('/edit')
  expect(plugin.zoomAreaKey('https://oo.lan/edit/a/b.docx')).toBe('/edit')
})

// Setup:    An app hosted under a reverse-proxy path prefix (pkg.url = http://black/relay), the
//           situation that collapsed all pages into one "/relay" area before the base parameter.
// Action:   Derive area keys with the base path stripped.
// Expected: Areas are the segments BELOW the base — the app root maps to "/" and editors to
//           "/edit", exactly like a root-hosted app — the base is only stripped on a segment
//           boundary ("/relay" must not eat "/relayout"), and URLs outside the base keep their own
//           first segment.
test('zoomAreaKey derives areas below the app base path', () => {
  expect(plugin.zoomAreaKey('http://black/relay', '/relay')).toBe('/')
  expect(plugin.zoomAreaKey('http://black/relay/', '/relay')).toBe('/')
  expect(plugin.zoomAreaKey('http://black/relay/edit/brief.docx', '/relay')).toBe('/edit')
  expect(plugin.zoomAreaKey('http://black/relay/login?next=%2F', '/relay')).toBe('/login')
  expect(plugin.zoomAreaKey('http://black/relayout/edit/x.docx', '/relay')).toBe('/relayout')
  expect(plugin.zoomAreaKey('http://black/other', '/relay')).toBe('/other')
})

// Setup:    Configured app URLs in root-hosted, path-prefixed and broken shapes.
// Action:   Derive the base path attachPlugin feeds into zoomAreaKey.
// Expected: The path prefix without a trailing slash ("" for root hosting), and "" for anything
//           unparseable — a broken pkg.url must degrade to the root-hosted behaviour, not throw.
test('baseAppPath extracts the app base path from pkg.url', () => {
  expect(plugin.baseAppPath('http://localhost:5001/')).toBe('')
  expect(plugin.baseAppPath('http://black/relay')).toBe('/relay')
  expect(plugin.baseAppPath('http://black/relay/')).toBe('/relay')
  expect(plugin.baseAppPath('https://oo.lan/a/b/')).toBe('/a/b')
  expect(plugin.baseAppPath(undefined)).toBe('')
  expect(plugin.baseAppPath('not a url')).toBe('')
})

// Setup:    Non-http(s) URLs: the plugins' data: loading/prompt pages, plus garbage.
// Action:   Derive their per-area zoom key.
// Expected: null — those pages must KEEP the current zoom rather than resetting it mid-flow, and a
//           malformed URL must not throw inside a navigation handler.
test('zoomAreaKey returns null for non-http(s) and malformed URLs', () => {
  expect(plugin.zoomAreaKey('data:text/html;charset=utf-8,spinner')).toBe(null)
  expect(plugin.zoomAreaKey('about:blank')).toBe(null)
  expect(plugin.zoomAreaKey('not a url')).toBe(null)
  expect(plugin.zoomAreaKey('')).toBe(null)
})

// Setup:    Create dialog open; plugins discovered from the real webapps/plugins tree.
// Action:   Add zoom, open its gear dialog; check the per-area toggle's default, enable it, Apply —
//           then reopen.
// Expected: The toggle is OFF by default (the classic one-zoom-per-app behaviour must stay the
//           default) and the enabled state loads back on reopen — proving the host round-trips the
//           pathZoom config key.
test('create dialog: zoom config defaults per-area zoom off and persists the toggle', async ({ managerPage }) => {
  await managerPage.click('.card-add')
  await managerPage.click('#create-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'zoom' }).click()
  await managerPage.locator('#create-plugin-list .domain-item', { hasText: 'zoom' })
    .locator('.domain-configure-btn').click()

  const overlay = managerPage.locator('.plugin-config-overlay:not(.hidden)')
  await expect(overlay).toHaveCount(1)
  const toggle  = overlay.locator('.dialog-field-toggle[data-config-key="pathZoom"]')

  await expect(toggle).not.toHaveClass(/active/)
  await toggle.click()
  await overlay.locator('.plugin-config-apply').click()

  await managerPage.locator('#create-plugin-list .domain-item', { hasText: 'zoom' })
    .locator('.domain-configure-btn').click()
  await expect(overlay.locator('.dialog-field-toggle[data-config-key="pathZoom"]')).toHaveClass(/active/)
})
