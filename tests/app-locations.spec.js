const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const os   = require('node:os')
const path = require('node:path')

// Per-app custom locations: where the AppImage is built (outputDir) and where the app keeps its
// profile/session data (profileDir). Both are chosen via a native folder dialog, so these tests
// override the manager:pick-folder IPC handler and verify the config round-trip, the resolved
// default display, and that moving the AppImage folder relocates the artifact + fixes the launcher.

const ROOT        = path.join(__dirname, '..')
const WEBAPPS_DIR = path.join(ROOT, 'webapps')
const CHOSEN = '/tmp/voltage-e2e-location'

// Points the folder picker at a fixed path (the native OS dialog can't run under the test).
const stubPicker = (electronApp, p) => electronApp.evaluate(({ ipcMain }, dir) => {
  ipcMain.removeHandler('manager:pick-folder')
  ipcMain.handle('manager:pick-folder', () => dir)
}, p)

// Setup:    Edit dialog for the private test-user-app; the native folder picker is stubbed to a
//           fixed path so no OS dialog is needed.
// Action:   Pick a folder for both the AppImage and the profile, then save.
// Expected: Both paths persist to the private config as outputDir / profileDir.
test('edit dialog: chosen AppImage and profile folders persist to the config', async ({ electronApp, managerPage }) => {
  await stubPicker(electronApp, CHOSEN)

  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-outputdir-btn')
  await expect(managerPage.locator('#edit-outputdir-name')).toHaveText(CHOSEN)
  await managerPage.click('#edit-profiledir-btn')
  await expect(managerPage.locator('#edit-profiledir-name')).toHaveText(CHOSEN)

  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch { return {} }
  }).toMatchObject({ outputDir: CHOSEN, profileDir: CHOSEN })
})

// Setup:    Edit dialog for test-user-app, which has no custom folders set.
// Action:   Open the dialog.
// Expected: With no override, each field shows the resolved default path (the dist/ output folder
//           and the profile folder) and hides the clear (✕) button — proving the field doubles as
//           the path display, and that an unset folder means "use the default location".
test('edit dialog: folder fields show the resolved default path when unset', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await expect(managerPage.locator('#edit-outputdir-name')).toContainText('dist')
  await expect(managerPage.locator('#edit-profiledir-name')).toContainText('test-user-app')
  await expect(managerPage.locator('#edit-outputdir-clear')).toBeHidden()
})

// Setup:    test-user-app made to look built+installed at the default dist/ location (a stand-in
//           AppImage + .version + a .desktop whose Exec points there).
// Action:   Change the AppImage folder to a temp dir and save.
// Expected: The AppImage and its .version sidecar are moved to the new folder (gone from dist/),
//           and the installed launcher's Exec line is rewritten to the new path.
test('edit dialog: moving the AppImage folder relocates the artifact and fixes the launcher Exec', async ({ electronApp, managerPage }) => {
  const artifact = path.join(ROOT, 'dist', 'vTest-user-app')
  const desktop  = path.join(os.homedir(), '.local', 'share', 'applications', 'vTest-user-app.desktop')
  const target   = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-out-'))

  fs.mkdirSync(path.dirname(artifact), { recursive: true })
  fs.writeFileSync(artifact, 'fake-appimage')
  fs.writeFileSync(`${artifact}.version`, '{"version":"1.0.0"}')
  fs.mkdirSync(path.dirname(desktop), { recursive: true })
  fs.writeFileSync(desktop, `[Desktop Entry]\nType=Application\nExec=${artifact} --no-sandbox %u\n`)

  try {
    await stubPicker(electronApp, target)

    const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
    await card.hover()
    await card.locator('[data-action="edit"]').click()
    await managerPage.click('#edit-outputdir-btn')
    await managerPage.click('#edit-save')

    const movedArtifact = path.join(target, 'vTest-user-app')
    await expect.poll(() => fs.existsSync(movedArtifact)).toBe(true)
    expect(fs.existsSync(artifact)).toBe(false)                         // moved, not copied
    expect(fs.existsSync(`${movedArtifact}.version`)).toBe(true)
    expect(fs.readFileSync(desktop, 'utf8')).toContain(`Exec=${movedArtifact} --no-sandbox %u`)
  } finally {
    fs.rmSync(desktop, { force: true })
    fs.rmSync(artifact, { force: true })
    fs.rmSync(`${artifact}.version`, { force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})
