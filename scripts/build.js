#!/usr/bin/env node
const { build } = require('electron-builder')
const fs = require('node:fs')
const path = require('node:path')
const { installDesktop, installIcon } = require('./lib')

const APP_ID_BASE = 'de.db0x.wrapweb'
const CONFIGS_DIR = path.join(__dirname, '..', 'webapps')

function resolveMailtoJs(app) {
  if (!app.mailtoJs) return null
  const val = app.mailtoJs.trim()
  if (val.endsWith('.js')) {
    const file = path.join(CONFIGS_DIR, val)
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
    console.warn(`  Warning: mailtoJs file not found: ${file}`)
  }
  return val
}

// Produces the electron-builder config for one app. All app-specific settings
// are embedded into the AppImage via extraMetadata, which overwrites the root
// package.json fields at build time — this is how main.js reads them at runtime
// without needing a separate config file next to the AppImage.
function expandConfig(app) {
  const appId = `${APP_ID_BASE}.${app.profile}`
  const productName = `wrapweb-${app.profile}`
  const mailtoJs = resolveMailtoJs(app)
  return {
    appId,
    productName,
    artifactName: productName,
    linux: {
      target: ['AppImage'],
      executableArgs: ['--no-sandbox'],
    },
    extraMetadata: {
      name: `wrapweb-${app.profile}`,
      appId,
      profile: app.profile,
      url: app.url,
      ...(app.userAgent           && { userAgent: app.userAgent }),
      ...(app.geometry            && { geometry:  app.geometry  }),
      ...(app.internalDomains     && { internalDomains: app.internalDomains }),
      ...(app.crossOriginIsolation && { crossOriginIsolation: true }),
      ...(app.singleInstance      && { singleInstance:       true }),
      ...(app.fileHandler        && { fileHandler:          true }),
      ...(app.rcloneFileHandler  && { rcloneFileHandler:    true }),
      ...(app.rcloneEditUrlBase && { rcloneEditUrlBase:   app.rcloneEditUrlBase }),
      ...(app.mimeTypes?.length  && { mimeTypes:            app.mimeTypes }),
      ...(app.mailtoTemplate    && { mailtoTemplate:       app.mailtoTemplate }),
      ...(app.mailtoParamMap    && { mailtoParamMap:       app.mailtoParamMap }),
      ...(mailtoJs              && { mailtoJs }),
    },
  }
}

const configs = fs
  .readdirSync(CONFIGS_DIR)
  .filter(f => /^build\..+\.json$/.test(f))
  .sort()

async function buildOne(configFile) {
  const app = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, configFile), 'utf8'))
  const label = configFile.replace(/^build\.(.+)\.json$/, '$1')
  console.log(`\n=== Building ${label} ===`)
  await build({ config: expandConfig(app), projectDir: process.cwd() })
  // Write build metadata alongside the AppImage so the Manager can detect
  // outdated builds and query capabilities (e.g. rclone binding) without
  // mounting or inspecting the AppImage itself.
  const { version } = require('../package.json')
  const meta = { version, ...(app.rcloneFileHandler && { rcloneFileHandler: true }) }
  fs.writeFileSync(path.join('dist', `wrapweb-${app.profile}.version`), JSON.stringify(meta), 'utf8')
  installIcon()
  installDesktop(app)
}

async function main() {
  const profile = process.argv[2]

  if (profile) {
    const configFile = `build.${profile}.json`
    if (!fs.existsSync(path.join(CONFIGS_DIR, configFile))) {
      const available = configs.map(f => f.replace(/^build\.(.+)\.json$/, '$1')).join(', ')
      console.error(`Config not found: ${configFile}\nAvailable: ${available}`)
      process.exit(1)
    }
    await buildOne(configFile)
  } else {
    if (configs.length === 0) {
      console.error('No build.*.json configs found in webapps/.')
      process.exit(1)
    }
    for (const configFile of configs) {
      await buildOne(configFile)
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
