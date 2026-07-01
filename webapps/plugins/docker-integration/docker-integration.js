// docker-integration plugin (main-process module). Goal: route an app to a Docker container running
// locally (e.g. a self-hosted draw.io on http://localhost:8080) instead of its online service, and —
// opt-in — manage that container's lifecycle via `docker compose`. Default is route-only; bringing the
// container up is a per-app extra (the "Hybrid/Opt-in" model).
//
// Lifecycle is owned by the AppImage runtime (this process), not the Manager: resolveLaunch() brings
// the container up before the window loads (the core seam in app-window.js awaits it and routes the
// window at the returned URL), and attachPlugin() tears it down when the last window closes. The
// orchestration itself lives in container.js; this file is the interface + config resolution.

const fs   = require('node:fs')
const path = require('node:path')
const container = require('./container')

const log = (...a) => console.log('[docker-integration]', ...a)

// Curated compose stacks shipped under stacks/<id>/ (each a compose.yaml + a stack.json describing
// it). Listed for the config dialog's Stack dropdown as [{ id, label }]; read live (cheap, and adding
// a stack dir then needs no code change). The framework injects this into the dialog via discovery —
// the renderer has no file access, so it can't read the directory itself.
function stacks() {
  const dir = path.join(__dirname, 'stacks')
  const out = []
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      let meta = {}, content = ''
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'stack.json'), 'utf8')) } catch {}
      // content = the raw compose.yaml, shown read-only in the config dialog's preview.
      try { content = fs.readFileSync(path.join(dir, e.name, 'compose.yaml'), 'utf8') } catch {}
      out.push({ id: e.name, label: meta.label || e.name, icon: stackIconDataUrl(meta.icon), content })
    }
  } catch {}
  return out
}

// Repo/AppImage root (three levels up from this plugin dir) — where the shared assets/ tree lives. A
// stack's "icon" in stack.json is resolved relative to it (e.g. "assets/webapps/drawio.svg").
const APP_ROOT = path.join(__dirname, '..', '..', '..')

function svgDataUrl(absPath) {
  try { return `data:image/svg+xml;base64,${fs.readFileSync(absPath).toString('base64')}` }
  catch { return null }
}

// A stack's chooser icon: the icon named in stack.json (repo-root-relative or absolute), else the
// generic docker glyph as a fallback.
function stackIconDataUrl(iconRel) {
  if (iconRel) {
    const url = svgDataUrl(path.isAbsolute(iconRel) ? iconRel : path.join(APP_ROOT, iconRel))
    if (url) return url
  }
  return svgDataUrl(path.join(__dirname, 'docker.svg'))
}

// Whether Docker + a usable Compose (v2 `docker compose` OR v1 `docker-compose`) are present. Delegates
// to the runtime's own detection (container.detectCompose, cached + PATH-augmented) so "available" and
// "actually starts" can't disagree — including on apt installs that ship only the legacy v1 binary.
// VOLTAGE_TEST_DOCKER forces the result in tests (0 = unavailable, 1 = available) so the grey-out
// behaviour is deterministic without a real Docker install.
function dockerAvailable() {
  const override = process.env.VOLTAGE_TEST_DOCKER
  if (override === '0') return false
  if (override === '1') return true
  return container.detectCompose() !== null
}

// Framework availability hook: a plugin may export available() → boolean | { available, reason }. The
// Manager keeps the plugin in the selection list but greys it out (unselectable) when this reports
// unavailable, using `reason` (an i18n key) as the hover explanation. docker-integration needs Docker
// + Compose, so without them routing an app to a local container is impossible.
function available() {
  return dockerAvailable() ? { available: true } : { available: false, reason: 'dockerUnavailable' }
}

// Per-app settings arrive as api.config (pkg.pluginConfig[<this plugin's path>]). Resolve the compose
// file + its metadata: a curated bundled stack (stacks/<id>/), or a power-user custom compose file
// (composeFile, which overrides the stack). null = not configured for a container → online fallback.
function resolveStack(config) {
  // A custom file carries no metadata we can read here; reuse-detection/health then rely on a fixed
  // port (config.port), and the compose file is expected to honour ${VOLTAGE_PORT} for the URL.
  if (config.composeFile) return { file: config.composeFile, meta: {}, bundled: false }
  if (!config.stack) return null
  const dir  = path.join(__dirname, 'stacks', config.stack)
  const file = path.join(dir, 'compose.yaml')
  if (!fs.existsSync(file)) return null
  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'stack.json'), 'utf8')) } catch {}
  return { file, meta, bundled: true }
}

// plugin.svg as a data URL for the "starting…" splash — the self-coloured whale-on-blue glyph reads
// on both the light and dark card backgrounds, so no recolouring is needed.
function dockerIconDataUrl() {
  try {
    return `data:image/svg+xml;base64,${fs.readFileSync(path.join(__dirname, 'plugin.svg')).toString('base64')}`
  } catch { return null }
}

// Splash info read by the core (app-window.js) BEFORE resolveLaunch runs, to render the in-window
// "starting…" page: the docker glyph + wording that says the required container is being started.
// Returns {} when no container is configured, so a misconfigured app just gets the generic splash.
function launchInfo(pkg, { config = {}, i18n = {} } = {}) {
  if (!resolveStack(config)) return {}
  const name = pkg.displayName || pkg.profile
  return {
    iconSrc: dockerIconDataUrl(),
    title:   (i18n.appStarting || 'Starting {name}…').replace('{name}', name),
    hint:    i18n.dockerStartingHint || 'The required Docker container is being started…',
  }
}

// Build the compose source for the runtime: a bundled stack passes its CONTENT (read from inside
// app.asar via fs, then piped to docker over stdin — no on-disk file, so neither asar nor snap-docker
// home-confinement can block it); a custom file passes its real path.
function composeSpecFor(stack) {
  if (!stack.bundled) return { file: stack.file }
  try { return { content: fs.readFileSync(stack.file, 'utf8') } }
  catch (err) { log('reading bundled compose failed:', err.message); return null }
}

// Set when THIS process started the container (drives teardown); the reuse path leaves it null so a
// container that was already running is never torn down under another window/process.
let session = null
let windowCount = 0  // open windows of this app in this process — refcount for teardown

// Async pre-launch hook (awaited by the core seam in app-window.js before the window opens). Brings
// the configured container up and returns the URL to load; returns null to fall back to the online
// pkg.url. The AppImage owns port assignment — no user-picked port unless they set a fixed one.
async function resolveLaunch(pkg, api = {}) {
  const config = api.config || {}
  const stack = resolveStack(config)
  if (!stack) { log('no stack configured → online fallback'); return null }

  const project = `voltage-${pkg.profile}`
  const { service, containerPort, healthPath = '/', portRange } = stack.meta
  const range = portRange || container.DEFAULT_PORT_RANGE
  log(`stack=${config.stack || '(custom)'} project=${project}`)

  // The compose definition is piped to docker over stdin (bundled) or referenced by path (custom).
  const spec = composeSpecFor(stack)
  if (!spec) return null

  // Already up (a second window, or a leftover from a previous session)? Reuse its published port and
  // do NOT mark it as ours, so we won't tear it down.
  if (service && containerPort) {
    const existing = await container.composeHostPort(spec, project, service, containerPort)
    if (existing) { log('reusing already-running container on port', existing); return { url: `http://localhost:${existing}` } }
  }

  // Fresh start: a user-fixed port if set, else the next free port in the range.
  const fixed = Number(config.port) > 0 ? Number(config.port) : null
  let port = fixed ?? await container.findFreePort(range)
  if (!port) { log('no free port in range', range); return null }

  const env = { VOLTAGE_PORT: String(port) }
  if (config.dataDir) env.VOLTAGE_DATA_DIR = config.dataDir

  try {
    log('compose up on port', port, '…')
    await container.composeUp(spec, project, env)
  } catch (err) {
    log('compose up failed:', (err.stderr || err.message || '').toString().trim())
    // Free-at-probe but taken-at-up (the brief race): retry once with another free port — but only
    // when auto-picking. A user-fixed port that's busy is a real conflict, so fall back instead.
    if (fixed) return null
    port = await container.findFreePort(range)
    if (!port) return null
    env.VOLTAGE_PORT = String(port)
    try { await container.composeUp(spec, project, env) }
    catch (err2) { log('compose up retry failed:', (err2.stderr || err2.message || '').toString().trim()); return null }
  }

  session = { spec, project }  // we own it now → tear down on last window close
  // Best-effort readiness gate; if it never answers we still return the URL and the window's load
  // guard surfaces the connection error (better than hanging the launch indefinitely).
  const healthy = await container.waitHealthy(port, healthPath)
  log(`container ready=${healthy} → http://localhost:${port}`)
  return { url: `http://localhost:${port}` }
}

// Runs after the window exists (window.js loadPlugins). Refcounts windows and, when the last one
// closes, tears the container down — but only if this process started it (session set). down runs
// synchronously so it completes before the process exits on quit.
function attachPlugin(win, api) {
  windowCount++
  win.on('closed', () => {
    windowCount--
    if (windowCount <= 0 && session) {
      container.composeDownSync(session.spec, session.project)
      session = null
    }
  })
  return {}
}

// configurable: surfaces the gear button on the plugin chip and loads config.html as the dialog
// (currently empty). resolveLaunch is exported now so the contract is visible, even though the core
// hook that invokes it is not wired yet. managesUrl: this plugin owns the app's URL (it routes to a
// container), so the Manager locks the URL field while it's selected.
module.exports = { attachPlugin, resolveLaunch, launchInfo, available, stacks, managesUrl: true, configurable: true }
