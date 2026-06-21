import { applyTemplate } from '../template.js'

// GNOME Shell extension dialog: shows whether the Voltage widget extension is installed,
// up to date and enabled, and installs/updates it on demand. Modelled on the Obsidian dialog
// but there is a single extension rather than a per-vault list.
export function initGnomeDialog({ i18n, icons, templates }) {
  const overlay = applyTemplate(templates.gnome, { i18n, icons })
  document.body.appendChild(overlay)

  const installBtn       = document.getElementById('gnome-install')
  const bundledVersion   = document.getElementById('gnome-bundled-version')
  const installedVersion = document.getElementById('gnome-installed-version')
  const statusBadge      = document.getElementById('gnome-status-badge')
  const relogHint        = document.getElementById('gnome-relog-hint')

  function closeDialog() { overlay.classList.add('hidden') }

  document.getElementById('gnome-close').addEventListener('click', closeDialog)
  document.getElementById('gnome-cancel').addEventListener('click', closeDialog)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog() })

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true
    installBtn.textContent = i18n.gnomeDialogInstalling
    const result = await window.managerAPI.installGnomeExtension()
    if (result.success) {
      // Refresh to reflect the new installed version / enabled state. The relog hint becomes
      // visible here when GNOME could not enable the freshly copied extension yet (Wayland).
      await loadStatus(!result.enabled)
    } else {
      installBtn.disabled = false
      installBtn.textContent = i18n.gnomeDialogInstall
    }
  })

  // showRelog forces the "relog required" hint after an install that copied the files but could
  // not enable them live (typical on Wayland). On a plain open we only show it when the session
  // is Wayland AND the extension is present but not yet enabled.
  async function loadStatus(showRelog = false) {
    const status = await window.managerAPI.getGnomeExtensionStatus()
    const { bundledVersion: bundled, installedVersion: installed, enabled, isWayland } = status

    bundledVersion.textContent   = bundled  != null ? `v${bundled}` : ''
    installedVersion.textContent = installed != null ? `v${installed}` : ''

    let action = false
    if (installed == null) {
      statusBadge.className = 'badge badge-not-built'
      statusBadge.textContent = i18n.gnomeDialogNotInstalled
      action = true
    } else if (installed !== bundled) {
      statusBadge.className = 'badge badge-outdated'
      statusBadge.textContent = i18n.gnomeDialogOutdated
      action = true
    } else if (!enabled) {
      statusBadge.className = 'badge badge-outdated'
      statusBadge.textContent = i18n.gnomeDialogDisabled
    } else {
      statusBadge.className = 'badge badge-installed'
      statusBadge.textContent = i18n.gnomeDialogEnabled
    }

    relogHint.style.display = (showRelog || (isWayland && installed != null && !enabled)) ? '' : 'none'

    installBtn.disabled = !action && enabled
    installBtn.textContent = (installed != null && action) ? i18n.gnomeDialogUpdate : i18n.gnomeDialogInstall
  }

  async function openGnomeDialog() {
    overlay.classList.remove('hidden')
    statusBadge.textContent = ''
    installBtn.disabled = true
    installBtn.textContent = i18n.gnomeDialogInstall
    await loadStatus()
  }

  return { openGnomeDialog }
}
