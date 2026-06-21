// Fullscreen control for the app windows' F11 key and "Fullscreen" context-menu item.
//
// Kept electron-free (it only drives the BrowserWindow passed in) so the state machine is unit
// testable without an Electron runtime — window.js wires it to the real window.
//
// A normal (framed) app keeps the plain on/off toggle. A widget app is frameless and has no
// titlebar controls, so the window can't be maximized or restored by the user any other way —
// there each activation cycles three states:
//   1. windowed   → maximized (fills the desktop work area, panels still visible)
//   2. maximized  → real fullscreen (covers the whole screen)
//   3. fullscreen → back to a plain window
// State is derived from the live window flags (not tracked separately) so manual changes stay in
// sync. isFullScreen() is checked before isMaximized() because a window entered fullscreen from the
// maximized state still reports maximized underneath.
function cycleFullscreen(win, isWidget) {
  if (!isWidget) {
    win.setFullScreen(!win.isFullScreen())
    return
  }
  if (win.isFullScreen()) {
    // Leaving fullscreen first restores the maximized state we passed through on the way in; drop
    // that only once the transition has settled, otherwise unmaximize races the fullscreen exit.
    win.once('leave-full-screen', () => win.unmaximize())
    win.setFullScreen(false)
  } else if (win.isMaximized()) {
    win.setFullScreen(true)
  } else {
    // A non-resizable widget (config.resizable === false) is also non-maximizable, so enable it
    // first — otherwise maximize() is silently ignored and the cycle never leaves the windowed step.
    win.setMaximizable(true)
    win.maximize()
  }
}

module.exports = { cycleFullscreen }
