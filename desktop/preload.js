// Narrow, origin-validated IPC bridge. No shell commands or arbitrary IPC exposed.
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('meshkeepDesktop', {
  onSelectAll: callback => {
    const listener = () => callback();
    ipcRenderer.on('meshkeep:selectAll', listener);
    return () => ipcRenderer.removeListener('meshkeep:selectAll', listener);
  },
  updateStatus: () => ipcRenderer.invoke('meshkeep:updateStatus'),
  checkUpdate: () => ipcRenderer.invoke('meshkeep:checkUpdate'),
  downloadUpdate: () => ipcRenderer.invoke('meshkeep:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('meshkeep:installUpdate'),
  updateRelease: () => ipcRenderer.invoke('meshkeep:updateRelease'),
  onUpdateState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('meshkeep:updateState', listener);
    return () => ipcRenderer.removeListener('meshkeep:updateState', listener);
  },
  onShowUpdates: callback => {
    const listener = () => callback();
    ipcRenderer.on('meshkeep:showUpdates', listener);
    return () => ipcRenderer.removeListener('meshkeep:showUpdates', listener);
  },
  slicer: () => ipcRenderer.invoke('meshkeep:slicer'),
  chooseSlicer: () => ipcRenderer.invoke('meshkeep:chooseSlicer'),
  sendToSlicer: paths => ipcRenderer.invoke('meshkeep:sendToSlicer', paths),
  chooseFolder: () => ipcRenderer.invoke('meshkeep:chooseFolder'),
});
