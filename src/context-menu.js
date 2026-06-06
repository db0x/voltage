const { Menu, dialog, app, nativeImage } = require('electron')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')
const { t } = require('./i18n')

// Falls back to aspell when Electron's built-in spellchecker returns no
// corrections — this covers languages not supported by the built-in engine.
// Tries system languages first, then English as a last resort.
function aspellSuggestions(word) {
  const preferred = app.getPreferredSystemLanguages().map(l => l.split('-')[0])
  const langs = [...new Set([...preferred, 'en'])]
  for (const lang of langs) {
    const r = spawnSync('aspell', ['-l', lang, '-a'], {
      input: word + '\n',
      encoding: 'utf8',
      timeout: 500,
    })
    if (r.stdout) {
      const match = r.stdout.match(/^& \S+ \d+ \d+: (.+)$/m)
      if (match) return match[1].split(', ').slice(0, 6)
    }
  }
  return []
}

function showContextMenu(mainWindow, customSession, params, opts = {}) {
  const i18n = t()
  const tr = (key, p = {}) => (i18n[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => p[k] ?? '')
  const template = []

  if (params.misspelledWord) {
    const corrections = params.spellingCorrections?.length
      ? params.spellingCorrections
      : aspellSuggestions(params.misspelledWord)

    if (corrections.length > 0) {
      for (const suggestion of corrections) {
        template.push({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        })
      }
    } else {
      template.push({ label: i18n.noSuggestions, enabled: false })
    }
    template.push({ type: 'separator' })
  }

  template.push(
    { role: 'cut',   label: i18n.cut   },
    { role: 'copy',  label: i18n.copy  },
    { role: 'paste', label: i18n.paste },
  )

  if (params.linkURL && opts.resolveRoute) {
    const route = opts.resolveRoute(params.linkURL)
    template.push({ type: 'separator' })
    if (route) {
      const icon = route.icon ? (() => {
        try { return nativeImage.createFromPath(route.icon).resize({ width: 16, height: 16 }) } catch { return undefined }
      })() : undefined
      template.push({
        label: tr('openWithApp', { name: route.name }),
        ...(icon && { icon }),
        click: () => spawn(route.appImagePath, ['--no-sandbox', route.url ?? params.linkURL], { detached: true, stdio: 'ignore' }).unref(),
      })
    }
    const browserIcon = opts.browserIconPath ? (() => {
      try { return nativeImage.createFromPath(opts.browserIconPath).resize({ width: 16, height: 16 }) } catch { return undefined }
    })() : undefined
    template.push({
      label: i18n.openInBrowser,
      ...(browserIcon && { icon: browserIcon }),
      click: () => opts.openInBrowser(params.linkURL),
    })
  }

  if (params.mediaType === 'image' && params.srcURL) {
    let defaultName = 'image.jpg'
    try {
      const name = path.basename(new URL(params.srcURL).pathname)
      if (name && path.extname(name)) defaultName = name
      else if (name)                  defaultName = name + '.jpg'
    } catch {}

    template.push({ type: 'separator' })
    template.push({
      label: i18n.saveAs,
      click: async () => {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
          defaultPath: defaultName,
        })
        if (!canceled && filePath) {
          // Intercept the download triggered below and redirect it to the chosen path.
          customSession.prependOnceListener('will-download', (_e, item) => item.setSavePath(filePath))
          mainWindow.webContents.downloadURL(params.srcURL)
        }
      },
    })
  }

  // Plugin-contributed entries (e.g. the widget plugin's "Quit") go last, after a separator.
  // Each item is a plain Electron MenuItem template ({ label, click, … }).
  if (opts.extraItems?.length) {
    template.push({ type: 'separator' })
    for (const item of opts.extraItems) template.push(item)
  }

  Menu.buildFromTemplate(template).popup({ window: mainWindow })
}

module.exports = { showContextMenu }
