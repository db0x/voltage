const { test, expect } = require('@playwright/test')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Unit coverage for the GNOME extension's pure placement rules (src/plugins/gnome/geometry.js).
// This is the safety logic that keeps a widget from being restored into a monitor that no longer
// exists, so it is exercised here without a live GNOME Shell (the rest of the extension needs GI
// and a Mutter session and cannot run under Playwright). The module is ESM — loaded via dynamic
// import; its folder package.json marks it as such for node.
let isRectVisible
let sanitizeRect
test.beforeAll(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'plugins', 'gnome', 'geometry.js')).href
  const mod = await import(url)
  isRectVisible = mod.isRectVisible
  sanitizeRect = mod.sanitizeRect
})

// A single 1920×1080 monitor with a 40px top panel removed.
const SINGLE = [{ x: 0, y: 40, width: 1920, height: 1040 }]
// Two side-by-side 1920×1080 monitors, panel on the primary only.
const DUAL = [
  { x: 0, y: 40, width: 1920, height: 1040 },
  { x: 1920, y: 0, width: 1920, height: 1080 },
]

// Setup:    A saved frame fully inside the single monitor's work area.
// Action:   Validate it against that work area.
// Expected: visible → true, because every corner lies on usable screen space.
test('isRectVisible: a frame fully on the monitor is restorable', () => {
  expect(isRectVisible({ x: 100, y: 100, width: 400, height: 300 }, SINGLE)).toBe(true)
})

// Setup:    A saved frame that lived on a now-removed left monitor (negative x), only one monitor left.
// Action:   Validate it against the remaining single monitor.
// Expected: false — its corners land in dead space, so the caller falls back to normal placement
//           instead of restoring the widget off-screen. This is the core anti-vanish guard.
test('isRectVisible: a frame from a disconnected monitor is rejected', () => {
  expect(isRectVisible({ x: -1500, y: 200, width: 400, height: 300 }, SINGLE)).toBe(false)
})

// Setup:    A frame straddling the seam between two adjacent monitors.
// Action:   Validate it against the dual-monitor work areas.
// Expected: true — each corner is inside one of the two abutting areas, so a spanning widget is
//           still considered visible and restored where it was.
test('isRectVisible: a frame spanning two abutting monitors stays restorable', () => {
  expect(isRectVisible({ x: 1820, y: 100, width: 300, height: 200 }, DUAL)).toBe(true)
})

// Setup:    That same spanning frame, but the right monitor is now gone.
// Action:   Validate it against only the left monitor.
// Expected: false — its right corners fall off the surviving monitor, so it is not restored.
test('isRectVisible: a once-spanning frame is rejected once a monitor is removed', () => {
  expect(isRectVisible({ x: 1820, y: 100, width: 300, height: 200 }, [SINGLE[0]])).toBe(false)
})

// Setup:    Edge cases for the inputs the guard receives.
// Action:   Pass an empty monitor list and a zero-size rect.
// Expected: both false — no usable area, or no real window, means "do not restore".
test('isRectVisible: no monitors or a degenerate rect is never restorable', () => {
  expect(isRectVisible({ x: 0, y: 0, width: 400, height: 300 }, [])).toBe(false)
  expect(isRectVisible({ x: 0, y: 0, width: 0, height: 0 }, SINGLE)).toBe(false)
})

// Setup:    A frame rect with fractional coordinates as Mutter may report under scaling.
// Action:   Sanitize it.
// Expected: rounded integers, because only clean integers are persisted.
test('sanitizeRect: fractional frame coordinates are rounded to integers', () => {
  expect(sanitizeRect({ x: 100.4, y: 200.6, width: 399.5, height: 300.2 }))
    .toEqual({ x: 100, y: 201, width: 400, height: 300 })
})

// Setup:    A nonsensical frame (zero width) and a missing frame.
// Action:   Sanitize each.
// Expected: null — a bad value is dropped so it can never be written and later "restored".
test('sanitizeRect: degenerate or missing rects yield null', () => {
  expect(sanitizeRect({ x: 10, y: 10, width: 0, height: 300 })).toBeNull()
  expect(sanitizeRect(null)).toBeNull()
})
