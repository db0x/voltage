// Where a launch argument that arrives at an ALREADY RUNNING app has to go (the single-instance
// path: a link routed from another voltage app, a .desktop %u, `--prompt`).
//
// Two things went wrong here before, and both are easy to get wrong again:
//  - The window. BrowserWindow.getAllWindows() comes in no guaranteed order, and an app can have
//    more than its main window open (a meeting pop-out, the About panel). The main window is the one
//    src/window.js tagged with _voltageAppContents.
//  - The webContents. In widget (view) mode the app does NOT live in win.webContents — that is the
//    host page drawing the shadow gutter around an inset WebContentsView, and the app is in the view.
//    Loading the URL into win.webContents put e.g. a Teams meeting into the frame page: no plugins,
//    no zoom, no injected CSS, and the widget's own chrome gone — "Teams forgot its widget plugin".
//
// Pure (no Electron) so it can be unit-tested with plain objects.
function launchTarget(windows = []) {
  const win = windows.find(w => w && w._voltageAppContents) ?? windows[0] ?? null
  if (!win) return null
  return { win, contents: win._voltageAppContents ?? win.webContents }
}

module.exports = { launchTarget }
