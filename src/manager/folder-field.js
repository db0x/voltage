// Folder-picker field for the create/edit dialogs (AppImage output folder, profile folder). Reuses
// the icon-picker field's markup: a button showing the effective absolute path, plus a reveal (…)
// button that opens it in the file manager and a clear (✕) button that resets to the default.
//
// Two values: `value` is the per-app override get() returns (empty = use the default), and
// `fallback` is the resolved default path shown/revealed while no override is set — so the field is
// the single place to see, open and change the folder (it replaces the old read-only path section).
export function initFolderField(btnId, nameId, clearId, revealId, i18n, onChange = () => {}) {
  const btn      = document.getElementById(btnId)
  const nameEl   = document.getElementById(nameId)
  const clearBtn = document.getElementById(clearId)
  const revealBtn = revealId ? document.getElementById(revealId) : null
  let value    = ''
  let fallback = ''

  const effective = () => value || fallback

  function render() {
    const eff = effective()
    nameEl.textContent = eff || i18n.createFolderDefault
    nameEl.className    = eff ? '' : 'icon-picker-placeholder'
    clearBtn.style.display = value ? '' : 'none'            // ✕ only when an override is set
    if (revealBtn) revealBtn.style.display = eff ? '' : 'none'  // reveal only when there's a path
  }

  btn.addEventListener('click', async () => {
    const picked = await window.managerAPI.pickFolder(effective() || undefined)
    if (picked) { value = picked; render(); onChange() }
  })
  clearBtn.addEventListener('click', () => { value = ''; render(); onChange() })
  revealBtn?.addEventListener('click', () => { const e = effective(); if (e) window.managerAPI.revealPath(e) })

  return {
    get:   ()  => value,
    // def: the resolved default path to display/reveal when no override is chosen.
    set:   (v, def = '') => { value = v || ''; fallback = def || ''; render() },
    reset: ()  => { value = ''; fallback = ''; render() },
  }
}
