const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Expose window.electron only for apps that opt in via fileHandler flag.
// draw.io-desktop protocol: if window.electron.request() is present, draw.io
// bypasses the File System Access API and uses native IPC instead.
if (process.argv.includes('--voltage-file-handler')) {
  let reqId = 0
  const pending = {}

  ipcRenderer.on('mainResp', (_, resp) => {
    const cbs = pending[resp.reqId]
    if (!cbs) return
    delete pending[resp.reqId]
    if (resp.error) cbs.error?.(resp.msg)
    else cbs.callback?.(resp.data)
  })

  contextBridge.exposeInMainWorld('electron', {
    request: (msg, callback, error) => {
      msg.reqId = reqId++
      pending[msg.reqId] = { callback, error }
      ipcRenderer.send('rendererReq', msg)
    }
  })
}

// Neutralise the page's own window.close() for apps that opt in (widget apps + blockWindowClose).
// Why this exists: Microsoft Teams' MSAL silent-auth runs in a hidden iframe whose redirect handler
// (teams.cloud.microsoft/v2/authv2) calls window.close() to dismiss itself. In a normal browser an
// iframe's window.close() is a no-op, but in Electron's view-mode (WebContentsView) it closes the
// HOST window — so a fresh-login Teams vanishes the moment silent auth fails and MSAL falls back to
// the interactive redirect. Neutralising window.close() lets MSAL continue to the login page.
//
// The gate is a synchronous IPC, NOT additionalArguments/process.argv or an env var. That auth iframe
// becomes an out-of-process frame after its cross-origin hop through login.microsoftonline.com, and
// neither additionalArguments nor a JS-set process.env ever reach an OOPIF renderer (Chromium
// snapshots the renderer environment in C++ before any JS runs). The preload itself DOES run in every
// frame including OOPIFs, and ipcRenderer.sendSync works there — and being synchronous it completes at
// document-start, before any page script, so the override is in place before the page can call close.
// webFrame.executeJavaScript reaches the MAIN world (where the page's own window.close lives — the
// isolated preload world can't see it). WM/title-bar close and our context-menu Quit go through the
// BrowserWindow, not window.close, so they keep working. Handler: registerBlockCloseHandler (app-window.js).
let _blockClose = false
try { _blockClose = ipcRenderer.sendSync('voltage:should-block-close') === true } catch {}
if (_blockClose) {
  webFrame.executeJavaScript(
    '(function(){try{Object.defineProperty(window,"close",{value:function(){},writable:false,configurable:true});}' +
    'catch(e){try{window.close=function(){};}catch(_){}}})();'
  ).catch(() => {})
}

// css-inject: apply the per-app stylesheet at document-start, before the first paint, so a
// `display:none`/recolour rule never lets its target flash visible for a frame (FOUC). Injected in
// EVERY frame so it also reaches elements the wrapped app renders inside iframes — notably the
// cross-origin out-of-process editor frame of Office/OnlyOffice (the top document at localhost can't
// style that frame; only this preload, which runs inside it, can). Two delivery paths, both
// synchronous at document-start: the main frame reads the CSS from additionalArguments (process.argv,
// no IPC); sub-frames — which never receive additionalArguments (esp. OOPIFs) — fetch the same CSS
// from main via a synchronous IPC (mirrors the per-frame voltage:should-block-close query).
// webFrame.insertCSS persists across in-page navigations; this preload re-runs on every full load.
{
  const CSS_ARG = '--voltage-css-inject='
  let css = null
  if (process.isMainFrame) {
    const cssArg = process.argv.find(a => a.startsWith(CSS_ARG))
    if (cssArg) css = decodeURIComponent(cssArg.slice(CSS_ARG.length))
  } else {
    try { css = ipcRenderer.sendSync('voltage:css-inject') || null } catch {}
  }
  if (css) { try { webFrame.insertCSS(css) } catch {} }
}

// ── notifications plugin: re-point the persistent-notification API at the main process ──────────
// Electron implements only NON-persistent web notifications. `new Notification()` reaches the
// desktop, but ServiceWorkerRegistration.showNotification() — the path Teams/Outlook and every
// other PWA-style app use — is accepted, resolves, and is then dropped without ever reaching the
// org.freedesktop.Notifications D-Bus service. Its sibling getNotifications() never settles at all,
// which stalls any app that awaits it before showing anything. Both are replaced here.
//
// Why contextBridge.executeInMainWorld and not a plain assignment: the preload runs in an ISOLATED
// world, so patching ServiceWorkerRegistration.prototype here would only patch our own copy — the
// page's calls go through the MAIN world's prototype. executeInMainWorld runs the shim over there
// while keeping the IPC entry points as proxied function ARGUMENTS, so — unlike an exposed global —
// nothing the page can reach ever holds a way to raise desktop notifications. The shim function is
// serialized across the world boundary, so it may not close over anything in this file; everything
// it needs is passed in as an argument.
//
// Opt-in per app (the notifications plugin's preloadArgs), because this replaces a standard web API
// for the whole page — an app whose notifications already work should keep Chromium's own path.
const NOTIFICATIONS_ARG = '--voltage-notifications'
if (process.isMainFrame && process.argv.includes(NOTIFICATIONS_ARG)) {
  const listeners = new Set()
  ipcRenderer.on('voltage:notification-event', (_e, payload) => {
    for (const cb of listeners) { try { cb(payload) } catch {} }
  })

  contextBridge.executeInMainWorld({
    args: [{
      show:      (payload) => ipcRenderer.invoke('voltage:notification-show', payload),
      close:     (id)      => ipcRenderer.send('voltage:notification-close', String(id)),
      subscribe: (cb)      => { listeners.add(cb) },
      // Kept in sync with MAX_ICON_BYTES in webapps/plugins/notifications/notifications.js, which
      // rejects anything larger — matching here avoids shipping a payload main will only discard.
      maxIconBytes: 512 * 1024,
    }],
    func: (bridge) => {
      const live = new Map()   // our id -> record for every notification currently on screen
      let seq = 0

      // The page's icon URL is usually a same-origin avatar behind the session cookie, so it has to
      // be fetched HERE (this world holds the cookies) and handed to main as a data URL — main has
      // no way to authenticate that request. Bounded by size and time: an icon is decoration and
      // must never delay, let alone block, the message itself.
      const iconToDataUrl = (src) => {
        if (typeof src !== 'string' || !src) return Promise.resolve(null)
        if (src.startsWith('data:')) return Promise.resolve(src.length <= bridge.maxIconBytes ? src : null)
        return new Promise((resolve) => {
          let done = false
          const finish = (v) => { if (!done) { done = true; resolve(v) } }
          setTimeout(() => finish(null), 2000)
          fetch(src, { credentials: 'include' }).then((r) => {
            if (!r.ok) return finish(null)
            return r.blob().then((blob) => {
              if (blob.size > bridge.maxIconBytes) return finish(null)
              const fr = new FileReader()
              fr.onload  = () => finish(typeof fr.result === 'string' ? fr.result : null)
              fr.onerror = () => finish(null)
              fr.readAsDataURL(blob)
            })
          }).catch(() => finish(null))
        })
      }

      // Mints the id both sides use to talk about one notification and starts the async hand-off.
      // Returns the record synchronously so a constructor (which cannot await) still gets its id.
      const send = (title, options, target) => {
        const opts = options || {}
        const id = 'vn' + (++seq)
        const rec = {
          id, target: target || null,
          title: String(title),
          body: opts.body == null ? '' : String(opts.body),
          tag:  opts.tag  == null ? '' : String(opts.tag),
          icon: opts.icon || '', data: opts.data,
        }
        live.set(id, rec)
        rec.sent = iconToDataUrl(opts.icon).then((icon) => bridge.show({
          id, title: rec.title, body: rec.body, tag: rec.tag,
          silent: !!opts.silent, requireInteraction: !!opts.requireInteraction, icon,
        })).catch(() => { live.delete(id); return false })
        return rec
      }

      // Main reports what became of a notification so the page object fires the same events it
      // would have fired natively. A service-worker notification has no page object (target null) —
      // it is only tracked so getNotifications() can still answer for it.
      bridge.subscribe((ev) => {
        const rec = live.get(ev.id)
        if (!rec) return
        if (ev.type === 'close' || ev.type === 'error') live.delete(ev.id)
        const target = rec.target
        if (!target) return
        let evt
        try { evt = new Event(ev.type) } catch { return }
        try { if (typeof target['on' + ev.type] === 'function') target['on' + ev.type].call(target, evt) } catch {}
        try { target.dispatchEvent(evt) } catch {}
      })

      // What getNotifications() hands back: enough of the Notification surface to inspect and close.
      const handleFor = (rec) => ({
        title: rec.title, body: rec.body, tag: rec.tag, icon: rec.icon, data: rec.data,
        close: () => { try { bridge.close(rec.id) } catch {} live.delete(rec.id) },
      })

      const swProto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype
      if (swProto) {
        // Resolves once main has accepted it, which matches the spec's "notification shown"
        // contract far better than Chromium's dead path here, which resolved and showed nothing.
        swProto.showNotification = function (title, options) {
          return send(title, options, null).sent.then(() => undefined)
        }
        // Answered from our own records. The native one never settles under Electron, so an app
        // that awaits it to de-duplicate would hang before showing anything at all.
        swProto.getNotifications = function (filter) {
          const tag = filter && filter.tag ? String(filter.tag) : ''
          const out = []
          live.forEach((rec) => {
            if (rec.target) return
            if (tag && rec.tag !== tag) return
            out.push(handleFor(rec))
          })
          return Promise.resolve(out)
        }
      }

      // The non-persistent path already works in Electron, but it is routed through main too so
      // both kinds get the same GNOME identity and the same click-raises-the-window behaviour.
      const Native = window.Notification
      if (typeof Native === 'function') {
        const Wrapped = class Notification extends EventTarget {
          constructor(title, options) {
            super()
            const opts = options || {}
            this.title = String(title)
            this.body  = opts.body == null ? '' : String(opts.body)
            this.tag   = opts.tag  == null ? '' : String(opts.tag)
            this.icon  = opts.icon || ''
            this.data  = opts.data
            this.dir   = opts.dir || 'auto'
            this.lang  = opts.lang || ''
            this.silent = !!opts.silent
            this.onclick = null; this.onclose = null; this.onerror = null; this.onshow = null
            const rec = send(title, opts, this)
            this._voltageId = rec.id
            // If the bridge is unavailable (plugin not attached, handler gone), fall back to the
            // native notification: that path works today, so a broken shim must never be worse
            // than no shim at all.
            rec.sent.then((ok) => { if (ok === false) { try { new Native(title, opts) } catch {} } })
          }
          close() { try { bridge.close(this._voltageId) } catch {} live.delete(this._voltageId) }
        }
        Object.defineProperty(Wrapped, 'permission', { get: () => Native.permission })
        Object.defineProperty(Wrapped, 'maxActions', { get: () => Native.maxActions })
        Wrapped.requestPermission = (cb) => Native.requestPermission(cb)
        window.Notification = Wrapped
      }
    },
  })
}

// Widget drag-zone reveal: report the cursor position so main can show/hide its overlay drag strip
// (see src/window.js). The strip itself can't sense hover — its -webkit-app-region:drag surface
// swallows pointer events — and on Wayland main can't query the global cursor position, but the app's
// own content DOES get mousemove. Runs in EVERY frame because the toolbar the strip overlaps may live
// in a cross-origin subframe (e.g. the Office editor): clientX/Y there still equal the window-relative
// coords for a frame aligned to the top, which is the case that matters. main ignores reports for
// windows that have no drag strip.
//
// We report EVERY move (not just near the top): the hide must fire when the cursor leaves the strip
// in ANY direction, and a near-top gate would drop the very report that signals a fast downward exit,
// leaving the strip stuck open. A leading+trailing throttle keeps the volume low while GUARANTEEING
// the final resting position is sent (a plain throttle drops the last event, so a quick flick-out
// would never be reported and the strip would never hide). We deliberately do NOT report a "pointer
// left" event: once revealed the strip is its own WebContentsView, so moving from the app onto it
// looks to the app like leaving the document — reporting that would hide the strip the instant it
// appears. main hides only on a later report placing the cursor outside the strip.
{
  let lastSent = 0, pending = null, timer = null
  const flush = () => {
    timer = null
    if (!pending) return
    lastSent = Date.now()
    const { x, y } = pending; pending = null
    try { ipcRenderer.send('voltage:dragzone-cursor', x, y) } catch {}
  }
  addEventListener('mousemove', (e) => {
    pending = { x: e.clientX, y: e.clientY }
    const dt = Date.now() - lastSent
    if (dt >= 40) flush()
    else if (!timer) timer = setTimeout(flush, 40 - dt)
  }, { passive: true, capture: true })
}

// ── Runtime marker for the hosted web app ───────────────────────────────────────────────────────
// A web app cannot otherwise tell that it is running inside voltage rather than in a browser tab —
// and relay wants to know: inside voltage there is a REAL window manager, so a document belongs in
// its own OS window instead of a dragged pseudo-window inside its page.
//
// Opt-in per app: only a plugin that asks for it (relay, via preloadArgs) gets this marker, so an
// arbitrary app's page is not handed a way to spawn windows. The arg arrives through
// additionalArguments, i.e. at document-start before any page script — so the app never has to
// poll for it.
//
// openDocumentWindow resolves true only if the main process actually launched something; the page
// can therefore fall back to its own in-page view instead of silently doing nothing. Main validates
// the URL (see the relay plugin) — this is not a general-purpose window opener.
const RUNTIME_ARG = '--voltage-runtime='
const runtimeArg = process.argv.find(a => a.startsWith(RUNTIME_ARG))
if (runtimeArg) {
  contextBridge.exposeInMainWorld('voltage', {
    runtime: runtimeArg.slice(RUNTIME_ARG.length) || 'voltage',
    openDocumentWindow: (url) => ipcRenderer.invoke('voltage:open-document-window', String(url)),
  })
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer→main bridge for the zoom plugin: a page can't reach its own webContents zoom, so the
  // injected ctrl+wheel listener signals the direction here and the plugin steps the zoom factor.
  // Harmless for apps without the zoom plugin (no 'adjust-zoom' handler is registered, so it no-ops).
  adjustZoom:        (delta)  => ipcRenderer.send('adjust-zoom',       delta),
  rcloneConfirm:     (choice) => ipcRenderer.send('rclone-confirm',    choice),
  checkSafeBrowsing: (url, ignoreExclude) => ipcRenderer.invoke('safe-browsing:check', url, ignoreExclude),
  // Used only by the built-in error page's "Close app" button; main scopes it to data:-URL senders.
  closeApp:          ()       => ipcRenderer.send('voltage:quit-app'),
});

// ── Custom Ctrl+right-click context menu ────────────────────────────────────────────────────────
// The ONE consistent way to reach our menu in every app, at any spot: a self-rendered in-page layer.
// It sidesteps every native pitfall — apps that suppress `contextmenu` (Teams/Office), Word's canvas
// editor that never fires it, app-region drag zones that swallow it, and Wayland's input-grab quirks
// with programmatic native popups. The item list is owned by the main process (so plugin entries +
// link routing stay authoritative); this layer only renders it and reports the activated id back.
//
// It lives entirely in the preload, inlined (not a required module): the renderer is sandboxed, so a
// preload can't require app files — but it does have DOM access + ipcRenderer, which is all we need.
// Styling uses element.style (CSSOM), never a <style> tag, so strict app CSPs can't drop it.
(() => {
  const Z = 2147483647
  const MENU_ID = 'voltage-context-menu'
  let teardown = null  // removes the open menu's document/window dismiss listeners

  const palette = () => matchMedia('(prefers-color-scheme: dark)').matches
    ? { dark: true,  bg: '#2c2c2c', fg: '#f0f0f0', muted: '#888', hover: '#3a3a3a', sep: '#4a4a4a' }
    : { dark: false, bg: '#ffffff', fg: '#1e1e1e', muted: '#999', hover: '#ececec', sep: '#e0e0e0' }

  const boxStyle = (p) => 'position:fixed;z-index:' + Z + ';min-width:200px;max-width:380px;padding:5px 0;' +
    'border-radius:8px;box-shadow:0 6px 28px rgba(0,0,0,0.4);transform-origin:0 0;' +
    "font:13px/1.4 'Ubuntu',system-ui,sans-serif;user-select:none;-webkit-user-select:none;" +
    'background:' + p.bg + ';color:' + p.fg + ';border:1px solid ' + p.sep

  function closeMenu() {
    if (teardown) { teardown(); teardown = null }
    const el = document.getElementById(MENU_ID)
    if (el) el.remove()
  }

  // One menu row. Leaf rows activate via fire(id); submenu rows open a child on hover. mousedown is
  // prevented so clicking the menu never blurs the page (keeps the selection cut/copy/paste act on).
  function makeRow(item, p, fire, openSubmenu) {
    if (item.type === 'separator') {
      const sep = document.createElement('div')
      sep.style.cssText = 'height:1px;margin:5px 8px;background:' + p.sep
      return sep
    }
    const row = document.createElement('div')
    const disabled = item.enabled === false
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 14px;white-space:nowrap;' +
      'cursor:' + (disabled ? 'default' : 'pointer') + ';opacity:' + (disabled ? '0.45' : '1')

    const ic = document.createElement('span')
    ic.style.cssText = 'width:16px;height:16px;flex:0 0 16px;display:flex;align-items:center;justify-content:center'
    // Icon is either a plain data URL (full-colour app/link icons — used as-is) or a { light, dark }
    // pair of themed SVG glyphs, from which the overlay picks the one matching its own menu theme
    // (dark menu → the light glyph). No CSS filter — the glyph already has the right colour.
    const iconSrc = item.icon && (typeof item.icon === 'string' ? item.icon : (p.dark ? item.icon.dark : item.icon.light))
    if (iconSrc) {
      const img = document.createElement('img')
      img.src = iconSrc
      img.style.cssText = 'width:16px;height:16px;object-fit:contain'
      ic.appendChild(img)
    }
    row.appendChild(ic)

    const label = document.createElement('span')
    label.textContent = item.label || ''
    label.style.cssText = 'flex:1 1 auto'
    row.appendChild(label)

    // Keyboard-shortcut hint, right-aligned and muted (label's flex:1 pushes it to the edge).
    if (item.shortcut) {
      const sc = document.createElement('span')
      sc.textContent = item.shortcut
      sc.style.cssText = 'margin-left:28px;font-size:12px;color:' + p.muted
      row.appendChild(sc)
    }

    const hasSub = Array.isArray(item.submenu) && item.submenu.length
    if (hasSub) {
      const arrow = document.createElement('span')
      arrow.textContent = '▸'
      arrow.style.cssText = 'color:' + p.muted + ';margin-left:8px'
      row.appendChild(arrow)
    }
    if (!disabled) {
      row.addEventListener('mouseenter', () => { row.style.background = p.hover })
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent' })
      // Submenu opens on CLICK (toggle), not on hover — hover-open popped the flyout instantly and
      // overlapped the rest. Leaf rows activate on click.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation()
        if (hasSub) openSubmenu(item, row)
        else fire(item.id)
      })
    }
    return row
  }

  function showMenu(items, x, y) {
    closeMenu()
    const p = palette()
    const root = document.createElement('div')
    root.id = MENU_ID
    root.style.cssText = 'position:fixed;inset:0;z-index:' + Z

    // Counter-scale by 1/zoom so the menu keeps a constant on-screen size regardless of the page
    // zoom (the zoom plugin's setZoomFactor scales the whole page, including this overlay). Applied
    // BEFORE measuring with transform-origin:0 0 (top-left anchor), so getBoundingClientRect already
    // returns the scaled size and the positioning/flip math below needs no further adjustment.
    const s = 1 / (webFrame.getZoomFactor() || 1)
    const scale = (el) => { el.style.transform = 'scale(' + s + ')' }

    const fire = (id) => { try { ipcRenderer.send('voltage:menu-action', { id }) } finally { closeMenu() } }

    let subBox = null, subRow = null
    const openSubmenu = (item, parentRow) => {
      const reclick = subBox && subRow === parentRow   // clicking the open submenu's row toggles it shut
      if (subBox) { subBox.remove(); subBox = null; subRow = null }
      if (!item || reclick) return
      const sub = document.createElement('div')
      sub.style.cssText = boxStyle(p)
      for (const child of item.submenu) sub.appendChild(makeRow(child, p, fire, () => {}))
      root.appendChild(sub)
      scale(sub)
      subBox = sub; subRow = parentRow
      const pr = parentRow.getBoundingClientRect(); const sr = sub.getBoundingClientRect()
      let left = pr.right - 2
      if (left + sr.width > innerWidth - 4) left = Math.max(4, pr.left - sr.width + 2)
      let top = Math.min(pr.top - 5, innerHeight - sr.height - 4)
      sub.style.left = Math.max(4, left) + 'px'; sub.style.top = Math.max(4, top) + 'px'
    }

    const box = document.createElement('div')
    box.style.cssText = boxStyle(p)
    for (const item of items) box.appendChild(makeRow(item, p, fire, openSubmenu))
    root.appendChild(box)
    scale(box)

    // Backdrop click / right-click dismisses without activating.
    root.addEventListener('mousedown', (e) => { if (e.target === root) { e.preventDefault(); closeMenu() } })
    root.addEventListener('contextmenu', (e) => e.preventDefault())
    document.body.appendChild(root)

    // Position the main box at the cursor, flipping when it would overflow. r is already the scaled
    // rect (transform applied above), so this measures the menu's real on-screen footprint.
    const r = box.getBoundingClientRect()
    box.style.left = Math.max(4, x + r.width  > innerWidth  - 4 ? x - r.width  : x) + 'px'
    box.style.top  = Math.max(4, y + r.height > innerHeight - 4 ? Math.min(y, innerHeight - r.height - 4) : y) + 'px'

    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeMenu() } }
    const onGone = () => closeMenu()
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onGone, true)
    window.addEventListener('resize', onGone, true)
    window.addEventListener('blur', onGone, true)
    teardown = () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onGone, true)
      window.removeEventListener('resize', onGone, true)
      window.removeEventListener('blur', onGone, true)
    }
  }

  // Trigger on the right-button mousedown (NOT `contextmenu`): some apps suppress contextmenu or
  // never fire it (Word's canvas), but the raw mouse button always arrives. Capture phase + preload
  // (isolated world, before the page's scripts) so we intercept first; preventDefault +
  // stopImmediatePropagation keep both the app and the native menu out of the way. A plain
  // right-click (no Ctrl) is left untouched — it reaches the app / the slim native menu.
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 2 || !e.ctrlKey) return
    e.preventDefault(); e.stopImmediatePropagation()
    const x = e.clientX, y = e.clientY
    let linkURL = null
    try { linkURL = (e.target.closest && e.target.closest('a[href]'))?.href || null } catch {}
    ipcRenderer.invoke('voltage:menu-items', { linkURL })
      .then(res => { if (res && res.items && res.items.length) showMenu(res.items, x, y) })
      .catch(() => {})
  }, true)

  // Swallow the contextmenu the same Ctrl+right-click would otherwise raise, so nothing flashes
  // behind our layer. The plain (no-Ctrl) contextmenu is left for the slim native menu in window.js.
  window.addEventListener('contextmenu', (e) => { if (e.ctrlKey) { e.preventDefault(); e.stopImmediatePropagation() } }, true)

  ipcRenderer.on('voltage:menu-close', closeMenu)

  // Plain right-click: the main process derives the slim menu (spelling + cut/copy/paste) from the
  // native context-menu event and pushes it here to render with the SAME overlay — so both menus
  // look identical and nothing native is ever shown.
  ipcRenderer.on('voltage:menu-show', (_e, d) => { if (d && d.items && d.items.length) showMenu(d.items, d.x, d.y) })
})();

// ── Pointer-lock toast ──────────────────────────────────────────────────────────────────────────
// pointerLock is now a granted permission for every app (see src/session.js) — before that, a page's
// requestPointerLock() was silently denied, so there was nothing to surface. Now that any app's own
// content can actually capture the mouse, this makes that otherwise invisible state change visible: a
// brief, non-interactive toast on every pointerlockchange. Runs in every frame (the element requesting
// lock may live in an OOPIF); reuses the context menu's in-page overlay technique (element.style, no
// <style> tag, so it can't be dropped by the app's own CSP) and the same max z-index.
(() => {
  let labels = null
  try { labels = ipcRenderer.sendSync('voltage:pointerlock-labels') } catch {}
  if (!labels) return

  const Z = 2147483647
  let toastEl = null, hideTimer = null

  function showToast(text) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:28px;z-index:' + Z + ';' +
        'transform:translateX(-50%);padding:8px 16px;border-radius:20px;pointer-events:none;' +
        "font:13px/1.4 'Ubuntu',system-ui,sans-serif;color:#fff;background:rgba(20,20,20,0.85);" +
        'box-shadow:0 4px 16px rgba(0,0,0,0.35);user-select:none;-webkit-user-select:none;' +
        'opacity:0;transition:opacity 0.15s ease'
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = text
    // Two rAFs: the element must paint at opacity:0 first, otherwise the browser coalesces the
    // opacity:0→1 change into the same frame as its creation and the transition never plays.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (toastEl) toastEl.style.opacity = '1' }))
    hideTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0' }, 1600)
  }

  document.addEventListener('pointerlockchange', () => {
    showToast(document.pointerLockElement ? labels.locked : labels.unlocked)
  })
})();

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }
  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type])
  }
})
