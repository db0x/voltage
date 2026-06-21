import { applyTemplate } from '../template.js'

const ASCII_ART = [
  '            ____               ',
  ' _  _____  / / /____ ____ ____ ',
  '| |/ / _ \\/ / __/ _ `/ _ `/ -_)',
  '|___/\\___/_/\\__/\\_,_/\\_, /\\__/ 🐧',
  '                    /___/       ',
].join('\n')

export function initAboutDialog({ i18n, version, icons, templates }, { obsidianAvailable = false, rcloneAvailable = false, gnomeAvailable = false, onOpenObsidian = null, onOpenRclone = null, onOpenGnome = null } = {}) {
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
  // GNOME is an environment integration (not a plugin), so it only surfaces when running on GNOME.
  if (gnomeAvailable) {
    const gnomeEl = document.getElementById('about-gnome')
    gnomeEl.hidden = false
    if (onOpenGnome) {
      gnomeEl.style.cursor = 'pointer'
      gnomeEl.addEventListener('click', () => { closeAboutDialog(); onOpenGnome() })
    }
  }

  function closeAboutDialog() { overlay.classList.add('hidden') }
  document.getElementById('about-close').addEventListener('click', closeAboutDialog)
  document.getElementById('about-close-btn').addEventListener('click', closeAboutDialog)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAboutDialog() })

  // openExternal goes through main to enforce an allowlist — renderer cannot open arbitrary URLs.
  document.getElementById('about-github-link').addEventListener('click', e => {
    e.preventDefault()
    window.managerAPI.openExternal('https://github.com/db0x/voltage')
  })

  function openAboutDialog() { overlay.classList.remove('hidden') }

  return { openAboutDialog }
}
