import { applyTemplate } from '../template.js'

// Renderer-local mirror of src/app-naming.js (canonical source of truth, but that module is
// CommonJS for the main process and can't be imported here). Keep these two in sync — they map
// a build profile to/from the user-facing .desktop name (e.g. "teams" ⇄ "vTeams").
const appNameFromProfile = (profile) => 'v' + profile.charAt(0).toUpperCase() + profile.slice(1)
const profileFromDesktop = (name) => {
  const base = name.replace(/\.desktop$/, '')
  const m = /^v(.+)/.exec(base)
  return m ? m[1].charAt(0).toLowerCase() + m[1].slice(1) : base
}

export function initMailHandlerDialog({ i18n, icons, apps, appDefaultSrc, templates }, { onSave } = {}) {
  // Only mail-capable apps that are both built and installed can be set as default.
  const mailApps = apps.filter(
    a => a.mimeTypes?.includes('x-scheme-handler/mailto') && a.built && a.installed
  )

  const overlay = applyTemplate(templates.mailHandler, { i18n, icons })
  document.body.appendChild(overlay)

  const listEl  = document.getElementById('mail-handler-app-list')
  const saveBtn = document.getElementById('mail-handler-save')

  // Profile of the currently selected app, or null for "no selection / clear handler".
  let selectedProfile = null

  function render() {
    listEl.innerHTML = ''
    for (const app of mailApps) {
      const item   = document.createElement('button')
      item.type    = 'button'
      item.className = 'mail-handler-item' + (selectedProfile === app.profile ? ' active' : '')
      const imgSrc   = app.iconPath ? `file://${app.iconPath}` : appDefaultSrc
      item.innerHTML = `<img src="${imgSrc}" width="20" height="20" alt=""><span>${app.name || app.profile}</span>`
      item.addEventListener('click', () => { selectedProfile = app.profile; render() })
      listEl.appendChild(item)
    }
  }

  function closeDialog() { overlay.classList.add('hidden') }

  document.getElementById('mail-handler-close').addEventListener('click', closeDialog)
  document.getElementById('mail-handler-cancel').addEventListener('click', closeDialog)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog() })

  saveBtn.addEventListener('click', async () => {
    if (selectedProfile !== null) {
      await window.managerAPI.setMailHandler(`${appNameFromProfile(selectedProfile)}.desktop`)
      onSave?.(selectedProfile)
    }
    closeDialog()
  })

  async function openMailHandlerDialog() {
    overlay.classList.remove('hidden')
    const current = await window.managerAPI.getMailHandler()
    // Derive profile from the default handler's .desktop name (e.g. "vGmail.desktop"); fall back
    // to null if not in mail apps.
    const profile = current ? profileFromDesktop(current) : null
    selectedProfile = mailApps.find(a => a.profile === profile) ? profile : null
    render()
  }

  return { openMailHandlerDialog }
}
