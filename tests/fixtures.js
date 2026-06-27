const { test: base, expect } = require('@playwright/test')
const { _electron: electron } = require('@playwright/test')
const path = require('node:path')
const os   = require('node:os')
const fs   = require('node:fs')

const ROOT             = path.join(__dirname, '..')
const CONFIGS_DIR      = path.join(ROOT, 'webapps')
const FAKE_ICON_PATH   = path.join(ROOT, 'assets', 'voltage.svg')
const RCLONE_FAKE_BIN  = path.join(__dirname, 'fixtures', 'bin')

// Minimal set of test configs that covers all major card variants:
//   - public app (no special flags)
//   - private/user app (isPrivate = true, shows edit button instead of info button)
//   - Microsoft-category app (for category filter tests)
//   - Google-category app (for category filter tests)
//   - private app with mailto MIME type (for mail handler tests)
const TEST_CONFIGS = [
  { file: 'build.test-app.json',              content: { profile: 'test-app',           url: 'https://example.com', name: 'Test App'        } },
  { file: 'build.private.test-user-app.json', content: { profile: 'test-user-app',      url: 'https://example.com', name: 'Test User App'   } },
  { file: 'build.test-ms-app.json',           content: { profile: 'test-ms-app',        url: 'https://example.com', name: 'Test MS App',    category: 'microsoft' } },
  { file: 'build.test-google-app.json',       content: { profile: 'test-google-app',    url: 'https://example.com', name: 'Test Google App', category: 'google', routingUrls: ['routing-claim.example.net/app'], plugins: ['plugins/rclone-sync/rclone-sync.js'] } },
  { file: 'build.private.test-mail-app.json', content: { profile: 'test-mail-app',      url: 'https://mail.example.com', name: 'Test Mail App', mimeTypes: ['x-scheme-handler/mailto'] } },
]

// Writes test configs, launches the Electron app, and returns the app instance.
// VOLTAGE_TEST=1 disables update checks, GTK icon lookups, and other non-test behaviors.
// A fresh temp directory is used as userData so tests never share persistent state.
async function launchApp(extraEnv = {}, extraArgs = []) {
  for (const { file, content } of TEST_CONFIGS)
    fs.writeFileSync(path.join(CONFIGS_DIR, file), JSON.stringify(content, null, 4))

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-test-'))
  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${userDataDir}`, ...extraArgs],
    // Isolate appData (XDG_CONFIG_HOME) so manager-state.json / global-settings.json start fresh each
    // run instead of inheriting the developer's real ~/.config/voltage. Keeps geometry-sensitive tests
    // deterministic — e.g. the persisted "custom chrome" flag must not silently change the layout.
    env: { ...process.env, XDG_CONFIG_HOME: userDataDir, VOLTAGE_TEST: '1', VOLTAGE_LANG: 'en', ELECTRON_RUN_AS_NODE: undefined, ...extraEnv },
  })
  return { app, userDataDir }
}

async function closeApp(app, userDataDir) {
  await app.close()
  for (const { file } of TEST_CONFIGS)
    fs.rmSync(path.join(CONFIGS_DIR, file), { force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
}

const test = base.extend({
  // Standard Manager fixture: all five test configs, English UI, no custom icons.
  electronApp: [async ({}, use) => {
    const { app, userDataDir } = await launchApp()
    await use(app)
    await closeApp(app, userDataDir)
  }, { scope: 'test' }],

  // Like electronApp but with VOLTAGE_TEST_FILTER_ICONS set, so filter buttons
  // receive a resolved icon path and render both an <img> and a text label.
  electronAppWithFilterIcons: [async ({}, use) => {
    const { app, userDataDir } = await launchApp({ VOLTAGE_TEST_FILTER_ICONS: FAKE_ICON_PATH })
    await use(app)
    await closeApp(app, userDataDir)
  }, { scope: 'test' }],

  // Like electronApp but with VOLTAGE_LANG=de so all UI text is in German.
  electronAppDe: [async ({}, use) => {
    const { app, userDataDir } = await launchApp({ VOLTAGE_LANG: 'de' })
    await use(app)
    await closeApp(app, userDataDir)
  }, { scope: 'test' }],

  // Manager window ready for interaction — waits until all IPC data is loaded
  // and the add-card button is visible before yielding.
  managerPage: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use(page)
  },

  managerPageWithFilterIcons: async ({ electronAppWithFilterIcons }, use) => {
    const page = await electronAppWithFilterIcons.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use(page)
  },

  managerPageDe: async ({ electronAppDe }, use) => {
    const page = await electronAppDe.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use(page)
  },
})

// ── rclone test helpers ──────────────────────────────────────────────────────

// Test config that looks like an installed rclone-capable app.
// A minimal .desktop file is written so `installed: true` in manager:apps.
const RCLONE_TEST_CONFIG = {
  file:    'build.test-rclone-app.json',
  content: {
    profile:          'test-rclone-app',
    name:             'Test Rclone App',
    url:              'https://docs.google.com',
    category:         'google',
    // rclone is a plugin now — the manager derives "rclone-capable" from this entry.
    plugins:          ['plugins/rclone-sync/rclone-sync.js'],
    mimeTypes:        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
}
// Desktop filename follows the artifact naming (appName: "test-rclone-app" → "vTest-rclone-app")
// so the manager's `installed` detection in manager:apps finds it.
const RCLONE_DESKTOP_FILE = path.join(
  os.homedir(), '.local', 'share', 'applications', 'vTest-rclone-app.desktop'
)

function writeRcloneTestConfig() {
  fs.writeFileSync(
    path.join(CONFIGS_DIR, RCLONE_TEST_CONFIG.file),
    JSON.stringify(RCLONE_TEST_CONFIG.content, null, 4)
  )
  // Minimal .desktop so the app counts as installed.
  fs.mkdirSync(path.dirname(RCLONE_DESKTOP_FILE), { recursive: true })
  fs.writeFileSync(RCLONE_DESKTOP_FILE, [
    '[Desktop Entry]', 'Type=Application',
    'Name=Test Rclone App', 'Icon=voltage', 'Exec=/dev/null',
  ].join('\n') + '\n')
}

function cleanupRcloneTestConfig() {
  fs.rmSync(path.join(CONFIGS_DIR, RCLONE_TEST_CONFIG.file), { force: true })
  fs.rmSync(RCLONE_DESKTOP_FILE, { force: true })
}

// Launches the Manager with the fake rclone binary prepended to PATH.
// mode controls VOLTAGE_TEST_RCLONE_MODE (default: 'new').
// A dedicated temp dir is used for the rclone config so the user's real
// ~/.config/voltage/rclone.json is never touched during tests.
async function launchAppWithRclone(mode = 'new', extraEnv = {}) {
  writeRcloneTestConfig()
  const rcloneDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-rclone-test-'))
  const { app, userDataDir } = await launchApp({
    PATH: `${RCLONE_FAKE_BIN}:${process.env.PATH}`,
    VOLTAGE_TEST_RCLONE_MODE: mode,
    VOLTAGE_TEST_DATA_DIR: rcloneDataDir,
    ...extraEnv,
  })
  return { app, userDataDir, rcloneDataDir }
}

async function closeAppWithRclone(app, userDataDir, rcloneDataDir) {
  await closeApp(app, userDataDir)
  cleanupRcloneTestConfig()
  fs.rmSync(rcloneDataDir, { recursive: true, force: true })
}

const rcloneTest = base.extend({
  // Manager with fake rclone available and one installed rclone-capable test app.
  electronAppWithRclone: [async ({}, use) => {
    const { app, userDataDir, rcloneDataDir } = await launchAppWithRclone()
    await use(app)
    await closeAppWithRclone(app, userDataDir, rcloneDataDir)
  }, { scope: 'test' }],

  managerPageWithRclone: async ({ electronAppWithRclone }, use) => {
    const page = await electronAppWithRclone.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use(page)
  },
})

// ── Mail-handler test helpers ────────────────────────────────────────────────

// Config for a mail-capable app that will appear as both built and installed.
const MAIL_TEST_CONFIG = {
  file:    'build.private.test-mail-dialog-app.json',
  content: {
    profile:   'test-mail-dialog-app',
    name:      'Test Mail Dialog App',
    url:       'https://mail.example.com',
    mimeTypes: ['x-scheme-handler/mailto'],
  },
}
// Artifact naming: appName("test-mail-dialog-app") → "vTest-mail-dialog-app".
const MAIL_DESKTOP_FILE = path.join(
  os.homedir(), '.local', 'share', 'applications', 'vTest-mail-dialog-app.desktop'
)
// Fake AppImage file — presence makes built:true in manager:apps.
const MAIL_DIST_FILE = path.join(ROOT, 'dist', 'vTest-mail-dialog-app')

function writeMailTestConfig() {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(CONFIGS_DIR, MAIL_TEST_CONFIG.file), JSON.stringify(MAIL_TEST_CONFIG.content, null, 4))
  fs.writeFileSync(MAIL_DIST_FILE, '')  // fake binary so built:true
  fs.mkdirSync(path.dirname(MAIL_DESKTOP_FILE), { recursive: true })
  fs.writeFileSync(MAIL_DESKTOP_FILE, [
    '[Desktop Entry]', 'Type=Application',
    'Name=Test Mail Dialog App', 'Icon=voltage', 'Exec=/dev/null',
  ].join('\n') + '\n')
}

function cleanupMailTestConfig() {
  fs.rmSync(path.join(CONFIGS_DIR, MAIL_TEST_CONFIG.file), { force: true })
  fs.rmSync(MAIL_DIST_FILE, { force: true })
  fs.rmSync(MAIL_DESKTOP_FILE, { force: true })
}

async function launchAppWithMailHandler(extraEnv = {}) {
  writeMailTestConfig()
  const { app, userDataDir } = await launchApp({
    // Pretend the test mail dialog app is already the default handler.
    VOLTAGE_TEST_MAIL_HANDLER: 'vTest-mail-dialog-app.desktop',
    ...extraEnv,
  })
  return { app, userDataDir }
}

async function closeAppWithMailHandler(app, userDataDir) {
  await closeApp(app, userDataDir)
  cleanupMailTestConfig()
}

const mailHandlerTest = base.extend({
  electronAppWithMailHandler: [async ({}, use) => {
    const { app, userDataDir } = await launchAppWithMailHandler()
    await use(app)
    await closeAppWithMailHandler(app, userDataDir)
  }, { scope: 'test' }],

  managerPageWithMailHandler: async ({ electronAppWithMailHandler }, use) => {
    const page = await electronAppWithMailHandler.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use(page)
  },
})

// ── Global-settings test helpers ─────────────────────────────────────────────

// Uses VOLTAGE_TEST_DATA_DIR so global-settings.json is written to a temp
// directory — tests never touch the user's real config.
async function launchAppWithGlobalSettings(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-gs-test-'))
  const { app, userDataDir } = await launchApp({ VOLTAGE_TEST_DATA_DIR: dataDir, ...extraEnv })
  return { app, userDataDir, dataDir }
}

async function closeAppWithGlobalSettings(app, userDataDir, dataDir) {
  await closeApp(app, userDataDir)
  fs.rmSync(dataDir, { recursive: true, force: true })
}

const globalSettingsTest = base.extend({
  electronAppWithGs: [async ({}, use) => {
    const { app, userDataDir, dataDir } = await launchAppWithGlobalSettings()
    await use(app)
    await closeAppWithGlobalSettings(app, userDataDir, dataDir)
  }, { scope: 'test' }],

  managerPageWithGs: async ({ electronAppWithGs }, use) => {
    const page = await electronAppWithGs.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use(page)
  },
})

// ── Obsidian-dialog test helpers ─────────────────────────────────────────────

// VOLTAGE_TEST_OBSIDIAN_AVAILABLE turns the drawer entry on without a real
// obsidian:// MIME registration; VOLTAGE_TEST_OBSIDIAN_FLATPAK toggles the
// Flatpak-hint section inside the dialog.
const obsidianTest = base.extend({
  electronAppObsidianFlatpak: [async ({}, use) => {
    const { app, userDataDir } = await launchApp({
      VOLTAGE_TEST_OBSIDIAN_AVAILABLE: '1',
      VOLTAGE_TEST_OBSIDIAN_FLATPAK:   '1',
    })
    await use(app)
    await closeApp(app, userDataDir)
  }, { scope: 'test' }],

  electronAppObsidianNative: [async ({}, use) => {
    const { app, userDataDir } = await launchApp({
      VOLTAGE_TEST_OBSIDIAN_AVAILABLE: '1',
    })
    await use(app)
    await closeApp(app, userDataDir)
  }, { scope: 'test' }],

  managerPageObsidianFlatpak: async ({ electronAppObsidianFlatpak }, use) => {
    const page = await electronAppObsidianFlatpak.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use(page)
  },

  managerPageObsidianNative: async ({ electronAppObsidianNative }, use) => {
    const page = await electronAppObsidianNative.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use(page)
  },
})

// ── GNOME-extension dialog test helpers ──────────────────────────────────────

// VOLTAGE_TEST_GNOME_AVAILABLE turns the drawer entry on without a real GNOME session.
// VOLTAGE_TEST_GNOME_EXT_DIR points the install target at a temp dir so the install
// handler copies the extension there instead of the user's real extensions directory.
// VOLTAGE_TEST_GNOME_ENABLED / _AFTER and _WAYLAND drive the status/relog-hint branches.
async function launchAppWithGnome(extraEnv = {}) {
  const gnomeExtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-gnome-test-'))
  const { app, userDataDir } = await launchApp({
    VOLTAGE_TEST_GNOME_AVAILABLE: '1',
    VOLTAGE_TEST_GNOME_EXT_DIR:   gnomeExtDir,
    ...extraEnv,
  })
  return { app, userDataDir, gnomeExtDir }
}

async function closeAppWithGnome(app, userDataDir, gnomeExtDir) {
  await closeApp(app, userDataDir)
  fs.rmSync(gnomeExtDir, { recursive: true, force: true })
}

const gnomeTest = base.extend({
  // GNOME session detected, extension not yet installed, Wayland (so a relog is required
  // after install — the dialog's relog hint should appear).
  electronAppGnomeWayland: [async ({}, use) => {
    const { app, userDataDir, gnomeExtDir } = await launchAppWithGnome({ VOLTAGE_TEST_GNOME_WAYLAND: '1' })
    await use({ app, gnomeExtDir })
    await closeAppWithGnome(app, userDataDir, gnomeExtDir)
  }, { scope: 'test' }],

  managerPageGnomeWayland: async ({ electronAppGnomeWayland }, use) => {
    const page = await electronAppGnomeWayland.app.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use({ page, gnomeExtDir: electronAppGnomeWayland.gnomeExtDir })
  },
})

// ── Edit-config deep-link test helper ────────────────────────────────────────

// Launches the Manager with --voltage-edit-config=<profile> so it should open straight into that
// app's edit dialog on startup.
const editConfigTest = base.extend({
  managerPageEditConfig: async ({}, use) => {
    const { app, userDataDir } = await launchApp({}, ['--voltage-edit-config=test-user-app'])
    const page = await app.firstWindow()
    await page.waitForSelector('.card-add', { timeout: 30_000 })
    await use(page)
    await closeApp(app, userDataDir)
  },
})

module.exports = { test, expect, FAKE_ICON_PATH, base, rcloneTest, mailHandlerTest, globalSettingsTest, obsidianTest, gnomeTest, editConfigTest }
