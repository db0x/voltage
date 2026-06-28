// ms-office plugin (main-process module). Selected per app (OneDrive/Word/Excel/PowerPoint/OneNote)
// to route Office document opens to the app that owns the file type.
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
// child and, as soon as it heads to a URL another built voltage app claims (Word/Excel/
// PowerPoint via routing.json), we launch that app and discard the child.
//
// To avoid a stray OneDrive window flashing up, same-origin popups are created hidden; the
// child is only ever shown if it turns out NOT to be a routed document.

const TAG = '[ms-office-plugin]'

// Grace period before revealing a hidden child that never routed. The routed-document case
// resolves within a few hundred ms (open launcher → in-page nav to the doc → route + close);
// anything still unrouted after this is a genuine OneDrive popup, so we show it.
const REVEAL_AFTER_MS = 1500

// Installs OneDrive's window-open routing. Receives the standard plugin api from window.js
// loadPlugins(); it uses:
//   webContents                — the APP's webContents (see below — NOT win.webContents)
//   appOrigin, internalDomains — classify a popup as same-origin/internal (a doc launcher)
//   routeUrl(url)              — launch the claiming AppImage, returns true on a routing hit
//   claimsUrl(url)             — whether THIS app owns the doc (e.g. a OneNote note from OneNote)
//   openExternal(url)          — hand a non-routed external URL to the system browser
//
// MUST use api.webContents, not win.webContents: when the app also loads the widget plugin it runs
// in an inset WebContentsView (view mode), so win.webContents is the transparent HOST window (the
// shadow page) while the app — and thus its window.open() calls — live in api.webContents. Binding
// the handlers to win.webContents there silently attached them to the wrong contents: no events
// fired and every document opened as an unrouted child window.
// Classifies a window.open target so the handler knows what to do with it:
//   'placeholder' — about:blank or any host-less popup. OneDrive reserves such a window synchronously
//                   on click (anti-popup-blocker) and navigates it to the real doc URL a moment later.
//   'internal'    — the document launcher: same-origin, or a whitelisted internal domain.
//   'external'    — a final/foreign URL to self-claim, route to another app, or hand to the browser.
// 'placeholder' and 'internal' are both allowed hidden and routed via did-create-window; only treating
// 'placeholder' as external (the old behaviour) made about:blank pop a stray empty browser tab.
function popupKind(url, appOrigin, internalDomains) {
  let t
  try { t = new URL(url) } catch { return 'external' }
  if (url === 'about:blank' || !t.hostname) return 'placeholder'
  if (t.origin === appOrigin) return 'internal'
  if ((internalDomains || []).some(d => t.hostname === d || t.hostname.endsWith('.' + d))) return 'internal'
  return 'external'
}

function attachPlugin(win, { webContents, appOrigin, internalDomains, routeUrl, claimsUrl, openExternal }) {
  const wc = webContents

  // Replace the default handler for OneDrive. The document launcher AND OneDrive's host-less
  // placeholder popups (about:blank) are allowed hidden — so a routed document never flashes a
  // window, and the placeholder no longer pops a stray empty browser tab — and routed once they
  // navigate to the real doc URL (see did-create-window). Everything else keeps the normal
  // self-claim / route / browser behaviour.
  wc.setWindowOpenHandler(({ url }) => {
    const kind = popupKind(url, appOrigin, internalDomains)
    if (kind === 'placeholder' || kind === 'internal') {
      console.log(TAG, `window.open ${kind} (allowed hidden, watching child):`, url)
      return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
    }
    // External: the final doc URL arrives here directly (no child window). Decide in this order —
    // the order matters:
    //   1. THIS app owns the doc (a OneNote note opened from OneNote): keep it, load in place.
    //      Checked FIRST and before routing, because SharePoint hosts a personal OneDrive note
    //      under *-my.sharepoint.com too, which a broad/stale routing key in another built app
    //      can also match — without self-first such a note is wrongly handed to that app.
    //   2. Another built app claims it (OneDrive → a .docx → Word): route there.
    //   3. Nobody claims it: system browser.
    try {
      if (claimsUrl(url)) {
        console.log(TAG, 'window.open → load in app (self-claimed):', url)
        wc.loadURL(url).catch(() => {})
        return { action: 'deny' }
      }
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
      // Same precedence as the window.open handler: a doc THIS app owns is kept (self-first, so a
      // broad/stale key in another app can't steal it); otherwise route to the claiming app. The
      // logged URL is exactly what drove the decision, so a wrong/unexpected one explains a miss.
      if (claimsUrl(url)) {
        console.log(TAG, 'routing URL (self-claimed, load in app):', url)
        handled = true
        if (event) event.preventDefault()
        if (!child.isDestroyed()) child.close()
        wc.loadURL(url).catch(() => {})
        return
      }
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

  console.log(TAG, 'attached')
  
}

module.exports = { attachPlugin, popupKind }
