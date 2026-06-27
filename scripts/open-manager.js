const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

// Launches the Voltage Manager (manager mode) and, when a profile is given, tells it to open straight
// into that app's edit dialog via --voltage-edit-config=<profile>. Invoked from a running app's
// "configure" button (src/window.js openConfigInManager) through a bash+nvm shell so the managed node
// is on PATH and `.`/require('electron') resolve in the repo. Mirrors start.js's hard-link trick so
// the process identifies as "voltage" (WM_CLASS), and spawns the Manager DETACHED so this bootstrap
// exits immediately — the Manager is single-instance, so a second launch just focuses the running
// window and routes the request there.
const electronBin = require('electron')
const voltageBin  = path.join(path.dirname(electronBin), 'voltage')

try { fs.unlinkSync(voltageBin) } catch {}
try { fs.linkSync(electronBin, voltageBin) } catch {}

const profile = process.argv[2] || ''
const args = ['.', '--no-sandbox']
if (profile) args.push(`--voltage-edit-config=${profile}`)

spawn(voltageBin, args, { detached: true, stdio: 'ignore' }).unref()
