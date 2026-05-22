// Single source of truth for card visibility. applyVisibility() is called
// whenever a filter changes, a card is added, or an app is installed/deleted.
import { applyTemplate } from './template.js'

export function initDrawer({ i18n, icons, rcloneAvailable, mailHandlerAvailable, templates }) {
  const { sun: sunSrc, moon: moonSrc, menu: menuSrc } = icons

  const menuBtn  = document.getElementById('menu-btn')
  const menuIcon = document.getElementById('menu-icon')
  if (menuSrc) menuIcon.src = menuSrc

  const backdrop = document.createElement('div')
  backdrop.className = 'drawer-backdrop'
  document.body.appendChild(backdrop)

  const drawer = document.createElement('div')
  drawer.className = 'drawer'
  const wrapper = applyTemplate(templates.drawer, { i18n, icons })
  // Mail-handler and rclone buttons are always in the template; remove when not applicable.
  if (!mailHandlerAvailable) wrapper.querySelector('#menu-mail-handler')?.remove()
  if (!rcloneAvailable) wrapper.querySelector('#menu-rclone')?.remove()
  drawer.innerHTML = wrapper.innerHTML
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
