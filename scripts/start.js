const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// A symlink won't work: Linux resolves symlinks in execve(), so /proc/self/exe
// still points at the real electron binary and Chromium reads "electron" as the
// process name (→ WM_CLASS).  A hard link shares the same inode but Linux stores
// the exec'd path as /proc/self/exe, so Chromium sees "voltage" instead.
const electronBin = require('electron')
const voltageBin  = path.join(path.dirname(electronBin), 'voltage')

try { fs.unlinkSync(voltageBin) } catch {}
fs.linkSync(electronBin, voltageBin)

execFileSync(voltageBin, ['.', '--no-sandbox'], { stdio: 'inherit' })
