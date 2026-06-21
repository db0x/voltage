import { OverlayScrollbars } from '../../../node_modules/overlayscrollbars/overlayscrollbars.mjs'
import { applyTemplate }     from '../template.js'

export function initIconPicker({ i18n, templates }) {
  let overlay = null
  let allIconsCache = null
  let onSelectCallback = null

  // Lazy-create the overlay DOM on first open — avoids building a large grid on startup.
  function ensureOverlay() {
    if (overlay) return
    overlay = applyTemplate(templates.iconPicker, { i18n })
    document.body.appendChild(overlay)
    OverlayScrollbars(document.getElementById('icon-picker-scroll-wrapper'), { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
    document.getElementById('icon-picker-close').addEventListener('click', closeIconPicker)
    document.getElementById('icon-search').addEventListener('input', e =>
      filterIconGrid(e.target.value.trim().toLowerCase())
    )
  }

  function closeIconPicker() {
    overlay?.classList.add('hidden')
  }

  function isOpen() {
    return overlay ? !overlay.classList.contains('hidden') : false
  }

  function renderIconGrid(icons) {
    const gridEl = document.getElementById('icon-picker-grid')
    const frag = document.createDocumentFragment()
    for (const { name, path } of icons) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'icon-item'
      btn.title = name
      btn.dataset.name = name
      const img = document.createElement('img')
      img.src = `file://${path}`
      img.width = 32
      img.height = 32
      img.alt = ''
      // Thousands of icons — lazy loading prevents a full-page image decode on open.
      img.loading = 'lazy'
      img.decoding = 'async'
      btn.appendChild(img)
      btn.addEventListener('click', () => {
        onSelectCallback?.(name, path)
        closeIconPicker()
      })
      frag.appendChild(btn)
    }
    gridEl.replaceChildren(frag)
  }

  function filterIconGrid(query) {
    for (const btn of document.getElementById('icon-picker-grid').querySelectorAll('.icon-item')) {
      btn.style.display = !query || btn.dataset.name.includes(query) ? '' : 'none'
    }
  }

  async function openIconPicker(onSelected) {
    ensureOverlay()
    onSelectCallback = onSelected
    overlay.classList.remove('hidden')

    // Focus immediately while the dialog is visible — before any async work so the
    // browser gesture association is still intact and the user can start typing right away.
    const searchEl = document.getElementById('icon-search')
    searchEl.value = ''

    // Cache the full icon list after the first IPC call — subsequent opens reuse it.
    if (!allIconsCache) {
      const loader = document.getElementById('icon-picker-loader')
      loader.classList.remove('hidden')
      allIconsCache = await window.managerAPI.getAllIcons()
      renderIconGrid(allIconsCache)
      loader.classList.add('hidden')
    }

    filterIconGrid('')
    // Focus after all DOM work (icon grid render + filter) is done — earlier calls get
    // displaced by the mass DOM insertion that follows.
    setTimeout(() => searchEl.focus(), 0)
  }

  return { openIconPicker, closeIconPicker, isOpen }
}
