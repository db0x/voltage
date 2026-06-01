// OneDrive plugin (main-process module). Hardcoded into the OneDrive AppImage for now;
// a generic per-app plugin mechanism will replace the hardcoded wiring later.
//
// Why a main-process module and not a page-injected script like the strato mail plugin:
// OneDrive opens an Office document by calling window.open() from a *cross-origin* iframe.
// A script injected into the page only lives in the top frame and can never see — let alone
// hook — that iframe's call. The new-window event, however, always surfaces in the main
// process, so this is the only place that can reliably observe and steer it.
//
// What it does: OneDrive's window.open() is called with a launcher URL, not the document URL,
// so the central setWindowOpenHandler can't route it — the real Office editor URL
// (…sharepoint.com/:w:/…) only appears a moment later when the freshly opened child window
// navigates (an in-page SPA navigation we can observe but not prevent). So we watch that
// child and, as soon as it heads to a URL another built wrapweb app claims (Word/Excel/
// PowerPoint via routing.json), we launch that app and discard the child.
//
// To avoid a stray OneDrive window flashing up, same-origin popups are created hidden; the
// child is only ever shown if it turns out NOT to be a routed document.

const TAG = '[onedrive-plugin]'

// Grace period before revealing a hidden child that never routed. The routed-document case
// resolves within a few hundred ms (open launcher → in-page nav to the doc → route + close);
// anything still unrouted after this is a genuine OneDrive popup, so we show it.
const REVEAL_AFTER_MS = 1500

// Installs OneDrive's window-open routing on `win` (the BrowserWindow from createWindow()).
// Receives the standard plugin api from window.js loadPlugins(); it uses:
//   appOrigin, internalDomains — classify a popup as same-origin/internal (a doc launcher)
//   routeUrl(url)              — launch the claiming AppImage, returns true on a routing hit
//   openExternal(url)          — hand a non-routed external URL to the system browser
function attachPlugin(win, { appOrigin, internalDomains, routeUrl, openExternal }) {
  const wc = win.webContents

  // Replace the default handler for OneDrive. Same-origin / internal popups (the document
  // launcher) are allowed but created hidden so a routed document never flashes a window;
  // everything else keeps the normal route-or-browser behaviour.
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const t = new URL(url)
      const internal = t.origin === appOrigin ||
        internalDomains.some(d => t.hostname === d || t.hostname.endsWith('.' + d))
      // Same-origin launcher: the real doc URL only appears on the child's later navigation,
      // so allow it hidden and let did-create-window route it.
      if (internal) {
        console.log(TAG, 'window.open internal (launcher, watching child):', url)
        return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
      }
      // Non-internal window.open: OneDrive sometimes opens docs (e.g. links into a different
      // project) with the final URL right here — no child window is created. Route it if a
      // built app claims it; otherwise it goes to the system browser. Logged either way so a
      // routing miss on this path (which previously produced no log at all) is visible.
      const hit = routeUrl(url)
      console.log(TAG, hit ? 'window.open routed:' : 'window.open → browser (no match):', url)
      if (!hit) openExternal(url)
      return { action: 'deny' }
    } catch {
      return { action: 'deny' }
    }
  })

  wc.on('did-create-window', (child, _details) => {
    const childWc = child.webContents
    let handled = false  // route-once guard: several nav events can carry the same doc URL

    // Routes `url` to its target app and discards the hidden child. preDecision events pass
    // their event so the in-flight load is cancelled too (in-page navigations can't be).
    const tryRoute = (url, event) => {
      if (handled || !url) return
      // Log every candidate URL we test against the routing table — the URL printed here is
      // exactly what determines the routing target, so a wrong/unexpected one explains a miss.
      const hit = routeUrl(url)
      console.log(TAG, hit ? 'routing URL (matched):' : 'routing URL (no match):', url)
      if (!hit) return
      handled = true
      if (event) event.preventDefault()
      if (!child.isDestroyed()) child.close()
    }

    childWc.on('will-navigate',        (e, url)  => tryRoute(url, e))
    childWc.on('will-redirect',        (e, url)  => tryRoute(url, e))
    childWc.on('did-navigate',         (_e, url) => tryRoute(url))
    childWc.on('did-navigate-in-page', (_e, url) => tryRoute(url))

    // Not a routed document → reveal it so a genuine OneDrive popup isn't stuck invisible.
    setTimeout(() => { if (!handled && !child.isDestroyed()) child.show() }, REVEAL_AFTER_MS)
  })
}

module.exports = { attachPlugin }
