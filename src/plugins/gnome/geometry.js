// Pure geometry helpers for widget window placement.
//
// Why a separate module: deciding whether a remembered window frame is still safe to restore is
// the one piece of real logic in the placement feature, and it is the part that protects against
// a widget vanishing into a monitor that no longer exists. Keeping it free of any GNOME/GI import
// lets it be unit-tested in node (see tests/gnome-widget-geometry.spec.js) without a live Shell.
//
// A "rect" here is a plain { x, y, width, height } in stage coordinates — the same shape both
// Meta.Window.get_frame_rect() and the per-monitor work areas expose.

// True when a point lies inside a rect, treating the rect as half-open [x, x+width) so adjacent
// monitors that share an edge (x+width of one == x of the next) do not both claim the seam pixel.
function pointInRect(px, py, r) {
  return px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height
}

// Decide whether a saved frame still lands on usable screen space.
//
// We require all four corners to fall inside *some* work area. That is deliberately strict:
//  - a window spanning a monitor seam still passes, because each corner is inside one of the two
//    adjacent areas;
//  - a window addressing coordinates that disappeared (a monitor was unplugged, or the layout
//    shrank) fails, because its corners land in dead space — and the caller then falls back to
//    normal placement instead of restoring it off-screen.
// The inset pulls each corner a hair inward so a window flush against a monitor edge is not
// rejected by an off-by-one at the exclusive boundary; it is clamped so it can never cross the
// window's own midline on a very small window.
export function isRectVisible(rect, workAreas, inset = 1) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
      !(rect.width > 0) || !(rect.height > 0)) return false
  if (!Array.isArray(workAreas) || workAreas.length === 0) return false

  const i = Math.min(inset, Math.floor((rect.width - 1) / 2), Math.floor((rect.height - 1) / 2))
  const right = rect.x + rect.width - 1
  const bottom = rect.y + rect.height - 1
  const corners = [
    [rect.x + i, rect.y + i],
    [right - i, rect.y + i],
    [rect.x + i, bottom - i],
    [right - i, bottom - i],
  ]
  return corners.every(([px, py]) => workAreas.some(w => pointInRect(px, py, w)))
}

// "vMastodon.desktop" -> "mastodon". Mirrors src/app-naming.js (appName / profileFromAppName) so
// the extension can derive a widget's default profile-data folder from its launcher id when an
// older launcher predates the explicit X-Voltage-ProfileDir line. Returns null for an id that does
// not follow the "v<Profile>" artifact convention, so the caller can skip rather than guess.
export function profileFromDesktopId(desktopId) {
  if (typeof desktopId !== 'string') return null
  const base = desktopId.replace(/\.desktop$/, '')
  const m = /^v(.+)/.exec(base)
  if (!m) return null
  return m[1].charAt(0).toLowerCase() + m[1].slice(1)
}

// Meta.MaximizeFlags as Mutter reports them via Meta.Window.get_maximized(): HORIZONTAL=1,
// VERTICAL=2, BOTH=3. A stable Mutter enum, inlined here so this stays a pure (GI-free) module.
const MAXIMIZE_BOTH = 3

// Whether a window is in one of the states the F11 cycle moves *through* (full maximize or
// fullscreen) — as opposed to a windowed placement the cycle must remember and return to.
//
// The crucial distinction is edge-tiling: snapping a widget to a screen half reports a PARTIAL
// (single-axis, usually vertical) maximize, not BOTH. That snapped placement is exactly where the
// user wants the widget to come back to, so it must count as windowed — only a full (both-axis)
// maximize or fullscreen is "abnormal". Treating a half-tiled window as abnormal was the bug where
// "back" landed at the pre-snap floating position instead of the edge.
export function isCycleAbnormalState(isFullscreen, maximizeFlags) {
  return !!isFullscreen || maximizeFlags === MAXIMIZE_BOTH
}

// Decide what to do when a tracked widget window's frame changes, driving the Wayland-only
// reposition that puts a widget back where it was after the F11 windowed→maximized→fullscreen→
// windowed cycle (window.js cycleFullscreen).
//
// Under Wayland the client cannot restore its own position: leaving maximized/fullscreen brings the
// size back but the compositor drops the window at the wrong spot. So the extension remembers the
// last *windowed* frame and, the moment the window returns to windowed, moves it back there.
//
// Pure state machine so it is unit-testable without a live Shell. `state` ({ lastNormalFrame,
// abnormal }) is mutated in place. Returns the frame to move the window to, or null when the change
// is mere bookkeeping (entering maximized/fullscreen, or a plain windowed move/resize to remember).
export function planWidgetReposition(state, isAbnormal, currentFrame) {
  if (isAbnormal) {
    // Maximized or fullscreen now — keep the remembered windowed frame as the restore target.
    state.abnormal = true
    return null
  }
  if (state.abnormal) {
    // Just returned to windowed: restore the frame captured before the cycle began.
    state.abnormal = false
    return state.lastNormalFrame ?? null
  }
  // Genuine windowed move/resize: this becomes the new restore target.
  const rect = sanitizeRect(currentFrame)
  if (rect) state.lastNormalFrame = rect
  return null
}

// Reduce a frame rect to the four integers we persist, or null for anything nonsensical. Storing
// only validated integers means a bad value can never be written and then "restored" later — the
// load path stays trivial because the data is already clean.
export function sanitizeRect(rect) {
  if (!rect) return null
  const x = Math.round(rect.x)
  const y = Math.round(rect.y)
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}
