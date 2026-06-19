// Preload for the About overlay's WebContentsView. The About panel runs in its OWN web
// context (our HTML, no host-page CSP/Trusted-Types), so it can't break on app-specific
// policies the way the old page-injected version did. This bridge is all it needs from main.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aboutAPI', {
  close:             ()    => ipcRenderer.send('about:close'),
  // ignoreExclude=true: the About panel reports the status even for apps excluded from the
  // passive link tooltip (matches the previous behaviour).
  checkSafeBrowsing: (url) => ipcRenderer.invoke('safe-browsing:check', url, true),
  // Open the footer links (Voltage/Electron) in the system browser instead of a child window.
  openExternal:      (url) => ipcRenderer.send('about:open-external', url),
})
