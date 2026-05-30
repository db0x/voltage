import { OverlayScrollbars } from '../../../node_modules/overlayscrollbars/overlayscrollbars.mjs'
import { applyTemplate } from '../template.js'

export function initGlobalSettingsDialog({ i18n, icons, apps, appDefaultSrc, builtInUaPresets, templates }, { onSave } = {}) {
  // Computed fresh on every open so newly deleted/uninstalled apps appear immediately.
  // Built or installed apps are excluded — hiding them would leave dangling launchers.
  const getHideableApps = () => apps.filter(a => !a.isPrivate && !a.built && !a.installed)

  const overlay = applyTemplate(templates.globalSettings, { i18n, icons, vars: { appDefaultSrc } })
  document.body.appendChild(overlay)

  const listEl     = document.getElementById('gs-hidden-list')
  const appTrigger = document.getElementById('gs-app-trigger')
  const uaListEl   = document.getElementById('gs-ua-list')
  const saveBtn    = document.getElementById('global-settings-save')

  // Portal dropdown for the hidden-apps picker.
  // Outer div is the positioned/shown-hidden host for OverlayScrollbars.
  // Inner ul holds the items — its innerHTML can be wiped without touching OS internals.
  const appList = document.createElement('div')
  appList.className = 'app-select-list'
  appList.style.display = 'none'
  const appListInner = document.createElement('ul')
  appList.appendChild(appListInner)
  document.body.appendChild(appList)

  let hiddenProfiles    = []
  let customUaPresets   = []
  let dropdownOpen      = false
  let dropdownScrollbar = false
  let scrollbarInited   = false

  // ── UA add sub-dialog (built once, reused) ─────────────────────

  const uaDialog = document.createElement('div')
  uaDialog.className = 'dialog-overlay hidden'
  uaDialog.innerHTML = `
    <div class="dialog gs-ua-dialog">
      <div class="dialog-header">
        <img src="${icons.globe}" width="20" height="20" alt="">
        <span class="dialog-title">${i18n.globalSettingsUaAddTitle}</span>
        <button class="dialog-close" id="gs-ua-d-close">✕</button>
      </div>
      <div class="dialog-fields">
        <div class="dialog-field">
          <label>${i18n.globalSettingsUaLabel}</label>
          <input type="text" id="gs-ua-d-label" spellcheck="false" autocomplete="off">
          <span class="field-hint" id="gs-ua-d-label-hint"></span>
        </div>
        <div class="dialog-field">
          <label>${i18n.globalSettingsUaValue}</label>
          <textarea id="gs-ua-d-value" class="gs-ua-d-value" spellcheck="false" rows="3"></textarea>
        </div>
      </div>
      <div class="confirm-actions">
        <button class="btn-cancel" id="gs-ua-d-cancel">${i18n.confirmCancel}</button>
        <button class="btn-secondary" id="gs-ua-d-save" disabled>${i18n.globalSettingsUaAdd}</button>
      </div>
    </div>`
  document.body.appendChild(uaDialog)

  const uaDlabelEl  = uaDialog.querySelector('#gs-ua-d-label')
  const uaDlabelHint = uaDialog.querySelector('#gs-ua-d-label-hint')
  const uaDvalueEl  = uaDialog.querySelector('#gs-ua-d-value')
  const uaDsaveBtn  = uaDialog.querySelector('#gs-ua-d-save')

  function openUaAddDialog({ label = '', value = '' } = {}) {
    uaDlabelEl.value = label
    uaDvalueEl.value = value
    validateUaDialog()
    uaDialog.classList.remove('hidden')
    uaDlabelEl.select()
    uaDlabelEl.focus()
  }
  function closeUaAddDialog() { uaDialog.classList.add('hidden') }

  function validateUaDialog() {
    const label = uaDlabelEl.value.trim()
    const duplicate = label && [
      ...builtInUaPresets,
      ...customUaPresets,
    ].some(p => p.label === label)

    if (duplicate) {
      uaDlabelEl.className = 'invalid'
      uaDlabelHint.textContent = i18n.globalSettingsUaLabelExists
      uaDlabelHint.className = 'field-hint error'
    } else {
      uaDlabelEl.className = ''
      uaDlabelHint.textContent = ''
      uaDlabelHint.className = 'field-hint'
    }

    uaDsaveBtn.disabled = !label || !uaDvalueEl.value.trim() || duplicate
  }
  uaDlabelEl.addEventListener('input', validateUaDialog)
  uaDvalueEl.addEventListener('input', validateUaDialog)

  uaDialog.querySelector('#gs-ua-d-close').addEventListener('click', closeUaAddDialog)
  uaDialog.querySelector('#gs-ua-d-cancel').addEventListener('click', closeUaAddDialog)
  uaDialog.addEventListener('click', e => { if (e.target === uaDialog) closeUaAddDialog() })

  uaDsaveBtn.addEventListener('click', () => {
    const label = uaDlabelEl.value.trim()
    const value = uaDvalueEl.value.trim()
    if (!label || !value) return
    customUaPresets.push({ label, value })
    renderUaList()
    closeUaAddDialog()
  })

  // ── Hidden apps ────────────────────────────────────────────────

  function renderHiddenList() {
    const hideableApps = getHideableApps()
    listEl.innerHTML = ''
    for (const profile of hiddenProfiles) {
      const app    = hideableApps.find(a => a.profile === profile)
      const name   = app ? (app.name || profile) : profile
      const imgSrc = app?.iconPath ? `file://${app.iconPath}` : appDefaultSrc
      const li     = document.createElement('li')
      li.className = 'domain-item'
      li.innerHTML = `<img src="${imgSrc}" width="16" height="16" alt="" style="flex-shrink:0;object-fit:contain;border-radius:3px"><span>${name}</span><button type="button" class="domain-remove-btn" tabindex="-1">−</button>`
      li.querySelector('button').addEventListener('click', () => {
        hiddenProfiles = hiddenProfiles.filter(p => p !== profile)
        renderHiddenList()
        updateAppSelect()
      })
      listEl.appendChild(li)
    }
  }

  function updateAppSelect() {
    appListInner.innerHTML = ''
    const available = getHideableApps().filter(a => !hiddenProfiles.includes(a.profile))
    appTrigger.disabled = available.length === 0
    for (const app of available) {
      const imgSrc = app.iconPath ? `file://${app.iconPath}` : appDefaultSrc
      const li     = document.createElement('li')
      li.className = 'app-select-item'
      li.innerHTML = `<img src="${imgSrc}" width="16" height="16" alt="" style="flex-shrink:0;object-fit:contain;border-radius:3px"><span>${app.name || app.profile}</span>`
      li.addEventListener('click', () => {
        hiddenProfiles.push(app.profile)
        closeDropdown()
        renderHiddenList()
        updateAppSelect()
      })
      appListInner.appendChild(li)
    }
  }

  function openDropdown() {
    const rect = appTrigger.getBoundingClientRect()
    appList.style.left   = rect.left + 'px'
    appList.style.width  = rect.width + 'px'
    appList.style.bottom = (window.innerHeight - rect.top + 2) + 'px'
    // Inline style beats the OS author stylesheet's "display: flex" rule that would
    // otherwise override the UA "[hidden] { display: none }" on close.
    appList.style.display = ''
    dropdownOpen = true
    // Init once after the element is visible so OverlayScrollbars can measure it.
    if (!dropdownScrollbar) {
      OverlayScrollbars(appList, { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
      dropdownScrollbar = true
    }
  }
  function closeDropdown() { appList.style.display = 'none'; dropdownOpen = false }

  appTrigger.addEventListener('click', () => {
    if (dropdownOpen) closeDropdown(); else openDropdown()
  })
  // Use contains() instead of stopPropagation — OverlayScrollbars rewrites the internal DOM,
  // so propagation-based close breaks as clicks on scrollbar elements bubble up unexpectedly.
  document.addEventListener('click', e => {
    if (!dropdownOpen) return
    if (!appList.contains(e.target) && !appTrigger.contains(e.target)) closeDropdown()
  })

  // ── User-Agent presets ─────────────────────────────────────────

  function renderUaList() {
    uaListEl.innerHTML = ''

    // Built-in presets: read-only, shown greyed. Tooltip reveals the full UA string.
    // The copy button pre-fills the add dialog so the user can derive a custom preset.
    for (const { label, value } of builtInUaPresets) {
      const li = document.createElement('li')
      li.className = 'gs-ua-item gs-ua-builtin'
      li.innerHTML = `<span class="gs-ua-label" data-tooltip="${value}">${label}</span><span class="gs-ua-badge">${i18n.globalSettingsUaBuiltin ?? 'built-in'}</span><button type="button" class="gs-ua-copy-btn" tabindex="-1"><img src="${icons.plus}" width="11" height="11" alt="+"></button>`
      li.querySelector('button').addEventListener('click', () => openUaAddDialog({ label, value }))
      uaListEl.appendChild(li)
    }

    // Custom presets: deletable.
    for (let i = 0; i < customUaPresets.length; i++) {
      const { label } = customUaPresets[i]
      const li = document.createElement('li')
      li.className = 'gs-ua-item'
      li.innerHTML = `<span class="gs-ua-label" data-tooltip="${customUaPresets[i].value}">${label}</span><button type="button" class="domain-remove-btn" tabindex="-1">−</button>`
      li.querySelector('button').addEventListener('click', () => {
        customUaPresets.splice(i, 1)
        renderUaList()
      })
      uaListEl.appendChild(li)
    }
  }

  // ── Dialog lifecycle ───────────────────────────────────────────

  function closeDialog() { closeDropdown(); overlay.classList.add('hidden') }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog() })
  document.getElementById('global-settings-close').addEventListener('click', closeDialog)
  document.getElementById('global-settings-cancel').addEventListener('click', closeDialog)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    // Close the sub-dialog first if it's open, then the main dialog.
    if (!uaDialog.classList.contains('hidden')) closeUaAddDialog()
    else closeDialog()
  })

  saveBtn.addEventListener('click', async () => {
    await window.managerAPI.saveGlobalSettings({ hiddenProfiles, customUaPresets })
    onSave?.({ hiddenProfiles, customUaPresets })
    closeDialog()
  })

  async function openGlobalSettingsDialog() {
    overlay.classList.remove('hidden')
    // Init once after the wrapper is visible so OverlayScrollbars can measure it.
    if (!scrollbarInited) {
      OverlayScrollbars(document.getElementById('gs-scroll-wrapper'), { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
      scrollbarInited = true
    }
    const saved = await window.managerAPI.loadGlobalSettings()
    hiddenProfiles  = Array.isArray(saved.hiddenProfiles)  ? [...saved.hiddenProfiles]  : []
    customUaPresets = Array.isArray(saved.customUaPresets) ? [...saved.customUaPresets] : []
    renderHiddenList()
    updateAppSelect()
    renderUaList()
  }

  return { openGlobalSettingsDialog }
}
