// Folder field for the create/edit dialogs (AppImage output folder, profile folder). A read-only
// path display (the app's .dialog-field-path look) plus three on-design .btn-reveal buttons:
// choose (folder icon, native dialog), reveal (… opens it in the file manager) and reset (✕ back to
// default). get() returns the chosen override path, or '' when the default location should be used.
//
// `fallback` is the resolved default path: shown (muted) and used by reveal while no override is set,
// so the field doubles as the path display the dialog used to show in a separate section.
export function initFolderField(nameId, browseId, revealId, clearId, i18n, onChange = () => {}) {
  const nameEl    = document.getElementById(nameId)
  const browseBtn = document.getElementById(browseId)
  const revealBtn = revealId ? document.getElementById(revealId) : null
  const clearBtn  = clearId  ? document.getElementById(clearId)  : null
  let value    = ''
  let fallback = ''

  const effective = () => value || fallback

  function render() {
    const eff = effective()
    nameEl.textContent = eff || i18n.createFolderDefault
    nameEl.classList.toggle('icon-picker-placeholder', !eff)   // muted while showing the default hint
    if (revealBtn) revealBtn.style.display = eff ? '' : 'none'  // reveal only when there's a path
    if (clearBtn)  clearBtn.style.display  = value ? '' : 'none' // reset only when an override is set
  }

  browseBtn.addEventListener('click', async () => {
    const picked = await window.managerAPI.pickFolder(effective() || undefined)
    if (picked) { value = picked; render(); onChange() }
  })
  revealBtn?.addEventListener('click', () => { const e = effective(); if (e) window.managerAPI.revealPath(e) })
  clearBtn?.addEventListener('click', () => { value = ''; render(); onChange() })

  return {
    get:   ()  => value,
    // def: the resolved default path to display/reveal when no override is chosen.
    set:   (v, def = '') => { value = v || ''; fallback = def || ''; render() },
    reset: ()  => { value = ''; fallback = ''; render() },
  }
}
