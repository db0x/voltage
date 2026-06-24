const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// Launches the Voltage app in notice mode to show a styled "app unavailable" dialog. Mirrors
// start.js's hard-link trick so the process identifies as "voltage" (WM_CLASS) instead of
// "electron" — a hard link shares the binary's inode while /proc/self/exe reports the new name.
//
// Invoked by the generic launcher (~/.local/share/voltage/voltage-launch) when an app's AppImage
// cannot be reached. The launcher cd's into the repo first, so `.` and require('electron') resolve
// here. The app name to display is passed as argv[2].
const electronBin = require('electron')
const voltageBin  = path.join(path.dirname(electronBin), 'voltage')

try { fs.unlinkSync(voltageBin) } catch {}
try { fs.linkSync(electronBin, voltageBin) } catch {}

const name = process.argv[2] || ''
execFileSync(voltageBin, ['.', '--no-sandbox', `--voltage-notice=${name}`], { stdio: 'ignore' })
