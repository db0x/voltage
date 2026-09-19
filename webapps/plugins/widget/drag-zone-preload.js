// Preload for the widget drag-zone overlay (its own WebContentsView, see src/window.js). main drives
// the reveal (from the app preload's cursor reports) and tells this page when to fade the faint bar
// in or out — we toggle the `shown` class here rather than resizing, because the view height is owned
// by main (a WebContentsView can't resize itself).

const { ipcRenderer } = require('electron')

// main → overlay: fade the bar in (true) or out (false). The CSS opacity transition does the rest.
ipcRenderer.on('voltage:dragzone-show', (_event, shown) => {
  try { document.body.classList.toggle('shown', shown === true) } catch {}
})

// main → overlay: whether the home button applies to the CURRENT page (only sent for relay
// apps, on every navigation). On the document list "/" — the very page the button routes to — it
// would be a no-op, so main hides it there; it appears only while an editor page (/edit/…) is open.
ipcRenderer.on('voltage:dragzone-home', (_event, enabled) => {
  try { document.body.classList.toggle('home-enabled', enabled === true) } catch {}
})

// main → overlay: current zoom level in percent for the zoom readout (only present for zoom-plugin apps).
ipcRenderer.on('voltage:dragzone-zoom', (_event, pct) => {
  try {
    const el = document.querySelector('.zoom-pct')
    if (el) el.textContent = `${pct}%`
  } catch {}
})

// overlay → main: the pointer left the strip UPWARD, i.e. out of the window over the top edge. main
// cannot see this itself — once the strip covers the app view the app stops reporting cursor moves,
// and on Wayland there is no global cursor position to query — so .exit-sensor (the no-drag band
// across the very top, the only part of this view that receives pointer events) witnesses it here.
//
// Deciding the DIRECTION of the exit is the whole job: leaving the band downward is the normal path
// to the buttons and must NOT dismiss the bar. We compare the leave position against the last move
// inside the band rather than testing for a negative coordinate, because a pointer leaving the
// window is reported as a synthesized leave whose coordinates may simply repeat the last known
// position instead of landing outside the band. So: strictly downward (y grew) keeps the bar, and
// everything else — upward, or the stale-coordinate exit — dismisses it. The x guard keeps a
// sideways exit into the transparent pad from counting, since main's own hysteresis still owns that
// case and hides with its edge grace.
//
// A very fast flick straight out of the window can skip the 6px band entirely between two pointer
// samples; no event fires then and the bar stays up until the cursor returns — the same behaviour as
// before this sensor existed, so it degrades rather than breaks.
addEventListener('DOMContentLoaded', () => {
  const sensor = document.querySelector('.exit-sensor')
  if (!sensor) return
  let lastY = null
  sensor.addEventListener('mousemove', (e) => { lastY = e.clientY }, { passive: true })
  sensor.addEventListener('mouseleave', (e) => {
    const movedDown = lastY !== null && e.clientY > lastY
    const leftSideways = e.clientX < 0 || e.clientX > sensor.clientWidth
    lastY = null
    if (movedDown || leftSideways) return
    try { ipcRenderer.send('voltage:dragzone-action', 'exit') } catch {}
  })
})

// overlay → main: is the pointer still inside this view? This feeds main's presence watchdog
// (DRAG_ZONE_PRESENCE_MS in src/window.js), which has no other way to know — once the strip covers
// the app view the app stops reporting cursor moves, and Wayland exposes no global cursor position.
//
// Polls :hover rather than listening for mousemove, because the case that matters is a cursor
// RESTING on the bar: it emits no events at all, so an event-driven check would read it as gone.
// :hover is the renderer's own hit test and answers for a motionless cursor. body:hover also covers
// the buttons and the sensor band, since :hover applies to every ancestor of the hovered element.
//
// KNOWN LIMIT, confirmed on this project's Wayland/Chromium: -webkit-app-region:drag areas are
// excluded from the renderer's hit region, so a cursor resting on the bar's draggable middle matches
// nothing here and reads as absent. The no-drag islands (buttons, sensor band) are all this can
// actually see. main closes the bar anyway once the silence outlasts the watchdog — the deliberate
// trade documented on DRAG_ZONE_PRESENCE_MS.
{
  const POLL_MS = 1000
  setInterval(() => {
    // Only while the bar is up — that is the only state the watchdog runs in, so polling otherwise
    // would be pure IPC noise.
    try {
      if (!document.body || !document.body.classList.contains('shown')) return
      if (document.querySelector('body:hover')) ipcRenderer.send('voltage:dragzone-action', 'present')
    } catch {}
  }, POLL_MS)
}

// overlay → main: forward a window-control button click (About/minimize/maximize/quit). The buttons
// are -webkit-app-region:no-drag so they receive clicks; main maps the action to the host window.
addEventListener('DOMContentLoaded', () => {
  for (const btn of document.querySelectorAll('[data-action]')) {
    btn.addEventListener('click', () => {
      try { ipcRenderer.send('voltage:dragzone-action', btn.dataset.action) } catch {}
    })
  }
})
