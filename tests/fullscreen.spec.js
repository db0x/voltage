const { test, expect } = require('@playwright/test')
const path = require('node:path')

// Unit tests for src/fullscreen.js — the F11 (toggleFullscreen) and Shift+F11 (toggleMaximize)
// window actions. Plain Node assertions against a fake BrowserWindow (no Electron runtime), like
// no-select.spec.js: the logic under test is which window method each action calls.

const { toggleFullscreen, toggleMaximize } = require(path.join(__dirname, '..', 'src', 'fullscreen.js'))

// Minimal BrowserWindow stub. Records calls and tracks the fullscreen/maximized flags so repeated
// toggles see realistic live state.
function fakeWin({ fullscreen = false, maximized = false } = {}) {
  const calls = []
  return {
    calls,
    _fullscreen: fullscreen,
    _maximized: maximized,
    isFullScreen() { return this._fullscreen },
    isMaximized() { return this._maximized },
    setFullScreen(v) { calls.push(['setFullScreen', v]); this._fullscreen = v },
    setMaximizable(v) { calls.push(['setMaximizable', v]) },
    maximize()   { calls.push(['maximize']);   this._maximized = true },
    unmaximize() { calls.push(['unmaximize']); this._maximized = false },
  }
}

const names = win => win.calls.map(c => c[0])

// Setup:    A windowed window.
// Action:   toggleFullscreen twice.
// Expected: Plain real-fullscreen on/off — F11 behaviour, identical for framed and widget apps.
test('toggleFullscreen turns real fullscreen on and off', () => {
  const win = fakeWin()
  toggleFullscreen(win)
  expect(win._fullscreen).toBe(true)
  toggleFullscreen(win)
  expect(win._fullscreen).toBe(false)
  expect(names(win)).toEqual(['setFullScreen', 'setFullScreen'])
})

// Setup:    A non-maximized window.
// Action:   toggleMaximize.
// Expected: It maximizes, and enables maximizable first so a non-resizable widget can maximize at
//           all — Shift+F11's job.
test('toggleMaximize maximizes a windowed window (unlocking maximizable first)', () => {
  const win = fakeWin()
  toggleMaximize(win)
  expect(names(win)).toEqual(['setMaximizable', 'maximize'])
  expect(win._maximized).toBe(true)
})

// Setup:    A maximized window.
// Action:   toggleMaximize.
// Expected: It restores (unmaximize) — Shift+F11 is a toggle, the second press brings the window
//           back without touching fullscreen.
test('toggleMaximize restores a maximized window', () => {
  const win = fakeWin({ maximized: true })
  toggleMaximize(win)
  expect(win._maximized).toBe(false)
  expect(names(win)).toEqual(['unmaximize'])
})

// Setup:    A windowed window.
// Action:   toggleMaximize twice.
// Expected: maximize then restore — the full Shift+F11 round trip leaves it windowed again, and
//           fullscreen is never touched (the two actions are independent).
test('toggleMaximize round-trips back to windowed without touching fullscreen', () => {
  const win = fakeWin()
  toggleMaximize(win)
  toggleMaximize(win)
  expect(win._maximized).toBe(false)
  expect(win._fullscreen).toBe(false)
  expect(names(win)).toEqual(['setMaximizable', 'maximize', 'unmaximize'])
})
