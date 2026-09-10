const { test, expect } = require('./fixtures')
const fs   = require('node:fs')
const path = require('node:path')

// The robot plugin's keep-alive (opt-in: feed synthetic user activity into the page on a timer, so
// an app that flips its presence to "Away" when nothing happens in its own window — Teams — keeps
// the session active while the user works elsewhere): node-level tests for the settings layer, the
// page-side burst's content, plus Manager e2e for the config dialog's round-trip. Actually sending
// the events is an Electron-runtime path (sendInputEvent + executeJavaScript on a live window) not
// exercised here. Requiring the module directly is safe: its electron import only destructures
// `screen`, which is used inside the timer tick only.

const ROBOT_DIR = path.join(__dirname, '..', 'webapps', 'plugins', 'robot')
const { resolveKeepAlive, DEFAULT_MINUTES, MIN_MINUTES, MAX_MINUTES } = require(path.join(ROBOT_DIR, 'keepalive.js'))
const BURST = fs.readFileSync(path.join(ROBOT_DIR, 'inject', 'keepalive.js'), 'utf8')

const WEBAPPS_DIR = path.join(__dirname, '..', 'webapps')

// Setup:    An app that uses the robot plugin without touching the keep-alive controls, plus one
//           that only lists actions.
// Action:   Resolve the keep-alive settings.
// Expected: Off. Synthetic input is a side effect no app should get merely for using the load
//           actions — it must stay something the user switched on deliberately.
test('resolveKeepAlive is off unless the app enabled it', () => {
  expect(resolveKeepAlive({}).enabled).toBe(false)
  expect(resolveKeepAlive(undefined).enabled).toBe(false)
  expect(resolveKeepAlive({ actions: [{ target: 'button', identifier: 'Login' }] }).enabled).toBe(false)
  expect(resolveKeepAlive({ keepAliveMinutes: 10 }).enabled).toBe(false)  // interval alone is not consent
})

// Setup:    The keep-alive enabled as the dialog stores it (a real boolean) and as a hand-written
//           build.*.json may spell it (the string form), each without an interval.
// Action:   Resolve.
// Expected: Both count as on and fall back to the 5-minute default — the presence timeouts this
//           works around sit around that mark, so an app that only flips the switch is already
//           configured usefully.
test('resolveKeepAlive accepts both truth spellings and defaults the interval', () => {
  for (const keepAlive of [true, 'true']) {
    expect(resolveKeepAlive({ keepAlive })).toEqual({
      enabled: true, minutes: DEFAULT_MINUTES, intervalMs: DEFAULT_MINUTES * 60 * 1000,
    })
  }
})

// Setup:    Intervals outside the range the dialog's slider can reach, and non-numeric junk.
// Action:   Resolve them.
// Expected: Clamped into the bounds, junk falls back to the default. A zero or negative interval
//           would otherwise become a timer firing continuously, which is a busy loop hammering the
//           page rather than a keep-alive.
test('resolveKeepAlive clamps the interval into the configurable range', () => {
  expect(resolveKeepAlive({ keepAlive: true, keepAliveMinutes: 0 }).minutes).toBe(MIN_MINUTES)
  expect(resolveKeepAlive({ keepAlive: true, keepAliveMinutes: -30 }).minutes).toBe(MIN_MINUTES)
  expect(resolveKeepAlive({ keepAlive: true, keepAliveMinutes: 999 }).minutes).toBe(MAX_MINUTES)
  expect(resolveKeepAlive({ keepAlive: true, keepAliveMinutes: 'soon' }).minutes).toBe(DEFAULT_MINUTES)
  expect(resolveKeepAlive({ keepAlive: true, keepAliveMinutes: 10 }).intervalMs).toBe(600000)
})

// Setup:    The page-side activity burst.
// Action:   Read its source.
// Expected: It varies the pointer position per tick and only ever presses Shift. A fixed position
//           reads as "no movement" to a tracker that compares coordinates, and any other key could
//           type into a focused field or fire an app shortcut — both would make the keep-alive
//           change the page instead of just signalling presence.
test('the injected burst moves the pointer and presses only a harmless key', () => {
  expect(BURST).toContain('state.tick % 2')
  expect(BURST).toContain("dispatchEvent(new MouseEvent('mousemove'")
  expect(BURST).toContain("key: 'Shift'")
  expect(BURST).toMatch(/KeyboardEvent\('keyup'/)
})

// Setup:    Edit dialog for test-user-app with the robot plugin added and its config dialog opened.
// Action:   Read the keep-alive controls, switch the toggle on, then off again.
// Expected: The toggle starts off and the interval slider is dimmed while it is — the interval is
//           meaningless without the feature, and showing it live would suggest the keep-alive runs.
test('edit dialog: the keep-alive interval is gated on the keep-alive toggle', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'robot' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'robot' })
    .locator('.domain-configure-btn').click()

  const overlay  = managerPage.locator('.plugin-config-overlay:not(.hidden)')
  const toggle   = overlay.locator('.dialog-field-toggle[data-config-key="keepAlive"]')
  const interval = overlay.locator('.dialog-field[data-config-enabled-by="keepAlive"]')
  const slider   = interval.locator('input[data-config-key="keepAliveMinutes"]')

  await expect(toggle).not.toHaveClass(/active/)
  await expect(interval).toHaveClass(/config-disabled/)
  await expect(slider).toBeDisabled()
  await expect(slider).toHaveValue(String(5))          // the default the plugin falls back to

  await toggle.click()
  await expect(interval).not.toHaveClass(/config-disabled/)
  await expect(slider).toBeEnabled()

  await toggle.click()
  await expect(interval).toHaveClass(/config-disabled/)
})

// Setup:    Edit dialog for test-user-app with the robot plugin added and its config dialog opened.
// Action:   Enable the keep-alive, move the interval slider, Apply + Save.
// Expected: Both land in pluginConfig next to the (here empty) action list. The keep-alive is a
//           per-app setting baked into the AppImage like every other plugin config, so this is what
//           proves an app can run it WITHOUT configuring a single load action.
test('edit dialog: the keep-alive settings persist under pluginConfig', async ({ managerPage }) => {
  const card = managerPage.locator('.card[data-private="true"][data-profile="test-user-app"]')
  await card.hover()
  await card.locator('[data-action="edit"]').click()

  await managerPage.click('#edit-plugin-trigger')
  await managerPage.locator('.app-select-list .app-select-item', { hasText: 'robot' }).click()
  await managerPage.locator('#edit-plugin-list .domain-item', { hasText: 'robot' })
    .locator('.domain-configure-btn').click()

  const overlay = managerPage.locator('.plugin-config-overlay:not(.hidden)')
  await overlay.locator('.dialog-field-toggle[data-config-key="keepAlive"]').click()
  await overlay.locator('input[data-config-key="keepAliveMinutes"]').fill('10')
  await expect(overlay.locator('output[data-config-value="keepAliveMinutes"]')).toHaveText('10 min')

  await overlay.locator('.plugin-config-apply').click()
  await expect(managerPage.locator('#edit-save')).toBeEnabled()
  await managerPage.click('#edit-save')

  const cfgPath = path.join(WEBAPPS_DIR, 'build.private.test-user-app.json')
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).pluginConfig ?? null } catch { return null }
  }).toEqual({
    'plugins/robot/robot.js': { actions: [], keepAlive: true, keepAliveMinutes: 10 },
  })
})
