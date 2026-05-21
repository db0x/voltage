export function initInfoDialog({ i18n, icons }) {
  const infoSrc = icons.info

  const overlay = document.createElement('div')
  overlay.className = 'dialog-overlay hidden'
  overlay.innerHTML = `
    <div class="dialog">
      <div class="dialog-header">
        ${infoSrc ? `<img src="${infoSrc}" alt="">` : ''}
        <span class="dialog-title" id="info-title"></span>
        <button class="dialog-close" id="info-close">✕</button>
      </div>
      <div class="dialog-fields" id="info-fields"></div>
      <div class="confirm-actions" id="info-footer" style="display:none">
        <button class="btn-save" id="info-copy-btn">${i18n.infoCopyToPrivate}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  let copyCallback = null
  let currentApp   = null

  function closeInfoDialog() { overlay.classList.add('hidden') }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeInfoDialog() })
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
    if (app.icon) rows.push(field(i18n.infoIcon, app.icon))
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
