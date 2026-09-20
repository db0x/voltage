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
let resolveRestoreFrame
let isUsableSize
let pickWorkArea
let rectsEqual
let MIN_USABLE_WIDTH
let MIN_USABLE_HEIGHT
let layoutSignature
let readGeometry
let writeGeometry
test.beforeAll(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'plugins', 'gnome', 'geometry.js')).href
  const mod = await import(url)
  isRectVisible = mod.isRectVisible
  sanitizeRect = mod.sanitizeRect
  profileFromDesktopId = mod.profileFromDesktopId
  planWidgetReposition = mod.planWidgetReposition
  isCycleAbnormalState = mod.isCycleAbnormalState
  centerRectIn = mod.centerRectIn
  resolveRestoreFrame = mod.resolveRestoreFrame
  isUsableSize = mod.isUsableSize
  pickWorkArea = mod.pickWorkArea
  rectsEqual = mod.rectsEqual
  MIN_USABLE_WIDTH = mod.MIN_USABLE_WIDTH
  MIN_USABLE_HEIGHT = mod.MIN_USABLE_HEIGHT
  layoutSignature = mod.layoutSignature
  readGeometry = mod.readGeometry
  writeGeometry = mod.writeGeometry
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

// ── resolveRestoreFrame: never hand back a frame the user cannot use ──────────────────────────────

// Setup:    A saved frame that is fully on screen and comfortably sized.
// Action:   Resolve it against the current work areas.
// Expected: the identical frame — the repair rules must stay invisible in the normal case, so a
//           window still comes back exactly where the user left it.
test('resolveRestoreFrame: a healthy frame is returned untouched', () => {
  const frame = { x: 100, y: 100, width: 800, height: 600 }
  expect(resolveRestoreFrame(frame, SINGLE)).toEqual(frame)
})

// Setup:    A frame shrunk to a few pixels, as Mutter can leave a window after a resolution switch.
// Action:   Resolve it.
// Expected: a centered, clearly usable frame instead of the speck — this is the reported bug
//           ("verkleinert auf das Minimum, fast nicht zu finden"): the size is replaced by a default
//           and the window is put in the middle of the work area where the user will see it.
test('resolveRestoreFrame: a frame shrunk to the minimum becomes a centered default', () => {
  const rescued = resolveRestoreFrame({ x: 1900, y: 1070, width: 4, height: 3 }, SINGLE)
  expect(rescued.width).toBeGreaterThanOrEqual(MIN_USABLE_WIDTH)
  expect(rescued.height).toBeGreaterThanOrEqual(MIN_USABLE_HEIGHT)
  expect(isRectVisible(rescued, SINGLE)).toBe(true)
  expect(rescued).toEqual({ ...centerRectIn(SINGLE[0], rescued), width: rescued.width, height: rescued.height })
})

// Setup:    A frame that is only slightly too small in ONE dimension (a squashed height).
// Action:   Resolve it.
// Expected: still repaired — a window one can grab but not read is just as unusable, so the
//           minimum applies per dimension, not to the area.
test('resolveRestoreFrame: a single unusable dimension is enough to trigger the default', () => {
  const rescued = resolveRestoreFrame({ x: 200, y: 200, width: 900, height: 20 }, SINGLE)
  expect(rescued.height).toBeGreaterThanOrEqual(MIN_USABLE_HEIGHT)
})

// Setup:    A well-sized frame that lived on a second monitor which is now unplugged.
// Action:   Resolve it against the remaining monitor.
// Expected: the SAME size, slid onto the surviving work area — the user keeps the window size they
//           chose and simply finds the window on the monitor that is left, rather than the window
//           being dropped wherever GNOME feels like (or not restored at all).
test('resolveRestoreFrame: a frame from a removed monitor keeps its size and slides on screen', () => {
  const rescued = resolveRestoreFrame({ x: 2200, y: 300, width: 800, height: 600 }, SINGLE)
  expect({ width: rescued.width, height: rescued.height }).toEqual({ width: 800, height: 600 })
  expect(isRectVisible(rescued, SINGLE)).toBe(true)
})

// Setup:    A frame hanging off the bottom-right of the only monitor (resolution was reduced).
// Action:   Resolve it.
// Expected: clamped flush against the work area's bottom-right edge, keeping its size — the
//           smallest correction that makes the window fully visible again.
test('resolveRestoreFrame: an overhanging frame is clamped into the work area', () => {
  expect(resolveRestoreFrame({ x: 1800, y: 900, width: 800, height: 600 }, SINGLE))
    .toEqual({ x: 1920 - 800, y: 40 + 1040 - 600, width: 800, height: 600 })
})

// Setup:    A window bigger than the work area it has to move to (came from a larger monitor).
// Action:   Resolve it.
// Expected: capped to the work area and placed at its origin, so no edge (and no titlebar) ends
//           up outside the screen.
test('resolveRestoreFrame: an oversized frame is capped to the work area', () => {
  expect(resolveRestoreFrame({ x: 0, y: 0, width: 3000, height: 2000 }, SINGLE))
    .toEqual({ x: 0, y: 40, width: 1920, height: 1040 })
})

// Setup:    A stale frame that still overlaps the secondary monitor most.
// Action:   Resolve it against the dual layout.
// Expected: repaired onto that secondary monitor, not yanked to the primary — the window stays on
//           the display the user had it on whenever that display still exists.
test('resolveRestoreFrame: repairs onto the monitor the frame belongs to', () => {
  const rescued = resolveRestoreFrame({ x: 3600, y: 900, width: 700, height: 500 }, DUAL)
  expect(rescued.x).toBeGreaterThanOrEqual(DUAL[1].x)
  expect(isRectVisible(rescued, DUAL)).toBe(true)
})

// Setup:    No saved frame at all, and a saved frame with no monitors to place it on.
// Action:   Resolve each.
// Expected: null — with nothing to repair or nowhere to put it, placement is left to GNOME rather
//           than invented.
test('resolveRestoreFrame: nothing to restore yields null', () => {
  expect(resolveRestoreFrame(null, SINGLE)).toBeNull()
  expect(resolveRestoreFrame({ x: 0, y: 0, width: 800, height: 600 }, [])).toBeNull()
})

// Setup:    A widget whose frame the compositor squashed to the minimum during a monitor switch.
// Action:   Feed that windowed frame to the F11 state machine.
// Expected: it is NOT remembered as the restore target — otherwise leaving fullscreen later would
//           force the widget back into the compositor's shrunken frame.
test('planWidgetReposition: a compositor-shrunken frame is not remembered', () => {
  const state = { lastNormalFrame: WIN_FRAME, abnormal: false }
  expect(planWidgetReposition(state, false, { x: 10, y: 10, width: 8, height: 6 })).toBeNull()
  expect(state.lastNormalFrame).toEqual(WIN_FRAME)
})

// Setup:    Frames around the usable threshold.
// Action:   Classify their size.
// Expected: the minimum itself counts as usable; anything under it does not.
test('isUsableSize: the minimum is inclusive', () => {
  expect(isUsableSize({ x: 0, y: 0, width: MIN_USABLE_WIDTH, height: MIN_USABLE_HEIGHT })).toBe(true)
  expect(isUsableSize({ x: 0, y: 0, width: MIN_USABLE_WIDTH - 1, height: MIN_USABLE_HEIGHT })).toBe(false)
  expect(isUsableSize(null)).toBe(false)
})

// Setup:    A frame overlapping the secondary monitor, and one overlapping nothing at all.
// Action:   Pick the work area to repair against.
// Expected: the most-overlapped area, falling back to the primary (first) area when the frame's
//           monitor is gone — the one place the user is certainly looking.
test('pickWorkArea: most overlap wins, primary is the fallback', () => {
  expect(pickWorkArea({ x: 2000, y: 100, width: 400, height: 300 }, DUAL)).toEqual(DUAL[1])
  expect(pickWorkArea({ x: -5000, y: -5000, width: 400, height: 300 }, DUAL)).toEqual(DUAL[0])
  expect(pickWorkArea({ x: 0, y: 0, width: 10, height: 10 }, [])).toBeNull()
})

// Setup:    Identical frames, frames differing in one field, and a missing frame.
// Action:   Compare them.
// Expected: exact equality only — the rescue pass uses this to skip a move that would change
//           nothing (and would needlessly re-enter the window's own frame-change handlers).
test('rectsEqual: compares all four fields', () => {
  expect(rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true)
  expect(rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 })).toBe(false)
  expect(rectsEqual(null, { x: 1, y: 2, width: 3, height: 4 })).toBe(false)
})

// ── layoutSignature / readGeometry / writeGeometry: one remembered position per monitor layout ───
// The laptop panel alone, and the same laptop docked to an external screen on its right.
const LAPTOP = [{ x: 0, y: 0, width: 1920, height: 1200 }]
const DOCKED = [{ x: 0, y: 0, width: 1920, height: 1200 }, { x: 1920, y: 0, width: 3840, height: 2160 }]

// Setup:    A monitor arrangement, and the same one reported in the opposite order.
// Action:   Build the signature of each.
// Expected: identical — the compositor's enumeration order must never invent a "new" layout, or
//           docking the same screen twice would remember two different sets of positions.
test('layoutSignature: independent of the order the monitors are reported in', () => {
  expect(layoutSignature(DOCKED)).toBe(layoutSignature([...DOCKED].reverse()))
})

// Setup:    Laptop alone vs. laptop docked, and a resolution change on the single screen.
// Action:   Compare the signatures.
// Expected: all different — each arrangement gets its own slot, which is the whole point: the
//           positions of the docked setup must not be overwritten by the laptop-only ones.
test('layoutSignature: a different arrangement or resolution is a different layout', () => {
  expect(layoutSignature(LAPTOP)).not.toBe(layoutSignature(DOCKED))
  expect(layoutSignature(LAPTOP)).not.toBe(layoutSignature([{ x: 0, y: 0, width: 1280, height: 800 }]))
})

// Setup:    No monitors (the compositor reports none, e.g. mid-switch).
// Action:   Build a signature.
// Expected: null — the caller then falls back to the layout-agnostic entry rather than storing
//           positions under a meaningless key.
test('layoutSignature: no monitors yields no signature', () => {
  expect(layoutSignature([])).toBeNull()
  expect(layoutSignature(null)).toBeNull()
})

// Setup:    An app placed differently on the laptop panel and on the docked setup — the exact
//           situation of unplugging and re-plugging an external monitor.
// Action:   Store a frame under each layout, then read both back.
// Expected: each layout returns its own frame. Plugging the dock back in restores the docked
//           position, unplugging restores the laptop one, and neither overwrites the other.
test('writeGeometry/readGeometry: every layout keeps its own position', () => {
  const app = 'vClaude.desktop'
  const onLaptop = { x: 100, y: 100, width: 1400, height: 900 }
  const onDock   = { x: 2200, y: 300, width: 2000, height: 1400 }

  let data = writeGeometry({}, app, layoutSignature(LAPTOP), onLaptop)
  data = writeGeometry(data, app, layoutSignature(DOCKED), onDock)

  expect(readGeometry(data, app, layoutSignature(LAPTOP))).toEqual(onLaptop)
  expect(readGeometry(data, app, layoutSignature(DOCKED))).toEqual(onDock)
})

// Setup:    Geometry stored for the docked layout, then read for a layout never seen before
//           (a projector plugged in at a customer site).
// Action:   Read for that unknown layout.
// Expected: the last written frame, as a starting guess — the caller repairs it onto the new
//           screens, and from then on that layout has an entry of its own.
test('readGeometry: an unknown layout falls back to the last known frame', () => {
  const app = 'vClaude.desktop'
  const onDock = { x: 2200, y: 300, width: 2000, height: 1400 }
  const data = writeGeometry({}, app, layoutSignature(DOCKED), onDock)
  expect(readGeometry(data, app, layoutSignature([{ x: 0, y: 0, width: 1024, height: 768 }]))).toEqual(onDock)
})

// Setup:    A geometry file written by an older extension version — a bare app id -> rect map with
//           no layouts at all.
// Action:   Read it under the current layout.
// Expected: the stored frame, so upgrading the extension never loses a remembered position.
test('readGeometry: a pre-layouts file still restores', () => {
  const legacy = { 'vClaude.desktop': { x: 10, y: 20, width: 800, height: 600 } }
  expect(readGeometry(legacy, 'vClaude.desktop', layoutSignature(LAPTOP)))
    .toEqual({ x: 10, y: 20, width: 800, height: 600 })
})

// Setup:    An existing map with entries for another app and another layout.
// Action:   Write one app's frame for one layout.
// Expected: nothing else is touched, and the input object is not mutated — two apps sharing a
//           profile folder, and two windows writing in turn, must not erase each other.
test('writeGeometry: writing one entry leaves the rest of the file intact', () => {
  const before = writeGeometry({}, 'vOther.desktop', layoutSignature(LAPTOP), { x: 1, y: 2, width: 300, height: 400 })
  const snapshot = JSON.parse(JSON.stringify(before))
  const after = writeGeometry(before, 'vClaude.desktop', layoutSignature(DOCKED), { x: 2000, y: 0, width: 900, height: 700 })

  expect(before).toEqual(snapshot)
  expect(readGeometry(after, 'vOther.desktop', layoutSignature(LAPTOP))).toEqual({ x: 1, y: 2, width: 300, height: 400 })
  expect(readGeometry(after, 'vClaude.desktop', layoutSignature(DOCKED))).toEqual({ x: 2000, y: 0, width: 900, height: 700 })
})

// Setup:    A degenerate rect, and a write with no layout signature (no monitors reported).
// Action:   Write each.
// Expected: the bad rect is refused outright; the signature-less write still records the flat
//           fallback, so a position is never silently lost just because the layout is unknown.
test('writeGeometry: refuses a bad rect, and stores flat when the layout is unknown', () => {
  expect(writeGeometry({}, 'vClaude.desktop', 'sig', { x: 0, y: 0, width: 0, height: 10 })).toEqual({})
  const flat = writeGeometry({}, 'vClaude.desktop', null, { x: 5, y: 5, width: 500, height: 400 })
  expect(readGeometry(flat, 'vClaude.desktop', 'any-layout')).toEqual({ x: 5, y: 5, width: 500, height: 400 })
})

// Setup:    An empty file, and an unknown app.
// Action:   Read.
// Expected: null — nothing remembered means GNOME places the window, never an invented frame.
test('readGeometry: nothing remembered yields null', () => {
  expect(readGeometry({}, 'vClaude.desktop', layoutSignature(LAPTOP))).toBeNull()
  expect(readGeometry(null, 'vClaude.desktop', null)).toBeNull()
})
