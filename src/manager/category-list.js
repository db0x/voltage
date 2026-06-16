import { OverlayScrollbars } from '../../node_modules/overlayscrollbars/overlayscrollbars.mjs'

// Normalises a config's `category` value into a clean array of names. Accepts the legacy single
// string (embedded apps still use e.g. "microsoft"), an array (new user apps), or null/undefined.
// Trims, drops empties, de-duplicates — the one shape the rest of the renderer reasons about.
export function normalizeCategories(value) {
  const arr = Array.isArray(value) ? value : (value ? [value] : [])
  const out = []
  for (const c of arr) {
    const name = String(c).trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

// Gathers every category currently in use, read live from the rendered cards (each carries its
// normalised list in data-categories as JSON). Used to seed the picker's suggestions so a
// category created earlier in the session is offered again — without an extra IPC round-trip.
export function collectCategories() {
  const all = new Set()
  for (const card of document.querySelectorAll('.card[data-categories]')) {
    try { JSON.parse(card.dataset.categories || '[]').forEach(c => all.add(c)) } catch {}
  }
  return [...all].sort((a, b) => a.localeCompare(b))
}

// Category picker for the create/edit dialogs. Deliberately built from the components already used
// in these dialogs: the chip list (domain-item chips with a "−" remove button) and add-row input +
// "+" button from the domain/routing fields, plus the portal dropdown styling (app-select-list)
// from the plugin picker for suggesting existing categories. Typing a name and pressing Enter / "+"
// adds it — picking an existing one or creating a brand-new one. get() returns the chosen names.
export function initCategoryList(listId, inputId, addBtnId, onChange) {
  const listEl  = document.getElementById(listId)
  const inputEl = document.getElementById(inputId)
  const addBtn  = document.getElementById(addBtnId)
  let chosen      = []          // selected category names, in insertion order
  let suggestions = []          // known category names offered in the dropdown

  // Portal dropdown (same pattern as the plugin picker): appended to body so position:fixed
  // escapes the dialog's overflow:hidden scroll wrapper.
  const dropdown = document.createElement('div')
  dropdown.className = 'app-select-list'
  dropdown.style.display = 'none'
  const dropdownInner = document.createElement('ul')
  dropdown.appendChild(dropdownInner)
  document.body.appendChild(dropdown)

  let open = false
  let scrollbarInited = false

  function renderChips() {
    listEl.innerHTML = ''
    for (const name of chosen) {
      const li = document.createElement('li')
      li.className = 'domain-item'
      li.innerHTML = `<span></span><button type="button" class="domain-remove-btn" tabindex="-1">−</button>`
      // textContent (not innerHTML) so a category name can safely contain markup characters.
      li.querySelector('span').textContent = name
      li.querySelector('.domain-remove-btn').addEventListener('click', () => {
        chosen = chosen.filter(c => c !== name)
        renderChips()
        onChange()
      })
      listEl.appendChild(li)
    }
  }

  function add(value) {
    const name = (value ?? '').trim()
    if (!name || chosen.includes(name)) { inputEl.value = ''; closeDropdown(); return }
    chosen.push(name)
    if (!suggestions.includes(name)) suggestions.push(name)  // a freshly created category becomes a suggestion
    inputEl.value = ''
    renderChips()
    closeDropdown()
    onChange()
  }

  // Suggestions not yet chosen, filtered by what the user has typed (case-insensitive substring).
  function matches() {
    const q = inputEl.value.trim().toLowerCase()
    return suggestions
      .filter(c => !chosen.includes(c))
      .filter(c => !q || c.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b))
  }

  function refreshDropdown() {
    const items = matches()
    dropdownInner.innerHTML = ''
    if (items.length === 0) { closeDropdown(); return }
    for (const name of items) {
      const li = document.createElement('li')
      li.className = 'app-select-item'
      li.innerHTML = '<span></span>'
      li.querySelector('span').textContent = name
      li.addEventListener('click', () => add(name))
      dropdownInner.appendChild(li)
    }
    openDropdown()
  }

  function openDropdown() {
    const rect = inputEl.getBoundingClientRect()
    dropdown.style.left  = rect.left + 'px'
    dropdown.style.width = rect.width + 'px'
    dropdown.style.top   = (rect.bottom + 2) + 'px'
    dropdown.style.display = ''
    open = true
    if (!scrollbarInited) {
      OverlayScrollbars(dropdown, { scrollbars: { autoHide: 'leave', autoHideDelay: 200 } })
      scrollbarInited = true
    }
  }
  function closeDropdown() { dropdown.style.display = 'none'; open = false }

  addBtn.addEventListener('click', () => add(inputEl.value))
  inputEl.addEventListener('input', refreshDropdown)
  inputEl.addEventListener('focus', refreshDropdown)
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); add(inputEl.value) }
    if (e.key === 'Escape' && open) { e.stopPropagation(); closeDropdown() }
  })
  // contains()-based close (not stopPropagation): OverlayScrollbars rewrites the dropdown's inner
  // DOM, so clicks on its scrollbar elements would otherwise bubble up and close it unexpectedly.
  document.addEventListener('click', e => {
    if (open && !dropdown.contains(e.target) && !inputEl.contains(e.target)) closeDropdown()
  })

  return {
    get:   ()     => [...chosen],
    set:   (sel)  => { chosen = normalizeCategories(sel); renderChips() },
    reset: ()     => { chosen = []; inputEl.value = ''; closeDropdown(); renderChips() },
    // Replaces the offered suggestions (called on dialog open with the live category set).
    setSuggestions: (list) => { suggestions = normalizeCategories(list) },
  }
}
