const { test, expect } = require('@playwright/test')
const net = require('node:net')

// Plain Node tests (no browser) for the docker-integration runtime: the free-port finder and the
// resolveLaunch fallback paths. The compose calls themselves need a real Docker daemon, so they are
// not exercised here — only the host-side logic that decides ports and when to do nothing.

const { findFreePort, isPortFree } = require('../webapps/plugins/docker-integration/container.js')
const { resolveLaunch } = require('../webapps/plugins/docker-integration/docker-integration.js')

// Bind an ephemeral loopback port and return { port, release } so a test can hold it occupied.
async function occupyPort() {
  const srv = net.createServer()
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '127.0.0.1', res) })
  return { port: srv.address().port, release: () => new Promise(r => srv.close(r)) }
}

// Setup:    A port that is bound, then released.
// Action:   Probe it with isPortFree before and after release.
// Expected: false while bound, true once free — the primitive the finder relies on.
test('isPortFree reflects whether a port is bound', async () => {
  const { port, release } = await occupyPort()
  expect(await isPortFree(port)).toBe(false)
  await release()
  expect(await isPortFree(port)).toBe(true)
})

// Setup:    A bound port at the start of a small range.
// Action:   Ask findFreePort for that range.
// Expected: It skips the taken port and returns a later, free one — proving auto port assignment
//           steps over what's already in use.
test('findFreePort skips a bound port and returns the next free one', async () => {
  const { port: taken, release } = await occupyPort()
  const got = await findFreePort([taken, taken + 5])
  expect(got).toBeGreaterThan(taken)
  await release()
})

// Setup:    A bound port used as a single-port range.
// Action:   Ask findFreePort for [taken, taken].
// Expected: null — a fully occupied range yields no port, which resolveLaunch treats as "give up".
test('findFreePort returns null when the whole range is taken', async () => {
  const { port: taken, release } = await occupyPort()
  expect(await findFreePort([taken, taken])).toBeNull()
  await release()
})

// Setup:    An app with no container configured (empty plugin config).
// Action:   Call resolveLaunch.
// Expected: null — the plugin does nothing and the app falls back to its online pkg.url. No Docker is
//           touched, so this must hold even on a host without Docker.
test('resolveLaunch returns null when no container is configured', async () => {
  expect(await resolveLaunch({ profile: 'demo' }, { config: {} })).toBeNull()
})

// Setup:    A config naming a stack that does not exist on disk.
// Action:   Call resolveLaunch.
// Expected: null — an unresolvable stack falls back gracefully rather than throwing or shelling out.
test('resolveLaunch returns null for an unknown stack', async () => {
  expect(await resolveLaunch({ profile: 'demo' }, { config: { stack: 'does-not-exist' } })).toBeNull()
})

// ── Rich stacks (build contexts / extra files) ────────────────────────────────

const os   = require('node:os')
const fs   = require('node:fs')
const path = require('node:path')
const { materializeStack, stacks } = require('../webapps/plugins/docker-integration/docker-integration.js')

// Creates a throwaway stack dir inside the REAL stacks tree (that's where stacks()/resolveStack
// read), runs fn, and always removes it again — the same write-into-webapps-then-clean-up pattern
// the manager fixtures use for TEST_CONFIGS. Keeps .yml/completeConfig coverage independent of which
// curated stacks happen to ship (the onlyoffice stack that used to carry these cases was dropped).
const STACKS_DIR = path.join(__dirname, '..', 'webapps', 'plugins', 'docker-integration', 'stacks')
function withTempStack(id, files, fn) {
  const dir = path.join(STACKS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  try {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
    fn()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Setup:    The shipped drawio stack (compose.yaml) plus a temp stack shipping a compose.yml.
// Action:   List the stacks for the config dialog.
// Expected: Both appear with a non-empty compose preview — proving discovery accepts compose.yml as
//           well as compose.yaml (a .yml-only stack used to resolve to nothing).
test('stacks() accepts compose.yml alongside compose.yaml', () => {
  withTempStack('test-yml-stack', {
    'compose.yml': 'services:\n  web:\n    image: test/yml-marker\n',
    'stack.json':  '{ "label": "Test YML" }',
  }, () => {
    const byId = Object.fromEntries(stacks().map(s => [s.id, s]))
    expect(byId.drawio.content).toContain('jgraph/drawio')
    expect(byId['test-yml-stack'].label).toBe('Test YML')
    expect(byId['test-yml-stack'].content).toContain('test/yml-marker')
  })
})

// Setup:    A temp source stack (compose.yml + a build-context file + a stray developer .env), and a
//           target still carrying a .env from the earlier .env-based design.
// Action:   Materialize into the target.
// Expected: The tree is copied (build context included), stack.json is dropped, the bind-mount dir
//           exists — and NO .env ends up in the target: the app config is the single source of the
//           stack environment, so neither the source's stray .env is shipped nor the stale one kept
//           (it could shadow config values via compose's .env auto-read).
test('materializeStack copies the tree and leaves no .env behind', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-stack-src-'))
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'voltage-stack-dst-'))
  try {
    fs.writeFileSync(path.join(src, 'compose.yml'), 'services: {}\n')
    fs.mkdirSync(path.join(src, 'backend'))
    fs.writeFileSync(path.join(src, 'backend', 'Dockerfile'), 'FROM scratch\n')
    fs.writeFileSync(path.join(src, 'stack.json'), '{}')
    fs.writeFileSync(path.join(src, '.env'), 'JWT_SECRET=developer-leak\n')
    fs.writeFileSync(path.join(dst, '.env'), 'JWT_SECRET=stale-old-design\n')

    materializeStack(src, dst, { createDirs: ['documents'] })

    expect(fs.existsSync(path.join(dst, 'backend', 'Dockerfile'))).toBe(true)
    expect(fs.existsSync(path.join(dst, 'stack.json'))).toBe(false)
    expect(fs.existsSync(path.join(dst, 'documents'))).toBe(true)
    expect(fs.existsSync(path.join(dst, '.env'))).toBe(false)
  } finally {
    fs.rmSync(src, { recursive: true, force: true })
    fs.rmSync(dst, { recursive: true, force: true })
  }
})

const { completeConfig } = require('../webapps/plugins/docker-integration/docker-integration.js')

// Setup:    A temp stack declaring env defaults + secrets, and an app config choosing it with one env
//           value the user already set.
// Action:   Run the Manager-save completion hook twice.
// Expected: Stack env defaults are seeded only where unset (the user's value wins), all declared
//           secrets are generated as 64-hex — and a second run changes NOTHING, so secrets persisted
//           in build.private.*.json stay stable across re-saves (regenerating would orphan the
//           containers' persisted state).
test('completeConfig seeds defaults + generates secrets once, stable across saves', () => {
  withTempStack('test-env-stack', {
    'compose.yml': 'services: {}\n',
    'stack.json':  JSON.stringify({
      label: 'Test Env', env: { SERVER_HOST: 'localhost', USER_NAME: 'Default' }, secrets: ['JWT_SECRET'],
    }),
  }, () => {
    const first = completeConfig({ stack: 'test-env-stack', env: { USER_NAME: 'Custom' } })
    expect(first.env.USER_NAME).toBe('Custom')            // user value wins over the default
    expect(first.env.SERVER_HOST).toBe('localhost')       // default seeded
    expect(first.env.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/)

    const second = completeConfig(first)
    expect(second.env).toEqual(first.env)  // idempotent — secrets untouched
  })

  // No stack chosen → nothing to complete.
  expect(completeConfig({})).toEqual({})
})

const { composeEnvFor, urlSuffixFrom } = require('../webapps/plugins/docker-integration/docker-integration.js')

// Setup:    A plugin config with an env block (as baked from build.*.json pluginConfig) — including an
//           invalid key and a non-scalar value — plus stack meta with a default, an overridden default
//           and a declared secret the config doesn't carry.
// Action:   Build the compose environment for port 18000.
// Expected: Meta defaults apply where unset, config.env wins where set, invalid entries are dropped,
//           VOLTAGE_PORT is authoritative, and the missing declared secret gets an ephemeral 64-hex
//           value (never an empty string — an unsigned JWT would fail silently).
test('composeEnvFor merges stack defaults, config overrides and ephemeral secrets', () => {
  const meta = { env: { DS_PORT: '18200', SERVER_HOST: 'localhost' }, secrets: ['JWT_SECRET'] }
  const env = composeEnvFor({ env: {
    USER_NAME: 'Thomas', DS_PORT: 19999, 'BAD-KEY': 'x', OBJ: { nope: 1 },
  } }, 18000, meta)
  expect(env.VOLTAGE_PORT).toBe('18000')
  expect(env.USER_NAME).toBe('Thomas')
  expect(env.DS_PORT).toBe('19999')          // config override beats the stack default
  expect(env.SERVER_HOST).toBe('localhost')  // unset key falls back to the stack default
  expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/)
  expect(env['BAD-KEY']).toBeUndefined()
  expect(env.OBJ).toBeUndefined()
})

// Setup:    Baked app URLs with and without a path.
// Action:   Derive the suffix the routed container URL keeps.
// Expected: Path+query survive (the app's entry page, e.g. /edit/beispiel.docx), a bare or root URL
//           adds nothing, and garbage yields '' instead of throwing.
test('urlSuffixFrom keeps the baked path+query on the routed URL', () => {
  expect(urlSuffixFrom('http://localhost:5001/edit/beispiel.docx')).toBe('/edit/beispiel.docx')
  expect(urlSuffixFrom('http://localhost:8888/')).toBe('')
  expect(urlSuffixFrom('https://example.com/a?b=1')).toBe('/a?b=1')
  expect(urlSuffixFrom('not a url')).toBe('')
})

const { waitForTargets } = require('../webapps/plugins/docker-integration/docker-integration.js')

// Setup:    Stack meta declaring waitFor targets — one via portEnv (resolved from the compose env,
//           like OnlyOffice's DS_PORT), one fixed, one unresolvable.
// Action:   Resolve the targets against an environment.
// Expected: portEnv resolves through env, fixed port passes through, defaults apply (path '/',
//           60s timeout), and an unresolvable port is skipped instead of producing NaN.
test('waitForTargets resolves ports from env and skips unresolvable entries', () => {
  const meta = { waitFor: [
    { portEnv: 'DS_PORT', path: '/healthcheck', timeoutMs: 90000 },
    { port: 9000 },
    { portEnv: 'MISSING' },
  ] }
  const targets = waitForTargets(meta, { DS_PORT: '18200' })
  expect(targets).toEqual([
    { port: 18200, path: '/healthcheck', timeoutMs: 90000 },
    { port: 9000, path: '/', timeoutMs: 60000 },
  ])
})
