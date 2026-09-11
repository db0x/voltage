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

// Setup:    Configs with the macOS button order unset, off and on.
// Action:   Ask the plugin for its drag-zone descriptor.
// Expected: macOrder defaults to false (the classic layout — gear left, window controls right) and is
//           true only when macButtonOrder is explicitly enabled — window.js maps this to the overlay's
//           `mac-order` body class.
test('dragZone exposes the macOrder flag (default classic layout)', () => {
  expect(dragZone({}).macOrder).toBe(false)
  expect(dragZone({ macButtonOrder: false }).macOrder).toBe(false)
  expect(dragZone({ macButtonOrder: true }).macOrder).toBe(true)
})

// Setup:    The default (enabled) descriptor.
// Action:   Inspect the overlay markup for the mac-order layout machinery.
// Expected: The window controls carry their wrapper classes and the stylesheet reorders them under
//           body.mac-order with close OUTERMOST LEFT (order:1) and the gear moved to the far right —
//           while without that class the DOM order (classic layout) stays untouched.
test('dragZone html ships the (body.mac-order-gated) macOS button order', () => {
  const html = dragZone({}).html
  expect(html).toContain('class="ctl ctl-close"')
  expect(html).toContain('class="ctl ctl-min"')
  expect(html).toContain('class="ctl ctl-max"')
  expect(html).toMatch(/body\.mac-order \.ctl-close\s*\{\s*order:\s*1/)
  expect(html).toMatch(/body\.mac-order \.config\s*\{\s*order:\s*10/)
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

// Setup:    The default (enabled) descriptor, plus the overlay's preload source.
// Action:   Inspect the markup for the upward-exit sensor and the preload for what it does with it.
// Expected: A .exit-sensor element marked -webkit-app-region:no-drag — the surrounding drag surface
//           is excluded from the hit region, so only a no-drag element can witness the cursor leaving
//           the strip over the top edge. main has no other way to learn about that exit (the app view
//           stops reporting once the strip covers it, and Wayland exposes no global cursor position),
//           so without this band the bar would stay open after the pointer left the window. The
//           preload must turn that leave into the 'exit' action and must NOT fire it for a downward
//           leave, which is the normal path from the band to the bar's buttons.
test('dragZone html ships the no-drag sensor that dismisses the bar on an upward exit', () => {
  const html = dragZone({}).html
  expect(html).toContain('class="exit-sensor"')
  // The sensor rule must carry no-drag; the bar around it stays draggable.
  const rule = /\.exit-sensor\s*\{[^}]*\}/.exec(html)
  expect(rule).not.toBeNull()
  expect(rule[0]).toMatch(/-webkit-app-region:\s*no-drag/)
  // REGRESSION: .handle is absolutely positioned too and comes later in the DOM, so without an
  // explicit z-index it paints over the sensor across the bar's whole width and the band only sees
  // the 16px pads — it then never fires, silently, which is exactly how it shipped broken once.
  expect(rule[0]).toMatch(/z-index:\s*[1-9]/)
  expect(html.indexOf('class="exit-sensor"')).toBeLessThan(html.indexOf('class="handle"'))

  const preload = fs.readFileSync(dragZone({}).preload, 'utf8')
  expect(preload).toContain(".querySelector('.exit-sensor')")
  expect(preload).toContain("'exit'")
  expect(preload).toContain('mouseleave')
  // A downward leave (into the bar) must be excluded, or reaching for a button would dismiss the bar.
  expect(preload).toMatch(/movedDown/)
})

// Setup:    The overlay's preload source.
// Action:   Inspect how it answers the main-process presence watchdog.
// Expected: Presence is POLLED via :hover, not derived from mousemove. That distinction is the whole
//           point: a cursor resting on the bar emits no events, so an event-driven check would read
//           it as gone and close the bar under the user. :hover is the renderer's own hit test and
//           answers for a motionless cursor. Polling only while the bar is up keeps it from being
//           constant IPC noise.
test('dragZone preload polls hover for presence', () => {
  const preload = fs.readFileSync(dragZone({}).preload, 'utf8')
  expect(preload).toContain("'present'")
  expect(preload).toMatch(/body:hover/)
  expect(preload).toMatch(/setInterval/)
  expect(preload).toContain("classList.contains('shown')")
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
// Action:   Inspect the overlay markup for the DevTools button and its visibility gate.
// Expected: The button (data-action="devtools") ships in the template wrapped in .ctl.devtools, which
//           is hidden by default and only revealed under body.devtools-enabled — the class window.js
//           adds from the build config's `devTools` flag (default on). So the button exists in the
//           markup but disappears entirely when DevTools are disabled for the app.
test('dragZone html includes the (devTools-gated) DevTools button', () => {
  const html = dragZone({}).html
  expect(html).toContain('data-action="devtools"')
  expect(html).toContain('class="ctl devtools"')
  // The gate: hidden by default, shown only with the devtools-enabled body class.
  expect(html).toMatch(/\.ctl\.devtools\s*\{\s*display:\s*none/)
  expect(html).toMatch(/body\.devtools-enabled\s+\.ctl\.devtools\s*\{\s*display:\s*flex/)
})

// Setup:    The default (enabled) descriptor.
// Action:   Inspect the overlay markup for the home button and its visibility gate.
// Expected: The button (data-action="home") ships wrapped in .ctl.home, hidden by default and only
//           revealed under body.home-enabled — toggled LIVE by main (only-office apps, on every
//           navigation): shown while an editor page (/edit/…) is open, hidden on the document list
//           "/" itself, where the button would be a no-op. The preload must therefore wire the
//           voltage:dragzone-home channel to that class. In mac-order the button must carry an
//           explicit order (unlisted flex children would jump to the front).
test('dragZone html includes the (navigation-gated) only-office home button', () => {
  const { html, preload } = dragZone({})
  expect(html).toContain('data-action="home"')
  expect(html).toContain('class="ctl home"')
  expect(html).toMatch(/\.ctl\.home\s*\{\s*display:\s*none/)
  expect(html).toMatch(/body\.home-enabled\s+\.ctl\.home\s*\{\s*display:\s*flex/)
  expect(html).toMatch(/body\.mac-order \.home\s*\{\s*order:\s*7/)
  const preloadSrc = fs.readFileSync(preload, 'utf8')
  expect(preloadSrc).toContain("'voltage:dragzone-home'")
  expect(preloadSrc).toContain('home-enabled')
})

// Setup:    The default (enabled) descriptor.
// Action:   Inspect the overlay stylesheet for the configure gear's availability gate.
// Expected: body.no-manager (set by window.js when the baked appRoot does NOT point at a Voltage
//           checkout on this machine — a handed-over AppImage or a moved repo) hides the gear
//           entirely: its only action opens the app's config in the Voltage Manager, which would
//           silently fail there.
test('dragZone html hides the configure gear without a reachable Voltage (body.no-manager)', () => {
  const html = dragZone({}).html
  expect(html).toMatch(/body\.no-manager \.config\s*\{\s*display:\s*none/)
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
