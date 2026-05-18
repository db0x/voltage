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
  adjustZoom:    (delta)  => ipcRenderer.send('adjust-zoom',    delta),
  rcloneConfirm: (choice) => ipcRenderer.send('rclone-confirm', choice),
});

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }
  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type])
  }
})
