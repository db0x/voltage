// no-select plugin (main-process module). Purely a UX nicety: stops accidental text/element
// selection so a wrapped web app feels more like a native desktop window. NOT a content-
// protection measure — DevTools, screenshots and "view source" are intentionally out of scope
// and can't be prevented anyway.
//
// Inputs stay selectable: text fields, textareas and contenteditable regions are exempt, so
// editing/selecting inside them keeps working as normal.
//
// Scope note: this only reaches the top frame and same-origin frames the CSS applies to;
// content inside cross-origin iframes keeps its own selection behaviour (the renderer can't
// reach across that boundary — same limitation as the other page-injected plugins).

const TAG = '[no-select-plugin]'

// CSS injected via insertCSS so it survives SPA navigations without re-injection (unlike
// executeJavaScript). user-select:none everywhere, re-enabled for inputs/editable content.
const CSS = `
  *, *::before, *::after {
    -webkit-user-select: none !important;
    user-select: none !important;
  }
  input, textarea, [contenteditable], [contenteditable] * {
    -webkit-user-select: text !important;
    user-select: text !important;
  }
`

// Belt-and-braces over the CSS: cancel selectstart/dragstart in the capture phase so a drag
// never starts one. Both bail out when the target is (or sits inside) an input/editable, so
// selection there is untouched. Injected after load; re-applied on navigation since the page
// document is replaced. Kept tiny and self-contained — it runs in the page, not Node.
const GUARD = `(() => {
  if (window.__wrapwebNoSelect) return;
  window.__wrapwebNoSelect = true;
  const editable = (el) => !!(el && el.closest && el.closest('input,textarea,[contenteditable]'));
  for (const ev of ['selectstart', 'dragstart']) {
    document.addEventListener(ev, (e) => { if (!editable(e.target)) e.preventDefault(); }, { capture: true });
  }
})();`

function attachPlugin(win) {
  const wc = win.webContents

  // CSS via insertCSS persists across in-page navigation; the JS guard must be re-run after
  // each load because a full navigation replaces the document (and our window flag with it).
  const apply = () => {
    wc.insertCSS(CSS).catch(() => {})
    wc.executeJavaScript(GUARD).catch(() => {})
  }

  wc.on('did-finish-load', apply)
  console.log(TAG, 'attached')
}

module.exports = { attachPlugin }
