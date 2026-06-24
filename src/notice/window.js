// Voltage-styled "app unavailable" notice window.
//
// The generic launcher (~/.local/share/voltage/voltage-launch, see src/launcher.js) opens this when
// an app's AppImage cannot be reached — typically because its project directory is still encrypted /
// locked. The app itself therefore can't render anything, so the Manager app (no profile) steps in
// to show the message in our own design instead of a bare system notification.
//
// Runs in Manager context, so app.getAppPath() and the i18n bundle resolve exactly as they do for
// the Manager window. No preload/IPC is needed: the already-localized strings are passed to the page
// via the file URL's query string, and the page closes its own window with window.close().

const { app, BrowserWindow, nativeTheme } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const { pathToFileURL } = require('node:url')
const { t } = require('../i18n')
const { appIconCandidates } = require('../icon-paths')

const APP_ROOT = app.getAppPath()

// file:// URL of the failed app's own installed icon (from Voltage's private icon theme), so the
// dialog shows which app is affected rather than the generic Voltage logo. Falls back to the bundled
// Voltage logo when the app has no installed icon (e.g. a default-icon app).
//
// Icons are installed under the artifact name ("vTeams.svg"). We probe the name as received and, when
// it lacks the leading "v", the canonical artifact form too — an older installed launcher passed the
// display name ("Teams") instead of the artifact name, and we still want its icon to resolve without
// requiring every app to be reinstalled first.
function resolveIconUrl(artifactName) {
  const names = artifactName.startsWith('v') ? [artifactName] : [artifactName, `v${artifactName}`]
  for (const name of names) {
    for (const [absPath] of appIconCandidates(name)) {
      if (fs.existsSync(absPath)) return pathToFileURL(absPath).href
    }
  }
  return pathToFileURL(path.join(APP_ROOT, 'assets', 'voltage.svg')).href
}

// Stable, non-localized window title used ONLY as a marker so the Voltage GNOME Shell extension can
// recognise this window and centre it under Wayland (where the client cannot position itself). It is
// never shown to the user — the window is frameless and skip-taskbar. Must match NOTICE_WINDOW_TITLE
// in src/plugins/gnome/extension.js.
const NOTICE_WINDOW_TITLE = 'voltage-notice'

// Follow the DESKTOP color scheme, not the Manager's manual light/dark toggle. The notice is a
// standalone system dialog the user may see without ever having opened the Manager, so matching the
// session's appearance is the least surprising behavior; a stored Manager preference can be stale or
// simply disagree with the desktop (e.g. Manager left on light while the desktop is prefer-dark).
function isDark() {
  return nativeTheme.shouldUseDarkColors
}

// Opens the notice for the given (already human-readable) app name and quits the process when the
// window is closed — the global window-all-closed handler in main.js owns the actual app.quit().
module.exports = function openNotice(artifactName) {
  app.whenReady().then(() => {
    const i18n = t()
    const dark = isDark()
    // The launcher passes the raw artifact name (e.g. "vTeams"); strip the leading "v" for a readable
    // display name, matching the appName convention (the rest is left intact, e.g. "vGoogle-docs").
    const displayName = artifactName.replace(/^v/, '')
    const params = new URLSearchParams({
      // {name} is the only placeholder; interpolate in both title and body so the page gets final text.
      title: (i18n.noticeUnavailableTitle ?? '').replace('{name}', displayName),
      body:  (i18n.noticeUnavailableBody ?? '').replace('{name}', displayName),
      ok:    i18n.noticeOk ?? 'OK',
      icon:  resolveIconUrl(artifactName),
      dark:  dark ? '1' : '0',
    })
    const win = new BrowserWindow({
      // Sized to fit the rounded card plus the transparent shadow gutter around it (notice.html).
      width: 520, height: 300,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      // Frameless + transparent: the dialog provides its own Close button, and the transparent
      // surface lets the card's rounded corners + drop shadow show through (same as the widget host).
      frame: false, transparent: true, backgroundColor: '#00000000',
      // center:true positions it on creation and win.center() re-centers — reliable on X11. Under
      // Wayland the compositor owns toplevel placement, so the bundled GNOME extension recognises
      // this window (by NOTICE_WINDOW_TITLE) and centers it; the title below is that marker.
      title: NOTICE_WINDOW_TITLE, center: true, alwaysOnTop: true,
      // Transient dialog: keep it out of the dash/taskbar (and the alt-tab list), which also means
      // the sentinel title is never surfaced to the user.
      skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    win.setMenuBarVisibility(false)
    // notice.html has no <title>, but guard anyway so the page can never overwrite the marker title
    // the extension matches on.
    win.on('page-title-updated', e => e.preventDefault())
    win.center()
    win.loadFile(path.join(APP_ROOT, 'src', 'notice', 'notice.html'), { search: params.toString() })
  })
}
