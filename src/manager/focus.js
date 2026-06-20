// Focus-ring management.
//
// Chromium keeps DOM focus on a button after a *mouse* click. The :focus-visible
// heuristic then flips into "keyboard mode" on the next keypress (e.g. Escape to
// close a dialog) and paints a focus ring on whatever still holds focus — typically
// the button that opened the dialog, which the user never keyboard-navigated to.
// That is the stray orange ring users see after dismissing a dialog with Escape.
//
// Dropping focus from pointer-activated buttons keeps the ring reserved for genuine
// keyboard navigation, where it is a real accessibility aid, while killing the
// spurious ring everywhere else.
export function initFocusRing() {
  document.addEventListener('pointerup', e => {
    const btn = e.target.closest('button, [role="button"]')
    if (btn) btn.blur()
  })
}
