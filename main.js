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

if (pkg.profile) {
  // App-window mode: profile is set — run as a single packaged web app.
  require('./src/app-window')()
} else {
  // Manager mode: no profile — run as the voltage app manager.
  require('./src/manager/ipc')()
  const { openManager } = require('./src/manager/window')
  app.whenReady().then(() => {
    openManager()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openManager()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
