// Single source of truth for card visibility. applyVisibility() is called
// whenever a filter changes, a card is added, or an app is installed/deleted.
export function initDrawer({ i18n, icons, rcloneAvailable }) {
  const { sun: sunSrc, moon: moonSrc, menu: menuSrc,
          filterAll: filterAllSrc, filterPublic: filterPublicSrc,
          filterPrivate: filterPrivateSrc,
          filterMicrosoft: filterMicrosoftSrc, filterGoogle: filterGoogleSrc,
          rclone: rcloneIconSrc } = icons

  const menuBtn  = document.getElementById('menu-btn')
  const menuIcon = document.getElementById('menu-icon')
  if (menuSrc) menuIcon.src = menuSrc

  const backdrop = document.createElement('div')
  backdrop.className = 'drawer-backdrop'
  document.body.appendChild(backdrop)

  const drawer = document.createElement('div')
  drawer.className = 'drawer'
  drawer.innerHTML = `
    <div class="drawer-section-label">${i18n.drawerAppearance}</div>
    <button class="menu-item" id="menu-darkmode">
      <img id="menu-darkmode-icon" src="" alt="">
      <span id="menu-darkmode-label"></span>
    </button>
    <hr class="drawer-divider">
    <div class="drawer-section-label">${i18n.drawerVisibility}</div>
    <button class="menu-item" data-filter="all">
      ${filterAllSrc    ? `<img src="${filterAllSrc}"    alt="">` : ''}
      <span>${i18n.drawerAllApps}</span>
    </button>
    <button class="menu-item" data-filter="public">
      ${filterPublicSrc ? `<img src="${filterPublicSrc}" alt="">` : ''}
      <span>${i18n.drawerEmbeddedApps}</span>
    </button>
    <button class="menu-item" data-filter="private">
      ${filterPrivateSrc ? `<img src="${filterPrivateSrc}" alt="">` : ''}
      <span>${i18n.drawerUserApps}</span>
    </button>
    <button class="menu-item" data-filter="microsoft">
      ${filterMicrosoftSrc ? `<img src="${filterMicrosoftSrc}" alt="">` : ''}
      <span>${i18n.drawerMicrosoft}</span>
    </button>
    <button class="menu-item" data-filter="google">
      ${filterGoogleSrc ? `<img src="${filterGoogleSrc}" alt="">` : ''}
      <span>${i18n.drawerGoogle}</span>
    </button>
    <button class="menu-item menu-toggle" id="menu-hide-uninstalled">
      <span class="toggle-switch"></span>
      <span>${i18n.drawerHideUninstalled}</span>
    </button>
    <hr class="drawer-divider">
    <button class="menu-item" id="menu-profiles">
      <span>${i18n.drawerProfiles}</span>
    </button>
    ${rcloneAvailable ? `
    <hr class="drawer-divider">
    <div class="drawer-section-label">${i18n.drawerRcloneSection}</div>
    <button class="menu-item" id="menu-rclone">
      ${rcloneIconSrc ? `<img src="${rcloneIconSrc}" alt="">` : ''}
      <span>${i18n.drawerRclone}</span>
    </button>` : ''}
    <button class="menu-item drawer-about-btn" id="menu-about">
      <span>${i18n.drawerAbout}</span>
    </button>
  `
  document.body.appendChild(drawer)

  function openDrawer()  { drawer.classList.add('open'); backdrop.classList.add('open') }
  function closeDrawer() { drawer.classList.remove('open'); backdrop.classList.remove('open') }

  menuBtn.addEventListener('click', () =>
    drawer.classList.contains('open') ? closeDrawer() : openDrawer()
  )
  backdrop.addEventListener('click', closeDrawer)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer() })

  function applyDarkmodeMenuItem() {
    const isDark = document.body.classList.contains('dark')
    const icon  = document.getElementById('menu-darkmode-icon')
    const label = document.getElementById('menu-darkmode-label')
    icon.src = isDark ? (sunSrc ?? '') : (moonSrc ?? '')
    icon.style.display = (sunSrc || moonSrc) ? '' : 'none'
    label.textContent = isDark ? i18n.drawerLightMode : i18n.drawerDarkMode
  }
  applyDarkmodeMenuItem()

  document.getElementById('menu-darkmode').addEventListener('click', () => {
    document.body.classList.toggle('dark')
    localStorage.setItem('dark', document.body.classList.contains('dark') ? '1' : '0')
    applyDarkmodeMenuItem()
  })

  let currentFilter   = localStorage.getItem('filter') ?? 'all'
  let hideUninstalled = localStorage.getItem('hideUninstalled') === '1'

  function applyVisibility() {
    document.querySelectorAll('.card[data-private]').forEach(card => {
      const isPrivate   = card.dataset.private   === 'true'
      const isInstalled = card.dataset.installed === 'true'
      const category    = card.dataset.category  || ''
      const passesFilter =
        currentFilter === 'all' ||
        (currentFilter === 'public'    && !isPrivate) ||
        (currentFilter === 'private'   &&  isPrivate) ||
        (currentFilter === 'microsoft' && category === 'microsoft') ||
        (currentFilter === 'google'    && category === 'google')
      card.style.display = (passesFilter && (!hideUninstalled || isInstalled)) ? '' : 'none'
    })
    const addCardEl = document.querySelector('.card-add')
    const hideAdd = ['public', 'microsoft', 'google'].includes(currentFilter)
    if (addCardEl) addCardEl.style.display = hideAdd ? 'none' : ''
  }

  function applyFilter(filter) {
    currentFilter = filter
    localStorage.setItem('filter', filter)
    drawer.querySelectorAll('[data-filter]').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.filter === filter)
    )
    applyVisibility()
  }

  drawer.querySelectorAll('[data-filter]').forEach(btn =>
    btn.addEventListener('click', () => { applyFilter(btn.dataset.filter); closeDrawer() })
  )

  // Restore last active filter and hide-uninstalled preference across sessions.
  const hideBtn = document.getElementById('menu-hide-uninstalled')
  hideBtn.classList.toggle('active', hideUninstalled)
  hideBtn.addEventListener('click', () => {
    hideUninstalled = !hideUninstalled
    localStorage.setItem('hideUninstalled', hideUninstalled ? '1' : '0')
    hideBtn.classList.toggle('active', hideUninstalled)
    applyVisibility()
  })

  return {
    openDrawer, closeDrawer,
    applyFilter, applyVisibility,
    applyInitialFilter: () => applyFilter(currentFilter),
  }
}
