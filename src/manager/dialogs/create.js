import { OverlayScrollbars } from '../../../node_modules/overlayscrollbars/overlayscrollbars.mjs'
import { applyTemplate } from '../template.js'
import { initDomainList } from '../domain-list.js'
import { initRoutingUrlList } from '../routing-url-field.js'
import { initPluginList } from '../plugin-list.js'

export function initCreateDialog({ i18n, tr, appDefaultSrc, uaPresets, plugins, icons, templates }, { iconPicker, applyVisibility, createCard, insertCard, openPluginConfig }) {
  const overlay = applyTemplate(templates.create, { i18n, vars: { appDefaultSrc } })
  document.body.appendChild(overlay)

  const uaSelect = document.getElementById('create-useragent')
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

  const domainList = initDomainList('create-domain-list', 'create-domain-input', 'create-domain-add', () => {})
  // getProfile reads the profile input live: the overlap check excludes the app's own
  // profile, and the field may change while the dialog is open.
  const routingList = initRoutingUrlList(
    'create',
    () => document.getElementById('create-profile').value.trim(),
    { tr, onChange: () => {} }
  )

  // Per-app, per-plugin settings (e.g. widget radius), keyed by plugin file path. Cleared on
  // each open; the configure dialog reads/writes the entry for the clicked plugin.
  let pluginConfig = {}

  // Plugin selection is its own select-and-add list, independent of the mail-handler toggle.
  // The configure button opens the plugin's own dialog, scoped to this app's config for it.
  const pluginList = initPluginList('create-plugin-trigger', 'create-plugin-list', plugins, appDefaultSrc, icons?.configure,
    () => {},
    file => openPluginConfig(file, {
      get: () => pluginConfig[file] || {},
      set: cfg => { pluginConfig[file] = cfg },
    }))

  document.getElementById('create-mail-handler').addEventListener('click', e => {
    e.currentTarget.classList.toggle('active')
  })

  let profileValid = false
  let urlValid     = false
  let widthValid   = true
  let heightValid  = true
  let profileCheckTimer = null
  let urlCheckTimer     = null
  let selectedIconName  = ''
  let scrollbarInited   = false

  const profileInput = document.getElementById('create-profile')
  const profileHint  = document.getElementById('create-profile-hint')
  const urlInput     = document.getElementById('create-url')
  const urlHint      = document.getElementById('create-url-hint')
  const saveBtn      = document.getElementById('create-save')
  const iconPreview  = document.getElementById('create-icon-preview')
  const iconNameEl   = document.getElementById('create-icon-name')
  const iconClearBtn = document.getElementById('create-icon-clear')

  function updateSaveBtn() {
    saveBtn.disabled = !(profileValid && urlValid && widthValid && heightValid)
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

  profileInput.addEventListener('input', () => {
    const val = profileInput.value.trim()
    profileValid = false
    if (!val) {
      profileInput.className = ''
      profileHint.textContent = ''
      clearTimeout(profileCheckTimer)
      updateSaveBtn()
      return
    }
    if (!/^[a-z0-9-]+$/.test(val)) {
      profileInput.className = 'invalid'
      profileHint.textContent = i18n.validPattern
      profileHint.className = 'field-hint error'
      clearTimeout(profileCheckTimer)
      updateSaveBtn()
      return
    }
    clearTimeout(profileCheckTimer)
    profileInput.className = ''
    profileHint.textContent = i18n.validChecking
    profileHint.className = 'field-hint'
    // Debounce the uniqueness check — avoids an IPC round-trip on every keystroke.
    // Guard against stale responses: discard if the input changed while awaiting.
    profileCheckTimer = setTimeout(async () => {
      const exists = await window.managerAPI.checkProfile(val)
      if (profileInput.value.trim() !== val) return
      if (exists) {
        profileInput.className = 'invalid'
        profileHint.textContent = i18n.validExists
        profileHint.className = 'field-hint error'
        profileValid = false
      } else {
        profileInput.className = 'valid'
        profileHint.textContent = tr('validHint', { profile: val })
        profileHint.className = 'field-hint'
        profileValid = true
      }
      updateSaveBtn()
    }, 300)
  })

  urlInput.addEventListener('input', () => {
    const val = urlInput.value.trim()
    clearTimeout(urlCheckTimer)
    if (!val) {
      urlValid = false
      urlInput.className = ''
      urlHint.textContent = ''
      urlHint.className = 'field-hint'
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
    // Format ok — base URLs must not overlap another app's base URL. The check is async
    // (IPC) and debounced; save stays disabled until it confirms the URL is collision-free.
    urlValid = false
    urlInput.className = ''
    urlHint.textContent = i18n.validChecking
    urlHint.className = 'field-hint'
    updateSaveBtn()
    urlCheckTimer = setTimeout(async () => {
      const { conflict } = await window.managerAPI.checkRoutingOverlap(profileInput.value.trim(), val, 'base')
      if (urlInput.value.trim() !== val) return  // input changed while awaiting
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

  document.getElementById('create-width').addEventListener('input', e =>
    validateDimension(e.target, document.getElementById('create-width-hint'), 400, 7680, v => { widthValid = v })
  )
  document.getElementById('create-height').addEventListener('input', e =>
    validateDimension(e.target, document.getElementById('create-height-hint'), 300, 4320, v => { heightValid = v })
  )
  document.getElementById('create-coi').addEventListener('click', e =>
    e.currentTarget.classList.toggle('active')
  )
  document.getElementById('create-single-instance').addEventListener('click', e =>
    e.currentTarget.classList.toggle('active')
  )

  document.getElementById('create-icon-btn').addEventListener('click', () => {
    iconPicker.openIconPicker((name, path) => {
      selectedIconName = name
      iconPreview.src = `file://${path}`
      iconNameEl.textContent = name
      iconNameEl.className = ''
      iconClearBtn.style.display = ''
    })
  })

  iconClearBtn.addEventListener('click', () => {
    selectedIconName = ''
    iconPreview.src = appDefaultSrc
    iconNameEl.textContent = i18n.createIconChoose
    iconNameEl.className = 'icon-picker-placeholder'
    iconClearBtn.style.display = 'none'
  })

  function openCreateDialog() {
    selectedIconName = ''
    profileInput.value = ''
    profileInput.className = ''
    profileHint.textContent = ''
    profileHint.className = 'field-hint'
    document.getElementById('create-name').value = ''
    urlInput.value = ''
    urlInput.className = ''
    urlHint.textContent = ''
    urlHint.className = 'field-hint'
    iconPreview.src = appDefaultSrc
    iconNameEl.textContent = i18n.createIconChoose
    iconNameEl.className = 'icon-picker-placeholder'
    iconClearBtn.style.display = 'none'
    document.getElementById('create-width').value = ''
    document.getElementById('create-height').value = ''
    document.getElementById('create-useragent').value = ''
    domainList.reset()
    routingList.reset()
    document.getElementById('create-coi').classList.remove('active')
    document.getElementById('create-single-instance').classList.remove('active')
    document.getElementById('create-mail-handler').classList.remove('active')
    pluginList.reset()
    pluginConfig = {}
    profileValid = false
    urlValid     = false
    widthValid   = true
    heightValid  = true
    updateSaveBtn()
    overlay.classList.remove('hidden')
    // Init once after the wrapper is visible so OverlayScrollbars can measure it.
    if (!scrollbarInited) {
      OverlayScrollbars(document.getElementById('create-scroll-wrapper'), { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
      scrollbarInited = true
    }
    profileInput.focus()
  }

  function closeCreateDialog() {
    clearTimeout(profileCheckTimer)
    clearTimeout(urlCheckTimer)
    overlay.classList.add('hidden')
  }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeCreateDialog() })
  document.getElementById('create-close').addEventListener('click', closeCreateDialog)
  document.getElementById('create-cancel').addEventListener('click', closeCreateDialog)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    if (iconPicker.isOpen()) iconPicker.closeIconPicker()
    else closeCreateDialog()
  })

  saveBtn.addEventListener('click', async () => {
    const profile             = profileInput.value.trim()
    const name                = document.getElementById('create-name').value.trim()
    const url                 = urlInput.value.trim()
    const icon                = selectedIconName
    const width               = document.getElementById('create-width').value.trim()
    const height              = document.getElementById('create-height').value.trim()
    const userAgent           = document.getElementById('create-useragent').value.trim()
    const internalDomains     = domainList.get().join(', ')
    const routingUrls          = routingList.get()
    const crossOriginIsolation = document.getElementById('create-coi').classList.contains('active')
    const singleInstance       = document.getElementById('create-single-instance').classList.contains('active')
    const mailHandler          = document.getElementById('create-mail-handler').classList.contains('active')
    const plugins              = pluginList.get()
    saveBtn.disabled = true
    const result = await window.managerAPI.createApp({ profile, name, url, icon, width, height, userAgent, internalDomains, routingUrls, crossOriginIsolation, singleInstance, mailHandler, plugins, pluginConfig })
    if (result.success) {
      closeCreateDialog()
      insertCard(createCard(result.app))
      applyVisibility()
    } else {
      updateSaveBtn()
    }
  })

  return { openCreateDialog, refreshUaPresets }
}
