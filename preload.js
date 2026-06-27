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
// `display:none`/recolour rule never lets its target flash visible for a frame (the FOUC the old
// post-load insertCSS left). The CSS rides in via additionalArguments (process.argv) — the same
// mechanism as --voltage-file-handler — because it must be in hand SYNCHRONOUSLY here, before any
// page script runs; a sync IPC would race the plugin's post-load attach. Main frame only: css-inject
// styles only the top document (its long-standing cross-origin limitation), and additionalArguments
// reach the main frame but not out-of-process iframes anyway. webFrame.insertCSS persists across the
// app's in-page navigations; this preload re-runs and re-injects on every full document load.
if (process.isMainFrame) {
  const CSS_ARG = '--voltage-css-inject='
  const cssArg = process.argv.find(a => a.startsWith(CSS_ARG))
  if (cssArg) {
    try { webFrame.insertCSS(decodeURIComponent(cssArg.slice(CSS_ARG.length))) } catch {}
  }
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

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }
  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type])
  }
})
