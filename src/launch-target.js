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


// --- Host aliases --------------------------------------------------------------------------------
// A service reachable under several hostnames (Teams: teams.cloud.microsoft, but meeting invitations
// still say teams.microsoft.com) must open every link on its OWN origin. Loading the alias host put
// the app on a different origin — separate cookies and storage, and Microsoft's "Teams will soon
// have a new URL" banner — and it stayed there. hostAliases names those hosts; a link on one keeps
// its path, query and hash but gets the app's own scheme and host.
//
// Deliberately NOT done for routingUrls: those also pull in OTHER services' links (SharePoint
// documents routed to the Office apps), which need their full URL untouched.
function canonicalAppUrl(pkg, url) {
  if (!url || !Array.isArray(pkg?.hostAliases) || pkg.hostAliases.length === 0) return url
  let link, own
  try { link = new URL(url); own = new URL(pkg.startUrl || pkg.url) } catch { return url }
  if (!/^https?:$/.test(link.protocol)) return url
  const aliases = pkg.hostAliases.map(h => String(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
  if (!aliases.includes(link.host.toLowerCase())) return url
  return `${own.protocol}//${own.host}${link.pathname}${link.search}${link.hash}`
}

module.exports = { launchTarget, canonicalAppUrl }
