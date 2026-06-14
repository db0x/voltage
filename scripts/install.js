#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { installDesktop, installIcon } = require('./lib')

const CONFIGS_DIR = path.join(__dirname, '..', 'webapps')

const configs = fs
  .readdirSync(CONFIGS_DIR)
  .filter(f => /^build\..+\.json$/.test(f))
  .sort()

const profile = process.argv[2]

// Always install the voltage launcher icon — it is shared by all app desktop entries.
installIcon()

// When a profile argument is given, install only that app; otherwise install all configs.
if (profile) {
  const configFile = `build.${profile}.json`
  if (!fs.existsSync(path.join(CONFIGS_DIR, configFile))) {
    const available = configs.map(f => f.replace(/^build\.(.+)\.json$/, '$1')).join(', ')
    console.error(`Config not found: ${configFile}\nAvailable: ${available}`)
    process.exit(1)
  }
  installDesktop(JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, configFile), 'utf8')))
} else {
  if (configs.length === 0) {
    console.error('No build.*.json configs found in webapps/.')
    process.exit(1)
  }
  for (const configFile of configs) {
    const label = configFile.replace(/^build\.(.+)\.json$/, '$1')
    console.log(`\n=== Installing ${label} ===`)
    installDesktop(JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, configFile), 'utf8')))
  }
}
