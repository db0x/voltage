const { test, expect } = require('@playwright/test')
const fs   = require('node:fs')
const os   = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// Pure-logic + behavioural tests for the shared indirection launcher (src/launcher.js). It runs in
// the plain Playwright node runner (no Electron) and guards the contract both the build scripts and
// the Manager rely on: every .desktop Exec= must resolve to an always-present binary so GNOME/GIO
// never drops the entry when the AppImage's directory is encrypted/locked.

// Redirect the launcher's install location to a throwaway XDG_DATA_HOME so the suite never touches
// the real ~/.local/share/voltage. Each helper is required fresh AFTER the env is set, because
// launcherPath() reads XDG_DATA_HOME at call time.
function withTempDataHome(fn) {
  const prev = process.env.XDG_DATA_HOME
  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-launcher-'))
  process.env.XDG_DATA_HOME = tmp
  try {
    return fn(tmp, require('../src/launcher'))
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

test.describe('desktopExec — Exec= value', () => {
  // Setup:    an AppImage path containing a space (a user-chosen outputDir is allowed to).
  // Action:   build the Exec= value that goes into the .desktop file.
  // Expected: it starts with the absolute launcher path (the only token GIO probes, and one that
  //           always exists) and passes the AppImage as a *quoted* first argument so the space does
  //           not split it; the sandbox flag and %u field code follow verbatim.
  test('routes through the launcher and quotes the AppImage path', () => {
    withTempDataHome((tmp, launcher) => {
      const exec = launcher.desktopExec('/enc/My Project/vTeams')
      expect(exec).toBe(`${tmp}/voltage/voltage-launch "/enc/My Project/vTeams" --no-sandbox %u`)
      // The probed binary is the launcher, never the (possibly missing) AppImage.
      expect(exec.startsWith(launcher.launcherPath())).toBe(true)
    })
  })
})

test.describe('ensureLauncher — installed script', () => {
  // Setup:    a fresh XDG_DATA_HOME with no launcher yet.
  // Action:   ensure the launcher, twice.
  // Expected: an executable POSIX-sh script exists at launcherPath() with the module's exact
  //           content; a second call is idempotent (same path, still executable) so repeated app
  //           installs do not churn the file.
  test('writes an executable sh script idempotently', () => {
    withTempDataHome((tmp, launcher) => {
      const p = launcher.ensureLauncher()
      expect(p).toBe(launcher.launcherPath())
      expect(fs.existsSync(p)).toBe(true)
      expect(fs.readFileSync(p, 'utf8')).toBe(launcher.buildLauncherScript(launcher.repoRoot()))
      expect(fs.readFileSync(p, 'utf8').startsWith('#!/bin/sh')).toBe(true)
      expect(fs.statSync(p).mode & 0o111).toBeTruthy()   // executable bit set

      expect(launcher.ensureLauncher()).toBe(p)          // second call: no throw, same path
      expect(fs.statSync(p).mode & 0o111).toBeTruthy()
    })
  })

  // Setup:    an installed launcher and a dummy "AppImage" that records the arguments it receives.
  // Action:   invoke the launcher the way a .desktop would: <launcher> <appimage> --no-sandbox URL.
  // Expected: the dummy is exec'd with exactly the forwarded args (the AppImage path is consumed as
  //           $1 and not passed on), proving the indirection is transparent to the real app.
  test('execs the AppImage and forwards the remaining args', () => {
    withTempDataHome((tmp, launcher) => {
      const p = launcher.ensureLauncher()
      const out = path.join(tmp, 'args.txt')
      const dummy = path.join(tmp, 'vDummy')
      fs.writeFileSync(dummy, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`, { mode: 0o755 })

      execFileSync('sh', [p, dummy, '--no-sandbox', 'https://example.test'])
      expect(fs.readFileSync(out, 'utf8')).toBe('--no-sandbox\nhttps://example.test\n')
    })
  })

  // Setup:    an installed launcher pointed at a non-existent AppImage (the encrypted/locked case).
  //           VOLTAGE_TEST=1 suppresses the notice-window spawn so the unit test never boots Electron.
  // Action:   invoke the launcher.
  // Expected: it exits non-zero (127) instead of crashing, signalling the failure to GIO/GNOME.
  test('exits non-zero when the AppImage is unreachable', () => {
    withTempDataHome((tmp, launcher) => {
      const p = launcher.ensureLauncher()
      let status = 0
      try {
        execFileSync('sh', [p, path.join(tmp, 'does-not-exist'), '--no-sandbox'],
          { stdio: 'ignore', env: { ...process.env, VOLTAGE_TEST: '1' } })
      } catch (err) {
        status = err.status
      }
      expect(status).toBe(127)
    })
  })
})
