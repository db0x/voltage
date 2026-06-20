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
