// Container runtime helpers for the docker-integration plugin (main process). Kept separate from the
// plugin's interface (docker-integration.js) so the Docker/Compose orchestration is testable in
// isolation and the plugin file stays a thin wiring layer.
//
// All compose calls are scoped to a per-app project name (voltage-<profile>) so a running container
// can be detected/reused and torn down deterministically. Host port discovery + the free-port probe
// let the AppImage own port assignment (the user never picks one).
//
// Compose command detection (detectCompose): prefer Compose v2 (`docker compose`), fall back to the
// legacy v1 binary (`docker-compose`, still common on apt installs) — so availability and the runtime
// agree regardless of how docker was installed.
//
// Compose file delivery differs per version to sidestep two real blockers: the bundled compose.yaml
// lives inside app.asar (unreadable by the external docker process), and snap-packaged docker (always
// v2) is confined away from hidden $HOME paths. So v2 gets the content over STDIN (`-f -`), which
// dodges both; v1 (no dependable stdin, and never snap) gets a real temp file written from the same
// content. A user's custom compose file passes its real path either way.

const net  = require('node:net')
const http = require('node:http')
const os   = require('node:os')
const path = require('node:path')
const fs   = require('node:fs')
const { spawn, execFileSync } = require('node:child_process')

// Default host-port search range. Deliberately away from common service ports (8080 etc.) to avoid
// clashes; a stack may override it via stack.json "portRange": [start, end].
const DEFAULT_PORT_RANGE = [18000, 18099]

// GUI/.desktop-launched AppImages often start with a minimal PATH that lacks docker (snap's /snap/bin,
// or apt's /usr/bin depending on the session). Prepend the usual locations so docker/docker-compose
// resolve the same way they do in an interactive shell.
const DOCKER_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin', process.env.PATH || ''].join(':')
const withEnv = (extra = {}) => ({ ...process.env, PATH: DOCKER_PATH, ...extra })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Detect the compose command once: Compose v2 first, then the v1 fallback. Returns the argv prefix
// (['docker','compose'] or ['docker-compose']) or null if neither is usable. Cached for the process.
let composeCmd  // undefined until probed; null = none found
function detectCompose() {
  if (composeCmd !== undefined) return composeCmd
  for (const cmd of [['docker', 'compose'], ['docker-compose']]) {
    try {
      execFileSync(cmd[0], [...cmd.slice(1), 'version'], { stdio: 'ignore', env: withEnv() })
      composeCmd = cmd
      return cmd
    } catch {}
  }
  composeCmd = null
  return null
}

// Materialize a bundled stack's content to a temp file (for the v1 path), cached on the spec so the
// same file is reused across up/port/down within a session. v1 is never snap-confined, so /tmp is fine.
function tmpFileFor(spec) {
  if (!spec._tmpFile) {
    spec._tmpFile = path.join(os.tmpdir(), `voltage-compose-${process.pid}-${Date.now()}.yaml`)
    fs.writeFileSync(spec._tmpFile, spec.content ?? '')
  }
  return spec._tmpFile
}

// Build { bin, args, input } for `<compose> -p <project> <fileArgs> <tail…>`, choosing stdin (v2) or a
// temp file (v1) for a bundled spec, or the real path for a custom file. Throws when no compose exists.
function composeInvoke(spec, project, tail) {
  const cmd = detectCompose()
  if (!cmd) throw new Error('no docker compose (v2 or v1) found')
  const v2 = cmd[cmd.length - 1] === 'compose'
  let fileArgs, input
  if (spec.file)      fileArgs = ['-f', spec.file]
  else if (v2)      { fileArgs = ['-f', '-']; input = spec.content }
  else                fileArgs = ['-f', tmpFileFor(spec)]
  return { bin: cmd[0], args: [...cmd.slice(1), '-p', project, ...fileArgs, ...tail], input }
}

// spawn-based runner so the compose file can be fed over stdin. Rejects on spawn error, non-zero exit,
// or timeout; the rejection carries stderr so callers can log the real docker message.
function run(bin, args, { input, env, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: withEnv(env) })
    let stdout = '', stderr = ''
    const timer = timeout ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')) }, timeout) : null
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.stdin.on('error', () => {})  // ignore EPIPE if docker exits before reading stdin
    child.on('error', err => { if (timer) clearTimeout(timer); reject(err) })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else { const e = new Error(`${bin} exited ${code}`); e.stderr = stderr; e.stdout = stdout; reject(e) }
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
    const { bin, args, input } = composeInvoke(spec, project, ['port', service, String(containerPort)])
    const { stdout } = await run(bin, args, { input, timeout: 10_000 })
    const m = stdout.trim().match(/:(\d+)\s*$/)
    return m ? Number(m[1]) : null
  } catch { return null }
}

// Bring the stack up detached. `up -d` pulls the image synchronously before returning, so this can run
// for minutes on the very first launch — the caller shows a splash meanwhile. env carries the compose
// ${VAR} substitutions (VOLTAGE_PORT, optionally VOLTAGE_DATA_DIR). Throws on failure (e.g. port in use).
async function composeUp(spec, project, env) {
  const { bin, args, input } = composeInvoke(spec, project, ['up', '-d'])
  await run(bin, args, { input, env, timeout: 600_000 })
}

// Tear the stack down (containers + network) and drop any temp compose file. Synchronous on purpose:
// it runs from the window's 'closed' handler as the app quits, and an async call would be killed when
// the process exits before it finishes. Best-effort — a failure here must never block shutdown.
function composeDownSync(spec, project) {
  try {
    const { bin, args, input } = composeInvoke(spec, project, ['down'])
    execFileSync(bin, args, { input, env: withEnv(), timeout: 60_000 })
  } catch {}
  if (spec._tmpFile) { try { fs.unlinkSync(spec._tmpFile) } catch {} }
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
  DEFAULT_PORT_RANGE, findFreePort, isPortFree, withEnv, detectCompose,
  composeHostPort, composeUp, composeDownSync, waitHealthy,
}
