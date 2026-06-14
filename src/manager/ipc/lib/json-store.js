// Generic JSON config store for a single file under the voltage appData dir.
// Replaces three near-identical load/save handler pairs (rclone, global-settings,
// safe-browsing) that all shared the same shape: read-or-default, mkdir + atomic write.

const { app } = require('electron')
const path    = require('node:path')
const fs      = require('node:fs')

// Creates a { load, save, configPath } trio bound to one filename.
// VOLTAGE_TEST_DATA_DIR redirects the file into a temp dir in tests so tests never
// read or write the user's real data files.
function makeJsonStore(filename) {
  const configPath = () => {
    const testDir = process.env.VOLTAGE_TEST_DATA_DIR
    return testDir
      ? path.join(testDir, filename)
      : path.join(app.getPath('appData'), 'voltage', filename)
  }

  // Missing or unparseable file yields {} so callers always get a usable object.
  const load = () => {
    try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { return {} }
  }

  const save = config => {
    const cfgPath = configPath()
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2))
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  return { configPath, load, save }
}

module.exports = { makeJsonStore }
