const { app } = require('electron')

const translations = {
  de: {
    // Context menu
    cut: 'Ausschneiden', copy: 'Kopieren', paste: 'Einfügen',
    saveAs: 'Speichern unter…', noSuggestions: 'Keine Vorschläge',
    openWithApp: 'Öffnen mit {name}', openInBrowser: 'Im Browser öffnen',

    // Drawer
    drawerAppearance:      'Darstellung',
    drawerLightMode:       'Light Mode',
    drawerDarkMode:        'Dark Mode',
    drawerVisibility:      'Sichtbarkeit',
    drawerAllApps:         'Alle Apps',
    drawerEmbeddedApps:    'Embedded Apps',
    drawerUserApps:        'Benutzer Apps',
    drawerMicrosoft:       'Microsoft Apps',
    drawerGoogle:          'Google Apps',
    drawerHideUninstalled: 'Nicht installierte ausblenden',

    // Badges
    badgeBuilt:       'Erstellt',
    badgeNotBuilt:    'Nicht erstellt',
    badgeInstalled:   'Installiert',
    badgeUser:        'Benutzer',
    badgeMailHandler: 'Mail-Handler',
    badgeOutdated:    'Neu erstellen erforderlich',

    // Toolbar buttons
    btnInfo:           'Informationen',
    btnEdit:           'Bearbeiten',
    btnBuild:          'AppImage erstellen',
    btnRebuild:        'AppImage neu erstellen',
    btnInstall:           'Installieren',
    btnInstallTooltip:    '{name} als Applikation im System installieren',
    btnReinstallTooltip:  '{name} neu installieren',
    btnDelete:            'Löschen',

    // Confirm dialog
    confirmCancel:       'Abbrechen',
    confirmDelete:       'Löschen',
    confirmDeleteMsg:    '<p>App-Image und Desktop-Eintrag für <strong>{name}</strong> wirklich löschen?</p><p>Das Profil-Verzeichnis bleibt erhalten.</p>',
    confirmDeleteConfig:      'Konfiguration löschen',
    confirmDeleteProfileData: 'Profil-Daten löschen (Cookies, Sessions, lokale Daten)',

    // Build overlay
    buildingApp: 'Erstellt {name} …',

    // Info dialog
    infoUrl:        'URL',
    infoProfile:    'Profil',
    infoIcon:       'Icon',
    infoGeometry:   'Fenstergröße',
    infoUserAgent:  'User-Agent',
    infoDomains:    'Interne Domains',
    infoCoi:        'Cross-Origin Isolation',
    infoCoiYes:     'Ja',
    infoAppImage:   'App-Image',
    infoProfileDir: 'Profil-Ordner',
    infoNotBuilt:   'App ist nicht erstellt.',
    infoReveal:     'Im Dateimanager öffnen',

    // Edit dialog
    editTitle:             'App bearbeiten',
    editSave:              'Speichern',
    editRebuildPrompt:     '<p>Konfiguration von <strong>{name}</strong> gespeichert.</p><p>AppImage jetzt neu erstellen?</p>',
    editRebuild:           'Neu erstellen',
    editInstallAfterBuild: 'Nach dem Erstellen installieren',

    // Install confirm
    installConfirmMsg:       '<p><strong>{name}</strong> als Applikation im System installieren?</p>',
    installConfirmOk:        'Installieren',
    installSetMailHandler:   'Als Standard-Mail-Handler registrieren',

    // Create dialog
    createTitle:    'Neue WebApp hinzufügen',
    createProfile:  'Profil',
    createName:     'Name',
    createUrl:      'URL',
    createIcon:     'Icon (GNOME-Theme)',
    createAdvanced: 'Erweitert (optional)',
    createWidth:    'Breite (px)',
    createHeight:   'Höhe (px)',
    createUAgent:   'User-Agent',
    createDomains:  'Interne Domains',
    createCoi:            'Cross-Origin Isolation (SharedArrayBuffer / WASM)',
    createSingleInstance: 'Nur eine Instanz erlauben',
    createMailHandler:    'Als Mail-Handler registrieren',
    createPlugin:         'Plugin',
    tooltipSingleInstance: 'Verhindert, dass die App mehrfach geöffnet wird. Ein zweiter Start bringt stattdessen das bestehende Fenster in den Vordergrund.',
    tooltipUAgent:      'Einige Webseiten blockieren Electron oder bieten bessere Funktionen für bestimmte Browser. Hier kann die App als Chrome, Firefox oder Edge auftreten.',
    tooltipDomains:     'Links zu diesen Domains öffnen sich im App-Fenster statt im Standard-Browser – z. B. für Login-Seiten oder SSO-Anbieter.',
    tooltipCoi:         'Ermöglicht SharedArrayBuffer und WASM-Threads. Nur aktivieren, wenn die Webseite es ausdrücklich benötigt – kann Cross-Origin-Requests einschränken.',
    tooltipMailHandler: 'Registriert diese App systemweit als Standard für mailto:-Links. Ein Klick auf eine E-Mail-Adresse öffnet direkt das Compose-Fenster dieser App.',
    tooltipPlugin:      'Skript, das beim Öffnen eines mailto:-Links ausgeführt wird, z. B. um den Compose-Dialog einer Webmail-App automatisch zu starten.',
    createPluginNone:     '— kein Plugin —',
    createCancel:         'Abbrechen',
    createSave:     'Speichern',
    createUaDefault:'— Standard (nicht gesetzt) —',

    // Validation
    validPattern:  'Nur Kleinbuchstaben, Ziffern und Bindestriche',
    validExists:   'Profil existiert bereits',
    validHint:     '→ build.private.{profile}.json',
    validChecking: '…',
    validUrl:      'Keine gültige URL',
    validDimRange: '{min}–{max} px',

    // Icon picker
    createIconChoose:  'Icon wählen …',
    iconPickerSearch:  'Suchen …',
    iconPickerLoading: 'Lädt Icons …',

    // About dialog
    drawerAbout:       'Über wrapweb',
    aboutLicense:      'MIT-Lizenz',
    aboutGithub:       'wrapweb bei GitHub',

    // rclone integration
    drawerRcloneSection:    'Integrationen',
    drawerRclone:           'rclone Integration',
    rcloneDialogTitle:      'rclone Integration',
    rcloneDialogGdrive:     'Google Drive',
    rcloneDialogRemote:     'Remote',
    rcloneDialogNone:       '— kein Remote ausgewählt —',
    rcloneDialogNoRemotes:  'Kein Google-Drive-Remote gefunden.',
    rcloneDialogHint:            'Remotes werden mit rclone config im Terminal eingerichtet.',
    rcloneDialogUploadFolders:   'Upload-Ordner',
    rcloneDialogFolderHint:      'Zielordner in Google Drive (wird automatisch erstellt)',
    rcloneDialogFolderRequired:  'Pflichtfeld',
    rcloneDialogSave:            'Speichern',

    // Profile sizes dialog
    drawerProfiles:    'Profile',
    profilesTitle:     'Profil-Verzeichnisse',
    profilesTotal:     'Gesamt',
    profilesEmpty:     'Kein Datenverzeichnis vorhanden',
    profilesDeleteConfirm: '<p>Profildaten von <strong>{name}</strong> wirklich löschen?</p><p>Cookies, Login-Sessions und lokale Daten gehen verloren. Die App bleibt installiert.</p>',

    // Rebuild notice
    rebuildNoticeTitle:    'wrapweb wurde aktualisiert',
    rebuildNoticeIntro:    'wrapweb wurde auf Version <strong>{version}</strong> aktualisiert. Folgende AppImages wurden mit einer älteren Version erstellt und müssen neu erstellt werden, damit alle neuen Funktionen verfügbar sind:',
    rebuildNoticeOk:       'Verstanden',
    rebuildNoticeRebuildAll: 'Alle neu erstellen',
    rebuildNoticeBuilding:   'Wird erstellt …',
    rebuildNoticeDone:       'Fertig',

    // Update notice
    updateNoticeTitle:  'Update verfügbar',
    updateNoticeBody:   '<p>wrapweb <strong>{version}</strong> ist verfügbar.</p><p style="margin-top:8px">Zum Aktualisieren im wrapweb-Verzeichnis <code>git pull</code> ausführen und anschließend alle AppImages neu erstellen.</p>',
    updateNoticeGithub: 'Auf GitHub öffnen',
    updateNoticeOk:     'Verstanden',
  },

  en: {
    // Context menu
    cut: 'Cut', copy: 'Copy', paste: 'Paste',
    saveAs: 'Save As…', noSuggestions: 'No suggestions',
    openWithApp: 'Open with {name}', openInBrowser: 'Open in browser',

    // Drawer
    drawerAppearance:      'Appearance',
    drawerLightMode:       'Light Mode',
    drawerDarkMode:        'Dark Mode',
    drawerVisibility:      'Visibility',
    drawerAllApps:         'All Apps',
    drawerEmbeddedApps:    'Embedded Apps',
    drawerUserApps:        'User Apps',
    drawerMicrosoft:       'Microsoft Apps',
    drawerGoogle:          'Google Apps',
    drawerHideUninstalled: 'Hide uninstalled',

    // Badges
    badgeBuilt:       'Built',
    badgeNotBuilt:    'Not built',
    badgeInstalled:   'Installed',
    badgeUser:        'User',
    badgeMailHandler: 'Mail handler',
    badgeOutdated:    'Rebuild required',

    // Toolbar buttons
    btnInfo:           'Information',
    btnEdit:           'Edit',
    btnBuild:          'Create AppImage',
    btnRebuild:        'Rebuild AppImage',
    btnInstall:           'Install',
    btnInstallTooltip:    'Install {name} as system application',
    btnReinstallTooltip:  'Reinstall {name}',
    btnDelete:            'Delete',

    // Confirm dialog
    confirmCancel:       'Cancel',
    confirmDelete:       'Delete',
    confirmDeleteMsg:    '<p>Really delete AppImage and desktop entry for <strong>{name}</strong>?</p><p>The profile directory will be kept.</p>',
    confirmDeleteConfig:      'Delete configuration',
    confirmDeleteProfileData: 'Delete profile data (cookies, sessions, local data)',

    // Build overlay
    buildingApp: 'Building {name} …',

    // Info dialog
    infoUrl:        'URL',
    infoProfile:    'Profile',
    infoIcon:       'Icon',
    infoGeometry:   'Window size',
    infoUserAgent:  'User-Agent',
    infoDomains:    'Internal domains',
    infoCoi:        'Cross-Origin Isolation',
    infoCoiYes:     'Yes',
    infoAppImage:   'App image',
    infoProfileDir: 'Profile directory',
    infoNotBuilt:   'App is not built.',
    infoReveal:     'Open in file manager',

    // Edit dialog
    editTitle:             'Edit app',
    editSave:              'Save',
    editRebuildPrompt:     '<p>Configuration of <strong>{name}</strong> saved.</p><p>Rebuild the AppImage now?</p>',
    editRebuild:           'Rebuild',
    editInstallAfterBuild: 'Install after build',

    // Install confirm
    installConfirmMsg:       '<p>Install <strong>{name}</strong> as a system application?</p>',
    installConfirmOk:        'Install',
    installSetMailHandler:   'Register as default mail handler',

    // Create dialog
    createTitle:    'Add new WebApp',
    createProfile:  'Profile',
    createName:     'Name',
    createUrl:      'URL',
    createIcon:     'Icon (GNOME theme)',
    createAdvanced: 'Advanced (optional)',
    createWidth:    'Width (px)',
    createHeight:   'Height (px)',
    createUAgent:   'User-Agent',
    createDomains:  'Internal domains',
    createCoi:            'Cross-Origin Isolation (SharedArrayBuffer / WASM)',
    createSingleInstance: 'Allow only one instance',
    createMailHandler:    'Register as mail handler',
    createPlugin:         'Plugin',
    tooltipSingleInstance: 'Prevents the app from being opened more than once. A second launch brings the existing window to the front instead.',
    tooltipUAgent:      'Some websites block Electron or work better with a specific browser identity. The app can pose as Chrome, Firefox or Edge.',
    tooltipDomains:     'Links to these domains open inside the app window instead of the default browser — e.g. for login pages or SSO providers.',
    tooltipCoi:         'Enables SharedArrayBuffer and WASM threads. Only turn on if the website explicitly requires it — may restrict cross-origin requests.',
    tooltipMailHandler: 'Registers this app system-wide as the default for mailto: links. Clicking an email address anywhere opens the compose window directly in this app.',
    tooltipPlugin:      'A script that runs when a mailto: link is opened, e.g. to automatically trigger the compose dialog of a webmail app.',
    createPluginNone:     '— no plugin —',
    createCancel:         'Cancel',
    createSave:     'Save',
    createUaDefault:'— Default (not set) —',

    // Validation
    validPattern:  'Only lowercase letters, digits and hyphens',
    validExists:   'Profile already exists',
    validHint:     '→ build.private.{profile}.json',
    validChecking: '…',
    validUrl:      'Not a valid URL',
    validDimRange: '{min}–{max} px',

    // Icon picker
    createIconChoose:  'Choose icon …',
    iconPickerSearch:  'Search …',
    iconPickerLoading: 'Loading icons …',

    // About dialog
    drawerAbout:       'About wrapweb',
    aboutLicense:      'MIT License',
    aboutGithub:       'wrapweb on GitHub',

    // rclone integration
    drawerRcloneSection:    'Integrations',
    drawerRclone:           'rclone Integration',
    rcloneDialogTitle:      'rclone Integration',
    rcloneDialogGdrive:     'Google Drive',
    rcloneDialogRemote:     'Remote',
    rcloneDialogNone:       '— no remote selected —',
    rcloneDialogNoRemotes:  'No Google Drive remote found.',
    rcloneDialogHint:            'Remotes are configured with rclone config in the terminal.',
    rcloneDialogUploadFolders:   'Upload folders',
    rcloneDialogFolderHint:      'Target folder in Google Drive (created automatically)',
    rcloneDialogFolderRequired:  'Required',
    rcloneDialogSave:            'Save',

    // Profile sizes dialog
    drawerProfiles:    'Profiles',
    profilesTitle:     'Profile directories',
    profilesTotal:     'Total',
    profilesEmpty:     'No data directory',
    profilesDeleteConfirm: '<p>Really delete profile data for <strong>{name}</strong>?</p><p>Cookies, login sessions and local data will be lost. The app remains installed.</p>',

    // Rebuild notice
    rebuildNoticeTitle:    'wrapweb updated',
    rebuildNoticeIntro:    'wrapweb was updated to version <strong>{version}</strong>. The following AppImages were built with an older version and need to be rebuilt for all new features to work:',
    rebuildNoticeOk:       'Got it',
    rebuildNoticeRebuildAll: 'Rebuild all',
    rebuildNoticeBuilding:   'Building …',
    rebuildNoticeDone:       'Done',

    // Update notice
    updateNoticeTitle:  'Update available',
    updateNoticeBody:   '<p>wrapweb <strong>{version}</strong> is available.</p><p style="margin-top:8px">To update, run <code>git pull</code> in the wrapweb directory and then rebuild all AppImages.</p>',
    updateNoticeGithub: 'Open on GitHub',
    updateNoticeOk:     'Got it',
  },
}

function t() {
  const lang = (process.env.WRAPWEB_LANG ?? app.getLocale()).split('-')[0].toLowerCase()
  return translations[lang] ?? translations.en
}

module.exports = { t }
