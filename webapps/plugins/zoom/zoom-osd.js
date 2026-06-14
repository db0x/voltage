// Zoom OSD + Ctrl+wheel listener for the zoom plugin. RUNS IN THE PAGE CONTEXT: zoom.js reads this
// file and executes it via webContents.executeJavaScript on every load (a frameless widget window
// can't load an external <script> under strict app CSPs, and this keeps it a real, lintable file
// instead of a string built in JS — same approach as the widget plugin's move-overlay.js).
//
// Two halves:
//   1. The ctrl+wheel listener that reports zoom INTENT to the main process via the preload bridge
//      (window.electronAPI.adjustZoom). Main does the actual zooming + step/min/max clamping — the
//      page can't read or set its own webContents zoom factor.
//   2. window.__voltageZoomOsd.show(pct): a centred card — laid out like the widget's "move" panel —
//      that main calls after each zoom step. It appears on the first change and hides when Ctrl is
//      released, so it tracks the live zoom level only while the user is actively zooming.
//
// The icon is handed in as a data URL on window.__voltageZoomIcon (set by zoom.js right before this
// runs), mirroring how move-overlay.js receives its icon — no file:// path needed in the page.
//
// Styles use element.style (CSSOM), NOT a <style> tag: strict app CSPs (e.g. Mastodon) silently
// drop injected <style> under style-src, but inline CSSOM styles are exempt — so this works
// everywhere. The theme (and the icon's invert) is re-read on every show() so a light/dark switch
// after load is reflected on the next zoom gesture.
(() => {
  if (window.__voltageZoomOsd) return                       // already installed for this document

  const ID = 'voltage-zoom-osd'

  // Built lazily on the first show() and reused. pointer-events:none — it's purely informational and
  // must never block the page. No dimming backdrop (unlike move mode, which needs a drag surface):
  // this only indicates the zoom level, so dimming the page on every tick would be intrusive.
  let panel = null, label = null, iconEl = null, hideTimer = 0
  function ensurePanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = ID
    panel.style.cssText = 'position:fixed;left:50%;top:50%;transform-origin:center;' +
      'transform:translate(-50%,-50%);z-index:2147483647;pointer-events:none;' +
      'display:flex;align-items:center;gap:10px;border-radius:12px;padding:16px 24px;' +
      'box-shadow:0 8px 32px rgba(0,0,0,0.45);opacity:0;transition:opacity .15s ease;' +
      "font:600 13px/1 'Ubuntu',system-ui,sans-serif;letter-spacing:.3px;white-space:nowrap"

    const icon = window.__voltageZoomIcon
    if (icon) {
      iconEl = document.createElement('img')
      iconEl.src = icon
      iconEl.style.cssText = 'width:18px;height:18px;flex-shrink:0;opacity:.8'
      panel.appendChild(iconEl)
    }
    label = document.createElement('span')
    panel.appendChild(label)
    document.body.appendChild(panel)
    return panel
  }

  function hide() { clearTimeout(hideTimer); if (panel) panel.style.opacity = '0' }

  // show(pct): display/refresh the current zoom percentage. The panel is counter-scaled by 100/pct so
  // it keeps a constant on-screen size — the page is zoomed by pct%, scale(100/pct) cancels that out,
  // so the OSD always reads at 100%. Theme + icon-invert are re-applied here to follow a live switch.
  //
  // The auto-hide timer (reset on every show) is the RELIABLE close: the OSD vanishes 1s after the
  // last zoom change. Tying the close to releasing Ctrl proved unreliable — the page rarely has
  // keyboard focus during a scroll-only gesture, so its keyup never fires; the timer is focus-free.
  function show(pct) {
    const p = ensurePanel()
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    p.style.background = dark ? '#2c2c2c' : '#fff'
    p.style.color      = dark ? '#f0f0f0' : '#1e1e1e'
    if (iconEl) iconEl.style.filter = dark ? 'invert(1)' : 'none'
    label.textContent = pct + ' %'
    p.style.transform = `translate(-50%,-50%) scale(${100 / pct})`
    p.style.opacity = '1'
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hide, 1000)
  }

  // hide() is also exposed so main can close it early on Ctrl keyUp (a before-input-event hook in
  // zoom.js that fires regardless of page focus); blur closes it if focus leaves mid-gesture. Both
  // are nice-to-haves on top of the timer, which is the guaranteed close.
  window.__voltageZoomOsd = { show, hide }
  window.addEventListener('blur', hide, true)

  // The zoom gesture itself: ctrl+wheel → ask main to zoom. passive — we only read the gesture.
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) window.electronAPI.adjustZoom(e.deltaY < 0 ? 1 : -1)
  }, { passive: true })
})();
