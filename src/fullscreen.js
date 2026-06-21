// Fullscreen / maximize control for the app windows' F11 keys and context-menu items.
//
// Kept electron-free (it only drives the BrowserWindow passed in) so it is unit testable without an
// Electron runtime — window.js wires it to the real window.
//
// In widget mode the window is frameless and has no titlebar controls, so these are the only ways
// to reach those states. The two actions are deliberately independent (no cycle): F11 toggles real
// fullscreen, Shift+F11 toggles maximize. A single native operation per key means GNOME/Mutter can
// restore the prior state cleanly — the chained cycle was what stranded snapped/tiled windows.

// Toggle real (whole-screen) fullscreen. Same for every app — F11.
function toggleFullscreen(win) {
  win.setFullScreen(!win.isFullScreen())
}

// Toggle maximize ↔ restore — Shift+F11, used by frameless widgets that have no titlebar button.
function toggleMaximize(win) {
  if (win.isMaximized()) {
    win.unmaximize()
  } else {
    // A non-resizable widget (config.resizable === false) is also non-maximizable, so enable it
    // first — otherwise maximize() is silently ignored.
    win.setMaximizable(true)
    win.maximize()
  }
}

module.exports = { toggleFullscreen, toggleMaximize }
