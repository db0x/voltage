const { test, expect } = require('@playwright/test')
const path = require('node:path')

// Unit tests for cycleFullscreen() — the F11 / "Fullscreen" menu-item state machine in
// src/fullscreen.js. Plain Node assertions against a fake BrowserWindow (no Electron runtime),
// like no-select.spec.js: the logic under test is the transition order, not any window rendering.

const { cycleFullscreen } = require(path.join(__dirname, '..', 'src', 'fullscreen.js'))

// Minimal BrowserWindow stub. Records every method call and tracks the fullscreen/maximized flags
// so successive cycleFullscreen() calls see realistic live state. setFullScreen(false) fires the
// 'leave-full-screen' once-listener synchronously, mirroring how Electron emits it on exit (which
// is when cycleFullscreen schedules the unmaximize).
function fakeWin({ fullscreen = false, maximized = false } = {}) {
  const calls = []
  let leaveFs = null
  return {
    calls,
    _fullscreen: fullscreen,
    _maximized: maximized,
    isFullScreen() { return this._fullscreen },
    isMaximized() { return this._maximized },
    once(event, cb) { if (event === 'leave-full-screen') leaveFs = cb },
    setFullScreen(v) {
      calls.push(['setFullScreen', v])
      this._fullscreen = v
      if (!v && leaveFs) { const cb = leaveFs; leaveFs = null; cb() }
    },
    setMaximizable(v) { calls.push(['setMaximizable', v]) },
    maximize()   { calls.push(['maximize']);   this._maximized = true },
    unmaximize() { calls.push(['unmaximize']); this._maximized = false },
  }
}

const names = win => win.calls.map(c => c[0])

// Setup:    A framed (non-widget) app window, windowed.
// Action:   Activate fullscreen control twice.
// Expected: Plain on/off toggle — never maximizes. Framed apps already have titlebar controls, so
//           the three-state widget cycle would only get in the way.
test('non-widget app: plain fullscreen toggle, no maximize step', () => {
  const win = fakeWin()
  cycleFullscreen(win, false)
  expect(win._fullscreen).toBe(true)
  cycleFullscreen(win, false)
  expect(win._fullscreen).toBe(false)
  expect(names(win)).toEqual(['setFullScreen', 'setFullScreen'])
})

// Setup:    A widget window, windowed.
// Action:   First activation.
// Expected: It maximizes, and enables maximizable first so a non-resizable widget can maximize at
//           all — otherwise the cycle would be stuck on the windowed step.
test('widget: first activation maximizes (and unlocks maximizable)', () => {
  const win = fakeWin()
  cycleFullscreen(win, true)
  expect(names(win)).toEqual(['setMaximizable', 'maximize'])
  expect(win._maximized).toBe(true)
  expect(win._fullscreen).toBe(false)
})

// Setup:    A widget window already maximized.
// Action:   Second activation.
// Expected: Real fullscreen — it must NOT re-maximize, so the second press visibly differs from the
//           first.
test('widget: second activation goes to real fullscreen', () => {
  const win = fakeWin({ maximized: true })
  cycleFullscreen(win, true)
  expect(win._fullscreen).toBe(true)
  expect(names(win)).toEqual(['setFullScreen'])
})

// Setup:    A widget window in fullscreen that was reached from the maximized state (both flags set,
//           as Electron reports it).
// Action:   Third activation.
// Expected: It leaves fullscreen AND unmaximizes, landing back on a plain window — isFullScreen is
//           checked before isMaximized, so it takes the exit path rather than re-entering fullscreen.
test('widget: third activation returns to a plain window', () => {
  const win = fakeWin({ fullscreen: true, maximized: true })
  cycleFullscreen(win, true)
  expect(win._fullscreen).toBe(false)
  expect(win._maximized).toBe(false)
  expect(names(win)).toEqual(['setFullScreen', 'unmaximize'])
})

// Setup:    A fresh widget window.
// Action:   Three successive activations.
// Expected: windowed → maximized → fullscreen → windowed, returning exactly to the start state —
//           the full round trip works when driven purely by the live flags.
test('widget: three activations complete the windowed→maximized→fullscreen→windowed cycle', () => {
  const win = fakeWin()
  cycleFullscreen(win, true)
  expect([win._maximized, win._fullscreen]).toEqual([true, false])
  cycleFullscreen(win, true)
  expect([win._maximized, win._fullscreen]).toEqual([true, true])
  cycleFullscreen(win, true)
  expect([win._maximized, win._fullscreen]).toEqual([false, false])
})
