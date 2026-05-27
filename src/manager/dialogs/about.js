import { applyTemplate } from '../template.js'

const ASCII_ART = [
  '                                 __ ',
  ' _    _________ ____ _    _____ / / ',
  '| |/|/ / __/ _ `/ _ \\ |/|/ / -_) _ \\',
  '|__,__/_/  \\_,_/ .__/__,__/\\__/_.__/🐧',
  '              /_/                   ',
].join('\n')

export function initAboutDialog({ i18n, version, icons, templates }, { obsidianAvailable = false, rcloneAvailable = false, onOpenObsidian = null, onOpenRclone = null } = {}) {
  const overlay = applyTemplate(templates.about, { i18n, icons, vars: { version } })
  document.body.appendChild(overlay)

  overlay.querySelector('.about-ascii').textContent = ASCII_ART

  if (obsidianAvailable) {
    const obsidianEl = document.getElementById('about-obsidian')
    obsidianEl.hidden = false
    if (onOpenObsidian) {
      obsidianEl.style.cursor = 'pointer'
      obsidianEl.addEventListener('click', () => { closeAboutDialog(); onOpenObsidian() })
    }
  }
  if (rcloneAvailable) {
    const rcloneEl = document.getElementById('about-rclone-plugin')
    rcloneEl.hidden = false
    if (onOpenRclone) {
      rcloneEl.style.cursor = 'pointer'
      rcloneEl.addEventListener('click', () => { closeAboutDialog(); onOpenRclone() })
    }
  }

  function closeAboutDialog() { overlay.classList.add('hidden') }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeAboutDialog() })
  document.getElementById('about-close').addEventListener('click', closeAboutDialog)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAboutDialog() })

  // openExternal goes through main to enforce an allowlist — renderer cannot open arbitrary URLs.
  document.getElementById('about-github-link').addEventListener('click', e => {
    e.preventDefault()
    window.managerAPI.openExternal('https://github.com/db0x/wrapweb')
  })

  function openAboutDialog() { overlay.classList.remove('hidden') }

  return { openAboutDialog }
}
