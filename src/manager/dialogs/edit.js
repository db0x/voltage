import { OverlayScrollbars } from '../../../node_modules/overlayscrollbars/overlayscrollbars.mjs'
import { applyTemplate }     from '../template.js'
import { initDomainList }    from '../domain-list.js'
import { initRoutingUrlList } from '../routing-url-field.js'
import { initPluginList }    from '../plugin-list.js'

export function initEditDialog({ i18n, tr, appDefaultSrc, uaPresets, plugins, icons, templates }, { iconPicker, showConfirm, openPluginConfig }) {
  const overlay = applyTemplate(templates.edit, { i18n, vars: { appDefaultSrc } })
  document.body.appendChild(overlay)

  const uaSelect = document.getElementById('edit-useragent')
  function refreshUaPresets(presets) {
    const current = uaSelect.value
    uaSelect.querySelectorAll('option:not([value=""])').forEach(o => o.remove())
    for (const { label, value } of presets) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      uaSelect.appendChild(opt)
    }
    uaSelect.value = current
  }
  refreshUaPresets(uaPresets)

  const domainList    = initDomainList('edit-domain-list', 'edit-domain-input', 'edit-domain-add', () => updateSaveBtn())
  // currentProfile is read live (set in openEditDialog) so the overlap check excludes this app.
  const routingList   = initRoutingUrlList('edit', () => currentProfile, { tr, onChange: () => updateSaveBtn() })

  // Per-app, per-plugin settings (e.g. widget radius), keyed by plugin file path. Reset per
  // open from the app; the configure dialog reads/writes the entry for the clicked plugin.
  let pluginConfig = {}

  // Plugin selection is its own select-and-add list, independent of the mail-handler toggle.
  // The configure button opens the plugin's own dialog, scoped to this app's config for it.
  const pluginList = initPluginList('edit-plugin-trigger', 'edit-plugin-list', plugins, appDefaultSrc, icons?.configure,
    () => updateSaveBtn(),
    file => openPluginConfig(file, {
      get: () => pluginConfig[file] || {},
      set: cfg => { pluginConfig[file] = cfg; updateSaveBtn() },
    }))

  document.getElementById('edit-mail-handler').addEventListener('click', e => {
    e.currentTarget.classList.toggle('active')
    updateSaveBtn()
  })

  let scrollbarInited  = false
  let urlValid         = true
  let urlCheckTimer    = null
  let widthValid       = true
  let heightValid      = true
  let selectedIconName = ''
  let currentProfile   = ''
  let currentApp       = null
  let onUpdated        = null
  let initialSnapshot  = null

  const urlInput     = document.getElementById('edit-url')
  const urlHint      = document.getElementById('edit-url-hint')
  const saveBtn      = document.getElementById('edit-save')
  const iconPreview  = document.getElementById('edit-icon-preview')
  const iconNameEl   = document.getElementById('edit-icon-name')
  const iconClearBtn = document.getElementById('edit-icon-clear')

  // Captures a comparable snapshot of all form fields so isDirty() can detect changes.
  function snapshot() {
    return {
      name:               document.getElementById('edit-name').value.trim(),
      url:                urlInput.value.trim(),
      icon:               selectedIconName,
      width:              document.getElementById('edit-width').value.trim(),
      height:             document.getElementById('edit-height').value.trim(),
      userAgent:          uaSelect.value.trim(),
      internalDomains:    domainList.get().join(','),
      routingUrls:        routingList.get().join(','),
      crossOriginIsolation: document.getElementById('edit-coi').classList.contains('active'),
      singleInstance:       document.getElementById('edit-single-instance').classList.contains('active'),
      mailHandler:          document.getElementById('edit-mail-handler').classList.contains('active'),
      // Sorted join so the dirty check ignores checkbox ordering and only reacts to which
      // plugins are selected.
      plugins:              pluginList.get().slice().sort().join(','),
      // Serialized so editing a plugin's settings (e.g. widget radius) marks the form dirty.
      pluginConfig:         JSON.stringify(pluginConfig),
    }
  }

  function isDirty() {
    if (!initialSnapshot) return false
    const cur = snapshot()
    return Object.keys(initialSnapshot).some(k => initialSnapshot[k] !== cur[k])
  }

  function updateSaveBtn() {
    saveBtn.disabled = !(urlValid && widthValid && heightValid && isDirty())
  }

  function validateDimension(inputEl, hintEl, min, max, flagSetter) {
    const val = inputEl.value.trim()
    if (!val) {
      inputEl.className = ''
      hintEl.textContent = ''
      flagSetter(true)
      updateSaveBtn()
      return
    }
    const n = Number(val)
    if (!Number.isInteger(n) || n < min || n > max) {
      inputEl.className = 'invalid'
      hintEl.textContent = tr('validDimRange', { min, max })
      hintEl.className = 'field-hint error'
      flagSetter(false)
    } else {
      inputEl.className = 'valid'
      hintEl.textContent = ''
      hintEl.className = 'field-hint'
      flagSetter(true)
    }
    updateSaveBtn()
  }

  urlInput.addEventListener('input', () => {
    const val = urlInput.value.trim()
    clearTimeout(urlCheckTimer)
    if (!val) {
      urlValid = false
      urlInput.className = ''
      urlHint.textContent = ''
      updateSaveBtn()
      return
    }
    try {
      new URL(val)
    } catch {
      urlValid = false
      urlInput.className = 'invalid'
      urlHint.textContent = i18n.validUrl
      urlHint.className = 'field-hint error'
      updateSaveBtn()
      return
    }
    // An unchanged base URL is never re-checked: it was already saved, so it must not be
    // blocked just because it overlaps another app's base (the overlap rule applies to new
    // or changed claims via the dialog, not retroactively to existing configs).
    if (val === (currentApp?.url || '')) {
      urlValid = true
      urlInput.className = 'valid'
      urlHint.textContent = ''
      urlHint.className = 'field-hint'
      updateSaveBtn()
      return
    }
    // Changed base URL — verify it does not overlap another app's base URL.
    urlValid = false
    urlInput.className = ''
    urlHint.textContent = i18n.validChecking
    urlHint.className = 'field-hint'
    updateSaveBtn()
    urlCheckTimer = setTimeout(async () => {
      const { conflict } = await window.managerAPI.checkRoutingOverlap(currentProfile, val, 'base')
      if (urlInput.value.trim() !== val) return
      if (conflict) {
        urlValid = false
        urlInput.className = 'invalid'
        urlHint.textContent = tr('routingUrlConflict', { app: conflict })
        urlHint.className = 'field-hint error'
      } else {
        urlValid = true
        urlInput.className = 'valid'
        urlHint.textContent = ''
        urlHint.className = 'field-hint'
      }
      updateSaveBtn()
    }, 300)
  })

  document.getElementById('edit-name').addEventListener('input', updateSaveBtn)
  document.getElementById('edit-width').addEventListener('input', e =>
    validateDimension(e.target, document.getElementById('edit-width-hint'), 400, 7680, v => { widthValid = v })
  )
  document.getElementById('edit-height').addEventListener('input', e =>
    validateDimension(e.target, document.getElementById('edit-height-hint'), 300, 4320, v => { heightValid = v })
  )
  uaSelect.addEventListener('change', updateSaveBtn)
  document.getElementById('edit-coi').addEventListener('click', e => {
    e.currentTarget.classList.toggle('active')
    updateSaveBtn()
  })
  document.getElementById('edit-single-instance').addEventListener('click', e => {
    e.currentTarget.classList.toggle('active')
    updateSaveBtn()
  })

  document.getElementById('edit-icon-btn').addEventListener('click', () => {
    iconPicker.openIconPicker((name, path) => {
      selectedIconName = name
      iconPreview.src = `file://${path}`
      iconNameEl.textContent = name
      iconNameEl.className = ''
      iconClearBtn.style.display = ''
      updateSaveBtn()
    })
  })

  iconClearBtn.addEventListener('click', () => {
    selectedIconName = ''
    iconPreview.src = appDefaultSrc
    iconNameEl.textContent = i18n.createIconChoose
    iconNameEl.className = 'icon-picker-placeholder'
    iconClearBtn.style.display = 'none'
    updateSaveBtn()
  })

  function renderInfoSection(app) {
    const section = document.getElementById('edit-info-section')
    const pathField = (label, value) => `
      <div class="dialog-field">
        <label>${label}</label>
        <div class="dialog-field-path">
          <div class="value">${value}</div>
          <button class="btn-reveal" data-reveal="${value}" data-tooltip="${i18n.infoReveal}">…</button>
        </div>
      </div>`

    if (app.built) {
      section.innerHTML =
        pathField(i18n.infoAppImage,   app.appImagePath) +
        pathField(i18n.infoProfileDir, app.profilePath)
    } else {
      section.innerHTML = `<p style="color:var(--card-url);font-size:0.85em;margin:4px 0 8px">${i18n.infoNotBuilt}</p>`
    }

    section.querySelectorAll('[data-reveal]').forEach(btn =>
      btn.addEventListener('click', () => window.managerAPI.revealPath(btn.dataset.reveal))
    )
  }

  function closeEditDialog() {
    clearTimeout(urlCheckTimer)
    overlay.classList.add('hidden')
  }

  function openEditDialog(app, onUpdatedCallback) {
    currentProfile = app.profile
    currentApp     = app
    onUpdated      = onUpdatedCallback

    document.getElementById('edit-profile-label').textContent = app.profile
    document.getElementById('edit-name').value = app.name || ''
    urlInput.value = app.url || ''
    urlInput.className = app.url ? 'valid' : ''
    urlHint.textContent = ''
    urlHint.className = 'field-hint'
    urlValid = !!app.url

    // Title and header icon reflect the specific app being edited.
    document.getElementById('edit-title').textContent = tr('editTitle', { name: app.name || app.profile })
    selectedIconName = app.icon || ''
    // Header icon mirrors the app's own icon (falls back to the wrapweb default).
    document.getElementById('edit-header-icon').src = app.iconPath ? `file://${app.iconPath}` : appDefaultSrc
    if (app.iconPath) {
      iconPreview.src = `file://${app.iconPath}`
      iconNameEl.textContent = app.icon
      iconNameEl.className = ''
      iconClearBtn.style.display = ''
    } else {
      iconPreview.src = appDefaultSrc
      iconNameEl.textContent = i18n.createIconChoose
      iconNameEl.className = 'icon-picker-placeholder'
      iconClearBtn.style.display = 'none'
    }

    document.getElementById('edit-width').value  = app.geometry?.width  || ''
    document.getElementById('edit-height').value = app.geometry?.height || ''
    document.getElementById('edit-width-hint').textContent  = ''
    document.getElementById('edit-height-hint').textContent = ''
    document.getElementById('edit-width').className  = app.geometry?.width  ? 'valid' : ''
    document.getElementById('edit-height').className = app.geometry?.height ? 'valid' : ''
    widthValid  = true
    heightValid = true

    uaSelect.value = app.userAgent || ''
    domainList.set(app.internalDomains || [])
    routingList.set(app.routingUrls || [])

    const coiBtn = document.getElementById('edit-coi')
    if (app.crossOriginIsolation) coiBtn.classList.add('active')
    else coiBtn.classList.remove('active')

    const siBtn = document.getElementById('edit-single-instance')
    if (app.singleInstance) siBtn.classList.add('active')
    else siBtn.classList.remove('active')

    const mailHandler = app.mimeTypes?.includes('x-scheme-handler/mailto')
    const mhBtn = document.getElementById('edit-mail-handler')
    if (mailHandler) mhBtn.classList.add('active')
    else mhBtn.classList.remove('active')
    pluginList.set(app.plugins || [])
    // Deep copy so editing in the config dialog doesn't mutate the app object until save.
    pluginConfig = app.pluginConfig ? JSON.parse(JSON.stringify(app.pluginConfig)) : {}

    renderInfoSection(app)
    initialSnapshot = snapshot()
    saveBtn.disabled = true

    overlay.classList.remove('hidden')
    if (!scrollbarInited) {
      OverlayScrollbars(document.getElementById('edit-scroll-wrapper'), { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
      scrollbarInited = true
    }
    document.getElementById('edit-name').focus()
  }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeEditDialog() })
  document.getElementById('edit-close').addEventListener('click', closeEditDialog)
  document.getElementById('edit-cancel').addEventListener('click', closeEditDialog)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || overlay.classList.contains('hidden')) return
    if (iconPicker.isOpen()) iconPicker.closeIconPicker()
    else closeEditDialog()
  })

  saveBtn.addEventListener('click', async () => {
    const cur = snapshot()
    saveBtn.disabled = true
    // snapshot() stringifies routingUrls/plugins/pluginConfig for dirty-detection; buildAppCfg
    // wants the real arrays/object.
    const result = await window.managerAPI.updateApp({ profile: currentProfile, ...cur, routingUrls: routingList.get(), plugins: pluginList.get(), pluginConfig })
    if (!result.success) { updateSaveBtn(); return }

    closeEditDialog()

    // After saving, offer a rebuild prompt when an AppImage already exists. Rebuilding now
    // always installs afterwards too (no separate toggle) — matching the card's combined
    // build-and-install action; cards.js installs after the build when rebuild is confirmed.
    if (currentApp.built) {
      const appName = currentApp.name || currentApp.profile
      const { confirmed } = await showConfirm(
        tr('editRebuildPrompt', { name: appName }),
        { okLabel: i18n.editRebuild, okClass: 'btn-save' }
      )
      onUpdated?.(result.app, { rebuild: confirmed })
    } else {
      onUpdated?.(result.app, { rebuild: false })
    }
  })

  return { openEditDialog, refreshUaPresets }
}
