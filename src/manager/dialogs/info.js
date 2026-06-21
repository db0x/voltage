import { applyTemplate } from '../template.js'

export function initInfoDialog({ i18n, icons, appDefaultSrc, plugins, templates }) {
  // Lookup from a plugin's webapps-relative file path → its catalog entry (label + icon).
  const pluginCatalog = new Map((plugins || []).map(p => [p.file, p]))
  const overlay = applyTemplate(templates.info, { i18n, icons })
  document.body.appendChild(overlay)

  let copyCallback = null
  let currentApp   = null

  function closeInfoDialog() { overlay.classList.add('hidden') }

  document.getElementById('info-close').addEventListener('click', closeInfoDialog)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeInfoDialog() })

  document.getElementById('info-copy-btn').addEventListener('click', async () => {
    if (!copyCallback || !currentApp) return
    const btn = document.getElementById('info-copy-btn')
    btn.disabled = true
    await copyCallback(currentApp)
    closeInfoDialog()
    btn.disabled = false
  })

  function openInfoDialog(app, name) {
    currentApp = app
    document.getElementById('info-title').textContent = name
    // Header icon mirrors the app's own icon (falls back to the voltage default).
    document.getElementById('info-header-icon').src = app.iconPath ? `file://${app.iconPath}` : appDefaultSrc
    const fieldsEl = document.getElementById('info-fields')

    const field = (label, value) => `
      <div class="dialog-field">
        <label>${label}</label>
        <div class="value">${value}</div>
      </div>`

    const pathField = (label, value) => `
      <div class="dialog-field">
        <label>${label}</label>
        <div class="dialog-field-path">
          <div class="value">${value}</div>
          <button class="btn-reveal" data-reveal="${value}" data-tooltip="${i18n.infoReveal}">…</button>
        </div>
      </div>`

    const rows = []
    rows.push(field(i18n.infoUrl, app.url))
    rows.push(field(i18n.infoProfile, app.profile))
    // Routing URLs: extra URLs other apps route here (array; one per line for readability).
    if (Array.isArray(app.routingUrls) && app.routingUrls.length) {
      rows.push(field(i18n.infoRoutingUrls, app.routingUrls.join('<br>')))
    }
    // Plugins: webapps-relative paths — show each plugin's icon + readable name. Falls back to
    // the basename (sans .js/private.) when a plugin isn't in the catalog.
    if (Array.isArray(app.plugins) && app.plugins.length) {
      const items = app.plugins.map(p => {
        const entry = pluginCatalog.get(p)
        const label = entry?.label ?? p.split('/').pop().replace(/\.js$/, '').replace(/^private\./, '')
        const icon  = entry?.icon ? `<img src="${entry.icon}" alt="" class="info-plugin-icon">` : ''
        return `<span class="info-plugin">${icon}<span>${label}</span></span>`
      })
      rows.push(field(i18n.infoPlugins, `<div class="info-plugins">${items.join('')}</div>`))
    }
    if (app.geometry) {
      const w = app.geometry.width  ? `${app.geometry.width} px`  : '—'
      const h = app.geometry.height ? `${app.geometry.height} px` : '—'
      rows.push(field(i18n.infoGeometry, `${w} × ${h}`))
    }
    if (app.userAgent) rows.push(field(i18n.infoUserAgent, app.userAgent))
    // internalDomains is stored as an array in new configs but as a string in legacy ones.
    if (app.internalDomains) {
      const domains = Array.isArray(app.internalDomains)
        ? app.internalDomains.join(', ')
        : app.internalDomains
      rows.push(field(i18n.infoDomains, domains))
    }
    if (app.crossOriginIsolation) rows.push(field(i18n.infoCoi, i18n.infoCoiYes))
    if (app.built) {
      rows.push(pathField(i18n.infoAppImage,   app.appImagePath))
      rows.push(pathField(i18n.infoProfileDir, app.profilePath))
    }

    fieldsEl.innerHTML = rows.join('')
    fieldsEl.querySelectorAll('[data-reveal]').forEach(btn =>
      btn.addEventListener('click', () => window.managerAPI.revealPath(btn.dataset.reveal))
    )

    // Copy button is only relevant for embedded (non-private) apps.
    const footer = document.getElementById('info-footer')
    footer.style.display = !app.isPrivate ? '' : 'none'

    overlay.classList.remove('hidden')
  }

  // Allows manager.js to register a callback that runs when the user copies
  // an embedded config to private. Called with the current app object.
  function setCopyCallback(fn) { copyCallback = fn }

  return { openInfoDialog, setCopyCallback }
}
