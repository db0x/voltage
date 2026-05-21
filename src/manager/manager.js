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
import { initRcloneDialog }      from './dialogs/rclone.js'
import { initSafeBrowsingDialog } from './dialogs/safe-browsing.js'
import { initCards }           from './cards.js'
import { initTooltip }         from './tooltip.js'

function toDisplayName(profile) {
  return profile
    .replace(/^private\./, '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const dark = localStorage.getItem('dark') === '1'
if (dark) document.body.classList.add('dark')

const [apps, version, uiIcons, i18n, uaPresets, plugins, rcloneStatus] = await Promise.all([
  window.managerAPI.getApps(),
  window.managerAPI.getVersion(),
  window.managerAPI.getUiIcons(),
  window.managerAPI.getI18n(),
  window.managerAPI.getUaPresets(),
  window.managerAPI.getPlugins(),
  window.managerAPI.getRcloneStatus(),
])

// String interpolation for i18n keys — falls back to the key name if missing.
const tr = (key, params = {}) =>
  (i18n[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))

// Converts a GTK icon key to a file:// URL; returns null if the icon wasn't resolved.
const s = k => uiIcons[k] ? `file://${uiIcons[k]}` : null
// appDefault is always provided by main (system theme in production, wrapweb.svg in tests).
const appDefaultSrc = s('appDefault')

const ctx = {
  i18n, tr, apps, version, toDisplayName, appDefaultSrc, uaPresets, plugins,
  rcloneAvailable: rcloneStatus?.available ?? false,
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
    rclone:             s('rclone'),
    googledrive:        s('googledrive'),
    googleSafeBrowsing: s('googleSafeBrowsing'),
    eyeVisible: s('eyeVisible'),
    eyeHidden:  s('eyeHidden'),
    github:         s('github'),
    updateNotifier: s('updateNotifier'),
  },
}

const drawer       = initDrawer(ctx)
const buildOverlay = initBuildOverlay(ctx)
const confirm      = initConfirmDialog(ctx)
const info         = initInfoDialog(ctx)
const profiles     = initProfilesDialog(ctx, { showConfirm: confirm.showConfirm })
const iconPicker   = initIconPicker(ctx)
const about        = initAboutDialog(ctx)
const rcloneDialog      = initRcloneDialog(ctx)
const safeBrowsingDialog = initSafeBrowsingDialog(ctx)
const editDialog   = initEditDialog(ctx, { iconPicker, showConfirm: confirm.showConfirm })

const cards = initCards(ctx, {
  showConfirm:      confirm.showConfirm,
  openInfoDialog:   info.openInfoDialog,
  showBuildOverlay: buildOverlay.showBuildOverlay,
  hideBuildOverlay: buildOverlay.hideBuildOverlay,
  openEditDialog:   editDialog.openEditDialog,
})

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

// Only rendered when rclone is available — guard against missing element on startup.
const rcloneBtn = document.getElementById('menu-rclone')
if (rcloneBtn) {
  rcloneBtn.addEventListener('click', () => {
    drawer.closeDrawer()
    rcloneDialog.openRcloneDialog()
  })
}

document.getElementById('menu-safe-browsing').addEventListener('click', () => {
  drawer.closeDrawer()
  safeBrowsingDialog.openSafeBrowsingDialog()
})

OverlayScrollbars(document.getElementById('grid-wrapper'), { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
drawer.applyInitialFilter()
initTooltip()
