// notifications plugin (main-process module + document-start shim in preload.js).
//
// Why this exists: Electron implements only NON-PERSISTENT web notifications. A page's
// `new Notification()` reaches the desktop, but `ServiceWorkerRegistration.showNotification()` —
// the "persistent" path every PWA-style app uses, Teams and Outlook included — is accepted,
// resolves its promise, and is then dropped: nothing is ever sent to the org.freedesktop.Notifications
// D-Bus service, so GNOME never sees it. Its sibling `getNotifications()` is worse than silent: its
// promise NEVER settles, so an app that awaits it (to de-duplicate or to close a stale toast) stalls
// its own notification code before anything is shown.
//
// What we do about it: the shim in preload.js re-points both methods at this module, which raises a
// REAL Electron notification from the main process — the one path proven to reach the daemon. The
// page keeps its normal API surface (promises resolve, click/close events fire, getNotifications
// answers), it just no longer talks to a half-implemented Chromium path.
//
// NOTE — a hard limit we cannot lift: Electron ships no push service ("push service not available"
// from pushManager.subscribe()), so nothing is delivered while the app is closed. Notifications can
// only originate from the running page's own live connection. Keeping the app running is the whole
// mechanism; there is no background delivery to fix.
//
// GNOME specifics, both handled outside this file:
//   - the `desktop-entry` hint must match the installed launcher or GNOME shows the notification
//     without the app's icon/name and ignores its per-app notification settings — see
//     app.setDesktopName() in src/app-window.js.
//   - raising the window on click is a compositor decision under Wayland, not a client one — see
//     activateWindow() below and the ActivateApp D-Bus method in src/plugins/gnome/extension.js.

const { ipcMain, Notification, nativeImage } = require('electron')
const { execFile } = require('node:child_process')

const TAG = '[notifications-plugin]'

// Marker passed to the preload through additionalArguments; presence alone enables the shim.
// Must match the reader in preload.js.
const PRELOAD_ARG = '--voltage-notifications'

// IPC channels shared with the shim in preload.js.
const SHOW_CHANNEL  = 'voltage:notification-show'
const CLOSE_CHANNEL = 'voltage:notification-close'
const EVENT_CHANNEL = 'voltage:notification-event'

// D-Bus coordinates of the Voltage GNOME Shell extension's activation method. Calling out via
// `gdbus` (glib2, present on every GNOME system) keeps this dependency-free — the repo already
// shells out to gsettings the same way.
const DBUS_NAME  = 'de.db0x.Voltage'
const DBUS_PATH  = '/de/db0x/Voltage'
const DBUS_IFACE = 'de.db0x.Voltage'

// Cap on an icon we accept from the page. The shim inlines the icon as a data URL (it must be
// fetched in the renderer, which holds the session cookies the icon URL usually needs); this bound
// keeps a hostile or broken page from pushing megabytes through IPC for every toast.
const MAX_ICON_BYTES = 512 * 1024

// Maps the web `requireInteraction` flag onto the freedesktop urgency that makes GNOME keep a
// notification on screen until it is dismissed, instead of auto-hiding it after a few seconds.
function urgencyFor(requireInteraction) {
  return requireInteraction ? 'critical' : 'normal'
}

// Decodes the shim's data: URL into a NativeImage. Returns undefined for anything unusable so the
// notification still goes out — an icon is decoration, never a reason to drop the message.
function iconFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return undefined
  if (dataUrl.length > MAX_ICON_BYTES) return undefined
  try {
    const img = nativeImage.createFromDataURL(dataUrl)
    return img.isEmpty() ? undefined : img
  } catch {
    return undefined
  }
}

// Brings the app's window to the front. Under Wayland a client may not raise itself — the request
// has to come from the compositor — so we ask the Voltage GNOME extension, which IS the shell, to
// activate the window belonging to this app's launcher. The local part (un-minimise, show a hidden
// window) is ours to do and always runs; only the final raise needs the shell. Without the
// extension the gdbus call fails and we fall back to Electron's own focus(), which under GNOME
// usually yields a "ready" marker on the dash icon rather than a real focus change — degraded, but
// never worse than doing nothing.
function activateWindow(win, desktopId) {
  try {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
  } catch { /* window state is best-effort */ }

  if (!desktopId) { try { win.focus() } catch {} ; return }

  execFile('gdbus', [
    'call', '--session',
    '--dest', DBUS_NAME,
    '--object-path', DBUS_PATH,
    '--method', `${DBUS_IFACE}.ActivateApp`,
    desktopId,
  ], { timeout: 2000 }, (err) => {
    if (!err) return
    console.log(TAG, 'shell activation unavailable, falling back to focus():', err.message)
    try { if (!win.isDestroyed()) win.focus() } catch {}
  })
}

function attachPlugin(win, { webContents, desktopId, displayName }) {
  const wc = webContents

  // id (minted by the shim) -> the live Electron notification, so a later close()/replacement can
  // reach it. Entries are removed when the notification closes, so this never grows unbounded.
  const live = new Map()
  // tag -> id of the notification currently occupying that tag. The web spec says a new
  // notification REPLACES the one carrying the same tag (Teams re-uses one tag per conversation);
  // Electron has no tag concept, so we close the predecessor ourselves.
  const byTag = new Map()

  // Tells the page what happened to one of its notifications so the shim can fire the matching
  // event on the JS object the page holds (onclick/onclose). Guarded: the window may be gone.
  const emit = (id, type) => {
    try { if (!wc.isDestroyed()) wc.send(EVENT_CHANNEL, { id, type }) } catch {}
  }

  const drop = (id) => {
    const rec = live.get(id)
    if (!rec) return
    live.delete(id)
    if (rec.tag && byTag.get(rec.tag) === id) byTag.delete(rec.tag)
  }

  // One window per process in practice, but createWindow() runs again when the last window was
  // closed and the app is re-activated — so never stack handlers (mirrors the relay plugin).
  ipcMain.removeHandler(SHOW_CHANNEL)
  ipcMain.handle(SHOW_CHANNEL, (event, payload) => {
    // Only the app's own contents may raise notifications through this bridge.
    if (event.sender !== wc) return false
    const { id, title, body, tag, silent, requireInteraction, icon } = payload || {}
    if (!id || typeof id !== 'string') return false

    // Replace a same-tag predecessor before showing the new one, mirroring the web spec.
    // The page is told explicitly: closing an Electron notification programmatically does not
    // reliably emit its 'close' event on Linux, so without this the replaced notification would
    // linger forever in the page's own list and keep turning up in getNotifications().
    if (tag && byTag.has(tag)) {
      const prevId = byTag.get(tag)
      const prev = live.get(prevId)
      try { prev?.notification.close() } catch {}
      drop(prevId)
      emit(prevId, 'close')
    }

    const image = iconFromDataUrl(icon)
    const notification = new Notification({
      title: String(title || displayName || ''),
      body: String(body || ''),
      silent: !!silent,
      urgency: urgencyFor(requireInteraction),
      // 'never' keeps a requireInteraction notification in GNOME's tray until the user acts.
      timeoutType: requireInteraction ? 'never' : 'default',
      ...(image ? { icon: image } : {}),
    })

    notification.on('click', () => {
      activateWindow(win, desktopId)
      emit(id, 'click')
    })
    notification.on('close', () => { drop(id); emit(id, 'close') })
    notification.on('show',  () => emit(id, 'show'))
    notification.on('failed', (_e, err) => {
      console.log(TAG, 'notification failed:', err)
      drop(id); emit(id, 'error')
    })

    live.set(id, { notification, tag: tag || null })
    if (tag) byTag.set(tag, id)
    notification.show()
    return true
  })

  const onClose = (event, id) => {
    if (event.sender !== wc) return
    const rec = live.get(id)
    if (!rec) return
    try { rec.notification.close() } catch {}
    drop(id)
  }
  ipcMain.on(CLOSE_CHANNEL, onClose)

  // Release both channels with the window, so a re-created window installs a clean pair and a
  // closed window's notifications cannot keep a dead webContents alive. Any notification still on
  // screen is dismissed with it — clicking a toast whose window is gone could only mislead.
  win.once('closed', () => {
    ipcMain.removeHandler(SHOW_CHANNEL)
    ipcMain.removeListener(CLOSE_CHANNEL, onClose)
    for (const { notification } of live.values()) { try { notification.close() } catch {} }
    live.clear(); byTag.clear()
  })

  if (!Notification.isSupported()) {
    console.log(TAG, 'the system reports no notification support — nothing will be shown')
  }
  console.log(TAG, 'attached, desktop-entry =', desktopId || '(none)')
}

// Enables the document-start shim in preload.js. No value is carried: the whole configuration of
// this plugin is "on".
function preloadArgs() {
  return [PRELOAD_ARG]
}

module.exports = {
  attachPlugin, preloadArgs, PRELOAD_ARG, urgencyFor, iconFromDataUrl, MAX_ICON_BYTES,
  SHOW_CHANNEL, CLOSE_CHANNEL, EVENT_CHANNEL,
}
