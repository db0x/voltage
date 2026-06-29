import { OverlayScrollbars } from '../../node_modules/overlayscrollbars/overlayscrollbars.mjs'

// Plugin selection widget for the create/edit dialogs. Native <select>/<option> can't render
// images, so this mirrors the safe-browsing exclude-list pattern instead: a custom dropdown
// (portal list anchored to a trigger button) showing each plugin's icon + name, and chips for
// the chosen ones — each chip with its icon and a "−" remove button. get() returns the
// selected plugins' webapps-relative file paths — the shape stored in a config's `plugins`.
//
// `plugins` is the discovered catalog [{ file, label, icon, configurable }] (icon is a data URL
// or null); `appDefaultSrc` is the fallback icon for plugins shipping no plugin.svg;
// `configureIconSrc` is the gear icon shown on configurable plugins' chips; `onConfigure(file)`
// opens that plugin's config dialog (the chip's configure button).
export function initPluginList(triggerId, listId, plugins, appDefaultSrc, configureIconSrc, onChange, onConfigure) {
  const trigger = document.getElementById(triggerId)
  const listEl  = document.getElementById(listId)
  const catalog = plugins || []
  let selected  = []  // webapps-relative file paths, in insertion order

  const entryFor = (file) => catalog.find(p => p.file === file)
  const iconFor  = (p)    => p?.icon || appDefaultSrc
  const IMG = (src) => `<img src="${src}" width="16" height="16" alt="" style="flex-shrink:0;object-fit:contain;border-radius:3px">`

  // Portal: appended to body so position:fixed escapes the overflow:hidden on the wrapper.
  // Outer div is the positioned/shown-hidden host for OverlayScrollbars; inner ul holds items.
  const dropdown = document.createElement('div')
  dropdown.className = 'app-select-list'
  dropdown.style.display = 'none'
  const dropdownInner = document.createElement('ul')
  dropdown.appendChild(dropdownInner)
  document.body.appendChild(dropdown)

  let open = false
  let scrollbarInited = false

  // Chips for the chosen plugins, each with icon + label + (for configurable plugins) a configure
  // button + remove button. The configure button comes BEFORE remove and only for configurable
  // plugins; the remove button is matched by class (not the generic <button>) so the optional
  // configure button doesn't get wired as the remover.
  function renderChips() {
    listEl.innerHTML = ''
    for (const file of selected) {
      const p  = entryFor(file)
      const li = document.createElement('li')
      li.className = 'domain-item'
      const configureBtn = p?.configurable && configureIconSrc
        ? `<button type="button" class="domain-configure-btn" tabindex="-1">${IMG(configureIconSrc)}</button>`
        : ''
      li.innerHTML = `${IMG(iconFor(p))}<span>${p?.label || file}</span>${configureBtn}<button type="button" class="domain-remove-btn" tabindex="-1">−</button>`
      li.querySelector('.domain-remove-btn').addEventListener('click', () => {
        selected = selected.filter(f => f !== file)
        renderChips()
        refreshDropdown()
        onChange()
      })
      li.querySelector('.domain-configure-btn')?.addEventListener('click', () => onConfigure?.(file))
      listEl.appendChild(li)
    }
  }

  // Rebuild the dropdown with plugins not yet chosen (prevents duplicates); disable the
  // trigger when nothing is left to add (or none shipped at all). A plugin whose prerequisites are
  // unmet (entry.available === false) stays in the list but greyed and unselectable — it gets no
  // click handler, just a tooltip explaining why (e.g. Docker not installed). Unavailable plugins
  // still count toward "something to show", so the trigger stays enabled to reveal them.
  function refreshDropdown() {
    dropdownInner.innerHTML = ''
    const remaining = catalog.filter(p => !selected.includes(p.file))
    trigger.disabled = remaining.length === 0
    for (const p of remaining) {
      const li = document.createElement('li')
      li.className = 'app-select-item'
      li.innerHTML = `${IMG(iconFor(p))}<span>${p.label}</span>`
      if (p.available === false) {
        li.classList.add('app-select-item-disabled')
        li.setAttribute('aria-disabled', 'true')
        // pointer-events stays on (no CSS suppression) so the tooltip still fires on hover; the
        // missing click handler is what makes it unselectable.
        if (p.unavailableReason) li.dataset.tooltip = p.unavailableReason
      } else {
        li.addEventListener('click', () => {
          selected.push(p.file)
          closeDropdown()
          renderChips()
          refreshDropdown()
          onChange()
        })
      }
      dropdownInner.appendChild(li)
    }
  }

  function openDropdown() {
    const rect = trigger.getBoundingClientRect()
    dropdown.style.left   = rect.left + 'px'
    dropdown.style.width  = rect.width + 'px'
    dropdown.style.bottom = (window.innerHeight - rect.top + 2) + 'px'
    // Inline style beats the OS author stylesheet's "display: flex" rule that would otherwise
    // override the UA "[hidden] { display: none }" on close.
    dropdown.style.display = ''
    open = true
    if (!scrollbarInited) {
      OverlayScrollbars(dropdown, { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
      scrollbarInited = true
    }
  }
  function closeDropdown() { dropdown.style.display = 'none'; open = false }

  trigger.addEventListener('click', () => { open ? closeDropdown() : openDropdown() })
  // contains()-based close (not stopPropagation): OverlayScrollbars rewrites the inner DOM,
  // so clicks on its scrollbar elements would otherwise bubble up and close unexpectedly.
  document.addEventListener('click', e => {
    if (open && !dropdown.contains(e.target) && !trigger.contains(e.target)) closeDropdown()
  })

  return {
    get:   ()    => [...selected],
    set:   (sel) => { selected = Array.isArray(sel) ? [...sel] : []; renderChips(); refreshDropdown() },
    reset: ()    => { selected = []; closeDropdown(); renderChips(); refreshDropdown() },
  }
}
