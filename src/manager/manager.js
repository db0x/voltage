import { OverlayScrollbars } from '../../node_modules/overlayscrollbars/overlayscrollbars.mjs'
import { initDrawer }          from './drawer.js'
import { initBuildOverlay }    from './build-overlay.js'
import { initConfirmDialog }   from './dialogs/confirm.js'
import { initInfoDialog }      from './dialogs/info.js'
import { initProfilesDialog }  from './dialogs/profiles.js'
import { initIconPicker }      from './dialogs/icon-picker.js'
import { initCreateDialog }    from './dialogs/create.js'
import { initEditDialog }      from './dialogs/edit.js'
import { initAboutDialog }     from './dialogs/about.js'
import { initRebuildNotice }   from './dialogs/rebuild-notice.js'
import { initUpdateNotice }    from './dialogs/update-notice.js'
import { initGlobalSettingsDialog } from './dialogs/global-settings.js'
import { initMailHandlerDialog }  from './dialogs/mail-handler.js'
import { initRcloneDialog }      from './dialogs/rclone.js'
import { initObsidianDialog }    from './dialogs/obsidian.js'
import { initSafeBrowsingDialog } from './dialogs/safe-browsing.js'
import { initCards }           from './cards.js'
import { initTooltip }         from './tooltip.js'
import { initPluginConfig }    from './plugin-config.js'
import { initColorPicker }     from './color-picker.js'

function toDisplayName(profile) {
  return profile
    .replace(/^private\./, '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const dark = localStorage.getItem('dark') === '1'
if (dark) document.body.classList.add('dark')
// Init the shared colour picker now so any data-coloris input (e.g. the widget config dialog)
// is enhanced, with its theme matching the current light/dark mode.
initColorPicker(dark)
// Mirror localStorage into manager-state.json so the next cold start can paint
// the correct backgroundColor before the renderer attaches. This is also the
// migration path for existing dark-mode users — first launch after the upgrade
// seeds the persisted flag without requiring an explicit toggle.
window.managerAPI.setDark(dark)

const [apps, version, uiIcons, i18n, uaPresets, plugins, rcloneStatus, templates, globalSettings, obsidianAvailable] = await Promise.all([
  window.managerAPI.getApps(),
  window.managerAPI.getVersion(),
  window.managerAPI.getUiIcons(),
  window.managerAPI.getI18n(),
  window.managerAPI.getUaPresets(),
  window.managerAPI.getPlugins(),
  window.managerAPI.getRcloneStatus(),
  window.managerAPI.getTemplates(),
  window.managerAPI.loadGlobalSettings(),
  window.managerAPI.getObsidianAvailable(),
])

document.title = `wrapweb Manager ${version}`

// String interpolation for i18n keys — falls back to the key name if missing.
const tr = (key, params = {}) =>
  (i18n[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))

// Converts a GTK icon key to a file:// URL; returns null if the icon wasn't resolved.
const s = k => uiIcons[k] ? `file://${uiIcons[k]}` : null
// appDefault is always provided by main (system theme in production, wrapweb.svg in tests).
const appDefaultSrc = s('appDefault')

// An app is "mail-capable" when it declares the mailto scheme handler and is both built and installed.
const mailHandlerAvailable = apps.some(
  a => a.mimeTypes?.includes('x-scheme-handler/mailto') && a.built && a.installed
)

const hiddenProfiles  = new Set(globalSettings.hiddenProfiles ?? [])
// Mutable array — create/edit dialogs hold a reference; refreshUaPresets() keeps selects in sync.
const allUaPresets = [...uaPresets, ...(globalSettings.customUaPresets ?? [])]

const ctx = {
  i18n, tr, apps, version, toDisplayName, appDefaultSrc,
  uaPresets: allUaPresets, builtInUaPresets: uaPresets, plugins, templates,
  hiddenProfiles,
  rcloneAvailable: rcloneStatus?.available ?? false,
  mailHandlerAvailable,
  icons: {
    sun:          s('sun'),
    moon:         s('moon'),
    info:         s('info'),
    edit:         s('edit'),
    build:        s('build'),
    install:      s('install'),
    delete:       s('delete'),
    menu:         s('menu'),
    filterAll:       s('filterAll'),
    filterPublic:    s('filterPublic'),
    filterPrivate:   s('filterPrivate'),
    filterMicrosoft: s('filterMicrosoft'),
    filterGoogle:    s('filterGoogle'),
    hideFilter:   s('hideFilter'),
    configure:          s('configure'),
    settings:           s('settings'),
    mail:               s('mail'),
    mailApp:            s('mailApp'),
    rclone:             s('rclone'),
    'google-drive':     s('google-drive'),
    googleSafeBrowsing: s('googleSafeBrowsing'),
    eyeVisible: s('eyeVisible'),
    eyeHidden:  s('eyeHidden'),
    github:         s('github'),
    updateNotifier: s('updateNotifier'),
    profiles:       s('profiles'),
    folderProfiles: s('folderProfiles'),
    globe:          s('globe'),
    plus:           s('plus'),
    minus:          s('minus'),
    obsidianMenu:   s('obsidianMenu'),
    obsidian:       s('obsidian'),
    rclonePlugin:   s('rclonePlugin'),
    pluginBadge:    s('pluginBadge'),
    shadow:         s('shadow'),
  },
}

const drawer       = initDrawer({ ...ctx, obsidianAvailable })
const buildOverlay = initBuildOverlay(ctx)
const confirm      = initConfirmDialog(ctx)
const info         = initInfoDialog(ctx)
const profiles     = initProfilesDialog(ctx, { showConfirm: confirm.showConfirm })
const iconPicker   = initIconPicker(ctx)
// Both integration callbacks are late-bound because their dialogs are initialized after about.
let onRcloneFromAbout   = null
let onObsidianFromAbout = null
const about        = initAboutDialog(ctx, {
  obsidianAvailable,
  rcloneAvailable: rcloneStatus?.available ?? false,
  onOpenObsidian: () => onObsidianFromAbout?.(),
  onOpenRclone:   () => onRcloneFromAbout?.(),
})
// Late-bound closures — cards is assigned after these dialogs are initialized.
let onGlobalSettingsSave = null
let onMailHandlerSave    = null

const globalSettingsDialog = initGlobalSettingsDialog(ctx, {
  onSave: profiles => onGlobalSettingsSave?.(profiles),
})
const mailHandlerDialog  = initMailHandlerDialog(ctx, {
  onSave: profile => onMailHandlerSave?.(profile),
})
const rcloneDialog      = initRcloneDialog(ctx)
onRcloneFromAbout   = () => rcloneDialog.openRcloneDialog()
const obsidianDialog    = initObsidianDialog(ctx)
onObsidianFromAbout = () => obsidianDialog.openObsidianDialog()
const safeBrowsingDialog = initSafeBrowsingDialog(ctx)
// Per-plugin config dialogs (the markup is shipped by each configurable plugin). Opened from the
// configure button on a plugin chip in the create/edit dialogs.
const pluginConfig = initPluginConfig(ctx)
const editDialog   = initEditDialog(ctx, {
  iconPicker, showConfirm: confirm.showConfirm, openPluginConfig: pluginConfig.openPluginConfig,
})

const cards = initCards(ctx, {
  showConfirm:      confirm.showConfirm,
  openInfoDialog:   info.openInfoDialog,
  showBuildOverlay: buildOverlay.showBuildOverlay,
  hideBuildOverlay: buildOverlay.hideBuildOverlay,
  openEditDialog:   editDialog.openEditDialog,
})

onMailHandlerSave    = profile  => cards.setDefaultMailHandler(profile)
onGlobalSettingsSave = ({ hiddenProfiles: hp, customUaPresets: custom }) => {
  cards.applyHiddenProfiles(hp)
  // Rebuild allUaPresets in-place so create/edit selects stay in sync after refresh.
  allUaPresets.splice(0, allUaPresets.length, ...uaPresets, ...custom)
  createDialog.refreshUaPresets(allUaPresets)
  editDialog.refreshUaPresets(allUaPresets)
}

// When the user copies an embedded config to private, replace the embedded card
// with a new private card so editable controls become available immediately.
info.setCopyCallback(async (embeddedApp) => {
  const result = await window.managerAPI.copyToPrivate(embeddedApp.configLabel)
  if (!result.success) return
  const privateApp = {
    ...embeddedApp,
    isPrivate:         true,
    configLabel:       result.privateConfigLabel,
    overridesEmbedded: true,
  }
  const oldCard = document.querySelector(`.card[data-profile="${CSS.escape(embeddedApp.profile)}"][data-private="false"]`)
  const newCard = cards.createCard(privateApp)
  if (oldCard) {
    oldCard.remove()
  }
  cards.insertCard(newCard)
  drawer.applyVisibility()
})

const createDialog = initCreateDialog(ctx, {
  iconPicker,
  applyVisibility: drawer.applyVisibility,
  createCard:      cards.createCard,
  insertCard:      cards.insertCard,
  openPluginConfig: pluginConfig.openPluginConfig,
})

const rebuildNotice = initRebuildNotice(ctx, {
  showBuildOverlay: buildOverlay.showBuildOverlay,
  hideBuildOverlay: buildOverlay.hideBuildOverlay,
  getBuildRunning:  cards.getBuildRunning,
  setBuildRunning:  cards.setBuildRunning,
})
// Show synchronously at startup — apps data is already loaded, no extra fetch needed.
rebuildNotice.showIfNeeded(apps)

// Update check runs in the background so it never delays the Manager UI from opening.
const updateNotice = initUpdateNotice(ctx)
window.managerAPI.checkUpdate().then(latestVersion => {
  if (latestVersion) updateNotice.show(latestVersion)
})

cards.addCard.addEventListener('click', createDialog.openCreateDialog)
document.getElementById('menu-profiles').addEventListener('click', () => {
  profiles.openProfilesDialog()
  drawer.closeDrawer()
})
document.getElementById('menu-about').addEventListener('click', () => {
  about.openAboutDialog()
  drawer.closeDrawer()
})

document.getElementById('menu-settings').addEventListener('click', () => {
  drawer.closeDrawer()
  globalSettingsDialog.openGlobalSettingsDialog()
})

// Only rendered when ≥1 mail-capable app is installed — guard against missing element.
const mailHandlerBtn = document.getElementById('menu-mail-handler')
if (mailHandlerBtn) {
  mailHandlerBtn.addEventListener('click', () => {
    drawer.closeDrawer()
    mailHandlerDialog.openMailHandlerDialog()
  })
}

// Only rendered when rclone is available — guard against missing element on startup.
const rcloneBtn = document.getElementById('menu-rclone')
if (rcloneBtn) {
  rcloneBtn.addEventListener('click', () => {
    drawer.closeDrawer()
    rcloneDialog.openRcloneDialog()
  })
}

// Only rendered when Obsidian is available — guard against missing element on startup.
const obsidianBtn = document.getElementById('menu-obsidian')
if (obsidianBtn) {
  obsidianBtn.addEventListener('click', () => {
    drawer.closeDrawer()
    obsidianDialog.openObsidianDialog()
  })
}

document.getElementById('menu-safe-browsing').addEventListener('click', () => {
  drawer.closeDrawer()
  safeBrowsingDialog.openSafeBrowsingDialog()
})

OverlayScrollbars(document.getElementById('grid-wrapper'), { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
drawer.applyInitialFilter()
initTooltip()

// Reveal the UI now that all synchronous init is done. The browser hasn't painted
// since the module started (everything above runs inside one microtask continuation
// after the await), so this flips visibility before the first frame — users never
// see a partial assembly. rAF would be cleaner but Electron throttles it while the
// BrowserWindow is still in its pre-ready-to-show hidden state, causing test hangs.
document.body.classList.add('ready')
