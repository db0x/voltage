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

import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Shell from 'gi://Shell'

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'

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
}
