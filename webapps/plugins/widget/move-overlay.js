// Move-mode overlay for the widget plugin. RUNS IN THE PAGE CONTEXT: widget.js reads this file
// and executes it via webContents.executeJavaScript (a frameless window can't load an external
// <script> under strict app CSPs). Parameters are passed in on window.__wrapwebWidgetMove,
// which widget.js sets right before executing this — keeping this a real, lintable file instead
// of a string built in JS.
//
// A frameless window has no titlebar to drag, and win.setPosition() is unreliable on Wayland —
// the only dependable way to move it is the compositor's interactive move, triggered by an
// element with -webkit-app-region:drag. The whole overlay is the drag surface so the window can
// be grabbed anywhere; only the "Done" button is no-drag so it stays clickable. Exit via the
// button or Esc (a drag surface swallows backdrop clicks, so there's no click-to-close).
//
// Styles are set via element.style (CSSOM), NOT a <style> tag: strict app CSPs (Mastodon) drop
// injected <style> elements under style-src, leaving the panel invisible. CSSOM inline styles
// are not subject to style-src, so this works everywhere.
(() => {
  const ID = 'wrapweb-widget-move'
  if (document.getElementById(ID)) return                 // already in move mode

  const { icon, hintText, doneText, zoom } = window.__wrapwebWidgetMove || {}
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  // Counter-scale the panel so it keeps a constant on-screen size when the view is zoomed (the zoom
  // plugin sets the page zoom; without this the panel would scale with the page). The backdrop (ov)
  // intentionally still fills the viewport — only the card is scaled, about its centre, so the
  // flex-centred position is preserved.
  const invZoom = 1 / (Number(zoom) || 1)

  const ov = document.createElement('div')
  ov.id = ID
  // -webkit-app-region:drag is !important so it survives the widget's global no-drag rule (injected
  // by the suppressAppTitlebar option); an inline !important beats an author-stylesheet !important.
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;' +
    'align-items:center;justify-content:center;background:rgba(0,0,0,0.45);' +
    "-webkit-app-region:drag!important;font-family:'Ubuntu',system-ui,sans-serif"

  // Visual hint panel — also draggable (inherits from the overlay).
  const card = document.createElement('div')
  card.style.cssText = 'border-radius:12px;max-width:90vw;' +
    'box-shadow:0 8px 32px rgba(0,0,0,0.45);overflow:hidden;' +
    'padding:18px 22px;display:flex;flex-direction:column;gap:14px;align-items:center;text-align:center;' +
    `transform-origin:center;transform:scale(${invZoom});` +
    (dark ? 'background:#2c2c2c;color:#f0f0f0' : 'background:#fff;color:#1e1e1e')

  // Hint row: move icon inline before the text.
  const hint = document.createElement('div')
  hint.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;line-height:1.4;' +
    (dark ? 'color:#aaa' : 'color:#666')
  if (icon) {
    const ic = document.createElement('img')
    ic.src = icon
    ic.style.cssText = 'width:22px;height:22px;flex-shrink:0;opacity:.7' + (dark ? ';filter:invert(1)' : '')
    hint.appendChild(ic)
  }
  const hintLabel = document.createElement('span')
  hintLabel.textContent = hintText || ''
  hint.appendChild(hintLabel)

  // The only no-drag island, so the button stays clickable instead of starting a window move.
  const btn = document.createElement('button')
  btn.textContent = doneText || ''
  btn.style.cssText = '-webkit-app-region:no-drag!important;cursor:pointer;border:none;border-radius:8px;' +
    'padding:7px 18px;font:inherit;font-size:13px;font-weight:500;background:#1a73e8;color:#fff'

  card.appendChild(hint)
  card.appendChild(btn)
  ov.appendChild(card)

  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true) }
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
  btn.addEventListener('click', close)
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(ov)
})();
