'use strict';

// Keep downloads and installation in the main process. The renderer receives
// only display state and cannot supply a feed, URL, file path or installer.
function createUpdater({autoUpdater, currentVersion, enabled, canInstall, publish, confirmInstall, beforeInstall}) {
  let state = {status: enabled ? 'idle' : 'disabled', currentVersion, version: null, percent: 0,
    canInstall, failedOperation: null, message: enabled ? '' : 'Update checks are available in the installed Mac and Windows apps.', revision: 0};
  let checking = false;
  let downloading = false;
  let installing = false;
  const getState = () => ({...state});
  function update(patch) {
    state = {...state, ...patch, revision: state.revision + 1};
    publish(getState());
  }
  function fail(error) {
    console.warn('Meshkeep update failed:', error?.message || error);
    const failedOperation = checking ? 'check' : downloading ? 'download' : 'install';
    if (failedOperation === 'check' && ['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'].includes(error?.code)) {
      update({status: 'unavailable', failedOperation: null, version: null, percent: 0,
        message: 'The published GitHub release does not include automatic update files yet. You can keep using Meshkeep and check again after the next release.'});
      return;
    }
    const message = failedOperation === 'check'
      ? 'Meshkeep could not check GitHub Releases. Please try again, or open the release page.'
      : failedOperation === 'download'
        ? 'The update could not be downloaded or verified. Please try again, or download the installer from the release page.'
        : 'The update could not be installed. Reopen Meshkeep and try again, or use the installer from the release page.';
    update({status: 'error', failedOperation, message});
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.on('error', fail);
  autoUpdater.on('update-available', info => {
    // Also reject a prerelease version accidentally published on the stable feed.
    if (info.version.split('+')[0].includes('-')) {
      update({status: 'current', version: null, message: ''});
      return;
    }
    update({status: 'available', version: info.version, percent: 0, message: ''});
  });
  autoUpdater.on('update-not-available', () => update({status: 'current', version: null, message: ''}));
  autoUpdater.on('download-progress', progress => update({status: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0))}));
  autoUpdater.on('update-downloaded', info => update({status: 'downloaded', version: info.version, percent: 100, message: ''}));

  return {
    getState,
    async check() {
      if (!enabled || checking || downloading || installing || ['downloaded', 'installing'].includes(state.status)) return getState();
      checking = true;
      update({status: 'checking', message: '', failedOperation: null, percent: 0});
      try { await autoUpdater.checkForUpdates(); } catch (error) { fail(error); }
      finally { checking = false; }
      return getState();
    },
    async download() {
      if (!enabled || !canInstall || checking || downloading || installing || state.status !== 'available') return getState();
      downloading = true;
      update({status: 'downloading', percent: 0, message: ''});
      try { await autoUpdater.downloadUpdate(); } catch (error) { fail(error); }
      finally { downloading = false; }
      return getState();
    },
    async install() {
      if (!enabled || !canInstall || installing || state.status !== 'downloaded') return getState();
      installing = true;
      try {
        if (await confirmInstall()) {
          update({status: 'installing', message: ''});
          await beforeInstall();
          autoUpdater.quitAndInstall(false, true);
        }
      } catch (error) { fail(error); }
      finally { installing = false; }
      return getState();
    },
  };
}

module.exports = {createUpdater};
