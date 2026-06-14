import { applyTemplate } from '../template.js'

export function initUpdateNotice({ i18n, tr, icons, templates }) {
  const overlay = applyTemplate(templates.updateNotice, { i18n, icons })
  document.body.appendChild(overlay)

  document.getElementById('update-notice-ok').addEventListener('click', () => {
    overlay.classList.add('hidden')
  })

  // openExternal goes through main to enforce an allowlist — renderer cannot open arbitrary URLs.
  document.getElementById('update-notice-github').addEventListener('click', () => {
    window.managerAPI.openExternal('https://github.com/db0x/voltage')
  })

  function show(latestVersion) {
    document.getElementById('update-notice-body').innerHTML =
      tr('updateNoticeBody', { version: latestVersion })
    overlay.classList.remove('hidden')
  }

  return { show }
}
