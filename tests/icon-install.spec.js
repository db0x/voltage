const { test, expect } = require('@playwright/test')
const { execFileSync } = require('node:child_process')
const fs   = require('node:fs')
const os   = require('node:os')
const path = require('node:path')

// Regression cover for the system-wide icon-breakage bug: older Voltage versions installed app
// icons into the shared `hicolor` theme and fabricated a sparse ~/.local/share/icons/hicolor/
// index.theme. Per the Icon Theme Spec, that file's Directories= list shadows the complete system
// index for the WHOLE theme, hiding every system icon whose context wasn't listed. The fix installs
// icons into a private `voltage` theme instead and never writes a hicolor index.
//
// These tests drive scripts/lib.js directly in a child node process with HOME redirected to a temp
// dir, so all of its desktop/icon/routing side effects stay isolated and are wiped on cleanup.

const ROOT = path.join(__dirname, '..')

// Runs installIcon() + installDesktop(app) inside a child process with HOME pointed at `home`, so
// every os.homedir()-derived path (computed at module load too) resolves inside the temp dir.
function runInstall(home, app) {
  const snippet =
    `const lib = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib.js'))});` +
    `lib.installIcon();` +
    `lib.installDesktop(${JSON.stringify(app)});`
  execFileSync('node', ['-e', snippet], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
  })
}

// Runs an arbitrary lib.js call inside a child process with HOME redirected (like runInstall) — used
// to drive uninstallAppIcon, which the manager's delete handler calls.
function runLib(home, snippet) {
  const call = `const lib = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib.js'))}); ${snippet};`
  execFileSync('node', ['-e', call], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
  })
}

let home
test.beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-icons-')) })
test.afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

const hicolorIndex = (h) => path.join(h, '.local', 'share', 'icons', 'hicolor', 'index.theme')
const voltageIndex = (h) => path.join(h, '.local', 'share', 'icons', 'voltage', 'index.theme')

// Setup:    A pristine temp HOME (no pre-existing icon themes).
// Action:   Install the launcher icon and a default-icon app's desktop entry.
// Expected: Icons land in a private `voltage` theme (Inherits=hicolor) and NO hicolor index.theme is
//           created — the partial-hicolor-index that shadowed system icons must never be written.
test('installs into a private voltage theme and never writes a hicolor index.theme', () => {
  runInstall(home, { profile: 'e2e-icon', name: 'E2E Icon', url: 'https://example.com/', icon: 'voltage' })

  expect(fs.existsSync(hicolorIndex(home))).toBe(false)
  expect(fs.existsSync(voltageIndex(home))).toBe(true)
  expect(fs.readFileSync(voltageIndex(home), 'utf8')).toContain('Inherits=hicolor')
})

// Setup:    A pristine temp HOME.
// Action:   Install a default-icon app's desktop entry.
// Expected: The .desktop Icon= is an ABSOLUTE path into the voltage theme that actually exists — a
//           path (not a name) is required because a private theme isn't searched by icon name.
test('desktop entry references the installed icon by absolute path', () => {
  runInstall(home, { profile: 'e2e-icon', name: 'E2E Icon', url: 'https://example.com/', icon: 'voltage' })

  const desktop = fs.readFileSync(
    path.join(home, '.local', 'share', 'applications', 'vE2e-icon.desktop'), 'utf8')
  const iconLine = desktop.split('\n').find(l => l.startsWith('Icon='))
  const iconPath = iconLine.slice('Icon='.length)
  expect(path.isAbsolute(iconPath)).toBe(true)
  expect(iconPath).toContain(path.join('icons', 'voltage'))
  expect(fs.existsSync(iconPath)).toBe(true)
})

// Setup:    A temp HOME seeded with a chosen icon that lives in a NON-apps context dir (mimetypes/),
//           exactly like the many such icons the manager's picker offers. python3/GTK is unavailable
//           in CI, so this exercises the filesystem-search fallback's any-context pass.
// Action:   Install an app whose icon= names that mimetypes icon.
// Expected: The .desktop points at the installed icon and its bytes equal the CHOSEN source — not the
//           generic Voltage logo. The old apps/-only search silently fell back to voltage.svg here.
test('installs a chosen icon that lives outside an apps/ context dir', () => {
  const themeMimetypes = path.join(home, '.local', 'share', 'icons', 'Seeded', '48x48', 'mimetypes')
  fs.mkdirSync(themeMimetypes, { recursive: true })
  const srcIcon = path.join(themeMimetypes, 'x-seeded-doc.svg')
  fs.writeFileSync(srcIcon, '<svg id="seeded-chosen-icon"/>')

  runInstall(home, { profile: 'e2e-ctx', name: 'E2E Ctx', url: 'https://example.com/', icon: 'x-seeded-doc' })

  const desktop = fs.readFileSync(
    path.join(home, '.local', 'share', 'applications', 'vE2e-ctx.desktop'), 'utf8')
  const iconPath = desktop.split('\n').find(l => l.startsWith('Icon=')).slice('Icon='.length)
  expect(fs.existsSync(iconPath)).toBe(true)
  expect(fs.readFileSync(iconPath, 'utf8')).toBe('<svg id="seeded-chosen-icon"/>')
})

// Setup:    A temp HOME seeded with a Voltage-fabricated hicolor index.theme (its signature:
//           Name=Hicolor with no Context= keys) plus a stale icon cache.
// Action:   Run an install, whose migration step inspects that file.
// Expected: The fabricated index + stale cache are removed so GTK falls back to the complete system
//           hicolor index again — repairing systems damaged by the old behaviour.
test('removes a previously fabricated hicolor index.theme on install', () => {
  const dir = path.dirname(hicolorIndex(home))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(hicolorIndex(home), '[Icon Theme]\nName=Hicolor\nDirectories=scalable/apps\n')
  fs.writeFileSync(path.join(dir, 'icon-theme.cache'), 'stale')

  runInstall(home, { profile: 'e2e-icon', name: 'E2E Icon', url: 'https://example.com/', icon: 'voltage' })

  expect(fs.existsSync(hicolorIndex(home))).toBe(false)
  expect(fs.existsSync(path.join(dir, 'icon-theme.cache'))).toBe(false)
})

// Setup:    A temp HOME seeded with a LEGITIMATE hicolor index.theme (contains Context= keys, as a
//           real distro file does).
// Action:   Run an install.
// Expected: The legitimate file is left untouched — the migration must only delete Voltage's own
//           fabricated file, never a real system/user index.
test('preserves a legitimate hicolor index.theme', () => {
  const legit = '[Icon Theme]\nName=Hicolor\nDirectories=48x48/apps\n\n[48x48/apps]\nContext=Applications\nSize=48\n'
  fs.mkdirSync(path.dirname(hicolorIndex(home)), { recursive: true })
  fs.writeFileSync(hicolorIndex(home), legit)

  runInstall(home, { profile: 'e2e-icon', name: 'E2E Icon', url: 'https://example.com/', icon: 'voltage' })

  expect(fs.existsSync(hicolorIndex(home))).toBe(true)
  expect(fs.readFileSync(hicolorIndex(home), 'utf8')).toBe(legit)
})

// A seeded icon in a NON-apps context dir (drives the filesystem-search fallback in CI where
// python3/GTK is unavailable), used by the reinstall/uninstall tests below.
function seedIcon(home, name, marker) {
  const ctx = path.join(home, '.local', 'share', 'icons', 'Seeded', '48x48', 'mimetypes')
  fs.mkdirSync(ctx, { recursive: true })
  fs.writeFileSync(path.join(ctx, `${name}.svg`), `<svg id="${marker}"/>`)
}
const voltageAppIcon = (home, desktopName) =>
  path.join(home, '.local', 'share', 'icons', 'voltage', 'scalable', 'apps', `${desktopName}.svg`)

// Setup:    An app installed with icon-old, then two candidate icons on disk.
// Action:   Reinstall the SAME app with a different icon (icon-new).
// Expected: The installed icon is overwritten with icon-new's bytes — the old early-return-on-exists
//           left the stale icon in place, so a changed icon selection never took effect on reinstall.
test('reinstalling with a changed icon overwrites the stale one', () => {
  seedIcon(home, 'icon-old', 'OLD')
  seedIcon(home, 'icon-new', 'NEW')
  const app = (icon) => ({ profile: 'e2e-over', name: 'E2E Over', url: 'https://example.com/', icon })

  runInstall(home, app('icon-old'))
  runInstall(home, app('icon-new'))  // reinstall with a different icon

  expect(fs.readFileSync(voltageAppIcon(home, 'vE2e-over'), 'utf8')).toBe('<svg id="NEW"/>')
})

// Setup:    An app installed with a chosen icon (its exclusive <desktopName>.svg exists).
// Action:   Call uninstallAppIcon(desktopName) — what the manager's delete handler now runs.
// Expected: The app's icon file is removed from the voltage theme, so uninstalling no longer leaves it
//           behind.
test('uninstallAppIcon removes the app icon from the voltage theme', () => {
  seedIcon(home, 'icon-x', 'X')
  runInstall(home, { profile: 'e2e-del', name: 'E2E Del', url: 'https://example.com/', icon: 'icon-x' })

  const iconFile = voltageAppIcon(home, 'vE2e-del')
  expect(fs.existsSync(iconFile)).toBe(true)

  runLib(home, `lib.uninstallAppIcon('vE2e-del')`)
  expect(fs.existsSync(iconFile)).toBe(false)
})
