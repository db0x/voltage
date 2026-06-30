// Container runtime helpers for the docker-integration plugin (main process). Kept separate from the
// plugin's interface (docker-integration.js) so the Docker/Compose orchestration is testable in
// isolation and the plugin file stays a thin wiring layer.
//
// All compose calls are scoped to a per-app project name (voltage-<profile>) so a running container
// can be detected/reused and torn down deterministically. Host port discovery + the free-port probe
// let the AppImage own port assignment (the user never picks one): on a fresh start we bind the next
// free port in a range; if the project is already up (a second window, or a leftover from a previous
// session) we reuse its published port instead of starting a second instance.
//
// The compose definition is fed to docker over STDIN (`-f -`) rather than as a file path. This dodges
// two real-world blockers at once: the bundled compose.yaml lives inside app.asar (which the external
// docker process can't read), and snap-packaged docker is confined to non-hidden $HOME paths (so a
// materialized copy under ~/.config is "permission denied"). Piping the content sidesteps both.

const net  = require('node:net')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')

// Default host-port search range. Deliberately away from common service ports (8080 etc.) to avoid
// clashes; a stack may override it via stack.json "portRange": [start, end].
const DEFAULT_PORT_RANGE = [18000, 18099]

// GUI/.desktop-launched AppImages often start with a minimal PATH that lacks docker — notably the
// snap location /snap/bin — which would make the spawn fail with ENOENT. Prepend the usual binary
// locations so docker resolves the same way it does in an interactive shell.
const DOCKER_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin', process.env.PATH || ''].join(':')
const withEnv = (extra = {}) => ({ ...process.env, PATH: DOCKER_PATH, ...extra })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A compose source → the `-f` argument(s) + optional stdin payload. Bundled stacks pass their CONTENT
// (piped via `-f -`); a user's custom compose passes its real file path.
function composeSource(spec) {
  return spec.content != null ? { fileArgs: ['-f', '-'], input: spec.content } : { fileArgs: ['-f', spec.file] }
}

// spawn-based docker runner so the compose file can be fed over stdin. Rejects on spawn error,
// non-zero exit, or timeout; the rejection carries stderr so callers can log the real docker message.
function run(args, { input, env, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: withEnv(env) })
    let stdout = '', stderr = ''
    const timer = timeout ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')) }, timeout) : null
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.stdin.on('error', () => {})  // ignore EPIPE if docker exits before reading stdin
    child.on('error', err => { if (timer) clearTimeout(timer); reject(err) })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else { const e = new Error(`docker exited ${code}`); e.stderr = stderr; e.stdout = stdout; reject(e) }
    })
    child.stdin.end(input ?? '')
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
async function composeHostPort(spec, project, service, containerPort) {
  try {
    const { fileArgs, input } = composeSource(spec)
    const { stdout } = await run(['compose', '-p', project, ...fileArgs, 'port', service, String(containerPort)], { input, timeout: 10_000 })
    const m = stdout.trim().match(/:(\d+)\s*$/)
    return m ? Number(m[1]) : null
  } catch { return null }
}

// Bring the stack up detached. `up -d` pulls the image synchronously before returning, so this can run
// for minutes on the very first launch — the caller shows a splash meanwhile. env carries the compose
// ${VAR} substitutions (VOLTAGE_PORT, optionally VOLTAGE_DATA_DIR). Throws on failure (e.g. port in use).
async function composeUp(spec, project, env) {
  const { fileArgs, input } = composeSource(spec)
  await run(['compose', '-p', project, ...fileArgs, 'up', '-d'], { input, env, timeout: 600_000 })
}

// Tear the stack down (containers + network). Synchronous on purpose: it runs from the window's
// 'closed' handler as the app quits, and an async call would be killed when the process exits before
// it finishes. Best-effort — a failure here must never block shutdown.
function composeDownSync(spec, project) {
  try {
    const { fileArgs, input } = composeSource(spec)
    execFileSync('docker', ['compose', '-p', project, ...fileArgs, 'down'], { input, env: withEnv(), timeout: 60_000 })
  } catch {}
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
  DEFAULT_PORT_RANGE, findFreePort, isPortFree, withEnv,
  composeHostPort, composeUp, composeDownSync, waitHealthy,
}
