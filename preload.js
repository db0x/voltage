const { contextBridge, ipcRenderer } = require('electron');

// Expose window.electron only for apps that opt in via fileHandler flag.
// draw.io-desktop protocol: if window.electron.request() is present, draw.io
// bypasses the File System Access API and uses native IPC instead.
if (process.argv.includes('--wrapweb-file-handler')) {
  let reqId = 0
  const pending = {}

  ipcRenderer.on('mainResp', (_, resp) => {
    const cbs = pending[resp.reqId]
    if (!cbs) return
    delete pending[resp.reqId]
    if (resp.error) cbs.error?.(resp.msg)
    else cbs.callback?.(resp.data)
  })

  contextBridge.exposeInMainWorld('electron', {
    request: (msg, callback, error) => {
      msg.reqId = reqId++
      pending[msg.reqId] = { callback, error }
      ipcRenderer.send('rendererReq', msg)
    }
  })
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer→main bridge for the zoom plugin: a page can't reach its own webContents zoom, so the
  // injected ctrl+wheel listener signals the direction here and the plugin steps the zoom factor.
  // Harmless for apps without the zoom plugin (no 'adjust-zoom' handler is registered, so it no-ops).
  adjustZoom:        (delta)  => ipcRenderer.send('adjust-zoom',       delta),
  rcloneConfirm:     (choice) => ipcRenderer.send('rclone-confirm',    choice),
  checkSafeBrowsing: (url, ignoreExclude) => ipcRenderer.invoke('safe-browsing:check', url, ignoreExclude),
});

// Ctrl+right-click → our context menu, the intuitive companion to the Shift+F10 / Menu-key shortcut
// (handled in window.js). Lives in the preload so it runs in the isolated world BEFORE the page's
// scripts: this capture-phase listener is registered first, so on Ctrl it stopImmediatePropagation
// blocks the app's own contextmenu handler across worlds (the app can't preventDefault or show its
// menu) — but we do NOT preventDefault, so Chromium still raises the native context-menu request and
// window.js shows our menu in the proper native context (full hit-test params: cut/copy/paste, link
// routing, etc.). A plain right-click is left untouched, so the app's own menus keep working.
//
// Works wherever a `contextmenu` event fires (most apps). Some apps (Word's canvas editor) swallow
// the right-click on the pointer level so no contextmenu event is ever generated — there nothing
// reaches us and the keyboard shortcut is the way in.
window.addEventListener('contextmenu', (e) => {
  if (e.ctrlKey) e.stopImmediatePropagation()
}, true);

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }
  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type])
  }
})
