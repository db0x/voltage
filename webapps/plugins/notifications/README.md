# notifications plugin

Gives an app **working desktop notifications under GNOME**. Electron implements only
*non-persistent* web notifications, so a page's `new Notification()` reaches the desktop but
`ServiceWorkerRegistration.showNotification()` — the path every PWA-style app uses, Teams and
Outlook included — is silently dropped. This plugin re-points that API at the main process, which
raises a real notification. Selected per app; it has no settings dialog.

## What Electron actually does

Measured against the session bus (Electron 42, GNOME 46/Wayland), watching which calls reach
`org.freedesktop.Notifications.Notify`:

| Path | Result |
|---|---|
| main-process `new Notification()` | arrives |
| renderer `new Notification()` | arrives |
| `ServiceWorkerRegistration.showNotification()` | **never arrives** — the promise still resolves |
| `registration.getNotifications()` | **promise never settles** |
| `pushManager.subscribe()` | `AbortError: push service not available` |

The `showNotification()` case is the one that makes Teams and Outlook look mute: nothing errors,
nothing warns, the promise resolves, and no notification is ever shown. `getNotifications()` is
worse than silent — an app that awaits it to de-duplicate or to close a stale toast stalls its own
notification code *before* showing anything, so patching only `showNotification` can still leave an
app quiet.

**The permissions were never the problem.** `notifications` has been in the granted set in
`src/session.js` all along, and `Notification.permission` reads `granted` on a real origin.

## The limit this cannot lift

Electron ships **no push service**, so nothing is delivered while the app is closed. Notifications
can only originate from the running page's own live connection — keeping the app open *is* the
delivery mechanism. There is no background delivery to fix, here or anywhere else.

This is also why the plugin does not try to patch the notification call *inside* the service worker:
without push events that path practically never fires. (It could not be patched anyway — Electron 42
can register a `type: 'service-worker'` preload, but that context is a bare Node sandbox with no
worker globals at all, not even `setTimeout`.)

## How it works

The shim lives in `preload.js` (gated by the `--voltage-notifications` marker this plugin
contributes through `preloadArgs()`) and is installed via `contextBridge.executeInMainWorld`:

1. **`showNotification()`** hands the notification to main over IPC and resolves once main accepts
   it. Main raises an Electron `Notification`, the one path that provably reaches the daemon.
2. **`getNotifications()`** is answered from the shim's own records instead of the native promise
   that never settles.
3. **`new Notification()`** is routed through main as well. It already worked, but going through the
   same path gives both kinds the same GNOME identity and the same click-raises-the-window
   behaviour. If the bridge is ever unavailable it falls back to the native constructor, so a broken
   shim is never worse than no shim.
4. **`tag`** replaces a same-tag predecessor, as the web spec requires (Teams re-uses one tag per
   conversation). Main closes the old notification *and* tells the page, because closing an Electron
   notification programmatically does not reliably emit its `close` event on Linux — without that
   message the replaced entry would linger in `getNotifications()` forever.
5. **`requireInteraction`** maps to freedesktop urgency `critical` + `timeoutType: 'never'`, which is
   what makes GNOME keep a notification up until the user acts on it.

Icons are fetched **in the renderer** and passed as data URLs: an icon URL is usually a same-origin
avatar behind the session cookie, and main has no way to authenticate that request. The fetch is
bounded by size (512 KB) and time (2 s) — an icon is decoration and must never delay the message.

Why `executeInMainWorld` and not a plain assignment: the preload runs in an **isolated world**, so
patching `ServiceWorkerRegistration.prototype` there would only patch our own copy — the page calls
the main world's prototype. Passing the IPC entry points as proxied *arguments* (rather than
exposing a global) means nothing the page can reach ever holds a way to raise desktop notifications.

## Two GNOME-specific pieces outside this directory

**Identity** — GNOME resolves a notification's owning app through the `desktop-entry` hint, which
Electron derives from `app.getName()`. That is the lowercased wm-class form (`vteams`), while the
installed launcher is `vTeams.desktop` and GNOME's lookup is case-sensitive: the hint matched
nothing, so notifications appeared without the app's icon and name and the user's per-app GNOME
notification settings never applied. `src/app-window.js` now calls `app.setDesktopName()`, which sets
that hint independently of the app name. It is still present at runtime in Electron 42, only missing
from the published typings — hence the guard. This fix applies to **every** Voltage app, not just the
ones loading this plugin.

**Raising the window on click** — under Wayland a client may not raise itself; the request has to
come from the compositor. The plugin asks the Voltage GNOME Shell extension over D-Bus
(`de.db0x.Voltage.ActivateApp`, addressed by launcher id) to activate the window. Without the
extension the call fails fast (`ServiceUnknown`) and we fall back to Electron's `focus()`, which
under GNOME usually just marks the dash icon as ready — degraded, never broken. The extension needs
**version 7 or newer**; install it from the Manager's GNOME panel, and note that on Wayland a
re-login is required before GNOME loads the new code.

## Pitfall for plugin authors

The shim is installed **only in the main frame** (`process.isMainFrame`). That is deliberate: the
preload runs in every frame including cross-origin OOPIFs, and patching a page-wide API once per
frame would install several competing copies. Notifications are raised by the top document in every
app this targets.

Everything logs under `[notifications-plugin]` — launch the app from a terminal to see the attach
line with the resolved `desktop-entry`, and any failed notification or shell activation.
