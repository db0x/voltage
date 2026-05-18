const { contextBridge, ipcRenderer } = require('electron')

// Expose a narrow, named API to the renderer via contextBridge.
// contextIsolation is enabled, so this is the only channel the renderer has to main.
contextBridge.exposeInMainWorld('managerAPI', {
  getApps:      () => ipcRenderer.invoke('manager:apps'),
  getVersion:   () => ipcRenderer.invoke('manager:version'),
  getUiIcons:   () => ipcRenderer.invoke('manager:ui-icons'),
  getI18n:      () => ipcRenderer.invoke('manager:i18n'),
  getUaPresets: () => ipcRenderer.invoke('manager:ua-presets'),
  buildApp:   (profile) => ipcRenderer.invoke('manager:build',   profile),
  installApp: (profile, setAsMailHandler) => ipcRenderer.invoke('manager:install', profile, setAsMailHandler),
  deleteApp:    (params)  => ipcRenderer.invoke('manager:delete',       params),
  launchApp:    (profile) => ipcRenderer.invoke('manager:launch',       profile),
  revealPath:   (p)       => ipcRenderer.invoke('manager:reveal-path',    p),
  checkProfile: (profile) => ipcRenderer.invoke('manager:check-profile', profile),
  createApp:    (data)    => ipcRenderer.invoke('manager:create-app',    data),
  updateApp:    (data)    => ipcRenderer.invoke('manager:update-app',    data),
  getPlugins:   ()        => ipcRenderer.invoke('manager:plugins'),
  getAllIcons:     ()      => ipcRenderer.invoke('manager:all-icons'),
  getProfileSizes:      ()        => ipcRenderer.invoke('manager:profile-sizes'),
  deleteProfileData:    (profile) => ipcRenderer.invoke('manager:delete-profile-data', profile),
  openExternal:    (url)  => ipcRenderer.invoke('manager:open-external', url),
  checkUpdate:     ()     => ipcRenderer.invoke('manager:check-update'),
  getRcloneStatus:      ()       => ipcRenderer.invoke('manager:rclone-status'),
  getRcloneDriveRemotes: ()      => ipcRenderer.invoke('manager:rclone-drive-remotes'),
  loadRcloneConfig:     ()       => ipcRenderer.invoke('manager:rclone-load-config'),
  saveRcloneConfig:     (config) => ipcRenderer.invoke('manager:rclone-save-config', config),
})
