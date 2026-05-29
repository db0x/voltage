// Shared path constants and the app package metadata.
// Centralized so every handler module resolves the app root the same way and reads
// version / minAppImageVersion from a single source.

const { app } = require('electron')
const path    = require('node:path')

const APP_ROOT    = app.getAppPath()
const CONFIGS_DIR = path.join(APP_ROOT, 'webapps')
const pkg         = require(APP_ROOT + '/package.json')

module.exports = { APP_ROOT, CONFIGS_DIR, pkg }
