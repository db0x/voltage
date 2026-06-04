const { test, expect } = require('./fixtures')

// Persistent drawer behaviour: at >=875px the menu becomes a fixed side panel that reserves
// space (grid inset on the right, hamburger hidden, drawer visible below the header); below
// that width it falls back to the slide-in overlay opened via the hamburger.

const setSize = (electronApp, w, h) =>
  electronApp.evaluate(({ BrowserWindow }, [width, height]) =>
    BrowserWindow.getAllWindows()[0].setContentSize(width, height), [w, h])

// Setup:    Window wide enough for the persistent layout (>=875px).
// Action:   (none — the media query applies on width)
// Expected: The hamburger is hidden, the drawer is visible without being opened, and the grid
//           wrapper reserves space on the right (non-zero right margin).
test('wide window: drawer is persistent, hamburger hidden, grid inset', async ({ electronApp, managerPage }) => {
  await setSize(electronApp, 1000, 700)

  // Hamburger hidden is the clearest signal the persistent layout is active; wait on it first.
  await expect(managerPage.locator('#menu-btn')).toBeHidden()
  await expect(managerPage.locator('.drawer')).toBeVisible()

  const marginRight = await managerPage.$eval('#grid-wrapper', el => getComputedStyle(el).marginRight)
  expect(parseInt(marginRight)).toBeGreaterThan(0)
})

// Setup:    Window in the persistent layout.
// Action:   (none — reads the drawer's top offset)
// Expected: The drawer starts below the header (top > 0), so it doesn't overlap the title bar.
test('wide window: drawer starts below the header', async ({ electronApp, managerPage }) => {
  await setSize(electronApp, 1000, 700)

  const top = await managerPage.$eval('.drawer', el => el.getBoundingClientRect().top)
  expect(top).toBeGreaterThan(0)
})

// Setup:    Narrow window (below the breakpoint).
// Action:   (none — the media query no longer applies)
// Expected: The hamburger is back, the grid wrapper has no reserved right margin, and the
//           drawer sits off-screen (slid out to the right) until opened.
test('narrow window: hamburger returns and drawer is an overlay', async ({ electronApp, managerPage }) => {
  await setSize(electronApp, 560, 700)

  // Wait until the narrow layout has actually applied (hamburger back, no reserved margin).
  await expect(managerPage.locator('#menu-btn')).toBeVisible()
  await expect.poll(async () =>
    parseInt(await managerPage.$eval('#grid-wrapper', el => getComputedStyle(el).marginRight))
  ).toBe(0)

  // Ensure the overlay is in its closed state (a prior test may have opened it), then verify it
  // is translated off the right edge — its left edge is at/after the viewport width. Polled so
  // the assert waits for setContentSize + layout to settle.
  await managerPage.evaluate(() => document.querySelector('.drawer')?.classList.remove('open'))
  await expect.poll(async () => {
    const left = await managerPage.$eval('.drawer', el => el.getBoundingClientRect().left)
    const vw   = await managerPage.evaluate(() => window.innerWidth)
    return left >= vw - 1
  }).toBe(true)
})
