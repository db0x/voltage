// Full-screen blocking overlay shown during AppImage builds.
// z-index is set above confirm-overlays (dialogs) so it blocks interaction
// even when triggered from within a dialog (e.g. "Rebuild all").
export function initBuildOverlay({ tr }) {
  const overlay = document.createElement('div')
  overlay.id = 'build-overlay'
  overlay.className = 'hidden'
  overlay.innerHTML = `
    <div class="build-spinner"></div>
    <span class="build-overlay-label" id="build-overlay-label"></span>
  `
  document.body.appendChild(overlay)

  // labelKey selects the status text: the card's combined action installs after building, so it
  // passes 'buildingInstallingApp'; the plain rebuild (rebuild-notice) keeps the default.
  function showBuildOverlay(name, labelKey = 'buildingApp') {
    document.getElementById('build-overlay-label').textContent = tr(labelKey, { name })
    overlay.classList.remove('hidden')
  }

  function hideBuildOverlay() {
    overlay.classList.add('hidden')
  }

  return { showBuildOverlay, hideBuildOverlay }
}
