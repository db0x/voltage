const { session, desktopCapturer, app } = require('electron')

const MEDIA_PERMISSIONS = [
  'media', 'display-capture', 'mediaKeySystem',
  'notifications', 'camera', 'microphone',
  'clipboard-read', 'clipboard-sanitized-write',
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
    ? [...MEDIA_PERMISSIONS, 'fileSystem']
    : MEDIA_PERMISSIONS

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
