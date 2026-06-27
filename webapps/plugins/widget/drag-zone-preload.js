// Preload for the widget drag-zone overlay (its own WebContentsView, see src/window.js). The overlay
// can't sense its own hover — a -webkit-app-region:drag surface swallows pointer events — so main
// drives the reveal (from the app preload's cursor reports) and just tells this page when to fade the
// faint bar in or out. We toggle the `shown` class here rather than resizing, because the view height
// is owned by main (a WebContentsView can't resize itself).

const { ipcRenderer } = require('electron')

// main → overlay: fade the bar in (true) or out (false). The CSS opacity transition does the rest.
ipcRenderer.on('voltage:dragzone-show', (_event, shown) => {
  try { document.body.classList.toggle('shown', shown === true) } catch {}
})

// overlay → main: forward a window-control button click (About/minimize/maximize/quit). The buttons
// are -webkit-app-region:no-drag so they receive clicks; main maps the action to the host window.
addEventListener('DOMContentLoaded', () => {
  for (const btn of document.querySelectorAll('[data-action]')) {
    btn.addEventListener('click', () => {
      try { ipcRenderer.send('voltage:dragzone-action', btn.dataset.action) } catch {}
    })
  }
})
