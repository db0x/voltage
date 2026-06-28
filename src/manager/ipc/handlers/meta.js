// Manager chrome / metadata: version, i18n strings, UA presets, HTML templates,
// UI + all-icons resolution, update check, and the guarded external-link opener.

const { ipcMain, shell } = require('electron')
const path = require('node:path')
const fs   = require('node:fs')
const { spawnSync } = require('node:child_process')

const { APP_ROOT, pkg }             = require('../lib/paths')
const { prefetchedAppDefaultIcon }  = require('../lib/icons')
const { t }                         = require('../../../i18n')
const { checkForUpdate }            = require('../../../update-check')

module.exports = function registerMetaHandlers() {
  ipcMain.handle('manager:version',    () => pkg.version)
  ipcMain.handle('manager:i18n',       () => t())
  ipcMain.handle('manager:ua-presets', () => {
    try { return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'src', 'ua-presets.json'), 'utf8')) } catch { return [] }
  })

  // Reads all HTML template files from src/manager at startup so the renderer
  // does not need fetch() or file:// access — IPC is the reliable transport.
  ipcMain.handle('manager:templates', () => {
    const tplDir = path.join(APP_ROOT, 'src', 'manager')
    const read   = rel => fs.readFileSync(path.join(tplDir, rel), 'utf8')
    return {
      about:         read('dialogs/about.html'),
      confirm:       read('dialogs/confirm.html'),
      info:          read('dialogs/info.html'),
      profiles:      read('dialogs/profiles.html'),
      rebuildNotice: read('dialogs/rebuild-notice.html'),
      updateNotice:  read('dialogs/update-notice.html'),
      globalSettings: read('dialogs/global-settings.html'),
      mailHandler:   read('dialogs/mail-handler.html'),
      rclone:        read('dialogs/rclone.html'),
      obsidian:      read('dialogs/obsidian.html'),
      gnome:         read('dialogs/gnome.html'),
      safeBrowsing:  read('dialogs/safe-browsing.html'),
      iconPicker:    read('dialogs/icon-picker.html'),
      create:        read('dialogs/create.html'),
      edit:          read('dialogs/edit.html'),
      drawer:        read('drawer.html'),
    }
  })

  ipcMain.handle('manager:ui-icons', async () => {
    const a = name => path.join(APP_ROOT, 'assets', name)

    // All UI chrome icons are bundled under assets/ to avoid missing icons on
    // desktops that don't ship the full GNOME icon set (e.g. KDE Plasma).
    // Only the generic app placeholder tries the system theme first so it blends
    // in with the desktop; the bundled SVG is the fallback.
    // Uses the pre-warmed Promise so no subprocess is started at this point.
    const r          = await prefetchedAppDefaultIcon
    const appDefault = r['application-default-icon'] || a('webapps/application-default-icon.svg')

    const icons = {
      sun:            a('weather-clear.svg'),
      moon:           a('weather-clear-night.svg'),
      info:           a('state-information.svg'),
      build:          a('system-run.svg'),
      install:        a('system-software-install-symbolic.svg'),
      delete:         a('entry-delete.svg'),
      appDefault,
      menu:           a('open-menu.svg'),
      filterAll:      a('view-app-grid-symbolic.svg'),
      filterPublic:   a('applications-internet-symbolic.svg'),
      filterPrivate:  a('avatar-default.svg'),
      filterMicrosoft: a('view-grid.svg'),
      filterGoogle:    a('view-grid.svg'),
      hideFilter:     a('view-filter.svg'),
      edit:           a('edit.svg'),
      github:         a('github.svg'),
      updateNotifier: a('system-software-update.svg'),
      profiles:       a('profiles.svg'),
      folderProfiles: a('folder-profiles.svg'),
      configure:          a('configure.svg'),
      settings:           a('settings.svg'),
      mail:               a('mail.svg'),
      mailApp:            a('webapps/mail.svg'),
      rclone:             a('rclone.svg'),
      'google-drive':     a('webapps/google-drive.svg'),
      googleSafeBrowsing: a('safe-browsing.svg'),
      eyeVisible:         a('visible.svg'),
      eyeHidden:          a('hidden.svg'),
      plus:               a('plus.svg'),
      minus:              a('minus.svg'),
      globe:              a('globe.svg'),
      obsidianMenu:       a('obsidian.svg'),
      obsidian:           a('plugins/obsidian.svg'),
      gnomeMenu:          a('gnome.svg'),
      gnome:              a('webapps/gnome.svg'),
      folderOpen:         a('folder-open.svg'),
      rclonePlugin:       a('plugins/rclone.svg'),
      pluginBadge:        a('plugins/plugin.svg'),
      shadow:             a('shadow.svg'),
      panel:              a('panel.svg'),
    }

    // In tests, VOLTAGE_TEST_FILTER_ICONS replaces the category filter icons with a
    // single known path so tests can assert on icon presence without coupling to
    // specific filenames.
    if (process.env.VOLTAGE_TEST) {
      const fi = process.env.VOLTAGE_TEST_FILTER_ICONS || null
      if (fi) return { ...icons, filterMicrosoft: fi, filterGoogle: fi }
    }
    return icons
  })

  ipcMain.handle('manager:all-icons', () => {
    const script = `
import gi, sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
theme = Gtk.IconTheme.get_default()
for name in sorted(theme.list_icons(None)):
    info = theme.lookup_icon(name, 48, 0)
    if info:
        fn = info.get_filename()
        if fn:
            sys.stdout.write(name + '\\t' + fn + '\\n')
`
    const r = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024 })
    if (r.error || r.status !== 0) return []
    return (r.stdout || '').trim().split('\n').filter(Boolean).map(line => {
      const tab = line.indexOf('\t')
      if (tab === -1) return null
      return { name: line.slice(0, tab), path: line.slice(tab + 1) }
    }).filter(Boolean)
  })

  ipcMain.handle('manager:check-update', () => checkForUpdate(pkg.version))

  ipcMain.handle('manager:open-external', (event, url) => {
    const allowed = /^https:\/\/github\.com\//
    if (allowed.test(url)) shell.openExternal(url)
  })
}
