// Narrow, origin-validated IPC bridge. No shell commands or arbitrary IPC exposed.
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('meshkeepDesktop', {
  slicer: () => ipcRenderer.invoke('meshkeep:slicer'),
  chooseSlicer: () => ipcRenderer.invoke('meshkeep:chooseSlicer'),
  sendToSlicer: paths => ipcRenderer.invoke('meshkeep:sendToSlicer', paths),
  chooseFolder: () => ipcRenderer.invoke('meshkeep:chooseFolder'),
});
