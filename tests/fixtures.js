const { test: base, expect } = require('@playwright/test')
const { _electron: electron } = require('@playwright/test')
const path = require('node:path')
const os   = require('node:os')
const fs   = require('node:fs')

const ROOT             = path.join(__dirname, '..')
const CONFIGS_DIR      = path.join(ROOT, 'webapps')
const FAKE_ICON_PATH   = path.join(ROOT, 'assets', 'wrapweb.svg')
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
  { file: 'build.test-google-app.json',       content: { profile: 'test-google-app',    url: 'https://example.com', name: 'Test Google App', category: 'google'   } },
  { file: 'build.private.test-mail-app.json', content: { profile: 'test-mail-app',      url: 'https://mail.example.com', name: 'Test Mail App', mimeTypes: ['x-scheme-handler/mailto'] } },
]

// Writes test configs, launches the Electron app, and returns the app instance.
// WRAPWEB_TEST=1 disables update checks, GTK icon lookups, and other non-test behaviors.
// A fresh temp directory is used as userData so tests never share persistent state.
async function launchApp(extraEnv = {}) {
  for (const { file, content } of TEST_CONFIGS)
    fs.writeFileSync(path.join(CONFIGS_DIR, file), JSON.stringify(content, null, 4))

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapweb-test-'))
  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, WRAPWEB_TEST: '1', WRAPWEB_LANG: 'en', ELECTRON_RUN_AS_NODE: undefined, ...extraEnv },
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

  // Like electronApp but with WRAPWEB_TEST_FILTER_ICONS set, so filter buttons
  // receive a resolved icon path and render both an <img> and a text label.
  electronAppWithFilterIcons: [async ({}, use) => {
    const { app, userDataDir } = await launchApp({ WRAPWEB_TEST_FILTER_ICONS: FAKE_ICON_PATH })
    await use(app)
    await closeApp(app, userDataDir)
  }, { scope: 'test' }],

  // Like electronApp but with WRAPWEB_LANG=de so all UI text is in German.
  electronAppDe: [async ({}, use) => {
    const { app, userDataDir } = await launchApp({ WRAPWEB_LANG: 'de' })
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
    rcloneFileHandler: true,
    mimeTypes:        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
}
const RCLONE_DESKTOP_FILE = path.join(
  os.homedir(), '.local', 'share', 'applications', 'wrapweb-test-rclone-app.desktop'
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
    'Name=Test Rclone App', 'Icon=wrapweb', 'Exec=/dev/null',
  ].join('\n') + '\n')
}

function cleanupRcloneTestConfig() {
  fs.rmSync(path.join(CONFIGS_DIR, RCLONE_TEST_CONFIG.file), { force: true })
  fs.rmSync(RCLONE_DESKTOP_FILE, { force: true })
}

// Launches the Manager with the fake rclone binary prepended to PATH.
// mode controls WRAPWEB_TEST_RCLONE_MODE (default: 'new').
// A dedicated temp dir is used for the rclone config so the user's real
// ~/.config/wrapweb/rclone.json is never touched during tests.
async function launchAppWithRclone(mode = 'new', extraEnv = {}) {
  writeRcloneTestConfig()
  const rcloneDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapweb-rclone-test-'))
  const { app, userDataDir } = await launchApp({
    PATH: `${RCLONE_FAKE_BIN}:${process.env.PATH}`,
    WRAPWEB_TEST_RCLONE_MODE: mode,
    WRAPWEB_TEST_DATA_DIR: rcloneDataDir,
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

module.exports = { test, expect, FAKE_ICON_PATH, base, rcloneTest }
