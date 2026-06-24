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
// the launcher's first argument and only touched at click time; if it is unreachable, the launcher
// asks the Manager app to show a Voltage-styled "app unavailable" dialog (see src/notice) instead of
// a vanished starter.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Repo root baked into the launcher so it can start the Manager app for the notice dialog. This file
// lives at <repo>/src/launcher.js, so one level up is the repo. Mirrors install.sh, which likewise
// bakes the install dir into the Manager .desktop (a moved repo breaks both equally — acceptable).
function repoRoot() {
  return path.resolve(__dirname, '..')
}

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

// The launcher itself. Self-contained POSIX sh so it has no runtime dependency on the app being
// reachable. On an unreachable AppImage it boots the Manager app (notice mode) for the dialog; the
// node/nvm bootstrap mirrors the Manager .desktop (install.sh) because GIO launchers run with a
// minimal PATH that usually lacks the nvm-managed node.
function buildLauncherScript(root) {
  return `#!/bin/sh
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
  # Show a Voltage-styled notice via the Manager app (src/notice) instead of failing silently.
  # Pass the artifact basename (e.g. vTeams) verbatim; the notice window derives both the display
  # name and the app's installed icon from it. Backgrounded so this launcher exits at once; skipped
  # under VOLTAGE_TEST so the test suite never spawns a real window.
  name=$(basename "\${APP:-?}")
  if [ -z "\${VOLTAGE_TEST:-}" ]; then
    (
      export NVM_DIR="$HOME/.nvm"
      if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi
      cd "${root}" && node scripts/notice.js "$name"
    ) >/dev/null 2>&1 &
  fi
  exit 127
fi

exec "$APP" "$@"
`
}

// Writes the launcher to disk (idempotent) and returns its path. Rewrites only when the content
// differs so we do not needlessly bump the file's mtime on every install, but always repairs a
// missing/outdated copy. chmod 0o755 is required: GIO/the script must be executable.
function ensureLauncher() {
  const file = launcherPath()
  const script = buildLauncherScript(repoRoot())
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (current !== script) {
    fs.mkdirSync(launcherDir(), { recursive: true })
    fs.writeFileSync(file, script, { mode: 0o755 })
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

module.exports = { repoRoot, launcherDir, launcherPath, buildLauncherScript, ensureLauncher, desktopExec }
