// Makes the app believe it runs in an ordinary browser tab (with OS window decoration) so it does
// NOT draw its own custom titlebar / top drag-zone. Apps like Microsoft Teams add that strip when
// they detect a standalone/frameless desktop app — primarily via the `display-mode` media feature
// (Electron reports `standalone`) and/or the Window Controls Overlay API. The widget provides its
// own Move mode, so an app-drawn titlebar is redundant and wastes the top of the view.
//
// RUNS IN THE PAGE'S MAIN WORLD (injected by widget.js as early as possible — on dom-ready). It must
// run before the app reads these signals; for the heavy SPAs this targets, the app's UI is rendered
// after its bundle boots, so dom-ready injection lands in time. Two signals are neutralised:
//   1. window.matchMedia — display-mode queries are rewritten to report a plain browser tab; every
//      other query passes through untouched, so normal responsive layout is unaffected. (CSS
//      @media (display-mode: …) rules can't be reached from JS — if an app drives its titlebar
//      purely from CSS, an app-specific CSS rule would be needed instead.)
//   2. navigator.windowControlsOverlay — presented as present-but-not-visible, covering apps that
//      gate their titlebar on the API's existence or its `visible` flag.
(() => {
  if (window.__wrapwebNoTitlebar) return                    // already installed for this document
  window.__wrapwebNoTitlebar = true

  // 1) display-mode → browser. Wrap matchMedia; only rewrite display-mode queries.
  const realMatchMedia = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null
  if (realMatchMedia) {
    const fakeList = (media, matches) => ({
      media, matches, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},                // deprecated aliases some apps still use
      dispatchEvent() { return false },
    })
    window.matchMedia = (query) => {
      const q = String(query)
      // Only (display-mode: browser) should match — standalone / minimal-ui / window-controls-overlay
      // all report false, i.e. "this is a normal browser tab with its own OS chrome".
      if (/display-mode\s*:/i.test(q)) return fakeList(q, /display-mode\s*:\s*browser/i.test(q))
      return realMatchMedia(q)
    }
  }

  // 2) Window Controls Overlay → present but never visible, with a zero titlebar rect and no events.
  try {
    const stub = {
      visible: false,
      getTitlebarAreaRect: () => new DOMRect(0, 0, 0, 0),
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false },
      ongeometrychange: null,
    }
    Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, get: () => stub })
  } catch {}
})();
