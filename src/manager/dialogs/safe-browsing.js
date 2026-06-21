import { OverlayScrollbars } from '../../../node_modules/overlayscrollbars/overlayscrollbars.mjs'
import { applyTemplate } from '../template.js'

export function initSafeBrowsingDialog({ i18n, icons, apps, appDefaultSrc, templates }) {
  const eyeHiddenSrc  = icons.eyeHidden  ?? ''
  const eyeVisibleSrc = icons.eyeVisible ?? ''

  const overlay = applyTemplate(templates.safeBrowsing, { i18n, icons })
  document.body.appendChild(overlay)

  const apiKeyInput   = document.getElementById('safe-browsing-api-key')
  const toggleBtn     = document.getElementById('safe-browsing-toggle')
  const enabledBtn    = document.getElementById('safe-browsing-enabled')
  const saveBtn       = document.getElementById('safe-browsing-save')
  const excludedList = document.getElementById('sb-excluded-list')
  const appTrigger   = document.getElementById('sb-app-trigger')

  // Portal: appended to body so position:fixed escapes the overflow:hidden on domain-field-wrapper.
  // Outer div is the positioned/shown-hidden host for OverlayScrollbars.
  // Inner ul holds the items — its innerHTML can be wiped without touching OS internals.
  const appList = document.createElement('div')
  appList.className = 'app-select-list'
  appList.style.display = 'none'
  const appListInner = document.createElement('ul')
  appList.appendChild(appListInner)
  document.body.appendChild(appList)

  let excludedProfiles  = []
  let dropdownOpen      = false
  let dropdownScrollbar = false

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
    appListInner.innerHTML = ''
    const available = apps.filter(a => a.built && !excludedProfiles.includes(a.profile))
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
      appListInner.appendChild(li)
    }
  }

  function openDropdown() {
    // Anchor the portal list to the trigger's viewport position.
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

  // Toggle on trigger click; stop propagation so the document handler doesn't close it immediately.
  appTrigger.addEventListener('click', () => {
    if (dropdownOpen) closeDropdown(); else openDropdown()
  })
  // Use contains() instead of stopPropagation — OverlayScrollbars rewrites the internal DOM,
  // so propagation-based close breaks as clicks on scrollbar elements bubble up unexpectedly.
  document.addEventListener('click', e => {
    if (!dropdownOpen) return
    if (!appList.contains(e.target) && !appTrigger.contains(e.target)) closeDropdown()
  })

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
