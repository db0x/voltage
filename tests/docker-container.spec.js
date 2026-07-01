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
