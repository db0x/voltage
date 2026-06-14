#!/usr/bin/env node
const { build } = require('electron-builder')
const fs = require('node:fs')
const path = require('node:path')
const { installDesktop, installIcon } = require('./lib')
const { appName } = require('../src/app-naming')

const APP_ID_BASE = 'de.db0x.voltage'
const CONFIGS_DIR = path.join(__dirname, '..', 'webapps')

// Validates that each configured plugin path resolves to an existing file under webapps/.
// The plugin files themselves ship inside the AppImage (the whole webapps/ tree is packaged),
// so only the relative paths need to travel in extraMetadata for the loader to require them.
function resolvePlugins(app) {
  if (!Array.isArray(app.plugins)) return null
  const list = app.plugins.map(p => p.trim()).filter(Boolean)
  for (const rel of list) {
    if (!fs.existsSync(path.join(CONFIGS_DIR, rel)))
      console.warn(`  Warning: plugin file not found: ${rel}`)
  }
  return list.length ? list : null
}

// Produces the electron-builder config for one app. All app-specific settings
// are embedded into the AppImage via extraMetadata, which overwrites the root
// package.json fields at build time — this is how main.js reads them at runtime
// without needing a separate config file next to the AppImage.
function expandConfig(app) {
  const appId = `${APP_ID_BASE}.${app.profile}`
  // User-facing artifact name (AppImage file + internal executable name). The executable name
  // drives the Wayland WM_CLASS (taskbar grouping reads /proc/self/exe), so this must stay in
  // lock-step with the .desktop StartupWMClass and the runtime wm-class switch.
  const productName = appName(app.profile)
  const plugins = resolvePlugins(app)
  return {
    appId,
    productName,
    artifactName: productName,
    linux: {
      target: ['AppImage'],
      executableArgs: ['--no-sandbox'],
      // The internal executable name seeds the Wayland app_id (Chromium reads /proc/self/exe, then
      // LOWERCASES it: "vTeams" → "vteams"). electron-builder otherwise derives it from package.json
      // `name`. Pin it to the artifact name so the lowercased app_id matches the .desktop
      // StartupWMClass (also lowercased — see scripts/lib.js wmClass()); a mismatch makes GNOME show
      // the raw "vteams" id instead of grouping under the launcher.
      executableName: productName,
    },
    extraMetadata: {
      name: productName,
      appId,
      profile: app.profile,
      url: app.url,
      // The embedded `name` is Electron's app.getName() and electron-builder derives the
      // updaterCacheDirName (and, on some Wayland compositors, the app_id) from it — so it must be
      // the artifact name (e.g. "vTeams"). The human-readable label travels separately as displayName (UI like
      // the About panel); window.js falls back to pkg.profile when a config sets no name.
      ...(app.name                && { displayName: app.name }),
      ...(app.userAgent           && { userAgent: app.userAgent }),
      ...(app.geometry            && { geometry:  app.geometry  }),
      ...(app.internalDomains     && { internalDomains: app.internalDomains }),
      ...(app.crossOriginIsolation && { crossOriginIsolation: true }),
      ...(app.singleInstance      && { singleInstance:       true }),
      ...(app.fileHandler        && { fileHandler:          true }),
      ...(app.acceptsFileArg     && { acceptsFileArg:       true }),
      ...(app.rcloneEditUrlBase && { rcloneEditUrlBase:   app.rcloneEditUrlBase }),
      ...(app.mimeTypes?.length  && { mimeTypes:            app.mimeTypes }),
      ...(app.mailtoTemplate    && { mailtoTemplate:       app.mailtoTemplate }),
      ...(app.mailtoParamMap    && { mailtoParamMap:       app.mailtoParamMap }),
      ...(plugins               && { plugins }),
      // Per-plugin settings (e.g. widget radius) must travel into the AppImage's package.json so
      // the runtime loader can hand each plugin its config via api.config — without this, every
      // plugin always falls back to its defaults regardless of what the Manager saved.
      ...(app.pluginConfig      && { pluginConfig: app.pluginConfig }),
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
  // rcloneFileHandler in the sidecar drives the manager's rclone card badge — now derived from
  // whether the app loads the rclone-sync plugin (rclone is a plugin, no longer a base flag).
  const hasRclonePlugin = (app.plugins ?? []).some(p => /(^|\/)rclone-sync\//.test(p))
  const meta = { version, ...(hasRclonePlugin && { rcloneFileHandler: true }) }
  fs.writeFileSync(path.join('dist', `${appName(app.profile)}.version`), JSON.stringify(meta), 'utf8')
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
