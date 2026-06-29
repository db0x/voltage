// Container runtime helpers for the docker-integration plugin (main process). Kept separate from the
// plugin's interface (docker-integration.js) so the Docker/Compose orchestration is testable in
// isolation and the plugin file stays a thin wiring layer.
//
// All compose calls are scoped to a per-app project name (voltage-<profile>) so a running container
// can be detected/reused and torn down deterministically. Host port discovery + the free-port probe
// let the AppImage own port assignment (the user never picks one): on a fresh start we bind the next
// free port in a range; if the project is already up (a second window, or a leftover from a previous
// session) we reuse its published port instead of starting a second instance.

const net  = require('node:net')
const http = require('node:http')
const { execFile, execFileSync } = require('node:child_process')

// Default host-port search range. Deliberately away from common service ports (8080 etc.) to avoid
// clashes; a stack may override it via stack.json "portRange": [start, end].
const DEFAULT_PORT_RANGE = [18000, 18099]

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Promise wrapper around execFile so the async compose calls read linearly. Rejects on non-zero exit.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err) }
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// True if `port` can be bound on loopback right now. Note: free-at-probe ≠ free-at-compose-up, so the
// caller still handles a port-conflict from `up` (the brief race) by retrying with another free port.
function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

// First free port in [start, end] inclusive, or null if the whole range is taken.
async function findFreePort([start, end] = DEFAULT_PORT_RANGE) {
  for (let p = start; p <= end; p++) if (await isPortFree(p)) return p
  return null
}

// The host port a running compose project publishes for <service>'s <containerPort>, or null when the
// project isn't up (or the lookup fails). Doubles as the "is it already running?" probe — a non-null
// result means reuse the running container instead of starting a new one.
async function composeHostPort(file, project, service, containerPort) {
  try {
    const { stdout } = await run('docker', ['compose', '-p', project, '-f', file, 'port', service, String(containerPort)], { timeout: 10_000 })
    const m = stdout.trim().match(/:(\d+)\s*$/)
    return m ? Number(m[1]) : null
  } catch { return null }
}

// Bring the stack up detached. `up -d` pulls the image synchronously before returning, so this can run
// for minutes on the very first launch — the caller shows a splash meanwhile. env carries the compose
// ${VAR} substitutions (VOLTAGE_PORT, optionally VOLTAGE_DATA_DIR). Throws on failure (e.g. port in use).
async function composeUp(file, project, env) {
  await run('docker', ['compose', '-p', project, '-f', file, 'up', '-d'],
    { env: { ...process.env, ...env }, timeout: 600_000 })
}

// Tear the stack down (containers + network). Synchronous on purpose: it runs from the window's
// 'closed' handler as the app quits, and an async call would be killed when the process exits before
// it finishes. Best-effort — a failure here must never block shutdown.
function composeDownSync(file, project) {
  try { execFileSync('docker', ['compose', '-p', project, '-f', file, 'down'], { timeout: 60_000, stdio: 'ignore' }) }
  catch {}
}

// One HTTP probe against the service; resolves true on any response (even a 4xx — the server is up).
function probe(port, healthPath) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: healthPath || '/', timeout: 2_000 }, res => {
      res.resume()
      resolve(typeof res.statusCode === 'number')
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// Poll the service until it answers or the timeout elapses. Returns whether it became healthy; the
// caller may still load the URL on timeout (the window's load guard surfaces a real connection error).
async function waitHealthy(port, healthPath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(port, healthPath)) return true
    await sleep(500)
  }
  return false
}

module.exports = {
  DEFAULT_PORT_RANGE, findFreePort, isPortFree,
  composeHostPort, composeUp, composeDownSync, waitHealthy,
}
