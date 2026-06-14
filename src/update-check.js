// Fetches the version from the main branch on every Manager start — no caching,
// since the payload is a tiny JSON file and stale cache caused missed notifications
// when the local version matched an outdated cached latestVersion.
const REMOTE_URL = 'https://raw.githubusercontent.com/db0x/wrapweb/main/package.json'

function semverLt(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false
  }
  return false
}

async function checkForUpdate(currentVersion) {
  if (process.env.VOLTAGE_TEST) return null
  try {
    const res = await fetch(REMOTE_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const latestVersion = (await res.json()).version ?? null
    return latestVersion && semverLt(currentVersion, latestVersion) ? latestVersion : null
  } catch {}
  return null
}

module.exports = { checkForUpdate }
