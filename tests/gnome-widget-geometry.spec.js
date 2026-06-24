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
let profileFromDesktopId
let planWidgetReposition
let isCycleAbnormalState
let centerRectIn
test.beforeAll(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'plugins', 'gnome', 'geometry.js')).href
  const mod = await import(url)
  isRectVisible = mod.isRectVisible
  sanitizeRect = mod.sanitizeRect
  profileFromDesktopId = mod.profileFromDesktopId
  planWidgetReposition = mod.planWidgetReposition
  isCycleAbnormalState = mod.isCycleAbnormalState
  centerRectIn = mod.centerRectIn
})

// Meta.MaximizeFlags values Mutter reports: none / horizontal / vertical / both.
const MAX_NONE = 0
const MAX_HORIZONTAL = 1
const MAX_VERTICAL = 2
const MAX_BOTH = 3

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

// Setup:    Launcher ids following the "v<Profile>.desktop" artifact convention, incl. a hyphenated
//           profile.
// Action:   Derive the profile used for the default profile-data folder.
// Expected: the lowercased profile, matching src/app-naming.js — this is the fallback used when a
//           launcher predates the explicit X-Voltage-ProfileDir line.
test('profileFromDesktopId: derives the profile from the launcher id', () => {
  expect(profileFromDesktopId('vMastodon.desktop')).toBe('mastodon')
  expect(profileFromDesktopId('vGoogle-docs.desktop')).toBe('google-docs')
})

// Setup:    Ids that do not follow the convention.
// Action:   Derive the profile.
// Expected: null — the caller then skips rather than guessing a wrong folder.
test('profileFromDesktopId: returns null for unconventional ids', () => {
  expect(profileFromDesktopId('firefox.desktop')).toBeNull()
  expect(profileFromDesktopId(null)).toBeNull()
})

// ── isCycleAbnormalState: which states the F11 cycle passes through ───────────────────────────────

// Setup:    A fullscreen window (any maximize flags).
// Action:   Classify it.
// Expected: Abnormal — fullscreen is a cycle state regardless of maximize flags.
test('isCycleAbnormalState: fullscreen is abnormal', () => {
  expect(isCycleAbnormalState(true, MAX_NONE)).toBe(true)
  expect(isCycleAbnormalState(true, MAX_BOTH)).toBe(true)
})

// Setup:    A fully (both-axis) maximized, non-fullscreen window.
// Action:   Classify it.
// Expected: Abnormal — this is the cycle's maximize step.
test('isCycleAbnormalState: a full both-axis maximize is abnormal', () => {
  expect(isCycleAbnormalState(false, MAX_BOTH)).toBe(true)
})

// Setup:    An edge-tiled widget — snapped to a screen half, which Mutter reports as a partial
//           (single-axis) maximize.
// Action:   Classify it.
// Expected: NOT abnormal — a half-snapped widget is a windowed placement to remember and restore
//           to. This is the regression the edge-tiling fix addresses.
test('isCycleAbnormalState: an edge-tiled (partial) maximize is windowed, not abnormal', () => {
  expect(isCycleAbnormalState(false, MAX_VERTICAL)).toBe(false)
  expect(isCycleAbnormalState(false, MAX_HORIZONTAL)).toBe(false)
})

// Setup:    A plain floating window.
// Action:   Classify it.
// Expected: NOT abnormal — nothing to cycle out of.
test('isCycleAbnormalState: a floating window is windowed', () => {
  expect(isCycleAbnormalState(false, MAX_NONE)).toBe(false)
})

// ── planWidgetReposition: the F11 widget windowed↔maximized/fullscreen state machine ──────────────
// The widget frame the user wants back after the cycle.
const WIN_FRAME = { x: 300, y: 200, width: 480, height: 360 }

// Setup:    A windowed widget the user just moved/resized.
// Action:   Report a windowed (not abnormal) frame change.
// Expected: No reposition (null), but the frame is remembered as the restore target — this is how
//           the pre-maximize position is captured before the cycle ever starts.
test('planWidgetReposition: a windowed move just records the restore target', () => {
  const state = { lastNormalFrame: null, abnormal: false }
  expect(planWidgetReposition(state, false, WIN_FRAME)).toBeNull()
  expect(state.lastNormalFrame).toEqual(WIN_FRAME)
})

// Setup:    A windowed widget with a remembered frame.
// Action:   Report an abnormal (maximized/fullscreen) frame change.
// Expected: No reposition, the remembered frame is left untouched, and the state flips to abnormal
//           so the next return-to-windowed triggers the restore.
test('planWidgetReposition: entering maximized/fullscreen keeps the target and arms the restore', () => {
  const state = { lastNormalFrame: WIN_FRAME, abnormal: false }
  expect(planWidgetReposition(state, true, { x: 0, y: 0, width: 1920, height: 1080 })).toBeNull()
  expect(state).toEqual({ lastNormalFrame: WIN_FRAME, abnormal: true })
})

// Setup:    A widget that was maximized/fullscreen (abnormal) and is now back to windowed — exactly
//           the moment Wayland has restored the size at the wrong position.
// Action:   Report the windowed frame change.
// Expected: It returns the remembered frame so the extension moves the window back there, and clears
//           the abnormal flag.
test('planWidgetReposition: returning to windowed restores the remembered frame', () => {
  const state = { lastNormalFrame: WIN_FRAME, abnormal: true }
  expect(planWidgetReposition(state, false, { x: 0, y: 0, width: 1920, height: 1080 })).toEqual(WIN_FRAME)
  expect(state.abnormal).toBe(false)
})

// Setup:    Nothing was ever recorded (window opened straight into an abnormal state).
// Action:   Return to windowed with no remembered frame.
// Expected: null — with no target there is nothing to restore, so the window is left where the
//           compositor placed it rather than moved to a bogus spot.
test('planWidgetReposition: no restore when there is no remembered frame', () => {
  const state = { lastNormalFrame: null, abnormal: true }
  expect(planWidgetReposition(state, false, WIN_FRAME)).toBeNull()
})

// Setup:    A fresh windowed widget.
// Action:   Drive the whole cycle: windowed (remember) → maximized → fullscreen → windowed.
// Expected: Only the final return-to-windowed yields a reposition, and it is exactly the frame the
//           widget started at — the full round trip lands back where it began.
test('planWidgetReposition: the full F11 cycle restores the original frame', () => {
  const state = { lastNormalFrame: null, abnormal: false }
  expect(planWidgetReposition(state, false, WIN_FRAME)).toBeNull()                              // windowed: remember
  expect(planWidgetReposition(state, true,  { x: 0, y: 40, width: 1920, height: 1040 })).toBeNull() // maximized
  expect(planWidgetReposition(state, true,  { x: 0, y: 0,  width: 1920, height: 1080 })).toBeNull() // fullscreen
  expect(planWidgetReposition(state, false, { x: 0, y: 0,  width: 1920, height: 1080 })).toEqual(WIN_FRAME) // back
})

// Setup:    A widget edge-tiled to the left half of a 1920×1080 screen (partial vertical maximize),
//           then cycled through F11. Drives the two functions together exactly as the extension does.
// Action:   tiled (windowed) → maximized → fullscreen → back, classifying each state via
//           isCycleAbnormalState before feeding planWidgetReposition.
// Expected: It returns to the half-tiled frame, not some earlier floating position — the regression
//           the user reported ("an den Rand geklebt, dann geht zurück nicht").
test('planWidgetReposition + isCycleAbnormalState: an edge-tiled widget returns to the edge', () => {
  const TILED = { x: 0, y: 40, width: 960, height: 1040 }  // left half, below the panel
  const state = { lastNormalFrame: null, abnormal: false }
  const step = (fs, flags, frame) => planWidgetReposition(state, isCycleAbnormalState(fs, flags), frame)

  expect(step(false, MAX_VERTICAL, TILED)).toBeNull()                              // tiled: remembered as windowed
  expect(step(false, MAX_BOTH,     { x: 0, y: 40, width: 1920, height: 1040 })).toBeNull() // F11 maximize
  expect(step(true,  MAX_BOTH,     { x: 0, y: 0,  width: 1920, height: 1080 })).toBeNull() // F11 fullscreen
  expect(step(false, MAX_NONE,     { x: 0, y: 0,  width: 1920, height: 1080 })).toEqual(TILED) // F11 back → edge
})

// Setup:    The notice window (460×230) on the single 1920×1080 work area (40px top panel).
// Action:   Compute its centered top-left.
// Expected: horizontally centered across the full width, and vertically centered WITHIN the work
//           area (offset added to the area's y), so the panel is never overlapped.
test('centerRectIn: centers within the work area, respecting the panel offset', () => {
  expect(centerRectIn(SINGLE[0], { x: 0, y: 0, width: 460, height: 230 }))
    .toEqual({ x: (1920 - 460) / 2, y: 40 + (1040 - 230) / 2 })
})

// Setup:    The notice window placed on the secondary monitor's work area (x origin 1920).
// Action:   Center it there.
// Expected: the centered position is offset by that monitor's origin, so it lands on the monitor
//           GNOME put it on rather than jumping to the primary.
test('centerRectIn: honors a non-zero monitor origin', () => {
  expect(centerRectIn(DUAL[1], { x: 0, y: 0, width: 480, height: 240 }))
    .toEqual({ x: 1920 + (1920 - 480) / 2, y: (1080 - 240) / 2 })
})

// Setup:    A window wider/taller than the work area (degenerate, e.g. a tiny monitor).
// Action:   Center it.
// Expected: offsets clamp to the area origin (never negative), so the window's top-left stays on
//           screen instead of being pushed off the top/left edge.
test('centerRectIn: clamps an oversized window to the area origin', () => {
  expect(centerRectIn({ x: 100, y: 50, width: 300, height: 200 }, { x: 0, y: 0, width: 800, height: 600 }))
    .toEqual({ x: 100, y: 50 })
})

// Setup:    Missing area or a zero-area rect (defensive: a window with no usable frame yet).
// Action:   Request a center.
// Expected: null, so the caller leaves placement to GNOME instead of moving to a bogus spot.
test('centerRectIn: returns null for invalid input', () => {
  expect(centerRectIn(null, { x: 0, y: 0, width: 10, height: 10 })).toBeNull()
  expect(centerRectIn(SINGLE[0], { x: 0, y: 0, width: 0, height: 10 })).toBeNull()
})
