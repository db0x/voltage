// Voltage GNOME Shell extension.
//
// Why this exists: under Wayland an AppImage (Electron) cannot reliably control its own
// window state — it cannot ask the compositor to keep a frameless "widget" window out of
// the taskbar/dash. That decision belongs to the shell, not the client. So we move it here:
// when this extension is active it hides every Voltage widget window from the GNOME dash
// and from dash-to-dock.
//
// How a window is recognised as a widget: the Voltage manager writes a per-app `.desktop`
// launcher into ~/.local/share/applications, and for apps that load the widget plugin it adds
// the marker line `X-Voltage-Widget=true`. That launcher is the single source of truth — it is
// created on install and removed on delete, so scanning it (and watching the directory) keeps
// the hidden set correct without any extra config file or IPC bridge.
//
// How hiding works: both the stock GNOME dash and dash-to-dock build their running-apps list
// from Shell.AppSystem.get_running(). We wrap that one method and drop apps whose .desktop id
// is in the hidden set. The window itself is untouched — it stays focusable and alt-tabbable,
// it just no longer earns a dash/dock icon. We restore the original method on disable.
//
// Second responsibility — window placement for EVERY Voltage app (not only widgets): for the same
// Wayland reason (a client cannot position its own window, only the compositor can), this extension
// remembers each Voltage app window's frame and restores it on the next launch. This is
// deliberately independent of the taskbar/widget setting — it applies to all Voltage AppImages
// whenever the extension is active. The geometry is persisted inside the app's own profile-data
// folder (widget-geometry.json), next to the rest of its data rather than in a shared global file.
//
// Frames are remembered PER MONITOR LAYOUT, and recorded continuously (debounced) rather than only
// on close. That combination is what makes docking work: the positions for the layout you are
// leaving are already on disk when you unplug, so plugging the dock back in can put every window
// back where it was on the dock, and unplugging it restores the laptop-panel positions. A layout
// the app has never been open on falls back to its last known frame, repaired to fit.
// An app is recognised, and its folder located, via the launcher's X-Voltage-ProfileDir line that
// the Manager writes on every Voltage app (override-aware; default-convention fallback). Restore is
// guarded: a saved frame is never reproduced verbatim when the layout has changed under it. One
// that would land off-screen is slid back onto the nearest monitor, and one whose size is no longer
// usable — a monitor/resolution switch can leave Mutter having shrunk the window to its minimum —
// is replaced by a centred default size. A window must never come back invisible, on a monitor that
// no longer exists, or as a speck the user cannot find. The same repair runs on the live windows
// when the monitor layout changes, so a shrunken window is rescued right away rather than at the
// next launch. See geometry.js for the repair rules and profile-id derivation.

// Third responsibility — activating a window on request: under Wayland a client may not raise
// itself, the request has to come from the compositor. A Voltage app that wants to come forward
// (today: the notifications plugin, when the user clicks one of its notifications) therefore asks
// US to do it, over the small D-Bus interface below. Without this extension the app can only call
// Electron's focus(), which under GNOME usually just marks the dash icon as "ready".

import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Shell from 'gi://Shell'

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'

import { sanitizeRect, profileFromDesktopId, planWidgetReposition, isCycleAbnormalState, centerRectIn,
         resolveRestoreFrame, isUsableSize, rectsEqual, layoutSignature, readGeometry, writeGeometry } from './geometry.js'

// Window title the Voltage app sets ONLY on its transient "app unavailable" notice window (see
// src/notice/window.js — NOTICE_WINDOW_TITLE there). It is a stable, non-localized sentinel, never
// shown to the user (the window is frameless + skip-taskbar), so the shell can recognise that one
// window and centre it without confusing it for the Manager window (which shares the WM class).
const NOTICE_WINDOW_TITLE = 'voltage-notice'

// Directory holding the user's .desktop launchers — the Voltage manager installs app
// launchers here, and this is what we scan/watch.
const APPLICATIONS_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'applications'])

// Filename, inside a Voltage app's profile folder, that stores its last window geometry. Named for
// historical reasons (the feature began with widgets); it now applies to every Voltage app.
const GEOMETRY_FILE = 'widget-geometry.json'

// How long to wait after a monitor/resolution change before repairing window frames. Mutter emits
// several monitors-changed signals for one plug event and keeps re-fitting windows for a moment
// afterwards; repairing earlier would simply be overwritten by the compositor's own re-fit.
const LAYOUT_SETTLE_MS = 800

// How long a window must sit still before its frame is written to disk. Debouncing keeps a drag
// from causing a write per pointer motion, while still getting the frame persisted long before the
// user unplugs a monitor — which is what makes the outgoing layout's positions survive the switch.
const FRAME_PERSIST_DEBOUNCE_MS = 2000

// D-Bus surface a running Voltage app uses to ask the shell to bring one of its windows forward.
// The app addresses itself by its launcher id ("vTeams.desktop") — the same identity this
// extension already keys every app by — so no extra handshake or pid tracking is needed.
const DBUS_NAME = 'de.db0x.Voltage'
const DBUS_PATH = '/de/db0x/Voltage'
const DBUS_IFACE = `
<node>
  <interface name="de.db0x.Voltage">
    <method name="ActivateApp">
      <arg type="s" direction="in"  name="desktopId"/>
      <arg type="b" direction="out" name="activated"/>
    </method>
  </interface>
</node>`

export default class VoltageExtension extends Extension {
  enable() {
    this._appSystem = Shell.AppSystem.get_default()
    // App ids (e.g. "vClaude.desktop") that must be kept out of the dash/dock (widgets only).
    this._hiddenIds = new Set()
    // App id -> profile-data folder, for EVERY Voltage app, where its window geometry is persisted.
    // Filled by the same launcher scan as _hiddenIds. Must exist before the scan runs.
    this._appProfileDirs = new Map()
    this._scanLaunchers()

    // Wrap get_running so the dash/dock never see the hidden apps. We keep `self` in scope
    // because the override runs with the AppSystem as `this`; the live Set reference means a
    // rescan is picked up without re-patching.
    const self = this
    this._origGetRunning = Shell.AppSystem.prototype.get_running
    Shell.AppSystem.prototype.get_running = function () {
      const running = self._origGetRunning.call(this)
      if (self._hiddenIds.size === 0) return running
      return running.filter(app => !self._hiddenIds.has(app.get_id()))
    }

    // The launcher set changes when the user installs/removes a Voltage app or toggles the
    // widget plugin (a rewrite of the .desktop file). Watch the directory and rescan on change.
    this._monitor = Gio.File.new_for_path(APPLICATIONS_DIR)
      .monitor_directory(Gio.FileMonitorFlags.NONE, null)
    this._monitorId = this._monitor.connect('changed', () => this._onLaunchersChanged())

    // Apply immediately to anything already running (e.g. a widget app open before enable).
    this._refreshShell()

    // --- Widget window placement -------------------------------------------------------------
    this._tracker = Shell.WindowTracker.get_default()
    // win -> array of per-window handler ids, so every per-window signal is disconnected on disable.
    this._trackedWindows = new Map()
    // win -> F11 cycle state of a widget window. Kept out of the closure that creates it so the
    // layout-change repair can correct a remembered frame that the new layout invalidated.
    this._widgetStates = new Map()
    // win -> app id, so the layout switch can look up each window's remembered frame.
    this._windowApps = new Map()
    // win -> { appId, rect }: where each tracked window currently sits under the active layout.
    // Held in memory and flushed debounced, because the frames that matter for a monitor switch
    // are the ones from BEFORE it — they have to be on disk by the time the switch happens.
    this._lastFrames = new Map()
    // Pending settle timer of the layout switch, and pending debounced disk write (0 = none).
    this._settleId = 0
    this._flushId = 0
    // True from the first monitors-changed signal until the compositor has settled: frames
    // reported in that window belong to no layout and must not be recorded.
    this._layoutBusy = false
    // Key every frame is stored under. Resolved before the first window is tracked.
    this._layoutSignature = this._currentLayoutSignature()
    this._windowCreatedId = global.display.connect('window-created', (_d, win) => this._onWindowCreated(win))
    // A monitor being plugged/unplugged or a resolution switch is the one event that changes a
    // window's frame without the user asking: Mutter re-fits windows to the new layout and can
    // leave one shrunk to its minimum, somewhere the user will not find it — and it never puts
    // them back when the old layout returns. So we switch to the new layout's remembered
    // positions ourselves, instead of waiting for the next launch.
    this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._onMonitorsChanged())
    // Attach the save-on-close handler to Voltage windows already open at enable time (e.g. after a
    // shell restart). We do NOT reposition them — they are already placed and moving them would be
    // surprising; restore only ever applies to windows created from here on.
    for (const actor of global.get_window_actors()) {
      this._trackAppWindow(actor.meta_window)
    }

    // --- Window activation on request --------------------------------------------------------
    // Exported last so the interface only appears once the rest of the extension is live. Owning
    // the name is what lets a client fail fast (gdbus reports "name has no owner") and fall back
    // to its own focus() when this extension is not installed or not enabled.
    this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE, this)
    this._dbusImpl.export(Gio.DBus.session, DBUS_PATH)
    this._dbusNameId = Gio.bus_own_name(
      Gio.BusType.SESSION, DBUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null)
  }

  disable() {
    if (this._origGetRunning) {
      Shell.AppSystem.prototype.get_running = this._origGetRunning
      this._origGetRunning = null
    }
    if (this._monitor) {
      this._monitor.disconnect(this._monitorId)
      this._monitor.cancel()
      this._monitor = null
    }
    this._hiddenIds = null
    this._appProfileDirs = null
    // Bring the previously hidden icons back now that filtering is off.
    this._refreshShell()
    this._appSystem = null

    // Tear down widget window placement: stop listening for new windows and drop every per-window
    // handler. Persisted geometry stays on disk so positions survive across enable/disable.
    if (this._windowCreatedId) {
      global.display.disconnect(this._windowCreatedId)
      this._windowCreatedId = null
    }
    if (this._monitorsChangedId) {
      Main.layoutManager.disconnect(this._monitorsChangedId)
      this._monitorsChangedId = null
    }
    if (this._settleId) {
      GLib.source_remove(this._settleId)
      this._settleId = 0
    }
    // Flush synchronously before dropping the timer: a disable (or a shell restart) must not lose
    // the positions of windows that are still open.
    if (this._flushId) {
      GLib.source_remove(this._flushId)
      this._flushId = 0
      this._flushFrames()
    }
    this._widgetStates = null
    this._windowApps = null
    this._lastFrames = null
    if (this._trackedWindows) {
      for (const [win, ids] of this._trackedWindows) {
        for (const id of ids) { try { win.disconnect(id) } catch { /* window already gone */ } }
      }
      this._trackedWindows.clear()
      this._trackedWindows = null
    }
    this._tracker = null

    // Drop the D-Bus surface. Unowning the name is what makes a client's call fail immediately
    // (and fall back) instead of waiting for a service that is no longer listening.
    if (this._dbusNameId) {
      Gio.bus_unown_name(this._dbusNameId)
      this._dbusNameId = null
    }
    if (this._dbusImpl) {
      try { this._dbusImpl.unexport() } catch { /* already gone */ }
      this._dbusImpl = null
    }
  }

  // D-Bus: bring the given Voltage app's most recently used window to the front. Returns false —
  // rather than throwing — when the app is unknown or has no window, so a caller that raced a
  // closing window just learns the activation did not happen.
  //
  // Shell.App.get_windows() is ordered most-recently-used first, which is the window the user
  // means when an app has several open. We deliberately do NOT fall back to app.activate(): that
  // would LAUNCH the app if it had no windows, and a notification click must never start anything.
  ActivateApp(desktopId) {
    try {
      const app = this._appSystem?.lookup_app(desktopId)
      const windows = app?.get_windows?.() ?? []
      if (!windows.length) return false
      Main.activateWindow(windows[0])
      return true
    } catch {
      return false
    }
  }

  // Rebuild the hidden set, then nudge the shell to redisplay so a freshly added/removed
  // widget app appears/disappears without waiting for the next unrelated app-state change.
  _onLaunchersChanged() {
    this._scanLaunchers()
    this._refreshShell()
  }

  // Scan ~/.local/share/applications and, from each Voltage launcher, populate two maps:
  //  - _hiddenIds: apps carrying X-Voltage-Widget=true, kept out of the dash/dock (widgets only).
  //  - _appProfileDirs: EVERY Voltage app -> its profile-data folder, used for window placement.
  // A launcher counts as a Voltage app when it carries the X-Voltage-ProfileDir line (written on
  // every app) or the legacy widget marker; this is what stops us tracking unrelated "v*.desktop"
  // launchers. Errors (unreadable file, missing directory) are non-fatal — a launcher we cannot
  // read is simply not tracked, the safe default.
  _scanLaunchers() {
    this._hiddenIds.clear()
    this._appProfileDirs?.clear()
    let dir
    try {
      dir = Gio.File.new_for_path(APPLICATIONS_DIR)
        .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)
    } catch {
      return
    }
    let info
    while ((info = dir.next_file(null)) !== null) {
      const name = info.get_name()
      if (!name.endsWith('.desktop')) continue
      const path = GLib.build_filenamev([APPLICATIONS_DIR, name])
      try {
        const [ok, bytes] = GLib.file_get_contents(path)
        if (!ok) continue
        const text = new TextDecoder().decode(bytes)
        // Match each marker as a full key=value line so a value substring elsewhere can't trip it.
        const isWidget = /^X-Voltage-Widget=true\s*$/m.test(text)
        const pd = /^X-Voltage-ProfileDir=(.+?)\s*$/m.exec(text)
        if (isWidget) this._hiddenIds.add(name)
        if (pd || isWidget) {
          // Prefer the explicit (override-aware) path; fall back to the default convention for a
          // legacy widget launcher written before the profile-dir line existed.
          const profileDir = pd ? pd[1] : this._defaultProfileDir(name)
          if (profileDir) this._appProfileDirs?.set(name, profileDir)
        }
      } catch {
        // ignore this launcher
      }
    }
    dir.close(null)
  }

  // Default profile-data folder for a Voltage launcher whose explicit X-Voltage-ProfileDir line is
  // absent (older launchers): <config>/voltage/<profile>, profile derived from the launcher id
  // (vMastodon.desktop -> mastodon). Null for an id that doesn't follow the artifact convention.
  _defaultProfileDir(desktopId) {
    const profile = profileFromDesktopId(desktopId)
    return profile
      ? GLib.build_filenamev([GLib.get_user_config_dir(), 'voltage', profile])
      : null
  }

  // Both the stock dash and dash-to-dock rebuild their lists on AppSystem's installed-changed
  // signal, so re-emitting it is the compositor-agnostic way to force a redisplay through our
  // get_running override. Guarded because emitting is best-effort cosmetic refresh.
  _refreshShell() {
    try {
      this._appSystem?.emit('installed-changed')
    } catch {
      // A failed refresh only delays the visual update until the next natural redisplay.
    }
  }

  // A trackable window is one whose backing app is a known Voltage app — i.e. its app id is in the
  // _appProfileDirs map (every Voltage app, widget or not). Returns that id, or null for any non-
  // Voltage (or not-yet-associated) window. The association is resolved lazily at call time because
  // under Wayland a window's app id is not reliably known the instant the window is created.
  _voltageAppIdForWindow(win) {
    if (!win || !this._appProfileDirs) return null
    const id = this._tracker?.get_window_app(win)?.get_id?.()
    return id && this._appProfileDirs.has(id) ? id : null
  }

  // On creation we cannot yet trust the window's geometry or its app association, so we wait for
  // the actor's first paint and only then restore + start tracking. If no actor exists yet (rare)
  // we fall back to a single idle tick rather than miss the window entirely.
  _onWindowCreated(win) {
    const actor = win.get_compositor_private()
    if (actor) {
      const id = actor.connect('first-frame', () => {
        actor.disconnect(id)
        this._onWindowReady(win)
      })
    } else {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._onWindowReady(win)
        return GLib.SOURCE_REMOVE
      })
    }
  }

  // First moment we can trust the window's title and geometry. The transient notice window only
  // needs centring and must NOT be tracked for geometry (it has no per-app identity); every other
  // Voltage app window takes the normal restore + save-on-close path.
  _onWindowReady(win) {
    if (this._isNoticeWindow(win)) {
      this._centerWindow(win)
      return
    }
    this._restoreAndTrack(win)
  }

  // The notice window is identified by its sentinel title (set in src/notice/window.js). Matching on
  // title — rather than WM class — is what separates it from the Manager window, which shares the
  // 'voltage' WM class but carries a different title.
  _isNoticeWindow(win) {
    try { return win?.get_title() === NOTICE_WINDOW_TITLE } catch { return false }
  }

  // Centre the notice on the monitor GNOME placed it on. The shell IS the compositor, so move_frame
  // positions the toplevel even under Wayland — exactly the capability a client lacks, which is why
  // centring the notice has to happen here rather than in the Electron process.
  _centerWindow(win) {
    const areas = this._workAreas()
    const area = areas[win.get_monitor()] ?? areas[0]
    const target = area && centerRectIn(area, win.get_frame_rect())
    if (target) win.move_frame(true, target.x, target.y)
  }

  // Restore a freshly shown Voltage window to its saved frame, then track it for save-on-close.
  _restoreAndTrack(win) {
    const appId = this._voltageAppIdForWindow(win)
    if (!appId) return
    this._restoreWindow(win, appId)
    this._trackAppWindow(win, appId)
  }

  // Connect the save-on-close handler exactly once per window. `appId` is passed in on the
  // creation path where it is already resolved; otherwise it is resolved here (enable-time
  // existing windows).
  _trackAppWindow(win, appId = this._voltageAppIdForWindow(win)) {
    if (!appId || !this._trackedWindows || this._trackedWindows.has(win)) return
    const handlerIds = []
    // 'unmanaging' fires while the window is still managed, so its frame rect is still valid here;
    // 'unmanaged' would be too late to read geometry. Persisting on close means the latest
    // position always wins.
    handlerIds.push(win.connect('unmanaging', () => {
      this._saveWindowGeometry(win, appId)
      this._untrackWindow(win)
    }))

    // Widget windows are frameless and use the F11 windowed→maximized→fullscreen→windowed cycle.
    // Under Wayland the client cannot restore its own position when it returns to windowed (the size
    // comes back but the compositor drops it at the wrong spot — "falsche Position"), so we remember
    // the windowed frame here and move the window back once it leaves maximized/fullscreen.
    const state = this._hiddenIds?.has(appId)
      ? { lastNormalFrame: sanitizeRect(win.get_frame_rect()), abnormal: this._isAbnormal(win) }
      : null
    if (state) this._widgetStates?.set(win, state)

    // One handler for both jobs, so a window never carries two sets of frame signals: the widget
    // F11 reposition (widgets only) and the frame recording that feeds the per-layout memory (all
    // Voltage apps). Recording on every move/resize — not only on close — is what lets the frames
    // of the OUTGOING layout already be on disk by the time a monitor is unplugged.
    const onFrameChanged = () => {
      if (state) this._repositionWidget(win, state)
      this._recordFrame(win, appId)
    }
    handlerIds.push(win.connect('size-changed', onFrameChanged))
    handlerIds.push(win.connect('position-changed', onFrameChanged))

    this._windowApps?.set(win, appId)
    this._trackedWindows.set(win, handlerIds)
    // Seed the memory with where the window is right now, so a window that is opened and never
    // touched again still has a frame recorded for this layout.
    this._recordFrame(win, appId)
  }

  // Disconnect every per-window handler and stop tracking the window.
  _untrackWindow(win) {
    const ids = this._trackedWindows?.get(win)
    if (!ids) return
    for (const id of ids) { try { win.disconnect(id) } catch { /* already gone */ } }
    this._trackedWindows.delete(win)
    this._widgetStates?.delete(win)
    this._windowApps?.delete(win)
    this._lastFrames?.delete(win)
  }

  // Whether the window is in a state the F11 cycle passes through (full maximize / fullscreen) —
  // NOT an edge-tiled (half-snapped) window, which is a windowed placement we must restore to. See
  // isCycleAbnormalState for why a partial maximize must not count here.
  _isAbnormal(win) {
    try { return isCycleAbnormalState(win.is_fullscreen(), win.get_maximized()) } catch { return false }
  }

  // On a widget window's frame change, run the pure state machine; when it asks for a restore, move
  // the window to the repaired version of its remembered windowed frame — the remembered frame may
  // predate a layout change, and restoring it verbatim is what used to strand a widget off-screen
  // or at a size it cannot be grabbed by.
  _repositionWidget(win, state) {
    const planned = planWidgetReposition(state, this._isAbnormal(win), win.get_frame_rect())
    if (!planned) return
    const target = resolveRestoreFrame(planned, this._workAreas())
    if (!target) return
    state.lastNormalFrame = target
    win.move_resize_frame(false, target.x, target.y, target.width, target.height)
  }

  // Put the window back where it last was ON THIS MONITOR LAYOUT (falling back to its last known
  // frame for a layout it has never been open on). The frame is run through the repair rules
  // first: one that no longer fits is slid back on screen instead of being reproduced off-screen,
  // and one whose *size* is unusable (a layout change had shrunk the window to its minimum) is
  // replaced by a centred default. Never restore a window into a state the user cannot see or
  // grab — that is worse than ignoring the saved frame.
  _restoreWindow(win, appId) {
    const saved = readGeometry(this._loadGeometry(appId), appId, this._layoutSignature)
    const target = resolveRestoreFrame(saved, this._workAreas())
    if (!target) return
    win.move_resize_frame(false, target.x, target.y, target.width, target.height)
  }

  // Persist the window's current frame into its app's profile folder, keyed by app id. The id key
  // (rather than a bare rect) keeps things correct in the rare case two launchers share a profile
  // folder. Invalid rects are dropped rather than stored, so a bad value can never be restored.
  //
  // A frame below the usable minimum is dropped too, keeping the previously saved (good) one: a
  // window closed while the compositor had it shrunk to its minimum — the usual aftermath of a
  // monitor switch — must not overwrite the size the user actually chose.
  _saveWindowGeometry(win, appId) {
    const rect = sanitizeRect(win.get_frame_rect())
    if (!rect || !isUsableSize(rect)) return
    this._storeGeometry(appId, rect)
  }

  // Write one app's frame into its geometry file, under the current layout and as the flat
  // fallback (see writeGeometry). Read-modify-write per call: the file is tiny and written rarely
  // (debounced), and re-reading is what keeps two windows of the same app from clobbering entries
  // the other one wrote.
  _storeGeometry(appId, rect) {
    const path = this._geometryPathFor(appId)
    if (!path) return
    this._persistGeometry(path, writeGeometry(this._loadGeometry(appId), appId, this._layoutSignature, rect))
  }

  // Remember where a window currently sits, for the layout currently in effect. Only sane frames
  // count: a minimized, maximized or fullscreen window has no placement of its own to remember,
  // and a sub-minimum frame is the compositor's doing rather than the user's.
  //
  // Suppressed entirely while a layout change is in flight (_layoutBusy): between unplugging a
  // monitor and the compositor settling, every frame Mutter reports belongs to no layout in
  // particular, and recording those is exactly how the positions of the outgoing layout get lost.
  _recordFrame(win, appId) {
    if (this._layoutBusy || !this._lastFrames) return
    let rect
    try {
      if (win.minimized || this._isAbnormal(win)) return
      rect = sanitizeRect(win.get_frame_rect())
    } catch {
      return
    }
    if (!rect || !isUsableSize(rect)) return
    const known = this._lastFrames.get(win)
    if (known && rectsEqual(known.rect, rect)) return
    this._lastFrames.set(win, { appId, rect })
    this._scheduleFlush()
  }

  // Debounce the disk write: a drag emits a frame change per pointer motion, and the position that
  // matters is the one the window is left at. The delay also has to stay well below how long a
  // window typically sits still before the user unplugs a monitor — otherwise the outgoing
  // layout's frames would not have reached disk yet when the switch happens.
  _scheduleFlush() {
    if (this._flushId) GLib.source_remove(this._flushId)
    this._flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, FRAME_PERSIST_DEBOUNCE_MS, () => {
      this._flushId = 0
      this._flushFrames()
      return GLib.SOURCE_REMOVE
    })
  }

  // Persist every recorded frame. Collapsed per app first, so an app with several windows causes
  // one write rather than one per window (the file is keyed by app id, so the last window wins —
  // the same rule that has always applied to save-on-close).
  _flushFrames() {
    if (!this._lastFrames?.size) return
    const perApp = new Map()
    for (const { appId, rect } of this._lastFrames.values()) perApp.set(appId, rect)
    for (const [appId, rect] of perApp) this._storeGeometry(appId, rect)
  }

  // Coalesce the burst of monitors-changed signals one plug/resolution event produces, then apply
  // the new layout once the compositor has settled. Restarting the timer on every signal means a
  // rapid sequence (dock plugged in, several outputs appearing) counts as a single layout change.
  _onMonitorsChanged() {
    // Stop recording immediately, and drop both the pending write and the in-memory frames: by the
    // time this signal arrives Mutter may already have re-fitted the windows, so what is in
    // _lastFrames can be the compositor's doing rather than the user's placement — writing it would
    // overwrite the outgoing layout's good positions with the re-fitted ones. Those good positions
    // were already flushed FRAME_PERSIST_DEBOUNCE_MS after the user last touched the window, which
    // is why dropping them here is safe: the only thing lost is a move made seconds before the
    // switch.
    this._layoutBusy = true
    if (this._flushId) { GLib.source_remove(this._flushId); this._flushId = 0 }
    this._lastFrames?.clear()

    if (this._settleId) GLib.source_remove(this._settleId)
    this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LAYOUT_SETTLE_MS, () => {
      this._settleId = 0
      this._applyLayout()
      return GLib.SOURCE_REMOVE
    })
  }

  // The compositor has settled on a new monitor arrangement: switch to that layout's remembered
  // positions. Every tracked window goes back to the frame it last had on THIS layout — plugging
  // the dock back in puts the windows where they were on the dock, unplugging it puts them where
  // they were on the laptop panel. A window with nothing remembered for this layout is merely
  // repaired (kept usable and on screen) rather than moved somewhere arbitrary.
  //
  // Maximized, fullscreen and minimized windows are skipped: their frame is not a placement we own,
  // and moving them would un-maximize or otherwise surprise the user.
  _applyLayout() {
    this._layoutSignature = this._currentLayoutSignature()
    this._layoutBusy = false
    if (!this._trackedWindows) return
    const areas = this._workAreas()
    if (!areas.length) return
    // Geometry is stored per app, not per window, so the remembered frame is handed to the first
    // window of an app only — otherwise a second window of the same app would be stacked exactly
    // on top of the first. The others are simply kept usable where they are.
    const placed = new Set()
    for (const win of this._trackedWindows.keys()) {
      try {
        if (win.minimized || this._isAbnormal(win)) continue
        const appId = this._windowApps?.get(win)
        const current = sanitizeRect(win.get_frame_rect())
        const saved = appId && !placed.has(appId)
          ? readGeometry(this._loadGeometry(appId), appId, this._layoutSignature)
          : null
        if (saved && appId) placed.add(appId)
        const target = resolveRestoreFrame(saved ?? current, areas)
        if (!target) continue
        if (!rectsEqual(target, current))
          win.move_resize_frame(false, target.x, target.y, target.width, target.height)
        // Keep the F11 cycle's restore target in sync, otherwise the next return-to-windowed would
        // undo this by moving the widget back to its pre-layout-change frame.
        const state = this._widgetStates?.get(win)
        if (state) state.lastNormalFrame = target
        if (appId) this._lastFrames?.set(win, { appId, rect: target })
      } catch {
        // A window that vanished mid-loop simply needs no placement.
      }
    }
  }

  // Signature of the monitor arrangement in effect right now — the key everything is stored under.
  // Built from monitor geometry rather than work areas on purpose; see layoutSignature.
  _currentLayoutSignature() {
    try {
      const monitors = []
      const n = global.display.get_n_monitors()
      for (let i = 0; i < n; i++) monitors.push(global.display.get_monitor_geometry(i))
      return layoutSignature(monitors)
    } catch {
      // No signature means the flat, layout-agnostic entry is used — the pre-layouts behaviour.
      return null
    }
  }

  // Absolute path to an app's geometry file inside its profile folder, or null when the folder is
  // unknown (non-Voltage app, or a launcher we could not resolve) — in which case we neither
  // restore nor persist, and the window is simply placed normally.
  _geometryPathFor(appId) {
    const dir = this._appProfileDirs?.get(appId)
    return dir ? GLib.build_filenamev([dir, GEOMETRY_FILE]) : null
  }

  // Usable area (panel-excluded) of every current monitor, in stage coordinates — the reference
  // the visibility check validates a saved frame against. Reading the active workspace's work
  // areas (rather than raw monitor geometry) keeps a restored widget clear of the panel.
  _workAreas() {
    const areas = []
    const ws = global.workspace_manager?.get_active_workspace()
    if (!ws) return areas
    const n = global.display.get_n_monitors()
    for (let i = 0; i < n; i++) {
      const r = ws.get_work_area_for_monitor(i)
      areas.push({ x: r.x, y: r.y, width: r.width, height: r.height })
    }
    return areas
  }

  // Read the persisted geometry map from a widget's profile folder. Any problem (unknown folder,
  // missing file, bad JSON) yields an empty map — the safe default meaning "no saved position yet".
  _loadGeometry(appId) {
    const path = this._geometryPathFor(appId)
    if (!path) return {}
    try {
      const [ok, bytes] = GLib.file_get_contents(path)
      if (!ok) return {}
      const data = JSON.parse(new TextDecoder().decode(bytes))
      return data && typeof data === 'object' ? data : {}
    } catch {
      return {}
    }
  }

  // Write the geometry map. Best-effort: a failed write only means the next launch falls back to
  // normal placement, never a crash. The profile folder already exists (the running app created
  // it), but mkdir_with_parents keeps this safe if it somehow does not.
  _persistGeometry(path, data) {
    try {
      GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700)
      GLib.file_set_contents(path, JSON.stringify(data))
    } catch {
      // ignore — persistence is best-effort
    }
  }
}
