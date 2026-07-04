// docker-integration plugin (main-process module). Goal: route an app to a Docker container running
// locally (e.g. a self-hosted draw.io on http://localhost:8080) instead of its online service, and —
// opt-in — manage that container's lifecycle via `docker compose`. Default is route-only; bringing the
// container up is a per-app extra (the "Hybrid/Opt-in" model).
//
// Lifecycle is owned by the AppImage runtime (this process), not the Manager: resolveLaunch() brings
// the container up before the window loads (the core seam in app-window.js awaits it and routes the
// window at the returned URL), and attachPlugin() tears it down when the last window closes. The
// orchestration itself lives in container.js; this file is the interface + config resolution.

const fs     = require('node:fs')
const os     = require('node:os')
const path   = require('node:path')
const crypto = require('node:crypto')
const container = require('./container')

const log = (...a) => console.log('[docker-integration]', ...a)

// A stack's compose file may be named compose.yaml or compose.yml (both are canonical to docker).
function composeNameIn(dir) {
  for (const n of ['compose.yaml', 'compose.yml']) if (fs.existsSync(path.join(dir, n))) return n
  return null
}

// Curated compose stacks shipped under stacks/<id>/ (each a compose.yaml|yml + a stack.json describing
// it). Listed for the config dialog's Stack dropdown as [{ id, label }]; read live (cheap, and adding
// a stack dir then needs no code change). The framework injects this into the dialog via discovery —
// the renderer has no file access, so it can't read the directory itself.
function stacks() {
  const dir = path.join(__dirname, 'stacks')
  const out = []
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const stackDir = path.join(dir, e.name)
      let meta = {}, content = ''
      try { meta = JSON.parse(fs.readFileSync(path.join(stackDir, 'stack.json'), 'utf8')) } catch {}
      // content = the raw compose file, shown read-only in the config dialog's preview.
      const composeName = composeNameIn(stackDir)
      if (composeName) { try { content = fs.readFileSync(path.join(stackDir, composeName), 'utf8') } catch {} }
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
// A bundled stack is "rich" when it ships more than compose + stack.json (build contexts, config
// templates, …) — those extra files force on-disk materialization, see composeSpecFor.
function resolveStack(config) {
  // A custom file carries no metadata we can read here; reuse-detection/health then rely on a fixed
  // port (config.port), and the compose file is expected to honour ${VOLTAGE_PORT} for the URL.
  if (config.composeFile) return { file: config.composeFile, meta: {}, bundled: false }
  if (!config.stack) return null
  const dir = path.join(__dirname, 'stacks', config.stack)
  let composeName = null
  try { composeName = composeNameIn(dir) } catch {}
  if (!composeName) return null
  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'stack.json'), 'utf8')) } catch {}
  let rich = false
  try { rich = fs.readdirSync(dir).some(n => n !== composeName && n !== 'stack.json') } catch {}
  return { dir, composeName, meta, rich, bundled: true }
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

// Recursive copy that works out of app.asar: Electron's patched fs reads asar sources transparently,
// but cpSync does not — so walk + read/write file by file onto real disk. A stray .env in the SOURCE
// is never copied: secrets are generated per machine (materializeStack), and a developer's own .env
// accidentally left in a stack dir must not ship into anyone's runtime.
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.env') continue
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else fs.writeFileSync(d, fs.readFileSync(s))
  }
}

// Where a rich stack is materialized so the EXTERNAL docker process can read it. Snap-confined docker
// cannot read hidden $HOME paths (and gets a private /tmp), but its own $SNAP_USER_COMMON
// (~/snap/docker/common) is always readable — non-snap docker has no such restriction, so the normal
// voltage config tree is fine there.
function stackTargetDir(id) {
  return container.dockerIsSnap()
    ? path.join(os.homedir(), 'snap', 'docker', 'common', 'voltage-stacks', id)
    : path.join(os.homedir(), '.config', 'voltage', 'docker-stacks', id)
}

// Materializes a rich stack onto real disk: copies the shipped tree (overwriting, so bundled updates
// propagate on every launch), drops stack.json (voltage metadata, not for docker), and pre-creates
// bind-mount dirs (createDirs) so docker doesn't create them root-owned. NO .env is written — the
// app's config (pluginConfig.env, completed by completeConfig on Manager save) is the single source
// of every variable incl. secrets, delivered as process env on each compose call. A stale .env from
// the earlier design is removed so it can't shadow anything. Exported for tests.
function materializeStack(srcDir, targetDir, meta = {}) {
  copyTree(srcDir, targetDir)
  fs.rmSync(path.join(targetDir, 'stack.json'), { force: true })
  fs.rmSync(path.join(targetDir, '.env'), { force: true })
  for (const d of meta.createDirs || []) fs.mkdirSync(path.join(targetDir, d), { recursive: true })
}

// Build the compose source for the runtime. Three shapes:
//   custom file        → its real path (the user owns it).
//   bundled, single    → the compose CONTENT, piped to docker over stdin — no on-disk file, so neither
//                        asar nor snap-docker home-confinement can block it.
//   bundled, rich      → stdin can't carry build contexts/config files, so the whole stack dir is
//                        materialized to a docker-readable location and referenced by real path
//                        (relative ./paths in the compose then resolve against that dir).
function composeSpecFor(stack, stackId) {
  if (!stack.bundled) return { file: stack.file }
  if (stack.rich) {
    const target = stackTargetDir(stackId)
    try {
      materializeStack(stack.dir, target, stack.meta)
      log('materialized rich stack →', target)
      return { file: path.join(target, stack.composeName) }
    } catch (err) { log('materializing stack failed:', err.message); return null }
  }
  try { return { content: fs.readFileSync(path.join(stack.dir, stack.composeName), 'utf8') } }
  catch (err) { log('reading bundled compose failed:', err.message); return null }
}

// Manager-save hook (called from buildAppCfg for every selected plugin exporting completeConfig): the
// app's config is the SINGLE source of the stack's variables — there is no machine-local .env — so
// saving must complete it. Seeds the stack's env defaults for keys the user hasn't set, and generates
// any declared-but-missing secret (64-hex) ONCE: values already present are never touched, so secrets
// stay stable across saves/rebuilds (regenerating would orphan the containers' persisted state).
// build.private.*.json is gitignored, so persisted secrets don't leak into the repo.
function completeConfig(config = {}) {
  const stack = resolveStack(config)
  if (!stack || !stack.bundled) return config
  const env = { ...(config.env || {}) }
  for (const [k, v] of Object.entries(stack.meta.env || {})) if (!(k in env)) env[k] = String(v)
  for (const name of stack.meta.secrets || []) if (!env[name]) env[name] = crypto.randomBytes(32).toString('hex')
  return Object.keys(env).length ? { ...config, env } : config
}

// Environment handed to compose: stack env defaults, overridden by the per-app config.env (the baked
// build.*.json is the single source — no .env on disk), plus the auto/fixed port. A declared secret
// still missing at launch (config never saved through the Manager) gets an EPHEMERAL value so JWT
// signing works rather than silently running with an empty secret — with a log nudge, since ephemeral
// secrets change every launch. Keys are validated as env identifiers so a stray config value can't
// smuggle odd strings into the child environment.
function composeEnvFor(config, port, meta = {}) {
  const env = {}
  for (const [k, v] of Object.entries(meta.env || {})) env[k] = String(v)
  if (config.dataDir) env.VOLTAGE_DATA_DIR = config.dataDir
  for (const [k, v] of Object.entries(config.env || {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v))
      env[k] = String(v)
  }
  for (const name of meta.secrets || []) {
    if (!env[name]) {
      env[name] = crypto.randomBytes(32).toString('hex')
      log(`secret ${name} missing from the app config — using an ephemeral value (re-save the app in the Manager to persist one)`)
    }
  }
  env.VOLTAGE_PORT = String(port)
  return env
}

// Extra readiness gates a stack declares (stack.json "waitFor"): services the entry page depends on
// beyond the primary one — e.g. OnlyOffice's editor is blank until the DocumentServer answers, even
// though the backend (the routed service) is up in seconds. Each entry names a fixed `port` or a
// `portEnv` key resolved from the compose environment, plus an optional probe path/timeout. Returns
// the resolved [{ port, path, timeoutMs }]; entries whose port can't be resolved are skipped.
function waitForTargets(meta, env) {
  const out = []
  for (const w of meta.waitFor || []) {
    const port = Number(w.portEnv ? env[w.portEnv] : w.port)
    if (port > 0) out.push({ port, path: w.path || '/', timeoutMs: w.timeoutMs || 60_000 })
  }
  return out
}

// The routed URL keeps the baked pkg.url's path+query (e.g. /edit/beispiel.docx as the entry page) —
// only the origin is replaced by the container's localhost:<port>. A bare or root-path URL adds nothing.
function urlSuffixFrom(pkgUrl) {
  try {
    const u = new URL(pkgUrl)
    const s = u.pathname + u.search
    return s === '/' ? '' : s
  } catch { return '' }
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

  // The compose definition: stdin (bundled single-file), materialized dir (bundled rich), or the
  // user's real path (custom) — see composeSpecFor.
  const spec = composeSpecFor(stack, config.stack)
  if (!spec) return null

  // Env is also needed for the reuse probe / teardown below — compose parses ${VARS} on every
  // subcommand; without values it spams unset-variable warnings. The port is patched in once known.
  const env = composeEnvFor(config, 0, stack.meta)

  // Already up (a second window, or a leftover from a previous session)? Reuse its published port and
  // do NOT mark it as ours, so we won't tear it down.
  if (service && containerPort) {
    const existing = await container.composeHostPort(spec, project, service, containerPort, env)
    if (existing) {
      log('reusing already-running container on port', existing)
      return { url: `http://localhost:${existing}${urlSuffixFrom(pkg.url)}` }
    }
  }

  // Fresh start: a user-fixed port if set, else the next free port in the range.
  const fixed = Number(config.port) > 0 ? Number(config.port) : null
  let port = fixed ?? await container.findFreePort(range)
  if (!port) { log('no free port in range', range); return null }
  env.VOLTAGE_PORT = String(port)

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

  session = { spec, project, env }  // we own it now → tear down on last window close
  // Best-effort readiness gates; if something never answers we still return the URL and the window's
  // load guard surfaces the connection error (better than hanging the launch indefinitely). Beyond the
  // primary service, the stack may declare further waitFor targets (e.g. OnlyOffice's DocumentServer,
  // which boots far slower than the routed backend — loading before it answers shows a blank editor).
  const healthy = await container.waitHealthy(port, healthPath)
  for (const w of waitForTargets(stack.meta, env)) {
    const ok = await container.waitHealthy(w.port, w.path, w.timeoutMs)
    log(`waitFor :${w.port}${w.path} ready=${ok}`)
  }
  const url = `http://localhost:${port}${urlSuffixFrom(pkg.url)}`
  log(`container ready=${healthy} → ${url}`)
  return { url }
}

// Runs after the window exists (window.js loadPlugins). Refcounts windows and, when the last one
// closes, tears the container down — but only if this process started it (session set). down runs
// synchronously so it completes before the process exits on quit.
function attachPlugin(win, api) {
  windowCount++
  win.on('closed', () => {
    windowCount--
    if (windowCount <= 0 && session) {
      container.composeDownSync(session.spec, session.project, session.env)
      session = null
    }
  })
  return {}
}

// configurable: surfaces the gear button on the plugin chip and loads config.html (stack chooser +
// compose preview). managesUrl: this plugin owns the app's URL (it routes to a container), so the
// Manager locks the URL field while it's selected. composeEnvFor/urlSuffixFrom/materializeStack are
// exported for the unit tests.
module.exports = {
  attachPlugin, resolveLaunch, launchInfo, available, stacks,
  materializeStack, composeEnvFor, urlSuffixFrom, completeConfig, waitForTargets,
  managesUrl: true, configurable: true,
}
