// Generic async subprocess helper, kept separate so it can be shared by the slow
// lookups that several handler modules pre-warm at load time (icons, obsidian, rclone).

const { spawn } = require('node:child_process')

// Runs a command asynchronously and resolves with stdout string ('' on error or timeout).
function runAsync(cmd, args, timeoutMs = 3000) {
  return new Promise(resolve => {
    let stdout = ''
    let settled = false
    const done = val => { if (!settled) { settled = true; resolve(val) } }
    try {
      const child = spawn(cmd, args)
      const timer = setTimeout(() => { child.kill(); done('') }, timeoutMs)
      child.stdout.on('data', d => { stdout += d })
      child.on('close', () => { clearTimeout(timer); done(stdout) })
      child.on('error', () => { clearTimeout(timer); done('') })
    } catch { done('') }
  })
}

module.exports = { runAsync }
