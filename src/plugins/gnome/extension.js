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
// Second responsibility — widget window placement: for the same Wayland reason (a client cannot
// position its own window, only the compositor can), this extension remembers each widget
// window's frame when it closes and restores it on the next launch. The geometry is persisted to
// an XDG state file keyed by the .desktop id. Restore is guarded: if the monitor layout changed
// so the saved frame would land off-screen, we skip it and let GNOME place the window normally —
// a widget must never vanish into a monitor that no longer exists. See geometry.js for the rule.

import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Shell from 'gi://Shell'

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'

import { isRectVisible, sanitizeRect } from './geometry.js'

// Directory holding the user's .desktop launchers — the Voltage manager installs app
// launchers here, and this is what we scan/watch.
const APPLICATIONS_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'applications'])

export default class VoltageExtension extends Extension {
  enable() {
    this._appSystem = Shell.AppSystem.get_default()
    // App ids (e.g. "vClaude.desktop") that must be kept out of the dash/dock.
    this._hiddenIds = new Set()
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
    // Persisted under XDG *state* (not config): this is recoverable window state, and keeping it
    // out of ~/.config avoids any clash with the Electron app's own userData directory.
    this._geometryPath = GLib.build_filenamev([GLib.get_user_state_dir(), 'voltage', 'widget-geometry.json'])
    this._geometry = this._loadGeometry()
    // win -> 'unmanaging' handler id, so every per-window signal is disconnected on disable.
    this._trackedWindows = new Map()
    this._windowCreatedId = global.display.connect('window-created', (_d, win) => this._onWindowCreated(win))
    // Attach the save-on-close handler to widget windows already open at enable time (e.g. after a
    // shell restart). We do NOT reposition them — they are already placed and moving them would be
    // surprising; restore only ever applies to windows created from here on.
    for (const actor of global.get_window_actors()) {
      this._trackWidgetWindow(actor.meta_window)
    }
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
    // Bring the previously hidden icons back now that filtering is off.
    this._refreshShell()
    this._appSystem = null

    // Tear down widget window placement: stop listening for new windows and drop every per-window
    // handler. Persisted geometry stays on disk so positions survive across enable/disable.
    if (this._windowCreatedId) {
      global.display.disconnect(this._windowCreatedId)
      this._windowCreatedId = null
    }
    if (this._trackedWindows) {
      for (const [win, id] of this._trackedWindows) {
        try { win.disconnect(id) } catch { /* window already gone */ }
      }
      this._trackedWindows.clear()
      this._trackedWindows = null
    }
    this._tracker = null
    this._geometry = null
  }

  // Rebuild the hidden set, then nudge the shell to redisplay so a freshly added/removed
  // widget app appears/disappears without waiting for the next unrelated app-state change.
  _onLaunchersChanged() {
    this._scanLaunchers()
    this._refreshShell()
  }

  // Populate _hiddenIds from every *.desktop launcher carrying the X-Voltage-Widget marker.
  // Errors (unreadable file, missing directory) are non-fatal — a launcher we cannot read
  // simply is not hidden, which is the safe default.
  _scanLaunchers() {
    this._hiddenIds.clear()
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
        // Match the marker as a full key=value line so a value substring elsewhere can't trip it.
        if (/^X-Voltage-Widget=true\s*$/m.test(text)) this._hiddenIds.add(name)
      } catch {
        // ignore this launcher
      }
    }
    dir.close(null)
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

  // A widget window is one whose backing app carries the X-Voltage-Widget marker — i.e. its app
  // id is already in the hidden set the dash filter maintains, so the two features share one
  // source of truth. Returns that id, or null for any non-widget (or not-yet-associated) window.
  // The association is resolved lazily at call time because under Wayland a window's app id is
  // not reliably known the instant the window is created.
  _widgetIdForWindow(win) {
    if (!win || !this._hiddenIds) return null
    const id = this._tracker?.get_window_app(win)?.get_id?.()
    return id && this._hiddenIds.has(id) ? id : null
  }

  // On creation we cannot yet trust the window's geometry or its app association, so we wait for
  // the actor's first paint and only then restore + start tracking. If no actor exists yet (rare)
  // we fall back to a single idle tick rather than miss the window entirely.
  _onWindowCreated(win) {
    const actor = win.get_compositor_private()
    if (actor) {
      const id = actor.connect('first-frame', () => {
        actor.disconnect(id)
        this._restoreAndTrack(win)
      })
    } else {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._restoreAndTrack(win)
        return GLib.SOURCE_REMOVE
      })
    }
  }

  // Restore a freshly shown widget window to its saved frame, then track it for save-on-close.
  _restoreAndTrack(win) {
    const appId = this._widgetIdForWindow(win)
    if (!appId) return
    this._restoreWindow(win, appId)
    this._trackWidgetWindow(win, appId)
  }

  // Connect the save-on-close handler exactly once per window. `appId` is passed in on the
  // creation path where it is already resolved; otherwise it is resolved here (enable-time
  // existing windows).
  _trackWidgetWindow(win, appId = this._widgetIdForWindow(win)) {
    if (!appId || !this._trackedWindows || this._trackedWindows.has(win)) return
    // 'unmanaging' fires while the window is still managed, so its frame rect is still valid here;
    // 'unmanaged' would be too late to read geometry. Persisting on close means the latest
    // position always wins.
    const handlerId = win.connect('unmanaging', () => {
      this._saveWindowGeometry(win, appId)
      try { win.disconnect(handlerId) } catch { /* already gone */ }
      this._trackedWindows?.delete(win)
    })
    this._trackedWindows.set(win, handlerId)
  }

  // Put the window back exactly where it last closed — but only if that frame still lands on
  // usable screen space. When the monitor layout has changed so the saved frame would be off-
  // screen, we deliberately do nothing and let GNOME place the window normally, so a widget can
  // never disappear into a non-existent monitor (the whole point of the visibility guard).
  _restoreWindow(win, appId) {
    const saved = this._geometry?.[appId]
    if (!saved) return
    if (!isRectVisible(saved, this._workAreas())) return
    win.move_resize_frame(false, saved.x, saved.y, saved.width, saved.height)
  }

  // Persist the window's current frame under its app id. Invalid rects are dropped rather than
  // stored, so a bad value can never be restored later.
  _saveWindowGeometry(win, appId) {
    const rect = sanitizeRect(win.get_frame_rect())
    if (!rect || !this._geometry) return
    this._geometry[appId] = rect
    this._persistGeometry()
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

  // Read the persisted geometry map. Any problem (missing file, bad JSON) yields an empty map —
  // the safe default that simply means "no saved positions yet".
  _loadGeometry() {
    try {
      const [ok, bytes] = GLib.file_get_contents(this._geometryPath)
      if (!ok) return {}
      const data = JSON.parse(new TextDecoder().decode(bytes))
      return data && typeof data === 'object' ? data : {}
    } catch {
      return {}
    }
  }

  // Write the geometry map. Best-effort: a failed write only means the next launch falls back to
  // normal placement, never a crash.
  _persistGeometry() {
    try {
      GLib.mkdir_with_parents(GLib.path_get_dirname(this._geometryPath), 0o700)
      GLib.file_set_contents(this._geometryPath, JSON.stringify(this._geometry))
    } catch {
      // ignore — persistence is best-effort
    }
  }
}
