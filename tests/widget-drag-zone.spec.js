const { test, expect } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')

// Unit tests for the widget plugin's dragZone() hook: the per-app config → { html, preload } the
// view-mode path (src/window.js collectPluginViewMode) renders as a WebContentsView on top of the
// app view. Plain Node assertions (no browser) because the logic is a config gate + static asset
// wiring; the config dialog's persistence is covered in plugins.spec.js, and the actual window-drag
// is an Electron-runtime path not exercised here.

const WIDGET = path.join(__dirname, '..', 'webapps', 'plugins', 'widget', 'widget.js')
const { dragZone } = require(WIDGET)

// Setup:    A brand-new / empty config (the toggle absent) and an explicit true.
// Action:   Ask the plugin for its drag-zone descriptor.
// Expected: An { html, preload } object in both cases — the strip is ON by default, because it is
//           the only reliable way to move the frameless window for apps whose toolbar lives in a
//           cross-origin OOPIF (e.g. the Office/WOPI editor frame).
test('dragZone is enabled by default and when explicitly on', () => {
  for (const config of [{}, undefined, { dragZone: true }]) {
    const dz = dragZone(config)
    expect(dz).not.toBeNull()
    expect(typeof dz.html).toBe('string')
    expect(typeof dz.preload).toBe('string')
  }
})

// Setup:    Configs with the drag-zone light theme unset, off and on.
// Action:   Ask the plugin for its drag-zone descriptor.
// Expected: light defaults to false (dark) and is true only when dragZoneLight is explicitly enabled —
//           window.js maps this to the overlay's `light` body class.
test('dragZone exposes the light flag (default dark)', () => {
  expect(dragZone({}).light).toBe(false)
  expect(dragZone({ dragZoneLight: false }).light).toBe(false)
  expect(dragZone({ dragZoneLight: true }).light).toBe(true)
})

// Setup:    A config with the drag zone explicitly switched off.
// Action:   Ask the plugin for its drag-zone descriptor.
// Expected: null — window.js then renders no overlay, leaving the window with only its other move
//           affordances (an app whose own titlebar already drags can opt out this way).
test('dragZone returns null when explicitly disabled', () => {
  expect(dragZone({ dragZone: false })).toBeNull()
})

// Setup:    The default (enabled) descriptor.
// Action:   Inspect the overlay page markup.
// Expected: The body is a -webkit-app-region: drag surface — that declaration is what makes dragging
//           the strip move the host window; losing it would silently break the whole feature.
test('dragZone html marks the surface as a window-drag region', () => {
  expect(dragZone({}).html).toMatch(/-webkit-app-region:\s*drag/)
})

// Setup:    The default (enabled) descriptor.
// Action:   Inspect the overlay markup for the zoom controls.
// Expected: It ships the −/+ zoom buttons and the level readout, gated behind a {{bodyClass}} token
//           that window.js fills with "zoom-enabled" only for apps that load the zoom plugin — so the
//           controls exist in the template but stay hidden otherwise.
test('dragZone html includes the (zoom-plugin-gated) zoom controls', () => {
  const html = dragZone({}).html
  expect(html).toContain('data-action="zoom-out"')
  expect(html).toContain('data-action="zoom-in"')
  expect(html).toContain('class="zoom-pct"')
  expect(html).toContain('{{bodyClass}}')
})

// Setup:    The default (enabled) descriptor.
// Action:   Inspect the preload path it hands window.js for the overlay WebContentsView.
// Expected: An absolute path to an existing drag-zone-preload.js — window.js sets it as the view's
//           preload, so a missing/relative path would make the overlay load with no hover wiring.
test('dragZone preload is an absolute path to an existing file', () => {
  const { preload } = dragZone({})
  expect(path.isAbsolute(preload)).toBe(true)
  expect(path.basename(preload)).toBe('drag-zone-preload.js')
  expect(fs.existsSync(preload)).toBe(true)
})
