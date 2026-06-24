// Generic indirection launcher for Voltage app .desktop entries.
//
// Why this module exists: GIO (g_desktop_app_info_new_from_filename) drops a desktop entry ENTIRELY
// when the binary named in its Exec= key cannot be resolved on disk. If an app's AppImage lives in
// an encrypted/locked project directory, that path disappears while the directory is locked, so
// GNOME silently removes the launcher — and does NOT restore it after unlocking, because the app
// index is cached until the .desktop file itself changes (verified: a passing TryExec= does not
// override the missing-Exec drop). The user then has to reinstall the app to get the starter back.
//
// The fix is indirection: every Voltage .desktop points its Exec= at ONE shared launcher script that
// always lives in the unencrypted home. GIO can therefore always resolve the binary and keeps the
// entry visible regardless of the AppImage's directory state. The real AppImage path is passed as
// the launcher's first argument and only touched at click time, so a still-locked project yields a
// helpful notification instead of a vanished starter.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// XDG_DATA_HOME (default ~/.local/share) keeps the script in the user's data tree, next to other
// installed Voltage artifacts (the private icon theme) and guaranteed outside any encrypted project.
function launcherDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'voltage')
}

// Absolute path to the shared launcher. The .desktop Exec= references this path directly, so it must
// never move once installed entries point at it.
function launcherPath() {
  return path.join(launcherDir(), 'voltage-launch')
}

// The launcher itself. Self-contained POSIX sh so it has no runtime dependency on Node/Electron and
// works even while the app's own files are unreachable. DE/EN message is picked from $LANG because a
// standalone launcher cannot read the Electron app's i18n bundle.
const LAUNCHER_SCRIPT = `#!/bin/sh
# voltage-launch — generic indirection launcher for Voltage app .desktop entries.
# Managed by Voltage; do not edit (reinstalling an app overwrites this file).
#
# Usage (from a .desktop Exec=): voltage-launch <appimage-path> [args...]
#
# Why: GIO removes a .desktop entry whose Exec= binary cannot be resolved. Pointing Exec= at this
# always-present script (instead of the AppImage directly) keeps the launcher visible even when the
# AppImage's directory is encrypted/locked, and lets us report that case instead of vanishing.
set -eu

APP="\${1:-}"
[ -n "$APP" ] && shift || true

if [ ! -x "$APP" ]; then
  # AppImage unreachable: most commonly its project directory is still encrypted / not unlocked.
  # Inform the user in their language rather than failing silently (GNOME would otherwise show a
  # bare "could not launch" or nothing at all).
  name=$(basename "\${APP:-?}")
  case "\${LANG:-}" in
    de*) title="Voltage"; body="$name lässt sich nicht starten – liegt das Projektverzeichnis evtl. noch verschlüsselt/gesperrt vor?" ;;
    *)   title="Voltage"; body="$name could not be started – is its project directory still encrypted/locked?" ;;
  esac
  notify-send -i dialog-warning "$title" "$body" 2>/dev/null || true
  exit 127
fi

exec "$APP" "$@"
`

// Writes the launcher to disk (idempotent) and returns its path. Rewrites only when the content
// differs so we do not needlessly bump the file's mtime on every install, but always repairs a
// missing/outdated copy. chmod 0o755 is required: GIO/the script must be executable.
function ensureLauncher() {
  const file = launcherPath()
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (current !== LAUNCHER_SCRIPT) {
    fs.mkdirSync(launcherDir(), { recursive: true })
    fs.writeFileSync(file, LAUNCHER_SCRIPT, { mode: 0o755 })
  }
  // writeFileSync's mode is ignored when the file already exists, so enforce the bit unconditionally.
  fs.chmodSync(file, 0o755)
  return file
}

// Builds the .desktop Exec= value that routes through the shared launcher. The AppImage path is
// quoted (it may carry a user-chosen outputDir with spaces) and passed as the launcher's first
// argument; the trailing args (sandbox flag + %u field code) are forwarded to the AppImage verbatim.
function desktopExec(appImageFile, args = '--no-sandbox %u') {
  return `${launcherPath()} "${appImageFile}" ${args}`
}

module.exports = { launcherDir, launcherPath, ensureLauncher, desktopExec, LAUNCHER_SCRIPT }
