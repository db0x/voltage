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

// Top-left {x, y} that centres `rect` within work area `area`. Used for the transient "app
// unavailable" notice window, which carries no saved geometry and just wants to sit in the middle
// of the screen. Clamped to the area origin so an oversized window never gets a negative offset
// (which would push it off the top/left edge). Pure so it can be unit-tested without a live Shell.
export function centerRectIn(area, rect) {
  if (!area || !rect || !(rect.width > 0) || !(rect.height > 0)) return null
  const x = area.x + Math.max(0, Math.floor((area.width  - rect.width)  / 2))
  const y = area.y + Math.max(0, Math.floor((area.height - rect.height) / 2))
  return { x, y }
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
  // Genuine windowed move/resize: this becomes the new restore target — unless the frame is too
  // small to be a placement the user chose. A monitor/resolution switch makes Mutter re-fit the
  // window, sometimes down to its minimum; remembering that would turn a transient compositor
  // shrink into the frame we keep forcing the widget back to.
  const rect = sanitizeRect(currentFrame)
  if (rect && isUsableSize(rect)) state.lastNormalFrame = rect
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

// Smallest frame we still accept as a window a user can actually work with. A layout change
// (monitor unplugged, resolution switched) can make Mutter re-fit a window down to its client
// minimum; that shrunken frame then gets remembered and faithfully restored, which is how a
// Voltage app ends up as an unfindable speck on the desktop. Anything below this counts as
// "never intended by the user" — Voltage apps default to 1280×1024 and even a small widget is
// far larger — so it is replaced by a sane default rather than reproduced.
export const MIN_USABLE_WIDTH = 240
export const MIN_USABLE_HEIGHT = 160

// Share of the work area used for the replacement size when a remembered frame is unusable.
// Large enough to be immediately visible and operable, small enough to still look like a window.
const FALLBACK_FRACTION = 0.6

// Whether a frame is big enough to be grabbed, read and resized by hand.
export function isUsableSize(rect) {
  return !!rect && rect.width >= MIN_USABLE_WIDTH && rect.height >= MIN_USABLE_HEIGHT
}

// Exact frame equality — lets callers skip a move that would change nothing (and thus avoid
// re-entering their own size-changed/position-changed handlers for no reason).
export function rectsEqual(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width,  b.x + b.width)  - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

// The work area a frame most belongs to: the one it overlaps most. With no overlap at all (the
// frame's monitor is gone) this falls back to the first area, which is the primary monitor — the
// one place the user is guaranteed to be looking.
export function pickWorkArea(rect, workAreas) {
  if (!Array.isArray(workAreas) || workAreas.length === 0) return null
  let best = workAreas[0]
  let bestOverlap = 0
  for (const area of workAreas) {
    const o = rect ? overlapArea(rect, area) : 0
    if (o > bestOverlap) { bestOverlap = o; best = area }
  }
  return best
}

// One extent (width or height) of the replacement size: a fraction of the work area, never below
// the usable minimum and never larger than the area itself (which wins on a very small monitor).
function fallbackExtent(areaExtent, min) {
  return Math.min(areaExtent, Math.max(min, Math.round(areaExtent * FALLBACK_FRACTION)))
}

// Turn a remembered frame into one that is guaranteed usable on the current layout.
//
// Returns null only when there is nothing to work with (no saved frame, or no monitors) — the
// caller then leaves placement to GNOME. Otherwise it always returns a frame:
//  - unchanged, when the remembered one is still fully on screen and big enough;
//  - same size, slid back inside the nearest work area, when only the position went stale (a
//    monitor was unplugged) — the user keeps the window size they chose;
//  - a centred default size, when the remembered size itself is unusable — the case where a
//    layout change had shrunk the window to its minimum. Centring matters as much as the size:
//    a rescued window must be where the user is already looking, not in a corner.
export function resolveRestoreFrame(saved, workAreas) {
  const rect = sanitizeRect(saved)
  if (!rect) return null
  const area = pickWorkArea(rect, workAreas)
  if (!area) return null
  if (isUsableSize(rect) && isRectVisible(rect, workAreas)) return rect

  if (!isUsableSize(rect)) {
    const width  = fallbackExtent(area.width,  MIN_USABLE_WIDTH)
    const height = fallbackExtent(area.height, MIN_USABLE_HEIGHT)
    return { ...centerRectIn(area, { width, height }), width, height }
  }

  // Size is fine, only the position is stale: keep it (capped to the area) and clamp it in.
  const width  = Math.min(rect.width,  area.width)
  const height = Math.min(rect.height, area.height)
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width  - width)
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

// Key under which the per-layout frames live inside a persisted geometry map. It can never collide
// with an app id, because every app id ends in ".desktop".
export const LAYOUT_KEY = 'layouts'

// Stable identifier for a monitor arrangement — the same set of monitors, in the same places, must
// always produce the same string, and any other arrangement a different one.
//
// Built from raw monitor geometry, deliberately NOT from work areas: work areas shrink and grow
// whenever a dock or panel appears, autohides or changes size, which would keep inventing "new"
// layouts and fragment the stored positions across near-identical keys. Sorted so the order the
// compositor happens to report the monitors in cannot change the key.
export function layoutSignature(monitors) {
  if (!Array.isArray(monitors) || monitors.length === 0) return null
  return monitors
    .map(m => `${Math.round(m.width)}x${Math.round(m.height)}+${Math.round(m.x)}+${Math.round(m.y)}`)
    .sort()
    .join('|')
}

// Read an app's frame out of a persisted geometry map for the given layout.
//
// The per-layout entry wins; the flat top-level entry is the fallback and covers two cases at once:
// a file written before layouts existed, and a layout the user has never had this app open on. In
// the second case the last known frame is the best guess available — the caller repairs it into the
// current layout (resolveRestoreFrame), and from then on this layout has an entry of its own.
export function readGeometry(data, appId, signature) {
  if (!data || typeof data !== 'object' || !appId) return null
  const perLayout = signature ? data[LAYOUT_KEY]?.[signature]?.[appId] : null
  return sanitizeRect(perLayout) ?? sanitizeRect(data[appId])
}

// Return a copy of the geometry map with `rect` stored for `appId`, both under the current layout
// and as the flat fallback. Pure (no mutation) so the persisted shape is easy to reason about and
// unit-testable; the flat write keeps the file readable by an older extension version.
export function writeGeometry(data, appId, signature, rect) {
  const base = data && typeof data === 'object' ? data : {}
  const clean = sanitizeRect(rect)
  if (!clean || !appId) return base
  const next = { ...base, [appId]: clean }
  if (signature) {
    const layouts = { ...(base[LAYOUT_KEY] ?? {}) }
    layouts[signature] = { ...(layouts[signature] ?? {}), [appId]: clean }
    next[LAYOUT_KEY] = layouts
  }
  return next
}
