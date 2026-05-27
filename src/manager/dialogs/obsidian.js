import { applyTemplate } from '../template.js'

export function initObsidianDialog({ i18n, icons, templates }) {
  const overlay    = applyTemplate(templates.obsidian, { i18n, icons })
  document.body.appendChild(overlay)

  const vaultList       = document.getElementById('obsidian-vault-list')
  const noVaultsHint    = document.getElementById('obsidian-no-vaults-hint')
  const installBtn      = document.getElementById('obsidian-install')
  const bundledVersion  = document.getElementById('obsidian-bundled-version')

  function closeDialog() { overlay.classList.add('hidden') }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog() })
  document.getElementById('obsidian-close').addEventListener('click', closeDialog)
  document.getElementById('obsidian-cancel').addEventListener('click', closeDialog)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog() })

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true
    installBtn.textContent = i18n.obsidianDialogInstalling
    const result = await window.managerAPI.installObsidianPlugin()
    if (result.success) {
      // Refresh vault list to show updated statuses.
      await loadStatus()
    } else {
      installBtn.disabled = false
      installBtn.textContent = i18n.obsidianDialogInstall
    }
  })

  async function loadStatus() {
    const status = await window.managerAPI.getObsidianPluginStatus()
    const { vaults } = status

    vaultList.innerHTML = ''
    noVaultsHint.style.display = vaults.length === 0 ? '' : 'none'
    bundledVersion.textContent = status.bundledVersion ? `v${status.bundledVersion}` : ''

    let anyAction = false

    for (const vault of vaults) {
      const row = document.createElement('div')
      row.className = 'obsidian-vault-row'

      const name = document.createElement('span')
      name.className = 'obsidian-vault-name'
      name.textContent = vault.name

      const versionEl = document.createElement('span')
      versionEl.className = 'obsidian-vault-version'
      versionEl.textContent = vault.installedVersion ? `v${vault.installedVersion}` : ''

      const badge = document.createElement('span')
      if (!vault.installedVersion) {
        badge.className = 'badge badge-not-built'
        badge.textContent = i18n.obsidianDialogNotInstalled
        anyAction = true
      } else if (vault.installedVersion !== status.bundledVersion) {
        badge.className = 'badge badge-outdated'
        badge.textContent = i18n.obsidianDialogOutdated
        anyAction = true
      } else {
        badge.className = 'badge badge-installed'
        badge.textContent = i18n.obsidianDialogUpToDate
      }

      row.appendChild(name)
      row.appendChild(versionEl)
      row.appendChild(badge)
      vaultList.appendChild(row)
    }

    installBtn.disabled = vaults.length === 0
    // Label reflects whether this is a first install or an update.
    const allInstalled = vaults.every(v => v.installedVersion)
    installBtn.textContent = allInstalled && anyAction ? i18n.obsidianDialogUpdate : i18n.obsidianDialogInstall
    if (!anyAction && vaults.length > 0) installBtn.disabled = true
  }

  async function openObsidianDialog() {
    overlay.classList.remove('hidden')
    vaultList.innerHTML = ''
    noVaultsHint.style.display = 'none'
    installBtn.disabled = true
    installBtn.textContent = i18n.obsidianDialogInstall
    await loadStatus()
  }

  return { openObsidianDialog }
}
