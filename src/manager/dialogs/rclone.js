export function initRcloneDialog({ i18n, icons, appDefaultSrc }) {
  const rcloneIconHtml = icons.rclone
    ? `<img src="${icons.rclone}" width="20" height="20" alt="">`
    : ''
  const gdriveIconHtml = icons.googledrive
    ? `<img src="${icons.googledrive}" width="16" height="16" alt="">`
    : ''

  const overlay = document.createElement('div')
  overlay.className = 'dialog-overlay hidden'
  overlay.innerHTML = `
    <div class="dialog rclone-dialog">
      <div class="dialog-header">
        ${rcloneIconHtml}
        <span class="dialog-title">${i18n.rcloneDialogTitle}</span>
        <button class="dialog-close" id="rclone-close">✕</button>
      </div>
      <div class="dialog-fields">
        <fieldset class="rclone-fieldset">
          <legend class="rclone-fieldset-legend">
            ${gdriveIconHtml}
            ${i18n.rcloneDialogGdrive}
          </legend>
          <div class="dialog-field">
            <label for="rclone-remote-select">${i18n.rcloneDialogRemote}</label>
            <select id="rclone-remote-select">
              <option value="">${i18n.rcloneDialogNone}</option>
            </select>
          </div>
          <p class="rclone-hint" id="rclone-no-remotes-hint" style="display:none">
            ${i18n.rcloneDialogNoRemotes}
          </p>
          <div id="rclone-folders-section" style="display:none">
            <div class="rclone-section-heading">${i18n.rcloneDialogUploadFolders}</div>
            <div id="rclone-folder-rows"></div>
            <p class="rclone-hint">${i18n.rcloneDialogFolderHint}</p>
          </div>
        </fieldset>
        <p class="rclone-hint">${i18n.rcloneDialogHint}</p>
      </div>
      <div class="confirm-actions">
        <button class="btn-cancel" id="rclone-cancel">${i18n.confirmCancel}</button>
        <button class="btn-secondary" id="rclone-save">${i18n.rcloneDialogSave}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const selectEl       = document.getElementById('rclone-remote-select')
  const noHint         = document.getElementById('rclone-no-remotes-hint')
  const foldersSection = document.getElementById('rclone-folders-section')
  const folderRows     = document.getElementById('rclone-folder-rows')
  const saveBtn        = document.getElementById('rclone-save')

  function closeDialog() { overlay.classList.add('hidden') }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog() })
  document.getElementById('rclone-close').addEventListener('click', closeDialog)
  document.getElementById('rclone-cancel').addEventListener('click', closeDialog)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog() })

  function updateFolderVisibility() {
    foldersSection.style.display = selectEl.value ? '' : 'none'
  }
  selectEl.addEventListener('change', updateFolderVisibility)

  saveBtn.addEventListener('click', async () => {
    const remote = selectEl.value || null

    const uploadFolders = {}
    if (remote) {
      let valid = true
      folderRows.querySelectorAll('input[data-profile]').forEach(input => {
        const val = input.value.trim()
        if (!val) {
          input.classList.add('invalid')
          valid = false
        } else {
          input.classList.remove('invalid')
          uploadFolders[input.dataset.profile] = val
        }
      })
      if (!valid) return
    }

    await window.managerAPI.saveRcloneConfig({ googleDriveRemote: remote, uploadFolders })
    closeDialog()
  })

  overlay.addEventListener('input', e => {
    if (e.target.tagName === 'INPUT') e.target.classList.remove('invalid')
  })

  async function openRcloneDialog() {
    overlay.classList.remove('hidden')

    // Reload apps on every open so newly installed apps appear without a manager restart.
    const [remotes, saved, currentApps] = await Promise.all([
      window.managerAPI.getRcloneDriveRemotes(),
      window.managerAPI.loadRcloneConfig(),
      window.managerAPI.getApps(),
    ])

    // Rebuild remote selector.
    selectEl.innerHTML = `<option value="">${i18n.rcloneDialogNone}</option>`
    for (const name of remotes) {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      selectEl.appendChild(opt)
    }
    if (saved.googleDriveRemote && remotes.includes(saved.googleDriveRemote)) {
      selectEl.value = saved.googleDriveRemote
    }

    // Rebuild folder rows from the current app list (installed + rclone-capable only).
    const rcloneApps = currentApps.filter(a => a.rcloneFileHandler && a.installed)
    folderRows.innerHTML = rcloneApps.map(app => {
      const iconSrc = app.iconPath ? `file://${app.iconPath}` : (appDefaultSrc ?? '')
      const saved_  = saved.uploadFolders?.[app.profile] ?? app.profile
      return `
        <div class="rclone-folder-row">
          <img src="${iconSrc}" alt="">
          <span class="rclone-folder-app-name">${app.name || app.profile}</span>
          <input type="text"
                 data-profile="${app.profile}"
                 value="${saved_}"
                 placeholder="${app.profile}"
                 title="${i18n.rcloneDialogFolderHint}">
        </div>`
    }).join('\n')

    foldersSection.style.display = foldersSection.querySelector('.rclone-folder-row') && selectEl.value ? '' : 'none'
    noHint.style.display = remotes.length === 0 ? '' : 'none'
  }

  return { openRcloneDialog }
}
