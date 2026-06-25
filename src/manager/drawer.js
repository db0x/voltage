// Single source of truth for card visibility. applyVisibility() is called
// whenever a filter changes, a card is added, or an app is installed/deleted.
import { applyTemplate } from './template.js'
// Gives the drawer the same custom scrollbar as the dialogs so every menu item
// stays reachable when the window is too short to show the whole menu at once.
import { OverlayScrollbars } from '../../node_modules/overlayscrollbars/overlayscrollbars.mjs'
import { setColorPickerTheme } from './color-picker.js'
import { collectCategories } from './category-list.js'

export function initDrawer({ i18n, icons, rcloneAvailable, obsidianAvailable, gnomeAvailable, mailHandlerAvailable, templates, onRebuildCategory }) {
  const { sun: sunSrc, moon: moonSrc, menu: menuSrc } = icons

  const menuBtn  = document.getElementById('menu-btn')
  const menuIcon = document.getElementById('menu-icon')
  if (menuSrc) menuIcon.src = menuSrc

  // Append into .window-shell (the UI wrapper) rather than <body>: in custom-chrome mode the shell is
  // the rounded, clipped card, so the drawer + backdrop must live inside it to be confined to the
  // card. In normal mode the shell fills the window, so behaviour is unchanged.
  const shell = document.querySelector('.window-shell') ?? document.body

  const backdrop = document.createElement('div')
  backdrop.className = 'drawer-backdrop'
  shell.appendChild(backdrop)

  const drawer = document.createElement('div')
  drawer.className = 'drawer'
  const wrapper = applyTemplate(templates.drawer, { i18n, icons })
  // Mail-handler and rclone buttons are always in the template; remove when not applicable.
  if (!mailHandlerAvailable) wrapper.querySelector('#menu-mail-handler')?.remove()
  if (!rcloneAvailable)    wrapper.querySelector('#menu-rclone')?.remove()
  if (!obsidianAvailable)  wrapper.querySelector('#menu-obsidian')?.remove()
  if (!gnomeAvailable)     wrapper.querySelector('#menu-gnome')?.remove()
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
  shell.appendChild(drawer)

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

  // Filters that aren't a category: the structural views. Anything else is a category name and
  // matches a card when that card's category list contains it.
  const STRUCTURAL = new Set(['all', 'public', 'private'])

  function applyVisibility() {
    document.querySelectorAll('.card[data-private]').forEach(card => {
      const isPrivate   = card.dataset.private   === 'true'
      const isInstalled = card.dataset.installed === 'true'
      // An app can carry multiple categories (stored as a JSON list in data-categories); a
      // category filter matches when that list contains the active filter name.
      let categories = []
      try { categories = JSON.parse(card.dataset.categories || '[]') } catch {}
      const passesFilter =
        currentFilter === 'all' ||
        (currentFilter === 'public'  && !isPrivate) ||
        (currentFilter === 'private' &&  isPrivate) ||
        (!STRUCTURAL.has(currentFilter) && categories.includes(currentFilter))
      card.style.display = (passesFilter && (!hideUninstalled || isInstalled)) ? '' : 'none'
    })
    // The add-card only makes sense in the "all" and user views; a category/embedded view hides it.
    const addCardEl = document.querySelector('.card-add')
    if (addCardEl) addCardEl.style.display = (currentFilter === 'all' || currentFilter === 'private') ? '' : 'none'
  }

  // Known categories keep their familiar localised label; user-created ones use their raw name.
  // Every category filter shares one icon — the same grid glyph the Microsoft/Google entries used
  // before — so the menu stays visually consistent regardless of how a category was created.
  const KNOWN_LABELS = { microsoft: i18n.drawerMicrosoft, google: i18n.drawerGoogle }
  const categoryIcon  = icons.filterMicrosoft
  const categoryFiltersEl = document.getElementById('drawer-category-filters')

  // Rebuilds the category filter buttons from the categories currently in use (read live from the
  // cards). Called at startup and whenever the cards change, so a freshly created category shows up
  // in the menu — and a category nobody uses any more disappears. Falls back to the "all" filter if
  // the active one was a category that no longer exists.
  function syncCategoryFilters() {
    if (!categoryFiltersEl) return
    const cats = collectCategories()
    categoryFiltersEl.innerHTML = ''
    for (const cat of cats) {
      // A row holds the filter button (left, grows) and a rebuild button (right) that recreates +
      // installs every app in the category — mirrors the appearance row's button+icon layout.
      const row = document.createElement('div')
      row.className = 'drawer-category-row'

      const btn = document.createElement('button')
      btn.className = 'menu-item'
      btn.dataset.filter = cat
      const img = document.createElement('img')
      if (categoryIcon) img.src = categoryIcon
      img.alt = ''
      const span = document.createElement('span')
      span.textContent = KNOWN_LABELS[cat] ?? cat
      btn.append(img, span)
      btn.addEventListener('click', () => { applyFilter(cat); closeDrawer() })

      const rebuildBtn = document.createElement('button')
      rebuildBtn.className = 'drawer-icon-btn'
      rebuildBtn.dataset.rebuildCategory = cat
      rebuildBtn.dataset.tooltip = i18n.drawerRebuildCategory
      const rebuildImg = document.createElement('img')
      if (icons.install) rebuildImg.src = icons.install
      rebuildImg.alt = i18n.drawerRebuildCategory
      rebuildBtn.appendChild(rebuildImg)
      rebuildBtn.addEventListener('click', e => { e.stopPropagation(); onRebuildCategory?.(cat) })

      row.append(btn, rebuildBtn)
      categoryFiltersEl.appendChild(row)
    }
    // Re-apply the active filter: keep it if still valid, otherwise reset to "all". This also
    // restores the active highlight on the freshly recreated buttons and re-runs visibility.
    applyFilter(STRUCTURAL.has(currentFilter) || cats.includes(currentFilter) ? currentFilter : 'all')
  }

  // Watch the card grid so the category filters track live changes (apps created/edited/deleted).
  // Debounced to one rebuild per microtask, coalescing the bulk card append at startup. Only
  // data-categories attribute changes are observed, so toggling card visibility can't loop back.
  const gridEl = document.getElementById('grid')
  if (gridEl) {
    let queued = false
    new MutationObserver(() => {
      if (queued) return
      queued = true
      queueMicrotask(() => { queued = false; syncCategoryFilters() })
    }).observe(gridEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-categories'] })
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
    applyFilter, applyVisibility, syncCategoryFilters,
    applyInitialFilter: () => applyFilter(currentFilter),
  }
}
