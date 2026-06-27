// Entry point — dispatches into app-window mode or manager mode depending on whether
// a build profile is set in package.json. All domain logic lives in src/.

const { app, BrowserWindow, Menu } = require('electron')

const pkg = require(app.getAppPath() + '/package.json')

Menu.setApplicationMenu(null)

// Skip GPU/Wayland switches in tests — Playwright runs without a display server
// and some switches crash the headless Chromium instance used by tests.
if (!process.env.VOLTAGE_TEST) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'wayland')
  app.commandLine.appendSwitch('use-gl',              'angle')
  app.commandLine.appendSwitch('disable-vulkan')
  app.commandLine.appendSwitch('disable-features',   'Vulkan,UseSkiaRenderer')
  app.commandLine.appendSwitch('enable-features',    'WebRTCPipeWireCapturer')
  app.commandLine.appendSwitch('enable-webrtc-pipewire-capturer')
}

// Notice mode: the generic launcher (src/launcher.js) starts the app this way when a target
// AppImage is unreachable (e.g. its project directory is still encrypted), to show a Voltage-styled
// "app unavailable" dialog instead of failing silently. Checked first because it overrides whichever
// of the two normal modes package.json would otherwise select.
const noticeArg = process.argv.find(a => a.startsWith('--voltage-notice='))

if (noticeArg !== undefined) {
  require('./src/notice/window')(noticeArg.slice('--voltage-notice='.length))
} else if (pkg.profile) {
  // App-window mode: profile is set — run as a single packaged web app.
  require('./src/app-window')()
} else {
  // Manager mode: no profile — run as the voltage app manager. Single-instance so an app's
  // "configure" button (which relaunches with --voltage-edit-config=<profile>) focuses the running
  // Manager and routes its request into the edit dialog instead of opening a second window.
  const { editProfileFromArgv, setPendingEditProfile } = require('./src/manager/edit-config')
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    require('./src/manager/ipc')()
    // Cold start: the renderer pulls this once after init (manager:initial-edit-profile).
    setPendingEditProfile(editProfileFromArgv(process.argv))
    const { openManager } = require('./src/manager/window')
    // Already running: focus the window and push the requested profile to the open-edit deep link.
    app.on('second-instance', (_event, argv) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.focus()
      const profile = editProfileFromArgv(argv)
      if (profile) win.webContents.send('manager:open-edit', profile)
    })
    app.whenReady().then(() => {
      openManager()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) openManager()
      })
    })
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
