'use strict';
(() => {
  const bridge = window.meshkeepDesktop;
  if (!bridge?.updateStatus) return;
  const $ = id => document.getElementById(id);
  let state = null;
  let visible = false;
  let dismissed = '';
  const key = value => `${value.status}:${value.version || ''}`;
  $('checkUpdates').hidden = false;

  function render(next) {
    if (state && next.revision < state.revision) return;
    state = next;
    const actionable = ['available', 'downloading', 'downloaded', 'installing'].includes(state.status);
    $('updateBanner').hidden = !(visible || (actionable && dismissed !== key(state)));
    const busy = ['checking', 'downloading', 'installing'].includes(state.status);
    $('checkUpdates').disabled = busy;
    $('updateProgress').hidden = state.status !== 'downloading';
    $('updateProgress').value = state.percent;
    $('updateAction').hidden = true;
    $('updateAction').disabled = busy;
    $('updateRelease').hidden = !['available', 'error', 'downloaded', 'unavailable'].includes(state.status);
    $('dismissUpdate').textContent = actionable ? 'Later' : 'Dismiss';
    let title = 'Meshkeep updates';
    let message = `Installed version: ${state.currentVersion}`;
    let action = null;
    if (state.status === 'checking') message = 'Checking GitHub Releases…';
    if (state.status === 'current') title = 'Meshkeep is up to date';
    if (state.status === 'available') {
      title = `Meshkeep ${state.version} is available`;
      message = state.canInstall ? 'Download the update now and restart when you are ready.' : 'This Mac build needs a manual update. Open the release page to download the latest installer.';
      if (state.canInstall) action = ['Download update', () => bridge.downloadUpdate()];
    }
    if (state.status === 'downloading') {
      title = `Downloading Meshkeep ${state.version}`;
      message = `${Math.floor(state.percent)}% downloaded. You can keep using Meshkeep.`;
    }
    if (state.status === 'downloaded') {
      title = `Meshkeep ${state.version} is ready to install`;
      message = 'Save your work, then restart to finish updating.';
      action = ['Restart and install', () => bridge.installUpdate()];
    }
    if (state.status === 'installing') message = 'Closing Meshkeep and installing the update…';
    if (state.status === 'unavailable') {
      title = 'Automatic updates are not available yet';
      message = state.message;
      action = ['Check again', () => bridge.checkUpdate()];
    }
    if (state.status === 'error') {
      title = state.failedOperation === 'check' ? 'Could not check for updates' : 'Could not update Meshkeep';
      message = state.message;
      action = ['Try again', () => bridge.checkUpdate()];
    }
    if (state.status === 'disabled') message = state.message;
    $('updateTitle').textContent = title;
    $('updateMessage').textContent = message;
    if (action) {
      $('updateAction').hidden = false;
      $('updateAction').textContent = action[0];
      $('updateAction').onclick = () => run(action[1]);
    }
  }
  async function run(action) {
    try { const next = await action(); if (next) render(next); }
    catch (_) {
      visible = true;
      $('updateBanner').hidden = false;
      $('updateTitle').textContent = 'Could not update Meshkeep';
      $('updateMessage').textContent = 'Please try again. If the problem continues, reopen Meshkeep.';
    }
  }
  $('checkUpdates').onclick = () => { visible = true; dismissed = ''; run(() => bridge.checkUpdate()); };
  $('dismissUpdate').onclick = () => { visible = false; dismissed = key(state); $('updateBanner').hidden = true; };
  $('updateRelease').onclick = () => run(() => bridge.updateRelease());
  const offState = bridge.onUpdateState(render);
  const offShow = bridge.onShowUpdates(() => { visible = true; dismissed = ''; if (state) render(state); });
  window.addEventListener('beforeunload', () => { offState(); offShow(); }, {once: true});
  // A subscription precedes the snapshot, and revisions reject stale replies.
  run(() => bridge.updateStatus());
})();
