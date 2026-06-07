// Single source of truth for card visibility. applyVisibility() is called
// whenever a filter changes, a card is added, or an app is installed/deleted.
import { applyTemplate } from './template.js'
// Gives the drawer the same custom scrollbar as the dialogs so every menu item
// stays reachable when the window is too short to show the whole menu at once.
import { OverlayScrollbars } from '../../node_modules/overlayscrollbars/overlayscrollbars.mjs'
import { setColorPickerTheme } from './color-picker.js'

export function initDrawer({ i18n, icons, rcloneAvailable, obsidianAvailable, mailHandlerAvailable, templates }) {
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
  if (!rcloneAvailable)    wrapper.querySelector('#menu-rclone')?.remove()
  if (!obsidianAvailable)  wrapper.querySelector('#menu-obsidian')?.remove()
  // Wrap the menu in a dedicated scroll surface: .drawer stays the fixed
  // slide-in host, .drawer-scroll is what OverlayScrollbars takes over, and the
  // item spacing moves onto .drawer-list — OS wraps only the scroll element's
  // single child, so the gap has to live one level deeper (same shape the
  // dialog scroll wrappers use).
  wrapper.classList.add('drawer-list')
  const scroll = document.createElement('div')
  scroll.className = 'drawer-scroll'
  scroll.appendChild(wrapper)
  drawer.appendChild(scroll)
  document.body.appendChild(drawer)

  const menuDarkmodeBtn = document.getElementById('menu-darkmode')

  // Initialise OverlayScrollbars once, while the drawer is actually on screen so it can
  // measure correctly; its ResizeObserver then keeps the scrollbar in sync afterwards.
  let scrollbarInited = false
  function ensureScrollbar() {
    if (scrollbarInited) return
    OverlayScrollbars(scroll, { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
    scrollbarInited = true
  }
  function openDrawer() {
    drawer.classList.add('open')
    backdrop.classList.add('open')
    ensureScrollbar()
  }
  function closeDrawer() { drawer.classList.remove('open'); backdrop.classList.remove('open') }

  // Persistent-drawer mode: a CSS media query (min-width:875px) shows the drawer as a fixed
  // side panel that reserves space. Two things need JS support:
  //  - the scrollbar is normally initialised on first open, but here the drawer is visible
  //    without ever being "opened", so init it whenever the wide layout is active;
  //  - the drawer starts below the header, so publish the measured header height as --header-h
  //    (kept current on resize, since the ASCII banner's height depends on window width).
  const headerEl = document.querySelector('header')
  const publishHeaderHeight = () => {
    if (headerEl) document.documentElement.style.setProperty('--header-h', `${headerEl.offsetHeight}px`)
  }
  const wide = window.matchMedia('(min-width: 875px)')
  const syncPersistent = () => { if (wide.matches) { ensureScrollbar(); publishHeaderHeight() } }
  wide.addEventListener('change', syncPersistent)
  window.addEventListener('resize', () => { if (wide.matches) publishHeaderHeight() })
  syncPersistent()

  menuBtn.addEventListener('click', () =>
    drawer.classList.contains('open') ? closeDrawer() : openDrawer()
  )
  backdrop.addEventListener('click', closeDrawer)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer() })

  // Theme switch is icon-only: show sun while dark (click → light), moon while light.
  // A data-tooltip carries the textual label that used to live next to the icon.
  function applyDarkmodeMenuItem() {
    const isDark = document.body.classList.contains('dark')
    const icon = document.getElementById('menu-darkmode-icon')
    icon.src = isDark ? (sunSrc ?? '') : (moonSrc ?? '')
    icon.style.display = (sunSrc || moonSrc) ? '' : 'none'
    menuDarkmodeBtn.dataset.tooltip = isDark ? i18n.drawerLightMode : i18n.drawerDarkMode
  }
  applyDarkmodeMenuItem()

  menuDarkmodeBtn.addEventListener('click', () => {
    document.body.classList.toggle('dark')
    const isDark = document.body.classList.contains('dark')
    localStorage.setItem('dark', isDark ? '1' : '0')
    // Keep the Coloris picker's theme in sync with the manager (it doesn't follow body.dark).
    setColorPickerTheme(isDark)
    // Mirror the choice into manager-state.json so main can paint the next
    // cold-start frame with a matching backgroundColor — prevents a theme-mismatched flash.
    window.managerAPI?.setDark?.(isDark)
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
