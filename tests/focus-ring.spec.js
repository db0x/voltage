const { test, expect } = require('./fixtures')

// Focus-ring management (src/manager/focus.js + the global :focus-visible rule in manager.css).
//
// Chromium keeps DOM focus on a button after a mouse click; the next keypress (e.g. Escape to
// close a dialog) then flips :focus-visible into keyboard mode and paints a focus ring on the
// button the user never keyboard-navigated to. The reported symptom was a stray orange ring on
// the "About Voltage" button after dismissing the about dialog with Escape. initFocusRing()
// blurs pointer-activated buttons so the ring is reserved for genuine keyboard navigation.

// Pins a window below the 875px persistent-drawer breakpoint, then opens the about dialog with a
// real mouse click. Below 875px the drawer is collapsed, so #menu-btn is reliably the toggle and
// #menu-about is only reachable after opening it (the persistent layout keeps #menu-about in the
// DOM but translated off-screen, so a width check is the only reliable signal — not visibility).
// Staying narrow also matters because the window manager carries the last size onto the next
// test's window; a wide window here would leave the drawer persistent and break specs that
// click #menu-btn. The tall height keeps the bottom-pinned About button inside the viewport.
async function openAbout(app, page) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 1000))
  await page.click('#menu-btn')
  await page.click('#menu-about')
}

// Setup:    Manager open; About button reachable.
// Action:   Click the About button with the mouse (which opens the about dialog).
// Expected: The button does not retain DOM focus — pointerup blurred it, so a later keypress
//           cannot resurrect a focus ring on it.
test('mouse-clicking a button does not leave it focused', async ({ electronApp, managerPage }) => {
  await openAbout(electronApp, managerPage)

  const aboutKeepsFocus = await managerPage.evaluate(
    () => document.activeElement === document.getElementById('menu-about')
  )
  expect(aboutKeepsFocus).toBe(false)
})

// Setup:    About dialog opened via a mouse click on the About button, then closed with Escape —
//           the exact sequence that produced the stray orange ring.
// Action:   Inspect the About button after the dialog has closed.
// Expected: The button matches neither :focus nor :focus-visible, so no focus ring is painted.
test('closing the about dialog with Escape leaves no stray focus ring', async ({ electronApp, managerPage }) => {
  await openAbout(electronApp, managerPage)
  await expect(managerPage.locator('.about-dialog')).toBeVisible()

  await managerPage.keyboard.press('Escape')
  await expect(managerPage.locator('.about-dialog')).not.toBeVisible()

  const ringShown = await managerPage.evaluate(() => {
    const btn = document.getElementById('menu-about')
    return btn.matches(':focus') || btn.matches(':focus-visible')
  })
  expect(ringShown).toBe(false)
})

// Setup:    Manager open; nothing focused via keyboard.
// Action:   Tab to move keyboard focus onto a control, then read its computed outline.
// Expected: A real keyboard-navigated control still gets a visible accent outline — the fix
//           suppresses the spurious mouse-click ring without destroying the accessibility ring.
test('keyboard navigation still shows a visible focus ring', async ({ managerPage }) => {
  await managerPage.keyboard.press('Tab')

  const outlineWidth = await managerPage.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return '0px'
    return getComputedStyle(el).outlineWidth
  })
  expect(outlineWidth).not.toBe('0px')
})
