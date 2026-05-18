export function initSafeBrowsingDialog({ i18n, icons }) {
  const safeBrowsingIconHtml = icons.googleSafeBrowsing
    ? `<img src="${icons.googleSafeBrowsing}" width="20" height="20" alt="">` : ''
  const eyeHiddenSrc  = icons.eyeHidden  ?? ''
  const eyeVisibleSrc = icons.eyeVisible ?? ''

  const overlay = document.createElement('div')
  overlay.className = 'dialog-overlay hidden'
  overlay.innerHTML = `
    <div class="dialog safe-browsing-dialog">
      <div class="dialog-header">
        ${safeBrowsingIconHtml}
        <span class="dialog-title">${i18n.safeBrowsingDialogTitle}</span>
        <button class="dialog-close" id="safe-browsing-close">✕</button>
      </div>
      <div class="dialog-fields">
        <button type="button" class="dialog-field-toggle" id="safe-browsing-enabled">
          <span class="toggle-switch"></span>
          <span>${i18n.safeBrowsingDialogEnabled}</span>
        </button>
        <div class="dialog-field">
          <label for="safe-browsing-api-key">${i18n.safeBrowsingDialogApiKey}</label>
          <div class="input-password-wrap">
            <input type="password" id="safe-browsing-api-key" autocomplete="off" spellcheck="false">
            <button type="button" class="btn-password-toggle" id="safe-browsing-toggle" aria-label="${i18n.safeBrowsingDialogShow}">
              ${eyeHiddenSrc ? `<img src="${eyeHiddenSrc}" width="16" height="16" alt="">` : i18n.safeBrowsingDialogShow}
            </button>
          </div>
        </div>
        <p class="rclone-hint">${i18n.safeBrowsingDialogHint}</p>
      </div>
      <div class="confirm-actions">
        <button class="btn-cancel" id="safe-browsing-cancel">${i18n.confirmCancel}</button>
        <button class="btn-secondary" id="safe-browsing-save">${i18n.safeBrowsingDialogSave}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const apiKeyInput   = document.getElementById('safe-browsing-api-key')
  const toggleBtn     = document.getElementById('safe-browsing-toggle')
  const enabledBtn    = document.getElementById('safe-browsing-enabled')
  const saveBtn       = document.getElementById('safe-browsing-save')

  enabledBtn.addEventListener('click', () => enabledBtn.classList.toggle('active'))

  toggleBtn.addEventListener('click', () => {
    const visible = apiKeyInput.type === 'text'
    apiKeyInput.type = visible ? 'password' : 'text'
    const src = visible ? eyeHiddenSrc : eyeVisibleSrc
    toggleBtn.innerHTML = src
      ? `<img src="${src}" width="16" height="16" alt="">`
      : (visible ? i18n.safeBrowsingDialogShow : i18n.safeBrowsingDialogHide)
    toggleBtn.setAttribute('aria-label', visible ? i18n.safeBrowsingDialogShow : i18n.safeBrowsingDialogHide)
  })

  function closeDialog() { overlay.classList.add('hidden') }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog() })
  document.getElementById('safe-browsing-close').addEventListener('click', closeDialog)
  document.getElementById('safe-browsing-cancel').addEventListener('click', closeDialog)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog() })

  saveBtn.addEventListener('click', async () => {
    const apiKey  = apiKeyInput.value.trim()
    const enabled = enabledBtn.classList.contains('active')
    await window.managerAPI.saveSafeBrowsingConfig({ apiKey: apiKey || null, enabled })
    closeDialog()
  })

  async function openSafeBrowsingDialog() {
    overlay.classList.remove('hidden')
    const saved = await window.managerAPI.loadSafeBrowsingConfig()
    apiKeyInput.value = saved.apiKey ?? ''
    enabledBtn.classList.toggle('active', saved.enabled ?? false)
    apiKeyInput.focus()
  }

  return { openSafeBrowsingDialog }
}
