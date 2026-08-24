const { session, desktopCapturer, app } = require('electron')

// Deny-by-default allowlist: anything not listed here is rejected for every app session (see the
// handlers below). pointerLock + fullscreen + keyboardLock are here for interactive/game-style app
// content — without them, a page's own pointer-lock request is silently denied and it falls back
// into a broken half-captured input state (cursor never truly OS-locked, so a mouse-driven scene
// loses tracking once the pointer crosses the window edge). keyboardLock lets a page in fullscreen
// additionally reserve Escape for itself (Chromium then requires a ~2s hold to actually leave
// fullscreen instead of an instant single press) — useful when Escape doubles as an in-game key
// (skip/menu), but NOTE this only softens Escape's exit-fullscreen behaviour: the Pointer Lock spec
// makes Escape's exit-pointer-lock action unconditional and un-overridable by any page or embedder
// API, precisely to guarantee the user can always break out of a captured mouse — no permission or
// flag changes that.
const ALLOWED_PERMISSIONS = [
  'media', 'display-capture', 'mediaKeySystem',
  'notifications', 'camera', 'microphone',
  'clipboard-read', 'clipboard-sanitized-write',
  'pointerLock', 'fullscreen', 'keyboardLock',
]

// Creates an isolated, persistent session for the given profile.
// Both permission handlers must be set — Electron calls the check handler for
// passive feature detection and the request handler for actual prompts.
// fileSystem must be explicitly included for the File System Access API (Electron 28+).
function createSession(profile, opts = {}) {
  const customSession = session.fromPartition('persist:my-profile', { cache: true })

  // setSpellCheckerLanguages THROWS on any code Chromium ships no dictionary for. Some systems —
  // and CI runners with a minimal locale (e.g. "C"/"POSIX") — report such codes, which would abort
  // window creation entirely. Filter to the supported set, and guard as a last resort, so an odd
  // locale just disables spell-check instead of preventing the app from opening.
  try {
    const available = customSession.availableSpellCheckerLanguages || []
    const wanted = app.getPreferredSystemLanguages().filter(lang => available.includes(lang))
    if (wanted.length) customSession.setSpellCheckerLanguages(wanted)
  } catch { /* spell-check is non-essential — never let it block startup */ }

  const allowed = opts.fileSystem
    ? [...ALLOWED_PERMISSIONS, 'fileSystem']
    : ALLOWED_PERMISSIONS

  customSession.setPermissionCheckHandler((_wc, permission) =>
    allowed.includes(permission)
  )

  customSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(allowed.includes(permission))
  )

  // Wayland: getSources() triggers xdg-desktop-portal so the user picks the screen.
  // No audio loopback — Teams manages its own audio routing in calls.
  customSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      callback(sources.length > 0 ? { video: sources[0] } : {})
    } catch {
      callback({})
    }
  })

  return customSession
}

module.exports = { createSession }
