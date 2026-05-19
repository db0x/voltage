export function initSafeBrowsingDialog({ i18n, icons, apps, appDefaultSrc }) {
  const safeBrowsingIconHtml = icons.googleSafeBrowsing
    ? `<img src="${icons.googleSafeBrowsing}" width="20" height="20" alt="">` : ''
  const eyeHiddenSrc  = icons.eyeHidden  ?? ''
  const eyeVisibleSrc = icons.eyeVisible ?? ''

  const overlay = document.createElement('div')
  overlay.className = 'dialog-overlay hidden'
  overlay.innerHTML = `
    <div class="dialog safe-browsing-dialog">
      <div class="dialog-header">
        ${safeBrowsingIconHtml}
        <span class="dialog-title">${i18n.safeBrowsingDialogTitle}</span>
        <button class="dialog-close" id="safe-browsing-close">✕</button>
      </div>
      <div class="dialog-fields">
        <button type="button" class="dialog-field-toggle" id="safe-browsing-enabled">
          <span class="toggle-switch"></span>
          <span>${i18n.safeBrowsingDialogEnabled}</span>
        </button>
        <div class="dialog-field">
          <label for="safe-browsing-api-key">${i18n.safeBrowsingDialogApiKey}</label>
          <div class="input-password-wrap">
            <input type="password" id="safe-browsing-api-key" autocomplete="off" spellcheck="false">
            <button type="button" class="btn-password-toggle" id="safe-browsing-toggle" aria-label="${i18n.safeBrowsingDialogShow}">
              ${eyeHiddenSrc ? `<img src="${eyeHiddenSrc}" width="16" height="16" alt="">` : i18n.safeBrowsingDialogShow}
            </button>
          </div>
        </div>
        <p class="rclone-hint">${i18n.safeBrowsingDialogHint}</p>
        <hr class="dialog-section-divider">
        <div class="dialog-field">
          <label>${i18n.safeBrowsingDialogExclude}</label>
          <div class="domain-field-wrapper">
            <ul class="domain-list" id="sb-excluded-list"></ul>
            <div class="domain-add-row">
              <button type="button" class="app-select-trigger" id="sb-app-trigger">
                <span class="app-select-hint">${i18n.safeBrowsingDialogExcludeHint}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="confirm-actions">
        <button class="btn-cancel" id="safe-browsing-cancel">${i18n.confirmCancel}</button>
        <button class="btn-secondary" id="safe-browsing-save">${i18n.safeBrowsingDialogSave}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const apiKeyInput   = document.getElementById('safe-browsing-api-key')
  const toggleBtn     = document.getElementById('safe-browsing-toggle')
  const enabledBtn    = document.getElementById('safe-browsing-enabled')
  const saveBtn       = document.getElementById('safe-browsing-save')
  const excludedList = document.getElementById('sb-excluded-list')
  const appTrigger   = document.getElementById('sb-app-trigger')

  // Portal: appended to body so position:fixed escapes the overflow:hidden on domain-field-wrapper.
  const appList = document.createElement('ul')
  appList.className = 'app-select-list'
  appList.hidden = true
  document.body.appendChild(appList)

  let excludedProfiles = []
  let dropdownOpen     = false

  // Rebuild the excluded-apps list UI.
  function renderExcludedList() {
    excludedList.innerHTML = ''
    for (const profile of excludedProfiles) {
      const app    = apps.find(a => a.profile === profile)
      const name   = app ? (app.name || profile) : profile
      const imgSrc = app?.iconPath ? `file://${app.iconPath}` : appDefaultSrc
      const li     = document.createElement('li')
      li.className = 'domain-item'
      li.innerHTML = `<img src="${imgSrc}" width="16" height="16" alt="" style="flex-shrink:0;object-fit:contain;border-radius:3px"><span>${name}</span><button type="button" class="domain-remove-btn" tabindex="-1">−</button>`
      li.querySelector('button').addEventListener('click', () => {
        excludedProfiles = excludedProfiles.filter(p => p !== profile)
        renderExcludedList()
        updateAppSelect()
      })
      excludedList.appendChild(li)
    }
  }

  // Rebuild the dropdown with apps not yet excluded (prevents duplicates).
  function updateAppSelect() {
    appList.innerHTML = ''
    const available = apps.filter(a => !excludedProfiles.includes(a.profile))
    appTrigger.disabled = available.length === 0
    for (const app of available) {
      const imgSrc = app.iconPath ? `file://${app.iconPath}` : appDefaultSrc
      const li     = document.createElement('li')
      li.className = 'app-select-item'
      li.innerHTML = `<img src="${imgSrc}" width="16" height="16" alt="" style="flex-shrink:0;object-fit:contain;border-radius:3px"><span>${app.name || app.profile}</span>`
      li.addEventListener('click', () => {
        excludedProfiles.push(app.profile)
        closeDropdown()
        renderExcludedList()
        updateAppSelect()
      })
      appList.appendChild(li)
    }
  }

  function openDropdown() {
    // Anchor the portal list to the trigger's viewport position.
    const rect = appTrigger.getBoundingClientRect()
    appList.style.left   = rect.left + 'px'
    appList.style.width  = rect.width + 'px'
    appList.style.bottom = (window.innerHeight - rect.top + 2) + 'px'
    appList.hidden = false
    dropdownOpen = true
  }
  function closeDropdown() { appList.hidden = true; dropdownOpen = false }

  // Toggle on trigger click; stop propagation so the document handler doesn't close it immediately.
  appTrigger.addEventListener('click', e => {
    e.stopPropagation()
    if (dropdownOpen) closeDropdown(); else openDropdown()
  })
  // Prevent clicks inside the list from closing it via the document handler.
  appList.addEventListener('click', e => e.stopPropagation())
  document.addEventListener('click', () => { if (dropdownOpen) closeDropdown() })

  enabledBtn.addEventListener('click', () => enabledBtn.classList.toggle('active'))

  toggleBtn.addEventListener('click', () => {
    const visible = apiKeyInput.type === 'text'
    apiKeyInput.type = visible ? 'password' : 'text'
    const src = visible ? eyeHiddenSrc : eyeVisibleSrc
    toggleBtn.innerHTML = src
      ? `<img src="${src}" width="16" height="16" alt="">`
      : (visible ? i18n.safeBrowsingDialogShow : i18n.safeBrowsingDialogHide)
    toggleBtn.setAttribute('aria-label', visible ? i18n.safeBrowsingDialogShow : i18n.safeBrowsingDialogHide)
  })

  function closeDialog() { closeDropdown(); overlay.classList.add('hidden') }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog() })
  document.getElementById('safe-browsing-close').addEventListener('click', closeDialog)
  document.getElementById('safe-browsing-cancel').addEventListener('click', closeDialog)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog() })

  saveBtn.addEventListener('click', async () => {
    const apiKey  = apiKeyInput.value.trim()
    const enabled = enabledBtn.classList.contains('active')
    await window.managerAPI.saveSafeBrowsingConfig({ apiKey: apiKey || null, enabled, excludedProfiles })
    closeDialog()
  })

  async function openSafeBrowsingDialog() {
    overlay.classList.remove('hidden')
    const saved = await window.managerAPI.loadSafeBrowsingConfig()
    apiKeyInput.value = saved.apiKey ?? ''
    enabledBtn.classList.toggle('active', saved.enabled ?? false)
    excludedProfiles = Array.isArray(saved.excludedProfiles) ? [...saved.excludedProfiles] : []
    renderExcludedList()
    updateAppSelect()
    apiKeyInput.focus()
  }

  return { openSafeBrowsingDialog }
}
