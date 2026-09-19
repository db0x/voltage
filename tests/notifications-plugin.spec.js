const { test, expect } = require('@playwright/test')
const path = require('node:path')
const fs   = require('node:fs')

// Unit tests for the notifications plugin's pure helpers and for the wiring that has to stay in
// lock-step across three files. Plain Node assertions (no browser): raising an actual notification
// needs a live Electron main process and a session D-Bus, which Playwright does not provide.
//
// The regression this guards: Electron drops every ServiceWorkerRegistration.showNotification()
// silently (it resolves, then nothing reaches org.freedesktop.Notifications) and its
// getNotifications() never settles at all. The plugin only fixes that if its preload marker
// actually reaches preload.js and the shim is installed there — a rename on either side would
// break notifications again without failing any other test.

const PLUGIN = path.join(__dirname, '..', 'webapps', 'plugins', 'notifications', 'notifications.js')
const { preloadArgs, PRELOAD_ARG, urgencyFor, iconFromDataUrl, MAX_ICON_BYTES } = require(PLUGIN)

// Setup:    The plugin's early hook, which is what enables the shim for an app.
// Action:   Ask it for the additionalArguments it contributes.
// Expected: Exactly the one marker — presence alone is the whole configuration.
test('preloadArgs contributes the shim marker', () => {
  expect(preloadArgs()).toEqual([PRELOAD_ARG])
  expect(PRELOAD_ARG).toBe('--voltage-notifications')
})

// Setup:    preload.js, the file that must recognise the marker.
// Action:   Look for the literal the plugin emits.
// Expected: Present. The two sides are wired by a bare string through additionalArguments, so
//           nothing but this test notices if one of them is renamed.
test('preload.js reads the same marker the plugin emits', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  expect(preload).toContain(`'${PRELOAD_ARG}'`)
  // The shim must patch BOTH halves of the persistent API: showNotification is the one that is
  // dropped, getNotifications the one that hangs forever and stalls the app before it shows
  // anything. Patching only the first leaves an app that awaits the second just as silent.
  expect(preload).toContain('swProto.showNotification')
  expect(preload).toContain('swProto.getNotifications')
})

// Setup:    The web `requireInteraction` flag.
// Action:   Map it onto a freedesktop urgency.
// Expected: 'critical' keeps the notification on screen until dismissed; everything else is
//           'normal' and auto-hides. 'low' is deliberately unused — it would suppress the popup.
test('urgencyFor maps requireInteraction onto the sticky urgency', () => {
  expect(urgencyFor(true)).toBe('critical')
  expect(urgencyFor(false)).toBe('normal')
  expect(urgencyFor(undefined)).toBe('normal')
})

// Setup:    Icon payloads that must never reach nativeImage.
// Action:   Decode them.
// Expected: undefined — the notification still goes out without an icon. A remote URL in
//           particular must be rejected here: main cannot authenticate it (the session cookies
//           live in the renderer), which is why the shim inlines icons as data URLs instead.
test('iconFromDataUrl rejects anything that is not an inlined, bounded data URL', () => {
  expect(iconFromDataUrl('https://example.com/avatar.png')).toBeUndefined()
  expect(iconFromDataUrl('')).toBeUndefined()
  expect(iconFromDataUrl(null)).toBeUndefined()
  expect(iconFromDataUrl(undefined)).toBeUndefined()
  expect(iconFromDataUrl(42)).toBeUndefined()
  // Over the size cap: refused before decoding, so a page cannot push megabytes per toast.
  expect(iconFromDataUrl('data:image/png;base64,' + 'A'.repeat(MAX_ICON_BYTES))).toBeUndefined()
})

// Setup:    The Microsoft apps this plugin was written for.
// Action:   Read their build configs.
// Expected: Both select the plugin. Teams and Outlook are the two apps whose notifications go
//           exclusively through the service-worker path, so dropping the entry silences them.
test('Teams and Outlook select the notifications plugin', () => {
  for (const profile of ['teams', 'outlook']) {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'webapps', `build.${profile}.json`), 'utf8'))
    expect(cfg.plugins).toContain('plugins/notifications/notifications.js')
  }
})

// Setup:    The GNOME extension, which owns the D-Bus name the plugin calls on a notification click.
// Action:   Compare the coordinates hard-coded on both sides.
// Expected: Identical. They are joined only by these literals (the plugin shells out to gdbus), so
//           a change on one side would silently degrade every click to the focus() fallback.
test('plugin and GNOME extension agree on the activation D-Bus address', () => {
  const plugin = fs.readFileSync(PLUGIN, 'utf8')
  const ext = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'plugins', 'gnome', 'extension.js'), 'utf8')
  for (const literal of ['de.db0x.Voltage', '/de/db0x/Voltage']) {
    expect(plugin).toContain(literal)
    expect(ext).toContain(literal)
  }
  expect(ext).toContain('ActivateApp')
  expect(plugin).toContain('ActivateApp')
})
